"""DeepSeek 模型适配器：对话与向量化。

所有调用都带超时、重试与异常归一化；API Key 只从环境变量读取。
"""

from __future__ import annotations

from typing import Sequence

import httpx

from ..errors import OntoRagError
from ..net import request_json
from ..ports import LLMResult
from ..settings import Settings


class DeepSeekLLM:
    """DeepSeek Chat Completions。"""

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(settings.llm_timeout_seconds),
            headers={
                "Authorization": f"Bearer {settings.deepseek_api_key}",
                "Content-Type": "application/json",
            },
        )

    async def complete(
        self,
        *,
        model: str,
        system: str,
        user: str,
        temperature: float = 0.0,
        max_tokens: int = 2048,
        timeout: float = 60.0,
    ) -> LLMResult:
        """调用模型。失败按配置重试。"""
        if not self.settings.deepseek_api_key:
            raise OntoRagError(
                "未配置 DEEPSEEK_API_KEY；本地演示请设置 RAG_MODE=memory",
                details={"hint": "生产环境必须配置真实密钥，禁止硬编码"},
            )
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        data = await request_json(
            self._client,
            "POST",
            f"{self.settings.deepseek_base_url.rstrip('/')}/chat/completions",
            json=payload,
            timeout=timeout,
            retries=self.settings.llm_max_retries,
        )
        choices = data.get("choices") or []
        if not choices:
            raise OntoRagError("模型返回为空", details={"raw": str(data)[:300]})
        usage = data.get("usage", {})
        return LLMResult(
            text=str(choices[0].get("message", {}).get("content", "")),
            prompt_tokens=int(usage.get("prompt_tokens", 0)),
            completion_tokens=int(usage.get("completion_tokens", 0)),
            model=str(data.get("model", model)),
        )

    async def aclose(self) -> None:
        """释放连接池。"""
        await self._client.aclose()


class DeepSeekEmbedder:
    """DeepSeek Embeddings。"""

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(settings.llm_timeout_seconds),
            headers={
                "Authorization": f"Bearer {settings.deepseek_api_key}",
                "Content-Type": "application/json",
            },
        )

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """批量向量化。"""
        if not self.settings.deepseek_api_key:
            raise OntoRagError("未配置 DEEPSEEK_API_KEY，无法调用向量化接口")
        data = await request_json(
            self._client,
            "POST",
            f"{self.settings.deepseek_base_url.rstrip('/')}/embeddings",
            json={"model": self.settings.embedding_model, "input": list(texts)},
            retries=self.settings.llm_max_retries,
        )
        items = sorted(data.get("data", []), key=lambda item: item.get("index", 0))
        return [list(item["embedding"]) for item in items]

    async def aclose(self) -> None:
        """释放连接池。"""
        await self._client.aclose()
