#!/usr/bin/env python
"""准确率离线评估：把"≥92%"变成可复现的数字，并给出可复核的报告。

输入（JSONL，一行一条用例）：
    question            必填，问题原文
    domain              可选，contract / carbon；用于跨域脏召回判定
    standard_answer     可选，人工撰写的标准答案（没有 judge 时用于抽数值兜底）
    expected_sparql     可选，金标准查询；其结果值用于计算金标准事实覆盖率
    expected_evidence   可选，必须被召回的 chunk_id 列表
    unexpected_evidence 可选，明确的反例 chunk_id（跨域文档无需标注，按 doc_domains 判定）
    judge               可选，{"all_of": [...], "any_of": [...], "none_of": [...],
                                "expect_block": false, "rule": "..."}
    兼容旧字段：must_any / should_block

输出：
    <out-dir>/report.md   人读报告
    <out-dir>/results.csv 逐用例结果（UTF-8 BOM，Excel 直接打开不乱码）

判定口径全部在 `app/evaluation/metrics.py`，本文件只做 I/O 与编排。

用法：
    backend/.venv/Scripts/python.exe scripts/eval_accuracy.py --threshold 0.92
    backend/.venv/Scripts/python.exe scripts/eval_accuracy.py --only pay-over,closed-contract --verbose
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

ROOT = Path(__file__).resolve().parents[1]
from _bootstrap import ensure_backend_path  # noqa: E402

ensure_backend_path()

from app.compat import use_psycopg_compatible_loop  # noqa: E402
from app.container import build_container  # noqa: E402
from app.errors import OntoRagError, OntologyGuardError  # noqa: E402
from app.evaluation import (  # noqa: E402
    CaseResult,
    failed_case,
    judge_answer,
    render_csv,
    render_markdown,
    spec_from_case,
    summarize,
)
from app.evaluation.metrics import (  # noqa: E402
    evidence_judge_for,
    numbers_in,
    ratio,
)
from app.evaluation.report import format_rate  # noqa: E402
from app.settings import Settings  # noqa: E402
from app.tenancy import build_tenant_context  # noqa: E402

# 评估可以跑在 pg 后端上；Windows 下必须先换事件循环策略
use_psycopg_compatible_loop()

DEFAULT_QA_SET = ROOT / "tests" / "eval" / "qa_set.jsonl"
DEFAULT_DOC_DOMAINS = ROOT / "tests" / "eval" / "doc_domains.json"


# ---------------------------------------------------------------------------
# 参数
# ---------------------------------------------------------------------------


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """命令行参数。默认值即"照 README 跑一遍"。"""
    parser = argparse.ArgumentParser(description="OntoRAG 准确率离线评估")
    parser.add_argument("--qa-set", default=str(DEFAULT_QA_SET), help="测试集 JSONL 路径")
    parser.add_argument("--doc-domains", default=str(DEFAULT_DOC_DOMAINS), help="文档域映射 JSON（可选）")
    parser.add_argument("--tenant", default="demo")
    parser.add_argument("--threshold", type=float, default=0.92, help="准确率门槛")
    parser.add_argument("--max-dirty-recall", type=float, default=0.05, help="脏召回率上限")
    parser.add_argument("--max-hallucination", type=int, default=0, help="允许的 SHACL 违规条数")
    parser.add_argument("--top-k", type=int, default=8)
    parser.add_argument("--limit", type=int, default=0, help="只跑前 N 条（0 表示全部）")
    parser.add_argument("--only", default="", help="逗号分隔的用例 id，只跑这些")
    parser.add_argument("--domain", default="", help="只跑某个业务域")
    parser.add_argument("--out-dir", default="", help="输出目录，默认 var/eval/<时间戳>")
    parser.add_argument("--csv", default="", help="CSV 输出路径（覆盖 --out-dir）")
    parser.add_argument("--report", default="", help="Markdown 输出路径（覆盖 --out-dir）")
    parser.add_argument("--verbose", action="store_true", help="打印失败用例的答案片段与备注")
    return parser.parse_args(argv)


# ---------------------------------------------------------------------------
# 用例执行
# ---------------------------------------------------------------------------


def load_cases(path: Path) -> list[dict[str, Any]]:
    """读 JSONL。空行跳过，坏行直接报错——评估集静默丢行等于偷偷降分母。"""
    cases: list[dict[str, Any]] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            case = json.loads(line)
        except json.JSONDecodeError as error:
            raise SystemExit(f"{path}:{line_no} 不是合法 JSON：{error}") from error
        if not case.get("question"):
            raise SystemExit(f"{path}:{line_no} 缺少 question")
        case.setdefault("id", f"line-{line_no}")
        cases.append(case)
    if not cases:
        raise SystemExit(f"{path} 没有可用用例")
    return cases


def select_cases(
    cases: Sequence[dict[str, Any]], *, only: str, domain: str, limit: int
) -> list[dict[str, Any]]:
    """按 id / 域筛选，再截断。顺序保持数据集原序，便于横向对比历史报告。"""
    selected = list(cases)
    if only:
        wanted = {item.strip() for item in only.split(",") if item.strip()}
        selected = [case for case in selected if str(case["id"]) in wanted]
        missing = wanted - {str(case["id"]) for case in selected}
        if missing:
            raise SystemExit(f"--only 中的用例不存在：{', '.join(sorted(missing))}")
    if domain:
        selected = [case for case in selected if str(case.get("domain") or "") == domain]
    if limit > 0:
        selected = selected[:limit]
    if not selected:
        raise SystemExit("筛选后没有用例可跑")
    return selected


def _normalize_cell(value: Any) -> str:
    """把查询结果单元格规格化：纯数值走 Decimal，其余保留原串。"""
    text = str(value).strip()
    if not text:
        return ""
    digits = text.replace(",", "").replace(".", "").replace("-", "")
    if digits.isdigit():
        canonical = numbers_in(text)
        if len(canonical) == 1:
            return next(iter(canonical))
    return text


async def query_values(store: Any, graph_uri: str, sparql: str | None, *, timeout: float) -> set[str] | None:
    """执行查询并收集全部单元格值；查询失败返回 None（区别于"查到空"）。"""
    if not sparql:
        return None
    try:
        rows = await store.select(graph_uri, sparql, timeout=timeout, max_rows=200)
    except OntoRagError:
        return None
    values: set[str] = set()
    for row in rows:
        for value in row.values():
            if value is None:
                continue
            normalized = _normalize_cell(value)
            if normalized:
                values.add(normalized)
    return values


def _value_in_answer(value: str, answer: str) -> bool:
    """金标准值是否出现在答案里：数值比数值，IRI 比本地名。"""
    digits = value.replace(",", "").replace(".", "").replace("-", "")
    if digits.isdigit():
        canonical = numbers_in(value)
        if canonical:
            return canonical <= numbers_in(answer)
    local = value.rsplit("#", 1)[-1].rsplit("/", 1)[-1]
    return value in answer or (bool(local) and local in answer)


def _violations_from_details(details: dict[str, Any]) -> list[dict[str, Any]]:
    """从阻断错误的 details 里取原始违规列表。"""
    guard = details.get("guard") or {}
    violations = guard.get("violations") or []
    return [item for item in violations if isinstance(item, dict)]


def _blocking(violations: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """只留 Violation 级别：Warning 不阻断，也不该计入幻觉。"""
    return [item for item in violations if str(item.get("severity", "Violation")) == "Violation"]


async def run_case(
    container: Any,
    tenant_id: str,
    settings: Settings,
    case: dict[str, Any],
    *,
    top_k: int,
    doc_domains: dict[str, str],
    timeout: float,
) -> CaseResult:
    """执行一条用例：检索指标取自 preview，答案与闸门取自完整链路。

    为什么跑两遍：`answer()` 的返回只带 citations（生成引用的子集），
    没有完整召回列表就无法算脏召回率。`preview()` 是同一套检索的只读入口，
    用它算召回指标、用 `answer()` 算答案指标，两者口径各自独立。
    """
    question = str(case["question"])
    domain = case.get("domain") or None
    spec = spec_from_case(case)
    judge = evidence_judge_for(case, doc_domains)
    tenant = build_tenant_context(tenant_id, f"eval-{case['id']}", settings)

    result = CaseResult(
        id=str(case["id"]),
        domain=str(case.get("domain") or ""),
        question=question,
        expect_block=spec.expect_block,
        judge_source=spec.source,
    )
    notes: list[str] = []

    # ---- 检索通道（preview）----
    started = time.perf_counter()
    preview = None
    try:
        preview = await container.pipeline.preview(tenant, question, domain=domain, top_k=top_k)
    except OntoRagError as error:
        notes.append(f"preview-failed:{error.code}")
    except Exception as error:  # noqa: BLE001 —— 后端异常不能让整轮评估中断
        notes.append(f"preview-failed:{type(error).__name__}")
    result.retrieval_ms = (time.perf_counter() - started) * 1000

    if preview is not None:
        result.retrieved = tuple(citation.chunk_id for citation in preview.citations)
        counts = judge.counts(result.retrieved)
        result.relevant = counts["relevant"]
        result.dirty = counts["dirty"]
        result.unjudged = counts["unjudged"]
        result.dirty_rate = ratio(result.dirty, result.relevant + result.dirty)

        expected = set(judge.expected)
        if expected:
            hit = expected & set(result.retrieved)
            result.evidence_recall = len(hit) / len(expected)
            result.evidence_missing = tuple(sorted(expected - set(result.retrieved)))
        if not result.retrieved:
            notes.append("no-evidence")

    # ---- 答案 + 闸门 ----
    started = time.perf_counter()
    guard_conforms = False
    blocked = False
    violation_dicts: list[dict[str, Any]] = []
    try:
        response = await container.pipeline.answer(tenant, question, domain=domain, top_k=top_k)
        guard_conforms = response.guard.conforms
        blocked = response.blocked
        result.answer = response.answer
        result.status = "ok"
        violation_dicts = [item.model_dump() for item in response.guard.violations]
    except OntologyGuardError as error:
        blocked = True
        guard_conforms = False
        result.status = "blocked"
        violation_dicts = _violations_from_details(error.details)
        notes.append("guard-blocked")
    except OntoRagError as error:
        result.status = "error"
        notes.append(f"error:{error.code}")
        result.reasons.append(f"error:{error.message}")
    except Exception as error:  # noqa: BLE001 —— 同上：记成用例失败，不冒泡
        result.status = "error"
        notes.append(f"error:{type(error).__name__}")
        result.reasons.append(f"error:{type(error).__name__}: {error}")
    result.answer_ms = (time.perf_counter() - started) * 1000
    result.guard_conforms = guard_conforms
    result.blocked = blocked

    blocking = _blocking(violation_dicts)
    result.violations = len(blocking)
    result.violation_rules = tuple(sorted({str(item.get("rule") or "") for item in blocking if item.get("rule")}))

    # ---- 金标准 SPARQL：金标准事实覆盖率（答案侧）----
    expected_sparql = case.get("expected_sparql")
    if expected_sparql:
        gold = await query_values(container.graph, tenant.graph_uri, str(expected_sparql), timeout=timeout)
        if gold is None:
            notes.append("gold-query-failed")
        elif not gold:
            notes.append("gold-query-empty")
        else:
            result.gold_values = tuple(sorted(gold))
            if result.answer:
                hit = sum(1 for value in gold if _value_in_answer(value, result.answer))
                result.gold_coverage = hit / len(gold)

    # ---- 判定 ----
    if result.status != "error":
        verdict = judge_answer(
            spec,
            result.answer,
            blocked=blocked,
            guard_conforms=guard_conforms,
            violation_rules=result.violation_rules,
        )
        result.checks = dict(verdict.checks)
        result.passed = verdict.passed
        result.reasons = list(verdict.reasons)

    result.notes = tuple(notes)
    return result


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def _write_outputs(
    args: argparse.Namespace, summary: Any, results: Sequence[CaseResult], meta: dict[str, Any]
) -> tuple[Path, Path]:
    """落地报告与 CSV。返回实际写入路径。"""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = Path(args.out_dir) if args.out_dir else ROOT / "var" / "eval" / stamp
    report_path = Path(args.report) if args.report else out_dir / "report.md"
    csv_path = Path(args.csv) if args.csv else out_dir / "results.csv"
    for path in (report_path, csv_path):
        path.parent.mkdir(parents=True, exist_ok=True)

    thresholds = {
        "accuracy": args.threshold,
        "max_dirty_recall": args.max_dirty_recall,
        "max_hallucination": args.max_hallucination,
    }
    report_path.write_text(
        render_markdown(summary, results, meta=meta, thresholds=thresholds), encoding="utf-8"
    )
    # utf-8-sig：Excel 打开中文 CSV 不乱码；纯 UTF-8 会被按 GBK 解读
    csv_path.write_text(render_csv(results), encoding="utf-8-sig")
    return report_path, csv_path


def _print_summary(summary: Any, args: argparse.Namespace, report_path: Path, csv_path: Path) -> list[str]:
    """终端汇总，并返回未达标项说明。"""
    failures: list[str] = []
    judged = summary.relevant + summary.dirty
    print("\n===== 评估汇总 =====")
    print(f"用例数        : {summary.total}")
    print(f"通过数        : {summary.passed}")
    print(f"业务问答准确率: {summary.accuracy:.2%}（门槛 ≥ {args.threshold:.0%}）")
    print(f"脏召回率      : {format_rate(summary.dirty_rate)}（{summary.dirty}/{judged} 可判定，上限 {args.max_dirty_recall:.0%}）")
    unjudged_rate = summary.unjudged / summary.retrieved if summary.retrieved else None
    print(f"未判定占比    : {format_rate(unjudged_rate)}（{summary.unjudged}/{summary.retrieved} 条召回无判定依据）")
    if summary.guard_samples:
        print(f"幻觉违规次数  : {summary.hallucination_violations}（SHACL Violation，上限 {args.max_hallucination}）")
    else:
        print("幻觉违规次数  : n/a（无闸门样本，链路全部异常）")
    print(f"闸门通过率    : {format_rate(summary.guard_pass_rate)}")
    print(f"证据召回率    : {format_rate(summary.evidence_recall)}")
    print(f"金标准事实覆盖率: {format_rate(summary.gold_coverage)}")
    print(f"平均检索耗时  : {summary.avg_retrieval_ms:.0f} ms；生成 P95：{summary.p95_answer_ms:.0f} ms")

    if summary.accuracy < args.threshold:
        failures.append(f"准确率 {summary.accuracy:.2%} < {args.threshold:.2%}")
    if summary.dirty_rate is not None and summary.dirty_rate > args.max_dirty_recall:
        failures.append(f"脏召回率 {summary.dirty_rate:.2%} > {args.max_dirty_recall:.2%}")
    if summary.guard_samples and summary.hallucination_violations > args.max_hallucination:
        failures.append(f"幻觉违规 {summary.hallucination_violations} > {args.max_hallucination}")

    print(f"\n报告: {report_path}")
    print(f"CSV : {csv_path}")
    if failures:
        print("\n未达标：")
        for item in failures:
            print(f"  - {item}")
    else:
        print("\n达标。")
    return failures


async def main(argv: Sequence[str] | None = None) -> int:
    """执行评估。"""
    args = parse_args(argv)
    settings = Settings()
    qa_set = Path(args.qa_set)
    cases = select_cases(load_cases(qa_set), only=args.only, domain=args.domain, limit=args.limit)

    doc_domains: dict[str, str] = {}
    doc_domains_path = Path(args.doc_domains)
    if doc_domains_path.is_file():
        doc_domains = json.loads(doc_domains_path.read_text(encoding="utf-8"))
    else:
        print(f"[warn] 未找到文档域映射 {doc_domains_path}，跨域脏召回将无法判定")

    container = build_container(settings)
    results: list[CaseResult] = []
    try:
        for case in cases:
            try:
                result = await run_case(
                    container,
                    args.tenant,
                    settings,
                    case,
                    top_k=args.top_k,
                    doc_domains=doc_domains,
                    timeout=settings.sparql_timeout_seconds,
                )
            except Exception as error:  # noqa: BLE001 —— 一条用例崩掉，其余照跑
                result = failed_case(
                    str(case["id"]), str(case.get("domain") or ""), str(case["question"]), str(error)
                )
            results.append(result)
            mark = "PASS" if result.passed else "FAIL"
            print(f"[{mark}] {result.id:<24} {'；'.join(result.reasons)}")
            if args.verbose and not result.passed:
                print(f"        answer : {result.answer[:240]}")
                print(f"        checks : {result.checks}")
                print(f"        notes  : {'；'.join(result.notes)}")
                if result.evidence_missing:
                    print(f"        missing: {', '.join(result.evidence_missing)}")
    finally:
        # 关闭失败不能覆盖真正的结论：池已经关闭时再关一次会抛 PoolClosed
        try:
            await container.aclose()
        except Exception as error:  # noqa: BLE001
            print(f"[warn] 关闭容器时出错：{type(error).__name__}: {error}")

    summary = summarize(results)
    meta = {
        "运行时间": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "测试集": str(qa_set),
        "用例数": len(results),
        "租户": args.tenant,
        "运行模式": settings.rag_mode,
        "SHACL 引擎": container.shacl_engine,
        "top_k": args.top_k,
        "生成器": settings.effective_llm_provider,
        "生成模型": f"{settings.llm_model_flash} / {settings.llm_model_strong}",
    }
    report_path, csv_path = _write_outputs(args, summary, results, meta)
    failures = _print_summary(summary, args, report_path, csv_path)
    errored = sum(1 for item in results if item.status == "error")
    if errored == len(results):
        print("\n[error] 全部用例都因后端异常失败——先确认数据库/图库可用、凭据正确，再判断模型质量。")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
