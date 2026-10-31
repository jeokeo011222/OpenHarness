"""评估结果的两种呈现：Markdown 报告（给人看）与 CSV（给表格看）。

两者都只接受已经算好的结果，不做任何判定——否则报告和判定会各自演化，
最后没人知道"报告里的 92%"是怎么来的。
"""

from __future__ import annotations

import csv
import io
from typing import Any, Mapping, Sequence

from .metrics import CaseResult, Summary

_VERDICT = {True: "达标", False: "**未达标**"}


def _cell(value: Any) -> str:
    """Markdown 表格单元格转义：竖线会破坏列结构，换行会破坏行结构。"""
    text = "" if value is None else str(value)
    return text.replace("|", "\\|").replace("\n", " ").strip()


def format_rate(value: float | None, digits: int = 2) -> str:
    """率值渲染：None 明确写成 n/a，不写成 0%。"""
    if value is None:
        return "n/a"
    return f"{value:.{digits}%}"


def _fmt_ms(value: float) -> str:
    return f"{value:.0f} ms"


def render_markdown(
    summary: Summary,
    results: Sequence[CaseResult],
    *,
    meta: Mapping[str, Any],
    thresholds: Mapping[str, float],
) -> str:
    """生成完整评估报告。

    结构固定为「结论 → 指标 → 失败归因 → 逐用例 → 口径」，顺序即阅读优先级：
    先看是否达标，再看差在哪，最后才看逐条明细。
    """
    lines: list[str] = []
    lines.append("# OntoRAG 离线评估报告")
    lines.append("")
    lines.append("| 项 | 值 |")
    lines.append("| --- | --- |")
    for key, value in meta.items():
        lines.append(f"| {_cell(key)} | {_cell(value)} |")
    lines.append("")
    if str(meta.get("生成器", "")) == "offline":
        lines.append(
            "> ⚠️ 本次运行使用**确定性离线生成器**（`LLM_PROVIDER=offline`，未配置模型密钥）。"
            "准确率衡量的是「检索 + 闸门」链路，不代表真实大模型的生成质量；"
            "要评估模型质量，需配置 `DEEPSEEK_API_KEY` 后重跑。"
        )
        lines.append("")

    # 章节号动态生成：某节被跳过时不能留下断档的编号
    section = iter(range(1, 10))
    lines.append(f"## {next(section)}. 结论")
    lines.append("")
    lines.append("| 指标 | 结果 | 门槛 | 判定 |")
    lines.append("| --- | --- | --- | --- |")
    accuracy_ok = summary.accuracy >= thresholds.get("accuracy", 0.0)
    lines.append(
        f"| 整体问答准确率 | {summary.passed}/{summary.total} = {summary.accuracy:.2%} | "
        f"≥ {thresholds.get('accuracy', 0.0):.0%} | {_VERDICT[accuracy_ok]} |"
    )
    max_dirty = thresholds.get("max_dirty_recall")
    if max_dirty is not None and summary.dirty_rate is not None:
        dirty_ok = summary.dirty_rate <= max_dirty
        lines.append(
            f"| 脏召回率 | {summary.dirty}/{summary.relevant + summary.dirty} = {summary.dirty_rate:.2%} | "
            f"≤ {max_dirty:.0%} | {_VERDICT[dirty_ok]} |"
        )
    elif max_dirty is not None:
        dirty_ok = True
        lines.append("| 脏召回率 | n/a（无可判定样本） | — | 跳过 |")
    else:
        dirty_ok = True
    max_hallucination = int(thresholds.get("max_hallucination", 0))
    if summary.guard_samples == 0:
        # 一条用例都没跑过闸门时，"0 违规"不是好成绩，是没有样本
        hallucination_ok = True
        lines.append("| 幻觉违规次数（SHACL Violation） | n/a（无闸门样本） | — | 跳过 |")
    else:
        hallucination_ok = summary.hallucination_violations <= max_hallucination
        lines.append(
            f"| 幻觉违规次数（SHACL Violation） | {summary.hallucination_violations} | "
            f"≤ {max_hallucination} | {_VERDICT[hallucination_ok]} |"
        )
    lines.append("")

    lines.append(f"## {next(section)}. 指标明细")
    lines.append("")
    lines.append("| 指标 | 值 | 口径 |")
    lines.append("| --- | --- | --- |")
    lines.append(f"| 用例总数 | {summary.total} | 本次实际执行条数 |")
    lines.append(
        f"| 闸门通过率 | {format_rate(summary.guard_pass_rate)} | 非对抗用例中 `guard.conforms` 且未被阻断的占比 |"
    )
    lines.append(
        f"| 证据召回率 | {format_rate(summary.evidence_recall)} | 标注 `expected_evidence` 被实际召回的比例（宏平均） |"
    )
    lines.append(
        f"| 金标准事实覆盖率 | {format_rate(summary.gold_coverage)} | "
        f"`expected_sparql` 返回的金标准值出现在最终答案中的比例（宏平均） |"
    )
    lines.append(
        f"| 未判定占比 | {format_rate(summary.unjudged / summary.retrieved if summary.retrieved else None)} | "
        f"{summary.unjudged}/{summary.retrieved} 条召回 chunk 既非标注证据也无跨域依据，不计入脏召回 |"
    )
    lines.append(f"| 对抗用例被阻断 | {summary.blocked_cases} | 期望被阻断的用例实际阻断数 |")
    lines.append(f"| 闸门样本数 | {summary.guard_samples} | 实际产出 SHACL 结论的用例数（链路异常的不计） |")
    lines.append(f"| 平均检索耗时 | {_fmt_ms(summary.avg_retrieval_ms)} | 仅检索通道（preview），不含生成 |")
    lines.append(f"| 生成耗时 P95 | {_fmt_ms(summary.p95_answer_ms)} | 含 LLM 生成与 SHACL 校验 |")
    lines.append("")

    lines.append(f"## {next(section)}. 失败归因")
    lines.append("")
    if summary.failure_buckets:
        lines.append("| 归因 | 次数 |")
        lines.append("| --- | --- |")
        for bucket, count in summary.failure_buckets.items():
            lines.append(f"| {_cell(bucket)} | {count} |")
        lines.append("")
        lines.append("> 归因按失败原因的前缀归类（`facts` 事实不符、`guard` 闸门阻断、"
                     "`expect_block` 对抗用例未被阻断、`error` 链路异常）。")
    else:
        lines.append("无失败用例。")
    lines.append("")

    lines.append(f"## {next(section)}. 逐用例结果")
    lines.append("")
    lines.append(
        "| # | 用例 | 域 | 判定 | 闸门 | 脏召回 | 证据召回 | 违规 | 耗时 | 失败原因 |"
    )
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for index, item in enumerate(results, start=1):
        mark = "PASS" if item.passed else "FAIL"
        guard = "通过" if item.guard_conforms and not item.blocked else ("阻断" if item.blocked else "未通过")
        lines.append(
            "| {idx} | {cid} | {domain} | {mark} | {guard} | {dirty} | {evidence} | {violations} | {ms} | {reason} |".format(
                idx=index,
                cid=_cell(item.id),
                domain=_cell(item.domain),
                mark=mark,
                guard=guard,
                dirty=format_rate(item.dirty_rate),
                evidence=format_rate(item.evidence_recall),
                violations=item.violations,
                ms=_fmt_ms(item.retrieval_ms + item.answer_ms),
                reason=_cell("；".join(item.reasons)),
            )
        )
    lines.append("")

    derived = [item.id for item in results if item.judge_source == "derived"]
    unjudged = [item.id for item in results if item.judge_source == "unjudged"]
    if derived or unjudged:
        lines.append(f"## {next(section)}. 判定口径告警")
        lines.append("")
        if derived:
            lines.append(f"- 以下用例没有显式 `judge`，仅以 `standard_answer` 中的数值兜底判定：{', '.join(derived)}")
        if unjudged:
            lines.append(f"- 以下用例既无 `judge` 也无 `standard_answer` 数值，无法判定：{', '.join(unjudged)}")
        lines.append("")

    lines.append(f"## {next(section)}. 口径说明")
    lines.append("")
    lines.append("1. **准确率**：闸门通过 + `judge.all_of` 全中 + `judge.any_of` 至少一中 + `judge.none_of` 全不出现。")
    lines.append("2. **数值感知**：`5,500,000`、`5500000`、`550 万` 视为同一事实，比较 Decimal 值而非字符串。")
    lines.append("3. **否定不算命中**：`未超付` 不会被当成提到 `超付`。")
    lines.append("4. **脏召回率**：`dirty / (dirty + relevant)`，微平均。`dirty` 只来自显式反例或跨域文档；"
                 "同域未标注的额外 chunk 记 `unjudged`，单独披露，不当成干净。")
    lines.append("5. **幻觉违规**：SHACL / 结构校验产生的 `Violation` 级别结果总数；"
                 "标注 `expect_block` 的对抗用例被阻断属期望结果，不计入。")
    lines.append("6. **金标准事实覆盖率**：执行 `expected_sparql` 得到金标准值集合，计算其中出现在最终答案里的比例。"
                 "只投影事实值（金额、数量、状态），不投影内部 IRI——IRI 的名字对读者没有意义，会稀释这个指标。")
    lines.append("")
    return "\n".join(lines)


