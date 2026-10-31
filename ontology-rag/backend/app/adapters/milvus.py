"""Milvus 适配器：仅作为第三级补全检索。

约束：向量检索权重固定 15%，且不得单独决定答案——它只负责召回图谱与关键词
都没覆盖到的同义表达。集合按 `tenant_id` 做分区键，查询必须带租户过滤表达式。
"""

from __future__ import annotations

import asyncio
from typing import Any, Sequence

from ..errors import RetrievalError
from ..schemas import Chunk, ScoredChunk
from ..settings import Settings


class MilvusVectorIndex:
    """基于 pymilvus 的向量检索。"""

    def __init__(self, settings: Settings, repository: Any) -> None:
        self.settings = settings
        self.repository = repository
        self._collection: Any = None

    def _get_collection(self) -> Any:
        """惰性连接，避免没有 Milvus 的环境启动失败。"""
        if self._collection is not None:
            return self._collection
        try:
            from pymilvus import Collection, connections  # 延迟导入
        except ImportError as error:  # pragma: no cover - 仅在缺依赖时触发
            raise RetrievalError("未安装 pymilvus，无法使用向量检索") from error
        connections.connect(alias="ontorag", uri=self.settings.milvus_uri, token=self.settings.milvus_token or None)
        self._collection = Collection(self.settings.milvus_collection, using="ontorag")
        self._collection.load()
        return self._collection

    async def search(self, tenant_id: str, vector: Sequence[float], *, top_k: int) -> list[ScoredChunk]:
        """按余弦相似度检索，返回补全用的 chunk。"""

        def _search() -> list[tuple[str, float]]:
            collection = self._get_collection()
            results = collection.search(
                data=[list(vector)],
                anns_field="vector",
                param={"metric_type": "COSINE", "params": {"nprobe": 16}},
                limit=top_k,
                expr=f'tenant_id == "{tenant_id}"',
                output_fields=["chunk_id"],
            )
            hits: list[tuple[str, float]] = []
            for hit in results[0]:
                chunk_id = hit.entity.get("chunk_id")
                if chunk_id:
                    hits.append((str(chunk_id), float(hit.score)))
            return hits

        hits = await asyncio.to_thread(_search)
        chunks: dict[str, Chunk] = await self.repository.get_many(tenant_id, [cid for cid, _ in hits])
        scored: list[ScoredChunk] = []
        for chunk_id, score in hits:
            chunk = chunks.get(chunk_id)
            if chunk is None or chunk.deprecated:
                continue
            scored.append(ScoredChunk(chunk=chunk, tier="vector", raw_score=score))
        return scored
