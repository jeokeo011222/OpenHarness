"""本体感知分块测试：按业务单元切、打本体标签、标记作废。"""

from __future__ import annotations

from datetime import date

from app.container import Container
from app.ontology.chunker import MAX_UNIT_CHARS, DocumentMeta

TEXT = """第一条 为规范付款管理，制定本办法。
第二条 付款申请须经部门负责人审批。
第三条 付款申请金额不得超过合同剩余应付金额，严禁超付。剩余应付 = 合同金额 ×（1 - 质保金比例）- 已付金额。
第四条 付款申请关联发票的合计金额不得超过本次付款申请金额，发票金额超过付款金额的属于链路不一致。
第五条 合同状态为已关闭的，不得再发起付款申请。
"""


def _meta(**overrides: object) -> DocumentMeta:
    """构造文档元数据。"""
    base: dict[str, object] = {
        "tenant_id": "demo",
        "doc_id": "test_policy",
        "title": "测试付款管理办法",
        "doc_type": "regulation",
        "version": "v1",
        "effective_from": date(2024, 1, 1),
        "effective_to": None,
        "superseded_by": None,
    }
    base.update(overrides)
    return DocumentMeta(**base)  # type: ignore[arg-type]


def test_splits_by_business_clause(container: Container) -> None:
    """一个条款一个 chunk，不按固定长度切。"""
    chunks = container.chunker.chunk(TEXT, _meta(), today=date(2024, 6, 1))
    assert len(chunks) == 5
    assert [chunk.clause_no for chunk in chunks] == ["第一条", "第二条", "第三条", "第四条", "第五条"]
    assert all("第三条" not in chunk.text for chunk in chunks[3:]), "条款不得跨块混入"


def test_tags_ontology_classes_and_properties(container: Container) -> None:
    """分块必须带本体标签，否则召回过滤无从判断兼容性。"""
    chunks = container.chunker.chunk(TEXT, _meta(), today=date(2024, 6, 1))
    third = next(chunk for chunk in chunks if chunk.clause_no == "第三条")
    assert any(iri.endswith("PaymentApplication") for iri in third.classes)
    assert any(iri.endswith("paymentAmount") for iri in third.properties)
    assert any(iri.endswith("contractAmount") for iri in third.properties)
    assert third.priority == 10


def test_archive_priority(container: Container) -> None:
    """来源权重标签按文档类型落位。"""
    chunks = container.chunker.chunk(TEXT, _meta(doc_type="archive"), today=date(2024, 6, 1))
    assert all(chunk.priority == 40 for chunk in chunks)


def test_superseded_document_marked_deprecated(container: Container) -> None:
    """版本检测：被替代的文档整篇标记作废。"""
    chunks = container.chunker.chunk(TEXT, _meta(superseded_by="v2"), today=date(2024, 6, 1))
    assert all(chunk.deprecated is True for chunk in chunks)


def test_expired_document_marked_deprecated(container: Container) -> None:
    """超出失效日期的文档标记作废。"""
    chunks = container.chunker.chunk(TEXT, _meta(effective_to=date(2023, 12, 31)), today=date(2024, 6, 1))
    assert all(chunk.deprecated is True for chunk in chunks)


def test_overlong_clause_splits_on_sentence_boundary(container: Container) -> None:
    """超长条款按句子断，不产生固定长度块，且保留同一 clause_no 前缀。"""
    sentence = "本条规定的付款申请应当经过财务复核并留存凭证。"
    body = "第三条 " + sentence * (MAX_UNIT_CHARS // len(sentence) + 5)
    chunks = container.chunker.chunk(body, _meta(), today=date(2024, 6, 1))
    assert len(chunks) > 1
    assert all(chunk.clause_no.startswith("第三条") for chunk in chunks)
    assert all(len(chunk.text) <= MAX_UNIT_CHARS + 60 for chunk in chunks)