_CSV_COLUMNS = (
    "id",
    "domain",
    "status",
    "passed",
    "guard_conforms",
    "blocked",
    "expect_block",
    "violations",
    "violation_rules",
    "dirty_rate",
    "relevant",
    "dirty",
    "unjudged",
    "evidence_recall",
    "evidence_missing",
    "gold_coverage",
    "retrieval_ms",
    "answer_ms",
    "judge_source",
    "reasons",
    "retrieved",
    "answer",
)


def render_csv(results: Sequence[CaseResult]) -> str:
    """逐用例 CSV。列名与 `CaseResult` 字段一一对应，便于二次分析。"""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(_CSV_COLUMNS)
    for item in results:
        writer.writerow(
            [
                item.id,
                item.domain,
                item.status,
                int(item.passed),
                int(item.guard_conforms),
                int(item.blocked),
                int(item.expect_block),
                item.violations,
                "|".join(item.violation_rules),
                "" if item.dirty_rate is None else f"{item.dirty_rate:.4f}",
                item.relevant,
                item.dirty,
                item.unjudged,
                "" if item.evidence_recall is None else f"{item.evidence_recall:.4f}",
                "|".join(item.evidence_missing),
                "" if item.gold_coverage is None else f"{item.gold_coverage:.4f}",
                f"{item.retrieval_ms:.1f}",
                f"{item.answer_ms:.1f}",
                item.judge_source,
                "；".join(item.reasons),
                "|".join(item.retrieved),
                item.answer.replace("\n", " "),
            ]
        )
    return buffer.getvalue()
