"""SHACL 闸门测试：证明约束真的会拦下错误结论，而不是只写在文档里。"""

from __future__ import annotations

import asyncio

from rdflib import Graph, Namespace
from rdflib.namespace import XSD

from app.container import Container
from app.schemas import Claim
from app.tenancy import TenantContext

CON = Namespace("http://ontorag.local/contract#")
CAR = Namespace("http://ontorag.local/carbon#")

PAY_1001 = "http://ontorag.local/tenant/demo/contract#PAY-1001"
PAY_1002 = "http://ontorag.local/tenant/demo/contract#PAY-1002"
SOURCE = "http://ontorag.local/tenant/demo/carbon#S-BOILER"


def _facts(container: Container, tenant: TenantContext, subjects: list[str]) -> Graph:
    """取测试所需的租户事实子图。"""
    from app.pipeline.guard import fetch_context_graph

    return asyncio.run(fetch_context_graph(container.graph, tenant.graph_uri, subjects))


def test_data_quality_catches_overpayment(container: Container, tenant: TenantContext) -> None:
    """存量数据质检：PAY-1001 超付必须被 PaymentWithinRemaining 抓到。"""
    report = container.validator.validate_dataset(container.graph.graph(tenant.graph_uri))
    rules = {violation.rule for violation in report.violations}
    assert report.conforms is False
    assert "PaymentWithinRemaining" in rules
    assert "InvoiceTotalWithinPayment" in rules


def test_claim_wrong_verdict_is_blocked(container: Container, tenant: TenantContext) -> None:
    """错误结论（把超付说成未超付）必须阻断，并指出冲突规则。"""
    facts = _facts(container, tenant, [PAY_1001])
    claims = [
        Claim(subject=PAY_1001, predicate="con:paymentVerdict", object="within-remaining"),
        Claim(subject=PAY_1001, predicate="doc:basedOnChunk", object="contract_policy#第三条"),
    ]
    report = asyncio.run(container.validator.validate_async(facts, claims))
    assert report.conforms is False
    rules = {violation.rule for violation in report.violations}
    assert "PaymentVerdictConsistency" in rules
    violation = next(v for v in report.violations if v.rule == "PaymentVerdictConsistency")
    assert violation.focus_node == PAY_1001
    assert "5,500,000" in violation.message or "5500000" in violation.message


def test_claim_correct_verdict_passes(container: Container, tenant: TenantContext) -> None:
    """正确结论必须放行，否则系统会退化成"什么都不答"。"""
    facts = _facts(container, tenant, [PAY_1001, PAY_1002])
    claims = [
        Claim(subject=PAY_1001, predicate="con:paymentVerdict", object="exceeds-remaining"),
        Claim(subject=PAY_1002, predicate="con:paymentVerdict", object="within-remaining"),
        Claim(subject=PAY_1001, predicate="doc:basedOnChunk", object="contract_policy#第三条"),
        Claim(subject=PAY_1002, predicate="doc:basedOnChunk", object="contract_policy#第三条"),
    ]
    report = asyncio.run(container.validator.validate_async(facts, claims))
    assert report.conforms is True, [v.message for v in report.violations]
    assert report.checked_triples > 0


def test_verdict_without_evidence_is_blocked(container: Container, tenant: TenantContext) -> None:
    """结论必须可溯源：缺 doc:basedOnChunk 直接阻断。"""
    facts = _facts(container, tenant, [PAY_1001])
    claims = [Claim(subject=PAY_1001, predicate="con:paymentVerdict", object="exceeds-remaining")]
    report = asyncio.run(container.validator.validate_async(facts, claims))
    assert report.conforms is False
    assert any(violation.rule == "VerdictRequiresEvidence" for violation in report.violations)


def test_fabricated_subject_is_blocked(container: Container, tenant: TenantContext) -> None:
    """凭空构造的主语必须被结构校验挡住。"""
    facts = _facts(container, tenant, [PAY_1001])
    ghost = "http://ontorag.local/tenant/demo/contract#PAY-FAKE"
    claims = [Claim(subject=ghost, predicate="con:paymentAmount", object=100, datatype="decimal")]
    report = asyncio.run(container.validator.validate_async(facts, claims))
    assert report.conforms is False
    assert any(violation.rule == "unresolved-subject" for violation in report.violations)


def test_unknown_predicate_is_blocked(container: Container, tenant: TenantContext) -> None:
    """未建模的关系不允许作为结论谓词。"""
    facts = _facts(container, tenant, [PAY_1001])
    claims = [Claim(subject=PAY_1001, predicate="con:secretRebate", object="30%")]
    report = asyncio.run(container.validator.validate_async(facts, claims))
    assert report.conforms is False
    assert any(violation.rule == "unknown-predicate" for violation in report.violations)


def test_carbon_boundary_verdict_conflict_blocked(container: Container, tenant: TenantContext) -> None:
    """S-BOILER 实际归属两个互斥边界，断言 exclusive 必须被拦。"""
    facts = _facts(container, tenant, [SOURCE])
    claims = [
        Claim(subject=SOURCE, predicate="car:boundaryVerdict", object="exclusive"),
        Claim(subject=SOURCE, predicate="doc:basedOnChunk", object="carbon_standard#5.4"),
    ]
    report = asyncio.run(container.validator.validate_async(facts, claims))
    assert report.conforms is False
    assert any(violation.rule == "BoundaryVerdictConsistency" for violation in report.violations)


def test_emission_claim_must_be_recomputable(container: Container, tenant: TenantContext) -> None:
    """声称的排放量必须能由活动数据 × 因子复算。"""
    record = "http://ontorag.local/tenant/demo/carbon#R-2024-001"
    facts = _facts(container, tenant, [record])
    good = [Claim(subject=record, predicate="car:claimedEmission", object=2630, datatype="decimal")]
    bad = [Claim(subject=record, predicate="car:claimedEmission", object=9999, datatype="decimal")]
    assert asyncio.run(container.validator.validate_async(facts, good)).conforms is True
    report = asyncio.run(container.validator.validate_async(facts, bad))
    assert report.conforms is False
    assert any(violation.rule == "EmissionClaimConsistency" for violation in report.violations)
