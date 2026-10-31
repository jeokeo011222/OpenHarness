"""三级混合检索的验收测试：规划、兼容性、触发门槛、排序与租户隔离。

这些用例锁的是**行为契约**，不是实现细节：
  * 图谱先行——第一级命中必须构成排序主体；
  * 向量是判定触发，不是默认执行；
  * 不兼容分块必须在召回后被丢弃，且丢了多少要能看见；
  * 同一输入两次运行得到同一份证据。
"""

from __future__ import annotations

import asyncio
from datetime import date

import pytest

from app.container import Container
from app.retrieval import (
    ConstraintRef,
    EntityRef,
    OntologyCompatibility,
    SparqlPlanner,
    StructuredQuery,
    TimeRange,
    known_names,
)
from app.tenancy import TenantContext

CON = "http://ontorag.local/contract#"
CAR = "http://ontorag.local/carbon#"


def _payment_query(**overrides: object) -> StructuredQuery:
    payload: dict[str, object] = {
        "raw": "C-2024-001 这笔 700 万的付款申请是否超付？",
        "domain": "contract",
        "entities": [EntityRef(iri=CON + "PaymentApplication", kind="class")],
        "constraints": [ConstraintRef(name="PaymentWithinRemaining")],
        "identifiers": ["C-2024-001"],
    }
    payload.update(overrides)
    return StructuredQuery.model_validate(payload)


# ------------------------------ SPARQL 规划 ------------------------------


def test_planner_builds_type_values_not_intersection(container: Container) -> None:
    """多类必须是"属于其中之一"（VALUES + ?type），不能写成"同时属于所有类"。"""
    planner = SparqlPlanner(container.ontology)
    planned = planner.plan(_payment_query())
    assert planned is not None
    sparql = planned.sparql
    assert "VALUES ?type" in sparql
    assert "?entity a ?type ." in sparql
    # 若退化成多个 `?entity a <C>`，多类查询会永远返回空结果
    assert sparql.count("?entity a <") == 0


def test_planner_projects_constraint_properties(container: Container) -> None:
    """约束隐含属性必须被投影：没有它们，兼容性判定少一整个维度。"""
    planner = SparqlPlanner(container.ontology)
    planned = planner.plan(_payment_query())
    assert planned is not None
    assert set(planned.projected) == {
        "v_paymentAmount",
        "v_contractAmount",
        "v_paidAmount",
        "v_retentionRate",
    }
    assert "OPTIONAL" in planned.sparql
    assert planned.sparql.rstrip().endswith(f"LIMIT {planner.max_rows}")


def test_planner_uses_values_for_individuals(container: Container) -> None:
    """点名实例时直接 VALUES 锚定，不再附加类型过滤（避免类型写法差异导致空结果）。"""
    planner = SparqlPlanner(container.ontology)
    query = StructuredQuery(
        raw="PAY-1001 是否超付",
        entities=[EntityRef(iri="http://ontorag.local/tenant/demo/contract#PAY-1001", kind="individual")],
    )
    planned = planner.plan(query)
    assert planned is not None
    assert "VALUES ?entity" in planned.sparql
    assert "?entity a ?type" not in planned.sparql


def test_planner_returns_none_without_entity_space(container: Container) -> None:
    """没有实体空间就不是"查到了 0 条"，而是"没查"——必须能区分。"""
    planner = SparqlPlanner(container.ontology)
    assert planner.plan(StructuredQuery(raw="随便问问")) is None
    unknown = StructuredQuery(
        raw="随便问问", entities=[EntityRef(iri=CON + "NoSuchClass", kind="class")]
    )
    # 不猜命名空间：拼一个不存在的 IRI 只会把"类名写错"伪装成"库里没有数据"
    assert planner.plan(unknown) is None


def test_planner_falls_back_to_constraint_target_class(container: Container) -> None:
    """类名写错但约束认得时，用约束目标类兜底，并留下可追溯的 note。"""
    planner = SparqlPlanner(container.ontology)
    query = StructuredQuery(
        raw="是否超付",
        entities=[EntityRef(iri=CON + "NoSuchClass", kind="class")],
        constraints=[ConstraintRef(name="PaymentWithinRemaining")],
    )
    planned = planner.plan(query)
    assert planned is not None
    assert planned.target_classes == ("PaymentApplication",)
    assert any(note.startswith("class-from-constraint:") for note in planned.notes)


