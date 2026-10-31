"""评估口径的确定性测试：不依赖 DB、不依赖 LLM、不依赖网络。

这些用例存在的理由：评估脚本一旦口径漂移，报告会"看起来更好"而没人发现。
所以每条口径都钉一个反例——尤其是"答反了却通过"这一类。
"""

from __future__ import annotations

import csv
import io

import pytest

from app.evaluation import (
    CaseResult,
    EvidenceJudge,
    JudgeSpec,
    failed_case,
    judge_answer,
    render_csv,
    render_markdown,
    spec_from_case,
    summarize,
)
from app.evaluation.metrics import (
    contains_fact,
    evidence_judge_for,
    is_pure_numeric,
    numbers_in,
    ratio,
)


# ---------------------------------------------------------------------------
# 数值规格化
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("left", "right"),
    [
        ("5,500,000", "550 万"),
        ("5500000", "5,500,000"),
        ("1000 万", "10,000,000"),
        ("2.63", "2.63"),
        ("150 万", "1,500,000"),
    ],
)
def test_numbers_compare_by_value_not_by_lexical_form(left: str, right: str) -> None:
    """同一事实的不同写法必须相等：千分位、中文数量级都不能影响判定。"""
    assert numbers_in(left) == numbers_in(right)


def test_percent_and_plain_number_are_distinct_scale() -> None:
    """`5%` 是 5，`5 万` 是 50000——后缀参与换算，不能混。"""
    assert numbers_in("5%") == {"5"}
    assert numbers_in("5 万") == {"50000"}
    assert numbers_in("5 万") != numbers_in("5%")


def test_large_decimal_is_not_scientific_notation() -> None:
    """Decimal 规格化后不能出现 `1E+7`，否则和查询结果对不上。"""
    assert numbers_in("10000000") == {"10000000"}
    assert numbers_in("10000000.0") == {"10000000"}


@pytest.mark.parametrize(
    ("needle", "expected"),
    [("550 万", True), ("10,000,000 元", True), ("2,630", True), ("超付 150 万", False), ("超付", False)],
)
def test_pure_numeric_detection(needle: str, expected: bool) -> None:
    """带实词的短语不能走纯数值比较，否则会退化成"只比数字"。"""
    assert is_pure_numeric(needle) is expected


# ---------------------------------------------------------------------------
# 事实匹配与否定
# ---------------------------------------------------------------------------


def test_fact_match_is_numeric_aware() -> None:
    assert contains_fact("剩余应付 5,500,000 元", "550 万")
    assert contains_fact("剩余应付 550 万元", "5,500,000")


@pytest.mark.parametrize("answer", ["未超付", "不构成超付", "没有超付", "并非超付"])
def test_negated_claim_does_not_count_as_hit(answer: str) -> None:
    """`未超付` 里含 `超付`：按子串匹配会把答反的回答判成对。"""
    assert contains_fact(answer, "超付") is False


def test_negation_does_not_swallow_affirmative_statement() -> None:
    """`超付 150 万，不得支付` 里 `不得` 在别处，不能连带把 `超付` 判成否定。"""
    assert contains_fact("本次申请超付 150 万元，不得支付", "超付") is True


def test_negative_needle_still_matches_itself() -> None:
    """判定词本身以否定词开头（`未超付`、`不得超过`）时不应被自己的前缀否掉。"""
    assert contains_fact("本次申请未超付", "未超付") is True
    assert contains_fact("发票总金额不得超过付款金额", "不得超过") is True


# ---------------------------------------------------------------------------
# 判定规格
# ---------------------------------------------------------------------------


def test_spec_reads_annotation_block() -> None:
    spec = spec_from_case(
        {
            "question": "q",
            "judge": {"all_of": ["A"], "any_of": ["B"], "none_of": ["C"], "expect_block": True, "rule": "R"},
        }
    )
    assert spec.all_of == ("A",)
    assert spec.any_of == ("B",)
    assert spec.none_of == ("C",)
    assert spec.expect_block is True
    assert spec.expected_rule == "R"
    assert spec.source == "annotation"


