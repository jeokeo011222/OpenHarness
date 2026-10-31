"""调试面板接口测试。

覆盖三件事：
1. 面板拿到的就是线上跑的那条链路（同一份 SPARQL、同一份评分、同一份闸门结论）；
2. 失败态有内容可看——被闸门拦下、链路中断都不是"只有一个 422"；
3. 开关关掉时接口与静态资源一起消失，不留半开状态。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import create_app
from app.schemas import GuardReport, Violation
from app.settings import Settings

DEMO_HEADERS = {"X-Tenant-Id": "demo", "X-Api-Key": "key-demo"}
OVERPAY_QUESTION = "C-2024-001 这笔 700 万的付款申请是否超付？"


def _trace(client: TestClient, question: str, **extra: object) -> dict:
    payload = {"question": question, "top_k": 5, **extra}
    response = client.post("/v1/debug/trace", headers=DEMO_HEADERS, json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def test_trace_exposes_every_stage(settings: Settings) -> None:
    """一次请求要能拿到解析、三级召回、闸门、答案、链路五段。"""
    with TestClient(create_app(settings)) as client:
        body = _trace(client, OVERPAY_QUESTION)

    assert body["parsed"]["classes"], "解析结果不能为空，否则面板第一屏就是空的"
    assert [tier["tier"] for tier in body["tiers"]] == ["graph", "keyword", "vector"]
    assert body["guard"]["conforms"] is True
    assert body["blocked"] is False
    assert "SELECT" in body["sparql"]["query"].upper(), "面板要展示真正执行的那条 SPARQL"

    kinds = [step["kind"] for step in body["chain"]]
    assert kinds[0] == "query"
    assert "guard" in kinds
    assert kinds[-1] in {"answer", "fact"}

    # 阶段表必须按执行顺序给出，且都记了耗时
    labels = [stage["label"] for stage in body["stages"]]
    assert labels[:2] == ["本体解析", "三级检索"]
    assert all(stage["ok"] for stage in body["stages"])


def test_tier_chunks_carry_status_and_reach_final_evidence(settings: Settings) -> None:
    """分通道候选必须标清"进入证据/被截断/被剔除"，且进入证据的要与引用一致。"""
    with TestClient(create_app(settings)) as client:
        body = _trace(client, OVERPAY_QUESTION)

    final_ids: set[str] = set()
    for tier in body["tiers"]:
        for chunk in tier["chunks"]:
            assert chunk["status"] in {"final", "cut", "dropped"}
            if chunk["status"] == "final":
                final_ids.add(chunk["chunk_id"])
                assert chunk["final_score"] > 0
            if chunk["status"] == "dropped":
                assert chunk["drop_reason"], "剔除必须带原因，否则面板只能显示一个红点"

    cited = {item["chunk_id"] for item in body["citations"]}
    assert final_ids == cited, "面板标成最终证据的分块，必须就是答案的溯源分块"


def test_dropped_chunks_are_explained(settings: Settings) -> None:
    """废止/过期分块要被点名并给出原因——这是"证据为何没出现"的答案。"""
    with TestClient(create_app(settings)) as client:
        body = _trace(client, "付款申请需要校验合同剩余应付吗")

    keyword = next(tier for tier in body["tiers"] if tier["tier"] == "keyword")
    dropped = [chunk for chunk in keyword["chunks"] if chunk["status"] == "dropped"]
    assert dropped, "该问题会召回到废止/过期条款，必须被剔除而不是静默消失"
    assert all(chunk["drop_reason"] for chunk in dropped)


def test_vector_tier_reports_why_it_did_not_run(settings: Settings) -> None:
    """向量没触发时必须能看出"已充足"，而不是"忘了跑"。"""
    with TestClient(create_app(settings)) as client:
        body = _trace(client, OVERPAY_QUESTION)

    vector = next(tier for tier in body["tiers"] if tier["tier"] == "vector")
    assert vector["executed"] is False
    assert vector["reason"].startswith("skipped:sufficient")


def test_baseline_marks_incompatible_naive_evidence(settings: Settings) -> None:
    """对照组的脏证据要被标出来，这是"普通 RAG vs 本体制导"唯一可量的差异。"""
    with TestClient(create_app(settings)) as client:
        body = _trace(client, "S-BOILER 的核算边界是否冲突？", domain="carbon")

    baseline = body["baseline"]
    assert baseline["enabled"] is True
    assert baseline["total"] >= 1
    assert baseline["dirty"] >= 1, "纯向量在跨域问题下必然捞到合同资料"
    dirty_ids = {chunk["chunk_id"] for chunk in baseline["chunks"] if chunk["drop_reason"] == "incompatible"}
    assert dirty_ids, "脏块必须能被逐条指认"
    # 脏块只可能来自"本体制导没要的那部分"：图谱命中的分块由事实链豁免，
    # 若它同时出现在本体制导的最终证据里，说明判定与过滤出现了分叉
    assert dirty_ids <= set(baseline["only_naive"]) | set(baseline["overlap"])
    assert set(baseline["only_naive"]) <= {chunk["chunk_id"] for chunk in baseline["chunks"]}


def test_guard_block_returns_report_instead_of_error(settings: Settings) -> None:
    """被闸门拦下时：HTTP 仍是 200，但 blocked + 明细齐全，草稿单独可查。"""

    class _Blocking:
        async def validate_async(self, *args: object, **kwargs: object) -> GuardReport:
            return GuardReport(
                conforms=False,
                checked_triples=3,
                engine="stub",
                violations=[
                    Violation(
                        rule="PaymentVerdictConsistency",
                        message="结论「未超付」与剩余应付金额矛盾",
                        severity="Violation",
                    )
                ],
            )

    app = create_app(settings)
    with TestClient(app) as client:
        app.state.container.pipeline.validator = _Blocking()
        response = client.post("/v1/debug/trace", headers=DEMO_HEADERS, json={"question": OVERPAY_QUESTION})
        assert response.status_code == 200, "调试面板不能把阻断变成一次异常"
        body = response.json()

    assert body["blocked"] is True
    assert body["guard"]["conforms"] is False
    assert body["guard"]["violations"][0]["rule"] == "PaymentVerdictConsistency"
    assert "SHACL" in body["block_reason"]
    assert body["error"], "被阻断也是一次失败，error 要留原因"
    # 前面几段照常给出：这正是面板相对 /v1/query 的价值
    assert body["parsed"] and body["tiers"]
    assert body["answer"], "草稿保留给调试查看，但不会作为正式答案返回"


def test_pipeline_failure_keeps_partial_trace(settings: Settings) -> None:
    """链路断在解析阶段时，也要指出卡在哪一步。"""

    class _Broken:
        async def parse(self, *args: object, **kwargs: object) -> None:
            raise RuntimeError("extractor unavailable")

    app = create_app(settings)
    with TestClient(app) as client:
        app.state.container.pipeline.parser = _Broken()
        response = client.post("/v1/debug/trace", headers=DEMO_HEADERS, json={"question": OVERPAY_QUESTION})
        assert response.status_code == 200
        body = response.json()

    assert body["blocked"] is True
    assert "extractor unavailable" in body["error"]
    failed = [stage for stage in body["stages"] if stage["ok"] is False]
    assert failed and failed[0]["label"] == "本体解析"
    assert body["tiers"] == [] and body["guard"] is None


def test_debug_requires_tenant_key(settings: Settings) -> None:
    """调试面板不比正式接口更宽松：没有密钥一样拒绝。"""
    with TestClient(create_app(settings)) as client:
        response = client.post("/v1/debug/trace", json={"question": OVERPAY_QUESTION})
    assert response.status_code == 403
    assert response.json()["code"] == "tenant_forbidden"


def test_panel_can_be_switched_off(settings: Settings) -> None:
    """关掉开关后，接口和静态页一起消失——不能出现"接口关了页面还能开"。"""
    disabled = settings.model_copy(update={"debug_panel_enabled": False})
    with TestClient(create_app(disabled)) as client:
        assert client.post("/v1/debug/trace", headers=DEMO_HEADERS, json={"question": OVERPAY_QUESTION}).status_code == 404
        assert client.get("/debug/").status_code == 404


def test_static_panel_is_served(settings: Settings) -> None:
    """面板三件套（html/css/js）由后端直接托管，不依赖任何 CDN。"""
    with TestClient(create_app(settings)) as client:
        page = client.get("/debug/")
        assert page.status_code == 200
        assert "OntoRAG 调试面板" in page.text
        assert client.get("/debug/style.css").status_code == 200
        assert client.get("/debug/app.js").status_code == 200
