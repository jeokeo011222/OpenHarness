"""三个自定义工具的行为测试。

覆盖的都是"看起来通过、其实没生效"的失效模式：
租户图没注入、LIMIT 被调用方改大、多语句拼接、外键图越权、
Warning 被当成 Violation 拦掉、以及形状里出现编译器不认识的组件
却被静默跳过。
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient
from rdflib import Graph, Literal, URIRef

from app.container import Container
from app.errors import ShapeCompileError
from app.main import create_app
from app.ontology.model import CON
from app.settings import Settings
from app.shacl.compiler import ShapeCompiler
from app.shacl.engine import FusekiShaclEngine, LocalShaclEngine

DEMO_HEADERS = {"X-Tenant-Id": "demo", "X-Api-Key": "key-demo"}
PAY_IRI = "http://ontorag.local/tenant/demo/contract#PAY-1001"
CONTRACT_IRI = "http://ontorag.local/tenant/demo/contract#C-2024-001"


# ---------------------------------------------------------------------------
# SPARQL 工具
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "sparql",
    [
        "DELETE WHERE { ?s ?p ?o }",
        "INSERT DATA { <urn:a> <urn:b> <urn:c> }",
        "SELECT * WHERE { ?s ?p ?o }; DROP ALL",
        "ASK { ?s ?p ?o }",
        "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }",
        "SELECT * WHERE { GRAPH <urn:ontorag:tenant:other:graph> { ?s ?p ?o } }",
        "SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }",
        "SELECT * FROM <urn:ontorag:tenant:other:graph> WHERE { ?s ?p ?o }",
    ],
)
def test_sparql_rejects_dangerous_forms(settings: Settings, sparql: str) -> None:
    """写操作、多语句、形态越界、跨租户图一律 400。"""
    with TestClient(create_app(settings)) as client:
        response = client.post("/v1/tools/sparql", headers=DEMO_HEADERS, json={"sparql": sparql})
        assert response.status_code == 400, response.text
        assert response.json()["code"] == "invalid_query"


def test_sparql_injects_tenant_scope_without_where(settings: Settings) -> None:
    """没有 WHERE 关键字的查询也必须被注入租户图。

    这是最容易漏的一种绕过：只按 `WHERE` 找注入点时，`SELECT * { ... }`
    会退回"原样执行"，默认图是所有租户的并集。
    """
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/v1/tools/sparql",
            headers=DEMO_HEADERS,
            json={"sparql": "SELECT * { ?s ?p ?o }", "limit": 50},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert "FROM <urn:ontorag:tenant:demo:graph>" in body["query"]
        assert body["rows"]
        assert all("tenant/other" not in str(row) for row in body["rows"])


def test_sparql_rewrites_oversized_limit(settings: Settings) -> None:
    """调用方写的 LIMIT 不能超过服务端上限。"""
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/v1/tools/sparql",
            headers=DEMO_HEADERS,
            json={"sparql": "SELECT * WHERE { ?s ?p ?o } LIMIT 999999", "limit": 20},
        )
        assert response.status_code == 200, response.text
        assert response.json()["query"].rstrip().endswith("LIMIT 20")


def test_sparql_rejects_out_of_range_timeout(settings: Settings) -> None:
    """超时参数由 schema 限定上下界，调用方无法放大。"""
    with TestClient(create_app(settings)) as client:
        too_big = client.post(
            "/v1/tools/sparql",
            headers=DEMO_HEADERS,
            json={"sparql": "SELECT * WHERE { ?s ?p ?o }", "timeout_ms": 10_000_000},
        )
        assert too_big.status_code == 422


# ---------------------------------------------------------------------------
# SHACL 工具
# ---------------------------------------------------------------------------


def _bad_verdict_payload() -> dict[str, object]:
    return {
        "triples": [
            {
                "subject": PAY_IRI,
                "predicate": "con:paymentVerdict",
                "object": "within-remaining",
            },
            {
                "subject": PAY_IRI,
                "predicate": "doc:basedOnChunk",
                "object": "contract_policy#第三条",
            },
        ]
    }


def test_shacl_violation_blocks_with_report(settings: Settings) -> None:
    """错误结论 → 422，且把冲突规则与证据一起返回。"""
    with TestClient(create_app(settings)) as client:
        response = client.post("/v1/tools/shacl", headers=DEMO_HEADERS, json=_bad_verdict_payload())
        assert response.status_code == 422, response.text
        body = response.json()
        assert body["code"] == "ontology_guard_blocked"
        guard = body["details"]["guard"]
        assert guard["blocked"] is True
        assert "PaymentVerdictConsistency" in {item["rule"] for item in guard["violations"]}
        assert guard["engine"] == "pyshacl"


def test_shacl_warning_passes_and_is_reported(container: Container) -> None:
    """Warning 级冲突不阻断，只出现在 warnings 里。

    构造方式：把合同质保金改成 25%（超出 0–10% 常见区间），
    提示形状应当触发，但 `conforms` 保持 True。
    """
    data = Graph()
    for triple in container.graph.graph("urn:ontorag:tenant:demo:graph"):
        data.add(triple)
    contract = URIRef(CONTRACT_IRI)
    data.remove((contract, CON.retentionRate, None))
    data.add((contract, CON.retentionRate, Literal("0.25")))

    report = asyncio.run(container.validator.validate_async(data, []))
    assert report.conforms is True
    assert report.blocked is False
    assert report.counts.get("Warning", 0) >= 1
    assert any(item.rule == "RetentionRateAdvisory" for item in report.warnings)

    strict = asyncio.run(container.validator.validate_async(data, [], fail_on_warning=True))
    assert strict.blocked is True
    assert strict.policy == "strict"


def test_shacl_rejects_empty_triples_with_distinct_code(settings: Settings) -> None:
    """参数错误必须是 422 但不是闸门 code——两者后果完全不同。

    闸门阻断意味着"结论是错的，原样上报"；参数错误意味着"改参数重来"。
    如果两者共用 `ontology_guard_blocked`，调用方就无法区分。
    """
    with TestClient(create_app(settings)) as client:
        response = client.post("/v1/tools/shacl", headers=DEMO_HEADERS, json={"triples": []})
        assert response.status_code == 422, response.text
        body = response.json()
        assert body["code"] == "invalid_request"
        assert "guard" not in body.get("details", {})


def test_validator_can_switch_engine(settings: Settings, container: Container) -> None:
    """按请求切换引擎：指定 local 时报告里的 engine 必须是 pyshacl。"""
    validator = container.validator_for("local")
    assert isinstance(validator.engine, LocalShaclEngine)
    assert not isinstance(validator.engine, FusekiShaclEngine)


# ---------------------------------------------------------------------------
# 实体链接工具
# ---------------------------------------------------------------------------


def test_entity_link_normalizes_synonyms(settings: Settings) -> None:
    """口语词映射到本体 IRI，并标注抽取方式。"""
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/v1/tools/entity-link",
            headers=DEMO_HEADERS,
            json={"text": "请款单金额是否超过乙方合同剩余应付"},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        iris = {item["iri"] for item in body["mentions"] if item["iri"]}
        assert "http://ontorag.local/contract#PaymentApplication" in iris
        assert "http://ontorag.local/contract#Supplier" in iris
        # memory 模式没有模型网关，必须如实标注为纯词表
        assert body["extractor"] == "lexicon"
        assert all(item["confidence"] == 1.0 for item in body["mentions"] if item["iri"])


def test_entity_link_leaves_noise_unmapped(container: Container) -> None:
    """对不上的词不猜：align 返回 None，由调用方追问。"""
    aligned = container.linker.align("量子纠缠")
    assert aligned is None


# ---------------------------------------------------------------------------
# 形状编译
# ---------------------------------------------------------------------------


def test_all_project_shapes_compile(container: Container) -> None:
    """项目自带的每个形状都必须可编译，且两类严重级别都在。"""
    constraints = ShapeCompiler(container.ontology.claim_shapes, container.ontology).compile()
    severities = {item.severity for item in constraints}
    assert severities == {"Violation", "Warning"}
    assert len(constraints) >= 7


def test_unsupported_component_fails_closed(container: Container) -> None:
    """编译器不认识的组件必须报错，不能静默跳过。"""
    shapes = Graph()
    shapes.parse(
        data="""
        @prefix sh: <http://www.w3.org/ns/shacl#> .
        @prefix con: <http://ontorag.local/contract#> .
        con:BrokenShape a sh:NodeShape ;
            sh:targetClass con:Contract ;
            sh:property [
                sh:path con:contractAmount ;
                sh:node con:SomeOtherShape ;
            ] .
        """,
        format="turtle",
    )
    with pytest.raises(ShapeCompileError):
        ShapeCompiler(shapes, container.ontology).compile()