def test_spec_accepts_legacy_fields() -> None:
    """旧数据集只有 must_any / should_block，不能让它们静默变成"未标注"。"""
    spec = spec_from_case({"question": "q", "must_any": ["超付"], "should_block": True})
    assert spec.any_of == ("超付",)
    assert spec.expect_block is True
    assert spec.source == "annotation"


def test_spec_falls_back_to_numbers_in_standard_answer() -> None:
    """没有 judge 时只用标准答案里的数值兜底，并如实标注来源为 derived。"""
    spec = spec_from_case({"question": "q", "standard_answer": "剩余应付为 550 万元。"})
    assert spec.any_of == ("5500000",)
    assert spec.source == "derived"


def test_spec_marks_unjudgeable_case() -> None:
    """既没有 judge 也没有数值，必须标成 unjudged，而不是默认通过。"""
    spec = spec_from_case({"question": "q", "standard_answer": "按制度执行。"})
    assert spec.source == "unjudged"
    assert spec.any_of == ()


# ---------------------------------------------------------------------------
# 回答判定
# ---------------------------------------------------------------------------


def _run(spec: JudgeSpec, answer: str, *, conforms: bool = True, blocked: bool = False, rules=()) -> bool:
    return judge_answer(spec, answer, blocked=blocked, guard_conforms=conforms, violation_rules=rules).passed


def test_all_of_and_any_of_together() -> None:
    spec = JudgeSpec(all_of=("超付",), any_of=("5,500,000", "550 万"))
    assert _run(spec, "本次申请超付，剩余应付 550 万元") is True
    assert _run(spec, "本次申请超付，但金额未知") is False
    assert _run(spec, "未超付，剩余 550 万元") is False


def test_none_of_blocks_forbidden_phrase() -> None:
    spec = JudgeSpec(all_of=("不得",), none_of=("可以发起",))
    assert _run(spec, "已关闭，不得再发起付款申请") is True
    assert _run(spec, "已关闭，但可以发起新的付款申请") is False


def test_guard_failure_fails_case_even_if_wording_matches() -> None:
    """措辞命中不能抵消闸门失败：这正是"看起来对"的幻觉形态。"""
    spec = JudgeSpec(all_of=("超付",))
    assert _run(spec, "本次申请超付", conforms=False) is False
    assert _run(spec, "本次申请超付", blocked=True) is False


def test_expect_block_case_scores_on_being_blocked() -> None:
    spec = JudgeSpec(expect_block=True, expected_rule="PaymentWithinRemaining")
    assert _run(spec, "", conforms=False, blocked=True, rules=("PaymentWithinRemaining",)) is True
    assert _run(spec, "", conforms=False, blocked=True, rules=("OtherRule",)) is False
    assert _run(spec, "超付", conforms=True, blocked=False) is False


def test_reason_lists_missing_facts() -> None:
    verdict = judge_answer(JudgeSpec(all_of=("A", "B")), "只有 A", blocked=False, guard_conforms=True)
    assert any("B" in reason for reason in verdict.reasons)
    assert verdict.checks["facts_all"] is False


# ---------------------------------------------------------------------------
# 证据判定
# ---------------------------------------------------------------------------


def _judge() -> EvidenceJudge:
    return EvidenceJudge(
        expected=frozenset({"contract_policy#第三条"}),
        negative=frozenset({"contract_policy#第九条"}),
        doc_domains={"contract_policy": "contract", "carbon_standard": "carbon", "legacy_policy": "archive"},
        domain="contract",
    )


def test_evidence_labels() -> None:
    judge = _judge()
    assert judge.label("contract_policy#第三条") == "relevant"
    assert judge.label("contract_policy#第九条") == "dirty"  # 显式反例
    assert judge.label("carbon_standard#5.2") == "dirty"  # 跨域
    assert judge.label("legacy_policy#第二条") == "dirty"  # 已废止资料
    assert judge.label("contract_policy#第四条") == "unjudged"  # 同域未标注
    assert judge.label("unknown_doc#x") == "unjudged"  # 域未知