def test_planner_adds_constraint_target_class_alongside_explicit_entity(container: Container) -> None:
    """约束的主体类必须与点名类并列，不能只取其一。

    问"核算边界是否冲突"时点名的是 AccountingBoundary，而冲突发生在
    EmissionSource 上；只取点名类就取不到冲突证据，结论会退化成规定复述。
    """
    planner = SparqlPlanner(container.ontology)
    query = StructuredQuery(
        raw="S-BOILER 的核算边界是否冲突？",
        domain="carbon",
        entities=[EntityRef(iri=CAR + "AccountingBoundary", kind="class")],
        constraints=[ConstraintRef(name="EmissionSourceSingleBoundary")],
    )
    planned = planner.plan(query)
    assert planned is not None
    assert set(planned.target_classes) == {"AccountingBoundary", "EmissionSource"}


def test_planner_infers_subject_class_from_property_domain(container: Container) -> None:
    """只点了属性（"合同金额"）时，用 rdfs:domain 推出主体类，而不是放弃图谱通道。"""
    planner = SparqlPlanner(container.ontology)
    query = StructuredQuery(
        raw="C-2024-001 的合同金额是多少？",
        entities=[EntityRef(iri=CON + "contractAmount", kind="property")],
        identifiers=["C-2024-001"],
    )
    planned = planner.plan(query)
    assert planned is not None
    assert planned.target_classes == ("Contract",)
    assert any(note.startswith("class-from-domain:") for note in planned.notes)


def test_planner_casts_time_to_xsd_date(container: Container) -> None:
    """时间比较必须先转 xsd:date：直接比 dateTime 与 date 会静默丢行。"""
    planner = SparqlPlanner(container.ontology)
    query = StructuredQuery(
        raw="2024 年签订的合同",
        entities=[EntityRef(iri=CON + "Contract", kind="class")],
        time_range=TimeRange(start=date(2024, 1, 1), end=date(2024, 12, 31), field="con:signedAt"),
    )
    planned = planner.plan(query)
    assert planned is not None
    assert planned.temporal_property == "signedAt"
    assert "xsd:date(?time_value)" in planned.sparql
    assert '"2024-01-01"^^xsd:date' in planned.sparql
    # 类型不对的字面量要稳定判假，而不是让整条表达式求值失败
    assert "datatype(?time_value) IN (xsd:date, xsd:dateTime)" in planned.sparql


def test_planner_discloses_unbound_time_range(container: Container) -> None:
    """时间范围无法落到具体属性时，宁可不过滤也要显式披露。"""
    planner = SparqlPlanner(container.ontology)
    query = StructuredQuery(
        raw="近一年的合同",
        entities=[EntityRef(iri=CON + "Contract", kind="class")],
        time_range=TimeRange(start=date(2025, 1, 1)),
    )
    planned = planner.plan(query)
    assert planned is not None
    assert "time-range-unbound" in planned.notes
    assert "?time_value" not in planned.sparql


def test_unknown_constraint_is_disclosed_not_ignored(container: Container) -> None:
    """未登记的约束名不能被当成"没有约束"。"""
    planner = SparqlPlanner(container.ontology)
    query = StructuredQuery(
        raw="超付",
        entities=[EntityRef(iri=CON + "Contract", kind="class")],
        constraints=[ConstraintRef(name="NotRegisteredShape")],
    )
    assert query.unknown_constraints() == ("NotRegisteredShape",)
    planned = planner.plan(query)
    assert planned is not None
    assert any(note.startswith("unknown-constraint:") for note in planned.notes)


def test_constraint_registry_covers_project_shapes(container: Container) -> None:
    """注册表里登记的形状必须在真实本体里存在，否则等于约束从未生效。"""
    from rdflib import URIRef
    from rdflib.namespace import RDF
    from app.ontology.model import SH

    declared = {
        str(subject).rsplit("#", 1)[-1]
        for subject in container.ontology.shapes.subjects(RDF.type, SH.NodeShape)
    }
    missing = [name for name in known_names() if name not in declared]
    assert missing == []
    assert URIRef(CON + "PaymentWithinRemaining") in set(
        container.ontology.shapes.subjects(RDF.type, SH.NodeShape)
    )


# ------------------------------ 本体兼容性 ------------------------------


