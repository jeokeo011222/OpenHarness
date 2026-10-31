"""HTTP 重试契约的确定性测试。

这组用例不需要任何外部服务：用 `httpx.MockTransport` 精确控制上游返回，
把"哪些错误该重试、哪些必须立刻上抛、耗尽后报什么"变成可断言的契约。

为什么值得单独测：SHACL 闸门依赖 GSP 写通道，而写通道的失败曾经表现成
"校验时好时坏"。真正的原因是 401/400 这类确定性错误也被放进了退避循环，
于是根因被延迟若干秒后丢弃，只剩一句"调用失败"。这里把该行为钉死。
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from app.errors import RetrievalError
from app.net import internal_client, request_idempotent, request_json, request_text


def _client(handler: object) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))  # type: ignore[arg-type]


def _sequence(statuses: list[int], *, body: str = "boom") -> tuple[object, list[int]]:
    """按顺序返回状态码（用完后重复最后一个），并记录被调用的次数。"""
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        status = statuses[min(len(calls), len(statuses) - 1)]
        calls.append(status)
        return httpx.Response(status, text=body)

    return handler, calls


def test_idempotent_retries_transient_failure_then_succeeds() -> None:
    """5xx 是瞬时的：重试到成功即返回，不把抖动透给上层。"""
    handler, calls = _sequence([503, 503, 201])

    async def run() -> int:
        async with _client(handler) as client:
            return await request_idempotent(
                client, "PUT", "http://fuseki/data", retries=4, base_delay=0.0
            )

    assert asyncio.run(run()) == 201
    assert len(calls) == 3


def test_idempotent_accepts_404_on_delete() -> None:
    """删一张本来就不存在的图不算失败：清理路径不该因为"已经干净"报错。"""
    handler, calls = _sequence([404])

    async def run() -> int:
        async with _client(handler) as client:
            return await request_idempotent(
                client, "DELETE", "http://fuseki/data", retries=3, base_delay=0.0
            )

    assert asyncio.run(run()) == 404
    assert len(calls) == 1


@pytest.mark.parametrize("status", [400, 401, 403, 405], ids=lambda s: f"http-{s}")
def test_idempotent_fails_fast_on_permanent_error(status: int) -> None:
    """凭据/权限/语法类错误只尝试一次：重试改变不了结论。"""
    handler, calls = _sequence([status])

    async def run() -> None:
        async with _client(handler) as client:
            await request_idempotent(client, "PUT", "http://fuseki/data", retries=6, base_delay=0.0)

    with pytest.raises(RetrievalError) as caught:
        asyncio.run(run())
    assert len(calls) == 1
    assert str(status) in str(caught.value)
    assert caught.value.details["status"] == status


def test_idempotent_exhausted_error_carries_root_cause() -> None:
    """重试耗尽必须报出最后一次的真实原因，否则线上等于无信息。"""
    handler, calls = _sequence([503])

    async def run() -> None:
        async with _client(handler) as client:
            await request_idempotent(client, "PUT", "http://fuseki/data", retries=3, base_delay=0.0)

    with pytest.raises(RetrievalError) as caught:
        asyncio.run(run())
    assert len(calls) == 3
    message = str(caught.value)
    assert "503" in message
    assert "PUT" in message
    assert "http://fuseki/data" in message


def test_internal_client_ignores_proxy_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """内网客户端必须直连，不吃 HTTP_PROXY。

    这是曾经让"校验时好时坏"的真凶：终端安全软件注入了 `HTTP_PROXY`，
    httpx 默认 `trust_env=True`，于是发往 `127.0.0.1:3030` 的 GSP 写入
    被塞进代理，代理连不到本机图库便回 502。表现是同一份代码换个终端
    就换一种结论，而闸门最不能容忍这类环境依赖。
    """
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:9")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9")

    client = internal_client(timeout=5.0)
    try:
        assert client.trust_env is False
        # httpx 会在 trust_env 为真时按环境变量挂代理传输层；这里必须一个都没有
        assert not client._mounts  # noqa: SLF001 - 直接验证传输层挂载，公开 API 无法观测
    finally:
        asyncio.run(client.aclose())


def test_request_json_does_not_retry_client_error() -> None:
    """查询侧的 400（SPARQL 写错）同样不该退避重试。"""
    handler, calls = _sequence([400], body="Encountered \"DELETE\"")

    async def run() -> None:
        async with _client(handler) as client:
            await request_json(client, "POST", "http://fuseki/query", retries=3, base_delay=0.0)

    with pytest.raises(RetrievalError) as caught:
        asyncio.run(run())
    assert len(calls) == 1
    assert "DELETE" in caught.value.details["body"]


def test_request_text_retries_then_returns_body() -> None:
    """CONSTRUCT 走文本通道，行为与 JSON 通道一致。"""
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) < 3:
            return httpx.Response(503, text="busy")
        return httpx.Response(200, text="@prefix ex: <http://example.org/> .")

    async def run() -> str:
        async with _client(handler) as client:
            return await request_text(client, "POST", "http://fuseki/query", retries=4, base_delay=0.0)

    assert "example.org" in asyncio.run(run())
    assert len(calls) == 3