def test_unjudged_is_not_counted_as_clean_or_dirty() -> None:
    counts = _judge().counts(["contract_policy#第三条", "contract_policy#第四条", "carbon_standard#5.2"])
    assert counts == {"relevant": 1, "dirty": 1, "unjudged": 1}


def test_evidence_judge_for_reads_case() -> None:
    judge = evidence_judge_for(
        {"domain": "carbon", "expected_evidence": ["carbon_standard#5.2"], "unexpected_evidence": ["carbon_standard#5.4"]},
        {"carbon_standard": "carbon"},
    )
    assert judge.label("carbon_standard#5.2") == "relevant"
    assert judge.label("carbon_standard#5.4") == "dirty"


def test_ratio_returns_none_on_empty_denominator() -> None:
    """没有样本必须是 n/a，不能渲染成 0%——那会把"没测"说成"很干净"。"""
    assert ratio(0, 0) is None
    assert ratio(1, 4) == 0.25


# ---------------------------------------------------------------------------
# 汇总与渲染
# ---------------------------------------------------------------------------


def _case(cid: str, **kwargs) -> CaseResult:
    base = CaseResult(id=cid, domain="contract", question="q")
    for key, value in kwargs.items():
        setattr(base, key, value)
    return base


def test_summary_uses_micro_average_for_dirty_recall() -> None:
    """一条召回 1 个 chunk 全脏、一条召回 9 个全干净：微平均是 10%，宏平均会是 50%。"""
    results = [
        _case("a", relevant=0, dirty=1, retrieved=("x",), passed=True, guard_conforms=True),
        _case("b", relevant=9, dirty=0, retrieved=("y",), passed=True, guard_conforms=True),
    ]
    summary = summarize(results)
    assert summary.dirty_rate == pytest.approx(0.1)
    assert summary.relevant == 9
    assert summary.dirty == 1


def test_summary_excludes_expect_block_cases_from_hallucination() -> None:
    """对抗用例被阻断是期望结果，不能算成幻觉。"""
    results = [
        _case("adv", violations=2, blocked=True, expect_block=True),
        _case("normal", violations=1, blocked=True, guard_conforms=False),
    ]
    summary = summarize(results)
    assert summary.hallucination_violations == 1
    assert summary.cases_with_violation == 1


def test_summary_accuracy_and_failure_buckets() -> None:
    results = [
        _case("ok", passed=True, guard_conforms=True),
        _case("bad", passed=False, reasons=["facts:缺少 超付"]),
        _case("bad2", passed=False, reasons=["guard:SHACL 校验未通过"]),
    ]
    summary = summarize(results)
    assert summary.accuracy == pytest.approx(1 / 3)
    assert summary.failure_buckets["facts"] == 1
    assert summary.failure_buckets["guard"] == 1


def test_failed_case_keeps_batch_alive() -> None:
    """一条用例的后端异常必须落成结果行：整轮报告不能因此消失。"""
    broken = failed_case("bad", "contract", "q", "PoolClosed: pool closed")
    assert broken.status == "error"
    assert broken.passed is False
    assert broken.reasons == ["error:PoolClosed: pool closed"]

    summary = summarize([broken, _case("ok", passed=True, guard_conforms=True)])
    assert summary.accuracy == pytest.approx(0.5)
    assert summary.failure_buckets["error"] == 1


def test_no_guard_samples_is_not_reported_as_zero_violations() -> None:
    """链路全断时"0 违规"是没有样本，不是好成绩。"""
    broken = failed_case("a", "contract", "q", "boom")
    summary = summarize([broken])
    assert summary.guard_samples == 0
    text = render_markdown(summary, [broken], meta={}, thresholds={"accuracy": 0.92, "max_hallucination": 0})
    assert "n/a（无闸门样本）" in text


def test_summary_marks_missing_metrics_as_none() -> None:
    summary = summarize([_case("a", passed=True, guard_conforms=True)])
    assert summary.dirty_rate is None
    assert summary.evidence_recall is None
    assert summary.gold_coverage is None