@pytest.mark.parametrize(
    ("chunk_classes", "chunk_properties", "query_classes", "query_properties", "tier", "expected"),
    [
        # 只有公共根类不算相关，否则过滤等于没做
        (["Contract"], [], ["Invoice"], [], "keyword", False),
        (["PaymentApplication"], [], ["Contract"], [], "keyword", False),
        # 父子类可比较
        (["ContractClause"], [], ["Clause"], [], "keyword", True),
        # 只打属性标签时用 rdfs:domain 搭桥
        ([], ["contractAmount"], ["Contract"], [], "keyword", True),
        ([], ["contractAmount"], ["Invoice"], [], "keyword", False),
        # 互逆属性等价（appliesToContract / hasPaymentApplication）
        ([], ["appliesToContract"], [], ["hasPaymentApplication"], "keyword", True),
        # 无标签分块：向量通道丢弃，关键词通道保留（原文命中本身就是证据）
        ([], [], ["Contract"], [], "vector", False),
        ([], [], ["Contract"], [], "keyword", True),
        # 图谱命中由事实链支撑，不参与标签判定
        (["Invoice"], [], ["Contract"], [], "graph", True),
        # 查询没有本体条件时不能凭空判脏
        (["Invoice"], [], [], [], "keyword", True),
    ],
)
def test_compatibility_verdicts(
    container: Container,
    chunk_classes: list[str],
    chunk_properties: list[str],
    query_classes: list[str],
    query_properties: list[str],
    tier: str,
    expected: bool,
) -> None:
    compat: OntologyCompatibility = container.retriever.service.compat
    verdict = compat.check(
        chunk_classes=[CON + item for item in chunk_classes],
        chunk_properties=[CON + item for item in chunk_properties],
        query_classes=query_classes,
        query_properties=query_properties,
        tier=tier,
    )
    assert verdict.compatible is expected, verdict.reason


def test_compatibility_reason_is_explained(container: Container) -> None:
    """结论必须带可读依据，否则审计里只有 True/False，无法复核。"""
    compat: OntologyCompatibility = container.retriever.service.compat
    verdict = compat.check(
        chunk_classes=[CON + "ContractClause"],
        chunk_properties=[],
        query_classes={"Clause"},
        query_properties=set(),
        tier="keyword",
    )
    assert verdict.reason.startswith("class-hierarchy:")


# ------------------------------ 三级执行顺序 ------------------------------


def test_graph_tier_leads_the_ranking(container: Container, tenant: TenantContext) -> None:
    """第一级命中必须是排序主体：图谱证据排在关键词证据之前。"""
    result = asyncio.run(container.retriever.service.retrieve(tenant, _payment_query(), top_k=5))
    assert result.items, "超付问题必须能召回到制度条款"
    top = result.items[0]
    assert top.chunk.chunk_id == "contract_policy#第三条"
    assert "graph" in top.matched_on
    assert top.breakdown["graph"] > 0
    assert result.tiers[0].tier == "graph" and result.tiers[0].executed


def test_every_item_carries_full_score_breakdown(container: Container, tenant: TenantContext) -> None:
    """排序要可解释：每个分块都要能回答"这个分数是怎么来的"。"""
    result = asyncio.run(container.retriever.service.retrieve(tenant, _payment_query(), top_k=5))
    for item in result.items:
        assert {"base", "doc_weight", "ontology_factor"} <= set(item.breakdown)
        assert item.reason, "兼容性结论不能为空"


def test_results_are_sorted_desc_by_final_score(container: Container, tenant: TenantContext) -> None:
    result = asyncio.run(container.retriever.service.retrieve(tenant, _payment_query(), top_k=5))
    scores = [item.weighted_score for item in result.items]
    assert scores == sorted(scores, reverse=True)


def test_vector_skipped_when_first_two_tiers_sufficient(
    container: Container, tenant: TenantContext
) -> None:
    """图谱+关键词已充足时，向量不应触发（避免语义漂移且省一次调用）。"""
    result = asyncio.run(container.retriever.service.retrieve(tenant, _payment_query(), top_k=3))
    assert result.stats.vector_triggered is False
    assert result.stats.tier_decisions["vector"].startswith("skipped:sufficient")


def test_vector_triggered_when_first_two_tiers_empty(
    container: Container, tenant: TenantContext
) -> None:
    """前两级都空时向量必须补位——这是"仅作补充"的正面证明。"""
    query = StructuredQuery(
        raw="zzz 无任何匹配的文本 qqq",
        domain="contract",
        entities=[EntityRef(iri=CON + "Supplier", kind="class")],
    )
    result = asyncio.run(container.retriever.service.retrieve(tenant, query, top_k=3))
    # 图谱确实查了，但没有任何分块挂在这些实体上——"查过但没证据"与"没查"要能区分
    assert result.stats.tier_decisions["graph"].startswith("planned")
    assert "no-chunk-link" in result.stats.tier_decisions["graph"]
    assert result.stats.tier_decisions["vector"].startswith("executed")
    assert result.stats.per_tier.get("graph", 0) == 0


