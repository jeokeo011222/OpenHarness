"""端口定义（Protocol）。

管线只依赖这些协议，不依赖具体实现，因此：
- 生产用 Fuseki / ES / Milvus / DeepSeek 适配器；
- 测试与本地演示用 memory 适配器，跑的是同一套管线代码。
"""

from __future__ import annotations

from typing import Any, Protocol, Sequence, runtime_checkable

from .schemas import Chunk, Claim, ScoredChunk


@runtime_checkable
class GraphStore(Protocol):
    """RDF 图存储（只读 SPARQL）。"""

    async def select(self, tenant_graph: str, sparql: str, *, timeout: float, max_rows: int) -> list[dict[str, Any]]:
        """执行 SELECT，返回行字典列表。"""


@runtime_checkable
class KeywordIndex(Protocol):
    """关键词/原文精准检索。"""

    async def search(self, tenant_id: str, query: str, *, filters: dict[str, Any], top_k: int) -> list[ScoredChunk]:
        """按 BM25 相关性返回 chunk。"""


@runtime_checkable
class VectorIndex(Protocol):
    """向量检索（仅作补全）。"""

    async def search(self, tenant_id: str, vector: Sequence[float], *, top_k: int) -> list[ScoredChunk]:
        """按向量相似度返回 chunk。"""


@runtime_checkable
class ChunkRepository(Protocol):
    """chunk 主数据读取。"""

    async def get_many(self, tenant_id: str, chunk_ids: Sequence[str]) -> dict[str, Chunk]:
        """按 id 批量取 chunk。"""

    async def put_many(self, chunks: Sequence[Chunk]) -> int:
        """写入/覆盖 chunk，返回写入条数。"""

    async def list_all(self, tenant_id: str) -> list[Chunk]:
        """列出某租户全部 chunk（评估与重建索引用）。"""


@runtime_checkable
class Embedder(Protocol):
    """文本向量化。"""

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """返回与输入等长的向量列表。"""


class LLMResult:
    """一次模型调用的结果与计量。"""

    __slots__ = ("text", "prompt_tokens", "completion_tokens", "model", "cached")

    def __init__(
        self,
        text: str,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        model: str = "",
        cached: bool = False,
    ) -> None:
        self.text = text
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.model = model
        self.cached = cached

    @property
    def total_tokens(self) -> int:
        """输入 + 输出 token。"""
        return self.prompt_tokens + self.completion_tokens


@runtime_checkable
class LLMClient(Protocol):
    """对话模型。"""

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
        """返回模型文本输出。"""


@runtime_checkable
class AuditStore(Protocol):
    """全链路审计。"""

    async def append(self, record: dict[str, Any]) -> None:
        """写入一条审计记录。"""

    async def get(self, tenant_id: str, trace_id: str) -> dict[str, Any] | None:
        """按 trace 读取记录（含跨租户拒绝）。"""

    async def usage(self, tenant_id: str, *, days: int = 1) -> dict[str, Any]:
        """按天聚合 token 与成本。"""

    async def recent(self, tenant_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
        """最近若干条审计。"""


@runtime_checkable
class Validator(Protocol):
    """候选三元组校验器。"""

    async def validate(self, tenant_graph: str, claims: Sequence[Claim], *, include_tenant_facts: bool) -> Any:
        """返回 GuardReport。"""
