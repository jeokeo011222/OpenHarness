"""HTTP 层测试：鉴权、问答、钩子、工具与跨租户拒绝。"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings

DEMO_HEADERS = {"X-Tenant-Id": "demo", "X-Api-Key": "key-demo"}
OTHER_HEADERS = {"X-Tenant-Id": "other", "X-Api-Key": "key-other"}


def test_health_and_ready(settings: Settings) -> None:
    """健康检查不依赖外部系统。"""
    with TestClient(create_app(settings)) as client:
        health = client.get("/healthz")
        assert health.status_code == 200
        assert health.json()["mode"] == "memory"
        assert client.get("/readyz").json()["ready"] is True


def test_query_success(settings: Settings) -> None:
    """主接口返回答案、引用与校验报告。"""
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/v1/query",
            headers=DEMO_HEADERS,
            json={"question": "C-2024-001 这笔 700 万的付款申请是否超付？"},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["guard"]["conforms"] is True
        assert "PAY-1001" in body["answer"]
        assert body["citations"][0]["chunk_id"] == "contract_policy#第三条"
        assert response.headers["X-Trace-Id"]


def test_query_preview_route(settings: Settings) -> None:
    """预览路由：只给证据，不给答案。"""
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/v1/query/preview",
            headers=DEMO_HEADERS,
            json={"question": "C-2024-001 这笔 700 万的付款申请是否超付？"},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["model"] == "retrieval-only"
        assert body["answer"] == ""
        assert body["citations"]


def test_query_requires_tenant(settings: Settings) -> None:
    """缺租户头直接 403。"""
    with TestClient(create_app(settings)) as client:
        response = client.post("/v1/query", json={"question": "付款是否超付"})
        assert response.status_code == 403
        assert response.json()["code"] == "tenant_forbidden"


def test_wrong_key_rejected(settings: Settings) -> None:
    """密钥不匹配 403。"""
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/v1/query",
            headers={"X-Tenant-Id": "demo", "X-Api-Key": "nope"},
            json={"question": "付款是否超付"},
        )
        assert response.status_code == 403


def test_post_generation_hook_blocks_bad_verdict(settings: Settings) -> None:
    """生成后钩子：错误结论返回 422，并给出冲突规则。"""
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/v1/hooks/post-generation",
            headers=DEMO_HEADERS,
            json={
                "query": "C-2024-001 的付款是否超付",
                "answer": "该付款未超付，可以支付。",
                "claims": [
                    {
                        "subject": "http://ontorag.local/tenant/demo/contract#PAY-1001",
                        "predicate": "con:paymentVerdict",
                        "object": "within-remaining",
                    },
                    {
                        "subject": "http://ontorag.local/tenant/demo/contract#PAY-1001",
                        "predicate": "doc:basedOnChunk",
                        "object": "contract_policy#第三条",
                    },
                ],
            },
        )
        assert response.status_code == 422
        payload = response.json()
        assert payload["code"] == "ontology_guard_blocked"
        rules = {item["rule"] for item in payload["details"]["guard"]["violations"]}
        assert "PaymentVerdictConsistency" in rules


def test_sparql_tool_blocks_writes(settings: Settings) -> None:
    """SPARQL 工具禁止任何更新操作。"""
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/v1/tools/sparql",
            headers=DEMO_HEADERS,
            json={"sparql": "DELETE WHERE { ?s ?p ?o }"},
        )
        assert response.status_code == 400
        assert response.json()["code"] == "invalid_query"


def test_sparql_tool_is_tenant_scoped(settings: Settings) -> None:
    """SPARQL 工具自动加 FROM 租户图，查询不到别的租户。"""
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/v1/tools/sparql",
            headers=DEMO_HEADERS,
            json={"sparql": "SELECT ?s WHERE { ?s ?p ?o }", "limit": 200},
        )
        assert response.status_code == 200
        rows = response.json()["rows"]
        assert rows
        assert all("tenant/other" not in str(row) for row in rows)


def test_entity_link_tool(settings: Settings) -> None:
    """术语归一：请款单 -> 付款申请。"""
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/v1/tools/entity-link",
            headers=DEMO_HEADERS,
            json={"text": "请款单金额是否超过合同剩余应付"},
        )
        assert response.status_code == 200
        iris = {mention["iri"] for mention in response.json()["mentions"]}
        assert "http://ontorag.local/contract#PaymentApplication" in iris


def test_audit_cross_tenant_forbidden(settings: Settings) -> None:
    """other 租户读不到 demo 的 trace。"""
    with TestClient(create_app(settings)) as client:
        created = client.post(
            "/v1/query",
            headers=DEMO_HEADERS,
            json={"question": "C-2024-001 的付款是否超付？"},
        ).json()
        trace_id = created["trace_id"]
        response = client.get(f"/v1/admin/audit/{trace_id}", headers=OTHER_HEADERS)
        assert response.status_code == 403
        own = client.get(f"/v1/admin/audit/{trace_id}", headers=DEMO_HEADERS)
        assert own.status_code == 200
        assert own.json()["found"] is True
