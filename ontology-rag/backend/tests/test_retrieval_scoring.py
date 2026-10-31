"""打分函数单测：纯函数，零外部依赖。

这些断言锁的是**排序语义**，不是具体数字。数字会随调参变化，
"向量不能反超图谱""文档优先级只乘一次""饱和函数对离群不敏感"这些性质不能变。
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.retrieval.scoring import (
    ScoringConfig,
    doc_weight,
    finalize,
    fuse,
    graph_score,
    keyword_score,
    ontology_factor,
    ontology_overlap,
    saturate,
    term_coverage,
    vector_score,
)
from app.schemas import Chunk

CONFIG = ScoringConfig()
TODAY = date(2026, 10, 31)


def _chunk(**kwargs: object) -> Chunk:
    payload: dict[str, object] = {
        "chunk_id": "doc#1",
        "tenant_id": "demo",
        "doc_id": "doc",
        "doc_title": "测试文档",
        "doc_type": "regulation",
        "clause_no": "1",
        "text": "付款申请金额不得超过合同剩余应付金额。",
        "priority": 10,
    }
    payload.update(kwargs)
    return Chunk.model_validate(payload)


# ------------------------------ 基础变换 ------------------------------


def test_saturate_is_monotonic_and_bounded() -> None:
    """饱和函数必须单调、有界、过半点取 0.5——否则调参无法推断。"""
    assert saturate(0.0, 6.0) == 0.0
    assert saturate(-5.0, 6.0) == 0.0
    assert saturate(6.0, 6.0) == pytest.approx(0.5)
    assert saturate(1.0, 6.0) < saturate(6.0, 6.0) < saturate(60.0, 6.0)
    assert saturate(1e9, 6.0) < 1.0


def test_saturate_does_not_collapse_on_outlier() -> None:
    """离群值不能把其余候选压平——这是不用 x/max 归一的直接原因。"""
    outlier = saturate(100.0, 6.0)
    typical = saturate(6.0, 6.0)
    max_normalized_typical = 6.0 / 100.0
    assert typical > max_normalized_typical
    assert outlier - typical < 0.5


# ------------------------------ 通道分数 ------------------------------


def test_graph_score_prefers_near_evidence_and_complete_facts() -> None:
    """路径越短、约束属性取得越全，图谱分越高。"""
    assert graph_score(0, 1.0) > graph_score(1, 1.0) > graph_score(2, 1.0)
    assert graph_score(1, 1.0) > graph_score(1, 0.25)
    assert graph_score(None, 0.5) == pytest.approx(0.70 * 0.75 + 0.30 * 0.5)


def test_term_coverage_matches_chinese_substring() -> None:
    """中文按子串计覆盖：'付款申请' 必须命中含 '付款申请金额' 的条款。"""
    text = "付款申请金额不得超过合同剩余应付金额。"
    assert term_coverage(text, ["付款申请", "合同"]) == 1.0
    assert term_coverage(text, ["付款申请", "发票"]) == 0.5
    assert term_coverage(text, []) == 0.0


def test_keyword_score_rewards_rank_and_coverage() -> None:
    strong = keyword_score(20.0, 1.0, CONFIG)
    weak = keyword_score(1.0, 0.2, CONFIG)
    assert strong > weak
    assert 0.0 <= weak < strong <= 1.0


def test_vector_score_floors_noise_and_discounts() -> None:
    """低于基线的相似度一律 0；高于基线要打折，保证向量是补充而非主力。"""
    assert vector_score(0.10, CONFIG) == 0.0
    assert vector_score(CONFIG.vector_floor, CONFIG) == 0.0
    mid = vector_score(0.60, CONFIG)
    high = vector_score(0.95, CONFIG)
    assert 0.0 < mid < high <= CONFIG.vector_trust
    assert high < 1.0


def test_vector_cannot_outrank_graph_at_equal_intrinsic_score() -> None:
    """同为满分时，向量贡献必须小于图谱——"向量只作补充"的量化保证。"""
    graph_total, _ = fuse([("graph", 1.0)], CONFIG)
    vector_total, _ = fuse([("vector", 1.0)], CONFIG)
    assert vector_total < graph_total


# ------------------------------ 融合 ------------------------------


def test_fuse_weights_follow_settings() -> None:
    total, breakdown = fuse([("graph", 1.0)], CONFIG)
    assert total == pytest.approx(CONFIG.weight_graph)
    assert breakdown["graph"] == pytest.approx(CONFIG.weight_graph)


def test_cross_validation_bonus_is_smaller_than_any_weight() -> None:
    """多通道命中的加分必须小于任一单通道权重，否则排序会被命中次数支配。"""
    single, _ = fuse([("graph", 0.5)], CONFIG)
    both, breakdown = fuse([("graph", 0.5), ("keyword", 0.5)], CONFIG)
    assert both > single
    assert breakdown["cross_validation"] < CONFIG.weight_graph
    assert breakdown["cross_validation"] < CONFIG.weight_keyword


def test_fuse_is_capped_at_one() -> None:
    total, _ = fuse([("graph", 1.0), ("keyword", 1.0), ("vector", 1.0)], CONFIG)
    assert total <= 1.0


# ------------------------------ 业务加权 ------------------------------


def test_ontology_overlap_counts_properties_half() -> None:
    overlap = ontology_overlap(
        ["http://x#Contract", "http://x#PaymentApplication"],
        ["http://x#contractAmount", "http://x#paidAmount"],
        {"Contract"},
        {"contractAmount"},
    )
    assert overlap == pytest.approx(1.5)


def test_ontology_factor_is_capped() -> None:
    """标签堆叠不能无限加成——否则长分块靠标签多就能反超。"""
    many = ontology_factor(100.0, CONFIG)
    capped = ontology_factor(CONFIG.ontology_overlap_cap, CONFIG)
    assert many == pytest.approx(capped)


def test_document_priority_is_applied_exactly_once() -> None:
    """优先级只乘一次：finalize 结果 = base × 优先级权重，不是平方。"""
    chunk = _chunk(priority=40)
    score, detail = finalize(0.5, overlap=0.0, chunk=chunk, today=TODAY, config=CONFIG)
    assert detail["doc_weight"] == pytest.approx(CONFIG.priority_weights[40])
    assert score == pytest.approx(0.5 * CONFIG.priority_weights[40])


def test_priority_order_matches_document_type() -> None:
    """现行制度 > 合同台账 > 国标 > 历史资料。"""
    weights = [
        doc_weight(priority, TODAY, None, CONFIG) for priority in (10, 20, 30, 40)
    ]
    assert weights == sorted(weights, reverse=True)
    assert weights[0] > weights[-1]


def test_freshness_penalty_only_inside_window() -> None:
    """临期降权只作用于窗口内，且不排除（排除是时效过滤的职责）。"""
    soon = _chunk(effective_to=TODAY + timedelta(days=5))
    later = _chunk(effective_to=TODAY + timedelta(days=365))
    assert doc_weight(10, TODAY, soon.effective_to, CONFIG) < doc_weight(10, TODAY, later.effective_to, CONFIG)
    assert doc_weight(10, TODAY, soon.effective_to, CONFIG) == pytest.approx(1.0 - CONFIG.freshness_penalty)


def test_freshness_penalty_does_not_change_priority_ordering() -> None:
    """临期制度仍然高于历史资料：降权是微调，不是重排。"""
    soon_regulation = doc_weight(10, TODAY, TODAY + timedelta(days=3), CONFIG)
    archive = doc_weight(40, TODAY, None, CONFIG)
    assert soon_regulation > archive


def test_finalize_combines_overlap_and_priority() -> None:
    chunk = _chunk(priority=10)
    plain, _ = finalize(0.4, overlap=0.0, chunk=chunk, today=TODAY, config=CONFIG)
    boosted, detail = finalize(0.4, overlap=2.0, chunk=chunk, today=TODAY, config=CONFIG)
    assert boosted > plain
    assert detail["ontology_factor"] == pytest.approx(1.0 + CONFIG.ontology_bonus * 2.0)