def test_identifier_narrowing_excludes_unrelated_entities(
    container: Container, tenant: TenantContext
) -> None:
    """点名 C-2024-001 时，指向 C-2024-002 的付款单不得进入图谱证据链。"""
    result = asyncio.run(container.retriever.service.retrieve(tenant, _payment_query(), top_k=8))
    assert result.seeds, "应能定位到付款单"
    assert all("PAY-1003" not in seed for seed in result.seeds)
    assert "identifier-unmatched" not in result.stats.tier_decisions["graph"]


def test_incompatible_chunks_are_dropped_after_recall(
    container: Container, tenant: TenantContext
) -> None:
    """召回后必须按本体兼容性丢弃：跨域分块即便关键词命中也不能进证据。"""
    query = StructuredQuery(
        raw="合同金额 排放量 核算因子 是否匹配",
        domain="carbon",
        entities=[EntityRef(iri=CAR + "EmissionRecord", kind="class")],
        constraints=[ConstraintRef(name="EmissionAmountMatchesFactor")],
    )
    result = asyncio.run(container.retriever.service.retrieve(tenant, query, top_k=5))
    ids = [item.chunk.chunk_id for item in result.items]
    assert ids == ["carbon_standard#5.2"], ids
    assert result.stats.dropped_dirty >= 1
    assert result.stats.dirty_recall_rate > 0


def test_no_entity_space_returns_nothing_and_says_so(
    container: Container, tenant: TenantContext
) -> None:
    """结构化查询没有实体时，图谱通道显式跳过，而不是拿全库标签凑数。"""
    query = StructuredQuery(raw="完全无法解析的输入")
    result = asyncio.run(container.retriever.service.retrieve(tenant, query, top_k=3))
    assert result.stats.tier_decisions["graph"] == "skipped:no-entity-space"
    assert result.trace.query == ""
    assert result.items == []


def test_stats_disclose_weights_and_gate_reasons(container: Container, tenant: TenantContext) -> None:
    """权重与门槛判定必须写进统计，审计才能复盘"当时为什么这么排"。"""
    result = asyncio.run(container.retriever.service.retrieve(tenant, _payment_query(), top_k=5))
    stats = result.stats
    assert stats.weights == {"graph": 0.6, "keyword": 0.25, "vector": 0.15}
    assert set(stats.tier_decisions) == {"graph", "keyword", "vector"}
    assert stats.graph_seeds >= 1
    assert stats.best_score > 0


def test_retrieval_is_deterministic(container: Container, tenant: TenantContext) -> None:
    """同一输入必须得到同一份证据与同一顺序，否则评估结果不可复现。"""
    first = asyncio.run(container.retriever.service.retrieve(tenant, _payment_query(), top_k=5))
    second = asyncio.run(container.retriever.service.retrieve(tenant, _payment_query(), top_k=5))
    assert first.chunk_ids() == second.chunk_ids()
    assert [item.weighted_score for item in first.items] == [
        item.weighted_score for item in second.items
    ]


def test_tenant_isolation_of_evidence(
    container: Container, tenant: TenantContext, tenant_other: TenantContext
) -> None:
    """向量/关键词/图谱都不能把别的租户的证据带进来。"""
    query = _payment_query(identifiers=[])
    own = asyncio.run(container.retriever.service.retrieve(tenant, query, top_k=8))
    other = asyncio.run(container.retriever.service.retrieve(tenant_other, query, top_k=8))
    assert all(item.chunk.tenant_id == "demo" for item in own.items)
    assert all(item.chunk.tenant_id == "other" for item in other.items)
    assert {item.chunk.chunk_id for item in other.items} <= {"other_policy#第一条"}


def test_deprecated_and_expired_chunks_never_become_evidence(
    container: Container, tenant: TenantContext
) -> None:
    """废止与过期分块在排序阶段之前就被剔除，且剔除数量可观测。"""
    result = asyncio.run(container.retriever.service.retrieve(tenant, _payment_query(), top_k=8))
    ids = {item.chunk.chunk_id for item in result.items}
    assert "legacy_policy#第二条" not in ids
    assert "contract_policy#旧版说明" not in ids
    assert result.stats.dropped_deprecated >= 1
    assert result.stats.dropped_expired >= 1