def _report() -> tuple[object, list[CaseResult]]:
    results = [
        _case(
            "pay-over",
            passed=True,
            guard_conforms=True,
            relevant=2,
            dirty=1,
            retrieved=("contract_policy#第三条", "carbon_standard#5.2", "contract_policy#第四条"),
            dirty_rate=1 / 3,
            evidence_recall=1.0,
            gold_coverage=0.75,
            retrieval_ms=12.0,
            answer_ms=800.0,
            violations=0,
        ),
        _case(
            "closed-contract",
            passed=False,
            guard_conforms=False,
            blocked=True,
            violations=1,
            violation_rules=("PaymentWithinRemaining",),
            reasons=["guard:SHACL 校验未通过"],
        ),
    ]
    return summarize(results), results


def test_markdown_report_has_required_sections() -> None:
    summary, results = _report()
    text = render_markdown(
        summary,
        results,
        meta={"测试集": "qa_set.jsonl"},
        thresholds={"accuracy": 0.92, "max_dirty_recall": 0.05, "max_hallucination": 0},
    )
    for heading in ("# OntoRAG 离线评估报告", "## 1. 结论", "## 2. 指标明细", "## 3. 失败归因", "## 4. 逐用例结果"):
        assert heading in text
    assert "整体问答准确率" in text
    assert "脏召回率" in text
    assert "幻觉违规次数" in text
    assert "**未达标**" in text


def test_markdown_escapes_pipe_in_cell() -> None:
    """失败原因里带竖线会把表格列冲垮，必须转义。"""
    summary, results = _report()
    results[1].reasons = ["facts:a|b"]
    text = render_markdown(summary, results, meta={}, thresholds={"accuracy": 0.92})
    assert "a\\|b" in text


def test_markdown_renders_missing_metric_as_na() -> None:
    summary = summarize([_case("a", passed=True, guard_conforms=True)])
    text = render_markdown(summary, [_case("a", passed=True, guard_conforms=True)], meta={}, thresholds={"accuracy": 0.92})
    assert "n/a" in text


def test_markdown_discloses_offline_generator() -> None:
    """离线确定性生成器的分数不能冒充模型质量，报告必须显式声明。"""
    summary, results = _report()
    text = render_markdown(summary, results, meta={"生成器": "offline"}, thresholds={"accuracy": 0.92})
    assert "确定性离线生成器" in text
    online = render_markdown(summary, results, meta={"生成器": "deepseek"}, thresholds={"accuracy": 0.92})
    assert "确定性离线生成器" not in online


def test_section_numbering_has_no_gap() -> None:
    """某节被跳过时编号必须连续：断档会让人以为报告少了一段。"""
    summary, results = _report()
    text = render_markdown(summary, results, meta={}, thresholds={"accuracy": 0.92})
    numbers = [int(line.split(".")[0].lstrip("# ")) for line in text.splitlines() if line.startswith("## ")]
    assert numbers == list(range(1, len(numbers) + 1))
    assert "## 6." not in text


def test_section_numbering_with_warning_section() -> None:
    """有 derived 判定时必须出现"判定口径告警"，且后续章节顺延。"""
    summary, results = _report()
    results[0].judge_source = "derived"
    text = render_markdown(summary, results, meta={}, thresholds={"accuracy": 0.92})
    numbers = [int(line.split(".")[0].lstrip("# ")) for line in text.splitlines() if line.startswith("## ")]
    assert numbers == list(range(1, len(numbers) + 1))
    assert "判定口径告警" in text


def test_csv_round_trip() -> None:
    _, results = _report()
    rows = list(csv.reader(io.StringIO(render_csv(results))))
    assert rows[0][0] == "id"
    assert len(rows) == 3
    header = rows[0]
    record = dict(zip(header, rows[1], strict=True))
    assert record["id"] == "pay-over"
    assert record["passed"] == "1"
    assert record["dirty_rate"] == "0.3333"
    assert record["evidence_missing"] == ""
    # 未判定的指标必须留空，不能写成 0
    assert dict(zip(header, rows[2], strict=True))["dirty_rate"] == ""
