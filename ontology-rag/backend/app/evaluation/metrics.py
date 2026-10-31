"""判定内核：全部纯函数，零 I/O、零全局状态。

为什么判定口径不写在脚本里：脚本随时会改，口径不能跟着改。历史报告要能被复核，
就只能把"算不算对"固化成可单测的函数。

四条口径（写死，不允许按报告结果回调）：

1. **正确性以业务事实为准**：`all_of` 必须全部命中，`any_of` 至少一个命中，
   `none_of` 一个都不能出现。关键字命中只是必要条件，闸门通过是另一个独立条件。
2. **数值比较是规格化的**：`5,500,000`、`5500000`、`550 万` 是同一个事实。
   比较 Decimal 值而不是字符串——否则同一份答案会因为千分位写法不同被判错。
3. **否定语境不算命中**：`未超付` 里含有 `超付`，若按子串匹配，把结论答反的回答
   反而会通过。这是本业务场景里最容易造成"看起来对了"的失效，必须显式处理。
4. **脏召回只在有判定依据时计入**：显式反例，或文档域与问题域不符。
   没有依据的额外 chunk 记为 `unjudged`，既不算脏也不算干净，单独披露占比——
   把"没标注"当成"干净"是评估报告最常见的自欺。
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Mapping, Sequence

# ---------------------------------------------------------------------------
# 文本与数值规格化
# ---------------------------------------------------------------------------

_NUMBER = re.compile(r"(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s*(亿|万|千)?")
_SCALE = {"亿": Decimal(100_000_000), "万": Decimal(10_000), "千": Decimal(1_000)}
# 纯数值判定时允许残留的单位与分隔符
_NUMERIC_RESIDUE = re.compile(r"[\s,，.。%％元人民币个条项万万千百十+-]")
# 否定词：命中位置前两字符内出现即视为被否定（中文否定通常紧贴，最多隔一个副词）
_NEGATORS = frozenset("未不没非无勿")


def normalize_text(text: str) -> str:
    """去掉全部空白并转小写：中文断行、全角空格都不该影响事实比对。"""
    return re.sub(r"\s+", "", text).lower()


def _format_decimal(value: Decimal) -> str:
    """Decimal -> 规范化字符串。`1E+7` 与 `10000000` 必须是同一个键。"""
    if value == value.to_integral_value():
        return str(value.to_integral_value())
    normalized = value.normalize()
    return format(normalized, "f")


def canonical_number(token: str) -> str | None:
    """把单个数字串（含 `万` / `亿` 后缀）转成规范化十进制字符串。"""
    match = _NUMBER.fullmatch(token.strip())
    if match is None:
        return None
    try:
        value = Decimal(match.group(1).replace(",", ""))
    except InvalidOperation:
        return None
    suffix = match.group(2)
    if suffix:
        value *= _SCALE[suffix]
    return _format_decimal(value)


def numbers_in(text: str) -> set[str]:
    """抽取文本中所有数值，返回规范化十进制字符串集合。"""
    values: set[str] = set()
    for match in _NUMBER.finditer(text):
        try:
            value = Decimal(match.group(1).replace(",", ""))
        except InvalidOperation:
            continue
        suffix = match.group(2)
        if suffix:
            value *= _SCALE[suffix]
        values.add(_format_decimal(value))
    return values


def is_pure_numeric(needle: str) -> bool:
    """`550 万` / `10,000,000 元` 是纯数值；`超付 150 万` 不是。"""
    if not _NUMBER.search(needle):
        return False
    return _NUMERIC_RESIDUE.sub("", _NUMBER.sub("", needle)) == ""


def _is_negated(normalized: str, index: int) -> bool:
    """命中位置前一小段内是否有否定词。

    窗口取 4 字并**在标点处截断**：`不构成超付` 的否定词离命中 3 个字，
    只回看 2 字会漏；而 `已结清。超付` 这种跨句的不该被前面的否定词吃掉。
    """
    window = normalized[max(0, index - 4) : index]
    for separator in ("，", "。", "；", "：", "、", ",", ".", ";", ":", "!", "?", "！", "？", "（", "）", "(", ")"):
        window = window.rsplit(separator, 1)[-1]
    return any(char in _NEGATORS for char in window)


def contains_fact(answer: str, needle: str) -> bool:
    """答案是否成立地提到了某个事实。

    纯数值按 Decimal 比较；其余按子串比较，但否定语境（`未超付`）不算命中。
    宁可漏判也不要把答反的回答判成对：漏判会在报告里显形，误判不会。
    """
    if not needle:
        return True

    if is_pure_numeric(needle):
        expected = numbers_in(needle)
        return bool(expected) and expected <= numbers_in(answer)

    normalized_answer = normalize_text(answer)
    normalized_needle = normalize_text(needle)
    if not normalized_needle:
        return True

    start = 0
    while True:
        index = normalized_answer.find(normalized_needle, start)
        if index < 0:
            return False
        if not _is_negated(normalized_answer, index):
            return True
        start = index + 1


# ---------------------------------------------------------------------------
# 判定规格
# ---------------------------------------------------------------------------


def _as_tuple(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        return (value,) if value.strip() else ()
    return tuple(str(item) for item in value if str(item).strip())


@dataclass(frozen=True, slots=True)
class JudgeSpec:
    """一条用例的判定规格。

    `source` 必须跟着结果一起进报告：`annotation` 是人工标注的关键事实，
    `derived` 是从 `standard_answer` 里抽出来的数值兜底——两者可信度不同，
    混在一起报会影响对准确率的解读。
    """

    all_of: tuple[str, ...] = ()
    any_of: tuple[str, ...] = ()
    none_of: tuple[str, ...] = ()
    expect_block: bool = False
    expected_rule: str = ""
    source: str = "annotation"


def spec_from_case(case: Mapping[str, Any]) -> JudgeSpec:
    """从用例字典取判定规格，兼容旧的 `must_any` / `should_block` 字段。"""
    judge = case.get("judge") or {}
    all_of = _as_tuple(judge.get("all_of") or case.get("must_all"))
    any_of = _as_tuple(judge.get("any_of") or case.get("must_any"))
    none_of = _as_tuple(judge.get("none_of"))
    expect_block = bool(judge.get("expect_block", case.get("should_block", False)))
    expected_rule = str(judge.get("rule") or case.get("expected_rule") or "")
    source = "annotation"

    if not all_of and not any_of:
        # 兜底：只拿 standard_answer 里的数值当关键事实。
        # 不抽中文实词——从自由文本里猜"关键短语"会把判定权交给分词器，
        # 数值至少是可复算的。
        standard_answer = str(case.get("standard_answer") or "")
        derived = sorted(numbers_in(standard_answer))
        if derived:
            any_of = tuple(derived)
            source = "derived"
        else:
            source = "unjudged"

    return JudgeSpec(
        all_of=all_of,
        any_of=any_of,
        none_of=none_of,
        expect_block=expect_block,
        expected_rule=expected_rule,
        source=source,
    )


@dataclass(frozen=True, slots=True)
class Verdict:
    """一次判定的结论：通过与否、逐项检查、可读原因。"""

    passed: bool
    checks: Mapping[str, bool]
    reasons: tuple[str, ...]


def judge_answer(
    spec: JudgeSpec,
    answer: str,
    *,
    blocked: bool,
    guard_conforms: bool,
    violation_rules: Sequence[str] = (),
) -> Verdict:
    """按规格判定一条回答。

    `expect_block` 的对抗用例单独计分：它要求"被阻断且命中预期规则"，
    阻断本身是**期望结果**，不能被算成幻觉。
    """
    checks: dict[str, bool] = {}
    reasons: list[str] = []

    if spec.expect_block:
        checks["blocked"] = blocked
        checks["rule"] = (not spec.expected_rule) or spec.expected_rule in set(violation_rules)
        if not blocked:
            reasons.append("expect_block:未被阻断")
        elif spec.expected_rule and spec.expected_rule not in set(violation_rules):
            reasons.append(f"rule:未命中预期规则 {spec.expected_rule}")
        return Verdict(passed=all(checks.values()), checks=checks, reasons=tuple(reasons))

    checks["guard"] = guard_conforms and not blocked
    if not guard_conforms:
        reasons.append("guard:SHACL 校验未通过")
    elif blocked:
        reasons.append("guard:回答被阻断")

    missing_all = [item for item in spec.all_of if not contains_fact(answer, item)]
    any_hit = (not spec.any_of) or any(contains_fact(answer, item) for item in spec.any_of)
    forbidden = [item for item in spec.none_of if contains_fact(answer, item)]

    checks["facts_all"] = not missing_all
    checks["facts_any"] = any_hit
    checks["facts_none"] = not forbidden

    if missing_all:
        reasons.append("facts:缺少 " + "、".join(missing_all))
    if not any_hit:
        reasons.append("facts:未命中任一关键事实 " + "、".join(spec.any_of))
    if forbidden:
        reasons.append("facts:出现禁止表述 " + "、".join(forbidden))

    return Verdict(passed=all(checks.values()), checks=checks, reasons=tuple(reasons))


# ---------------------------------------------------------------------------
# 证据判定（脏召回）
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class EvidenceJudge:
    """chunk 相关性判定。

    判为 `dirty` 只有两条依据：用例显式标注的反例，或该文档所属域与问题域不符
    （跨域文档不可能是本域问题的有效证据；`archive` 表示已废止资料，对任何域都脏）。
    同域但未被标注的额外 chunk 一律 `unjudged`——它可能是有用的补充条款，
    没有标注就没有资格判它脏。
    """

    expected: frozenset[str] = frozenset()
    negative: frozenset[str] = frozenset()
    doc_domains: Mapping[str, str] = field(default_factory=dict)
    domain: str = ""

    def label(self, chunk_id: str) -> str:
        """返回 relevant / dirty / unjudged。"""
        if chunk_id in self.expected:
            return "relevant"
        if chunk_id in self.negative:
            return "dirty"
        doc = chunk_id.split("#", 1)[0]
        doc_domain = self.doc_domains.get(doc)
        if doc_domain is None:
            return "unjudged"
        if doc_domain == "archive":
            return "dirty"
        if self.domain and doc_domain != self.domain:
            return "dirty"
        return "unjudged"

    def counts(self, retrieved: Iterable[str]) -> dict[str, int]:
        """统计三类标签的条数。"""
        result = {"relevant": 0, "dirty": 0, "unjudged": 0}
        for chunk_id in retrieved:
            result[self.label(chunk_id)] += 1
        return result


def evidence_judge_for(case: Mapping[str, Any], doc_domains: Mapping[str, str]) -> EvidenceJudge:
    """按用例构造证据判定器。"""
    return EvidenceJudge(
        expected=frozenset(_as_tuple(case.get("expected_evidence"))),
        negative=frozenset(_as_tuple(case.get("unexpected_evidence"))),
        doc_domains=doc_domains,
        domain=str(case.get("domain") or ""),
    )


def ratio(numerator: int, denominator: int) -> float | None:
    """分母为 0 时返回 None 而不是 0.0：没有样本 != 指标为零。"""
    if denominator <= 0:
        return None
    return numerator / denominator


# ---------------------------------------------------------------------------
# 用例结果与汇总
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class CaseResult:
    """一条用例的完整结果。字段名与 CSV 列一一对应。"""

    id: str
    domain: str
    question: str
    status: str = "ok"  # ok / blocked / error
    passed: bool = False
    reasons: list[str] = field(default_factory=list)
    checks: dict[str, bool] = field(default_factory=dict)
    guard_conforms: bool = False
    blocked: bool = False
    expect_block: bool = False
    violations: int = 0
    violation_rules: tuple[str, ...] = ()
    retrieved: tuple[str, ...] = ()
    relevant: int = 0
    dirty: int = 0
    unjudged: int = 0
    dirty_rate: float | None = None
    evidence_recall: float | None = None
    evidence_missing: tuple[str, ...] = ()
    gold_values: tuple[str, ...] = ()
    # 金标准值出现在最终答案中的比例：expected_sparql 提供的机器可校验事实
    gold_coverage: float | None = None
    retrieval_ms: float = 0.0
    answer_ms: float = 0.0
    answer: str = ""
    judge_source: str = "annotation"
    notes: tuple[str, ...] = ()

    @property
    def judged(self) -> int:
        """可判定的召回条数：脏召回率的分母。"""
        return self.relevant + self.dirty


@dataclass(slots=True)
class Summary:
    """汇总指标。率值用 `float | None`，避免"没有样本"被渲染成 0%。"""

    total: int
    passed: int
    accuracy: float
    guard_pass_rate: float | None
    dirty_rate: float | None
    evidence_recall: float | None
    gold_coverage: float | None
    hallucination_violations: int
    cases_with_violation: int
    blocked_cases: int
    # 真正跑过闸门的用例数：为 0 时"0 违规"是假达标，必须渲染成 n/a
    guard_samples: int
    relevant: int
    dirty: int
    unjudged: int
    retrieved: int
    avg_retrieval_ms: float
    p95_answer_ms: float
    failure_buckets: dict[str, int]


def failed_case(case_id: str, domain: str, question: str, error: str) -> CaseResult:
    """把一条无法执行的用例转成结果行。

    批量评估最怕"一条用例把整轮打挂"：跑了 11 条、第 12 条因为审计库断了抛异常，
    整轮没有报告，前面 11 条的数字也一起丢了。异常必须留在结果里，而不是冒泡出去。
    """
    return CaseResult(
        id=case_id,
        domain=domain,
        question=question,
        status="error",
        passed=False,
        reasons=[f"error:{error}"],
        guard_conforms=False,
    )


def _percentile(values: Sequence[float], fraction: float) -> float:
    """最近秩百分位：小样本下比线性插值更保守。"""
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, math.ceil(fraction * len(ordered)) - 1)
    return ordered[index]


def summarize(results: Sequence[CaseResult]) -> Summary:
    """把逐用例结果聚合成报告口径。

    脏召回率用**微平均**（总脏数 / 总可判定数），不用宏平均：
    宏平均会让只召回了 1 条 chunk 的用例和召回了 8 条的用例等权，
    与"召回列表里有多少无关内容"这个问题的本意不符。
    """
    total = len(results)
    passed = sum(1 for item in results if item.passed)
    judged = [item for item in results if not item.expect_block]
    guard_ok = sum(1 for item in judged if item.guard_conforms and not item.blocked)

    relevant = sum(item.relevant for item in results)
    dirty = sum(item.dirty for item in results)
    unjudged = sum(item.unjudged for item in results)
    retrieved = sum(len(item.retrieved) for item in results)

    evidence = [item.evidence_recall for item in results if item.evidence_recall is not None]
    gold = [item.gold_coverage for item in results if item.gold_coverage is not None]

    buckets: dict[str, int] = {}
    for item in results:
        for reason in item.reasons:
            bucket = reason.split(":", 1)[0]
            buckets[bucket] = buckets.get(bucket, 0) + 1

    return Summary(
        total=total,
        passed=passed,
        accuracy=(passed / total) if total else 0.0,
        guard_pass_rate=(guard_ok / len(judged)) if judged else None,
        dirty_rate=ratio(dirty, relevant + dirty),
        evidence_recall=(sum(evidence) / len(evidence)) if evidence else None,
        gold_coverage=(sum(gold) / len(gold)) if gold else None,
        # 幻觉违规只统计"本不该被阻断"的用例；对抗用例被阻断是期望结果
        hallucination_violations=sum(item.violations for item in judged),
        cases_with_violation=sum(1 for item in judged if item.violations > 0),
        blocked_cases=sum(1 for item in results if item.blocked),
        guard_samples=sum(1 for item in judged if item.status != "error"),
        relevant=relevant,
        dirty=dirty,
        unjudged=unjudged,
        retrieved=retrieved,
        avg_retrieval_ms=(sum(item.retrieval_ms for item in results) / total) if total else 0.0,
        p95_answer_ms=_percentile([item.answer_ms for item in results], 0.95),
        failure_buckets=dict(sorted(buckets.items(), key=lambda kv: (-kv[1], kv[0]))),
    )
