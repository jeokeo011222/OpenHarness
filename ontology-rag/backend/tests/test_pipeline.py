"""主链路测试：检索权重、优先级、时效、审计与阻断。"""

from __future__ import annotations

import asyncio

from app.container import Container
from app.schemas import Chunk
from app.tenancy import TenantContext

CON = "http://ontorag.local/contract#"


def test_overpayment_answer_end_to_end(container: Container, tenant: TenantContext) -> None:
    """超付问题：答案、溯源、SPARQL 路径、审计四件套齐全。"""
    response = asyncio.run(container.pipeline.answer(tenant, "C-2024-001 这笔 700 万的付款申请是否超付？"))

    assert response.guard.conforms is True
    assert "PAY-1001" in response.answer
    assert "超付" in response.answer
    assert "5,500,000" in response.answer.replace("5,500,000.00", "5,500,000")

    # 证据必须命中"剩余应付"那条制度，而不是发票条款
    assert response.citations[0].chunk_id == "contract_policy#第三条"
    # SPARQL 路径必须可复核
    assert "SELECT" in response.sparql.query.upper()
    assert response.sparql.row_count >= 2
    # 权重必须与规范一致
    assert response.recall.weights == {"graph": 0.6, "keyword": 0.25, "vector": 0.15}
    assert response.claims, "结论不可为空，否则等于没有校验对象"


def test_identifier_narrowing_excludes_other_contracts(container: Container, tenant: TenantContext) -> None:
    """点名 C-2024-001 时，不应把 C-2024-002 的付款混进结论。"""
    response = asyncio.run(container.pipeline.answer(tenant, "C-2024-001 这笔 700 万的付款申请是否超付？"))
    assert "PAY-1001" in response.answer
    assert "PAY-1003" not in response.answer


def test_expired_and_deprecated_chunks_are_filtered(container: Container, tenant: TenantContext) -> None:
    """过期文档自动降权屏蔽；已废止文档永不进入证据。"""
    response = asyncio.run(container.pipeline.answer(tenant, "付款申请需要校验合同剩余应付吗"))
    ids = {citation.chunk_id for citation in response.citations}
    assert "legacy_policy#第二条" not in ids, "已废止文档不得作为证据"
    assert response.recall.dropped_deprecated >= 1


def test_history_query_can_include_archives(container: Container, tenant: TenantContext) -> None:
    """显式查询历史资料时，归档分块可进入候选（但废止的仍被剔除）。"""
    intent = asyncio.run(container.parser.parse("demo", "历史 旧版 付款审批流程是什么"))
    assert intent.filters.get("include_history") is True
    evidence, stats, _, _ = asyncio.run(container.retriever.retrieve(tenant, intent, top_k=5))
    ids = {item.chunk.chunk_id for item in evidence}
    assert "legacy_policy#第二条" not in ids
    assert stats.dropped_deprecated >= 1


def test_preview_returns_evidence_without_generation(container: Container, tenant: TenantContext) -> None:
    """只检索预览：有证据、有 SPARQL、无答案、无断言。

    这条用例是补的——重写编排层时 `preview()` 一度被整个漏掉，而当时
    没有任何测试引用它，于是 `/v1/query/preview` 静默 500、全量测试依然全绿。
    一个公开入口没有用例，等于它可以随时消失。
    """
    response = asyncio.run(
        container.pipeline.preview(tenant, "C-2024-001 这笔 700 万的付款申请是否超付？", top_k=5)
    )
    assert response.model == "retrieval-only"
    assert response.answer == "" and response.claims == []
    assert response.citations, "预览必须返回证据，否则它没有存在的意义"
    assert response.citations[0].chunk_id == "contract_policy#第三条"
    assert "SELECT" in response.sparql.query.upper()
    assert response.recall.after_filter >= 1
    # 预览不跑闸门：它不产出断言，也就没有可校验对象
    assert response.guard.conforms is True and response.guard.violations == []


def test_audit_record_is_complete(container: Container, tenant: TenantContext) -> None:
    """审计必须能回放到 query / 意图 / 召回 / SPARQL / 校验结论。"""
    response = asyncio.run(container.pipeline.answer(tenant, "C-2024-001 这笔 700 万的付款申请是否超付？"))
    record = asyncio.run(container.audit.get("demo", response.trace_id))
    assert record is not None
    assert record["tenant_id"] == "demo"
    assert record["question"].startswith("C-2024-001")
    assert record["guard_ok"] == 1
    assert record["sparql"] and "SELECT" in record["sparql"].upper()
    assert record["intent_json"] and record["recall_json"]


def test_dirty_recall_definition(container: Container, tenant: TenantContext) -> None:
    """脏召回判定：类不相交即剔除；向量召回无本体标签也剔除。"""
    retriever = container.retriever
    contract_chunk = Chunk(
        chunk_id="x#1",
        tenant_id="demo",
        doc_id="x",
        doc_title="测试",
        doc_type="regulation",
        clause_no="1",
        text="合同金额",
        classes=[CON + "Contract"],
        properties=[CON + "contractAmount"],
    )
    assert retriever._is_dirty(contract_chunk, {"Invoice"}, set(), "keyword") is True
    assert retriever._is_dirty(contract_chunk, {"Contract"}, set(), "keyword") is False

    untagged = contract_chunk.model_copy(update={"classes": [], "properties": []})
    assert retriever._is_dirty(untagged, {"Contract"}, set(), "vector") is True
    assert retriever._is_dirty(untagged, {"Contract"}, set(), "keyword") is False


def test_tenant_isolation_on_evidence(container: Container, tenant: TenantContext, tenant_other: TenantContext) -> None:
    """other 租户只能看到自己的分块。"""
    own = asyncio.run(container.chunks.list_all(tenant_other.tenant_id))
    assert {chunk.chunk_id for chunk in own} == {"other_policy#第一条"}
    demo_chunks = asyncio.run(container.chunks.list_all(tenant.tenant_id))
    assert all(chunk.tenant_id == "demo" for chunk in demo_chunks)
