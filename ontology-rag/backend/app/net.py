"""带重试与超时的 HTTP 调用封装。

所有外部依赖（Fuseki / ES / DeepSeek）都必须走这里：
- 指数退避 + 抖动，避免雪崩式重试；
- **只重试瞬时错误**（5xx / 429 / 408 / 连接与超时），4xx 一律快速失败；
- 超时统一由调用方传入，禁止无上限等待。

为什么区分可重试与不可重试：把 401（凭据错）和 400（查询语法错）也放进
退避循环，会让一个确定性的配置/逻辑错误伪装成"偶发抖动"——报错被推迟
几秒，且最终消息只剩"调用失败"，根因（状态码与响应体）在重试中被丢弃。
闸门类组件最怕这种伪装：看起来是网络不稳，实际是权限或形状写错了。
"""

from __future__ import annotations

import asyncio
import random
from typing import Any

import httpx

from .errors import RetrievalError

# 这些状态码代表"上游暂时不行"，隔一会儿重试有意义。
# 其余 4xx 属于请求本身的问题，重试改变不了结论。
_RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


def _delay(attempt: int, base_delay: float) -> float:
    """指数退避 + 抖动：同时失败的调用方不会在同一刻重试。"""
    return base_delay * (2**attempt) + random.uniform(0, base_delay)


def internal_client(*, timeout: float, auth: tuple[str, str] | None = None) -> httpx.AsyncClient:
    """构造访问**内网**依赖（Fuseki / ES）的客户端：显式 `trust_env=False`。

    `httpx` 默认会读 `HTTP_PROXY` / `HTTPS_PROXY`。政企环境里这两个变量通常
    由终端安全软件或平台注入，一旦存在，访问 `127.0.0.1:3030` 的请求也会被
    塞进代理，代理连不到内网图库就回 502。症状极具欺骗性：**同一份代码在本机
    某些终端下永远失败，换个终端永远成功**；出现在闸门上就是"校验时好时坏"。

    内网依赖与代理无关，必须直连。出网的大模型网关则相反（见 `deepseek.py`），
    那里保留 `trust_env`，因为部署可能确实需要经代理出网。
    """
    return httpx.AsyncClient(
        timeout=httpx.Timeout(timeout),
        auth=auth,
        trust_env=False,
    )


def _failure(method: str, url: str, status: int, body: str) -> RetrievalError:
    """把上游失败包装成带状态码与响应体的错误。"""
    return RetrievalError(
        f"上游服务返回 {status}：{method} {url}",
        details={"method": method, "url": url, "status": status, "body": body[:500]},
    )


def _exhausted(method: str, url: str, retries: int, last_error: Exception | None) -> RetrievalError:
    """重试耗尽时的错误必须自带根因，否则线上无从排查。"""
    return RetrievalError(
        f"调用失败：{method} {url}（{retries} 次重试后仍失败：{last_error}）",
        details={"method": method, "url": url, "error": str(last_error)},
    )


async def request_json(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    retries: int = 3,
    base_delay: float = 0.3,
    **kwargs: Any,
) -> Any:
    """发起请求并解析 JSON，瞬时失败按指数退避重试。"""
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            response = await client.request(method, url, **kwargs)
        except (httpx.TimeoutException, httpx.TransportError) as error:
            last_error = error
        else:
            if response.status_code < 400:
                return response.json()
            failure = _failure(method, url, response.status_code, response.text)
            if response.status_code not in _RETRYABLE_STATUS:
                # 确定性失败：立刻上抛，别用退避把根因埋掉
                raise failure
            last_error = failure
        if attempt == retries - 1:
            break
        await asyncio.sleep(_delay(attempt, base_delay))
    raise _exhausted(method, url, retries, last_error)


async def request_idempotent(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    retries: int = 3,
    base_delay: float = 0.3,
    accept_status: tuple[int, ...] = (200, 201, 204, 404),
    **kwargs: Any,
) -> int:
    """执行**幂等**写操作（PUT / DELETE 整图）并返回状态码。

    与 `request_json` 的区别只有一条：允许重试非查询请求。
    前提是调用方保证幂等——GSP 的 `PUT graph`（整图覆盖）与 `DELETE graph`
    都满足，重复执行结果相同；`DELETE` 返回 404 也视为成功（图本来就不在）。

    TDB2 是单写者，并发校验时后到的写会撞上锁，Fuseki 会返回 5xx。
    这种失败是瞬时的，不重试就会让"偶发校验失败"变成线上常态。
    反之，401（凭据错）这类确定性失败必须立刻上抛，否则会表现成"时好时坏"。
    """
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            response = await client.request(method, url, **kwargs)
        except (httpx.TimeoutException, httpx.TransportError) as error:
            last_error = error
        else:
            if response.status_code in accept_status:
                return response.status_code
            failure = _failure(method, url, response.status_code, response.text)
            if response.status_code not in _RETRYABLE_STATUS:
                raise failure
            last_error = failure
        if attempt == retries - 1:
            break
        await asyncio.sleep(_delay(attempt, base_delay))
    raise _exhausted(method, url, retries, last_error)


async def request_text(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    retries: int = 3,
    base_delay: float = 0.3,
    **kwargs: Any,
) -> str:
    """发起请求并返回文本（SPARQL CONSTRUCT 用）。"""
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            response = await client.request(method, url, **kwargs)
        except (httpx.TimeoutException, httpx.TransportError) as error:
            last_error = error
        else:
            if response.status_code < 400:
                return response.text
            failure = _failure(method, url, response.status_code, response.text)
            if response.status_code not in _RETRYABLE_STATUS:
                raise failure
            last_error = failure
        if attempt == retries - 1:
            break
        await asyncio.sleep(_delay(attempt, base_delay))
    raise _exhausted(method, url, retries, last_error)
