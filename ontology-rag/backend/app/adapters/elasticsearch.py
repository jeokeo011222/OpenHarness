"""Elasticsearch 适配器：原文精准检索与 chunk 主数据。"""

from __future__ import annotations

from typing import Any, Sequence

import httpx

from ..errors import RetrievalError
from ..net import internal_client, request_json
from ..schemas import Chunk, ScoredChunk
from ..settings import Settings


def _source_to_chunk(source: dict[str, Any]) -> Chunk:
    """把 ES `_source` 还原为 Chunk（忽略未知字段）。"""
    return Chunk(
        chunk_id=source["chunk_id"],
        tenant_id=source["tenant_id"],
        doc_id=source["doc_id"],
        doc_title=source["doc_title"],
        doc_type=source["doc_type"],
        clause_no=source["clause_no"],
        text=source["text"],
        classes=source.get("classes", []),
        properties=source.get("properties", []),
        priority=int(source.get("priority", 30)),
        effective_from=source.get("effective_from"),
        effective_to=source.get("effective_to"),
        version=source.get("version", "v1"),
        deprecated=bool(source.get("deprecated", False)),
    )


class ElasticsearchKeywordIndex:
    """BM25 检索；索引按租户隔离。"""

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        auth = (settings.es_username, settings.es_password) if settings.es_username else None
        # 同 Fuseki：内网依赖直连，不吃 HTTP_PROXY
        self._client = client or internal_client(timeout=settings.es_timeout_seconds, auth=auth)

    def index_for(self, tenant_id: str) -> str:
        """租户索引名。"""
        return f"{self.settings.es_index_prefix}_{tenant_id}_chunks"

    async def search(
        self, tenant_id: str, query: str, *, filters: dict[str, Any], top_k: int
    ) -> list[ScoredChunk]:
        """多字段匹配 + 结构化过滤。"""
        body: dict[str, Any] = {
            "size": top_k,
            "query": {
                "bool": {
                    "must": [
                        {
                            "multi_match": {
                                "query": query,
                                "fields": ["text^3", "clause_no^2", "doc_title^1.5", "classes^1.2"],
                                "type": "best_fields",
                            }
                        }
                    ],
                    "filter": self._filters(filters),
                }
            },
            # 文档优先级作为**同分裁决**参与，但不进 `_score`：
            # 真正的优先级加权在融合层做一次（scoring.finalize），这里如果再乘一遍，
            # "低优先级条款同时被图谱和关键词命中"就会被罚两次。
            # 加这条 sort 只解决一个具体问题：top_k 窗口切分时别把同分的现行制度挤掉。
            "sort": [{"_score": {"order": "desc"}}, {"priority": {"order": "asc"}}],
        }
        payload = await request_json(
            self._client,
            "POST",
            f"{self.settings.es_url.rstrip('/')}/{self.index_for(tenant_id)}/_search",
            json=body,
            retries=self.settings.llm_max_retries,
        )
        hits = payload.get("hits", {}).get("hits", [])
        return [
            ScoredChunk(
                chunk=_source_to_chunk(hit["_source"]),
                tier="keyword",
                raw_score=float(hit.get("_score") or 0.0),
                matched_on=["bm25"],
            )
            for hit in hits
        ]

    @staticmethod
    def _filters(filters: dict[str, Any]) -> list[dict[str, Any]]:
        """把业务过滤条件翻译为 ES filter 子句。"""
        clauses: list[dict[str, Any]] = [{"term": {"deprecated": False}}]
        doc_types = filters.get("doc_types")
        if doc_types:
            clauses.append({"terms": {"doc_type": list(doc_types)}})
        priority_max = filters.get("priority_max")
        if priority_max is not None:
            clauses.append({"range": {"priority": {"lte": int(priority_max)}}})
        wanted_classes = filters.get("ontology_classes") or []
        wanted_props = filters.get("ontology_properties") or []
        if wanted_classes or wanted_props:
            should: list[dict[str, Any]] = []
            if wanted_classes:
                should.append({"terms": {"classes": list(wanted_classes)}})
            if wanted_props:
                should.append({"terms": {"properties": list(wanted_props)}})
            clauses.append({"bool": {"should": should, "minimum_should_match": 1}})
        return clauses

    async def get_many(self, tenant_id: str, chunk_ids: Sequence[str]) -> dict[str, Chunk]:
        """按 id 批量读取 chunk。"""
        if not chunk_ids:
            return {}
        ids = list(dict.fromkeys(chunk_ids))
        payload = await request_json(
            self._client,
            "POST",
            f"{self.settings.es_url.rstrip('/')}/{self.index_for(tenant_id)}/_mget",
            json={"ids": ids},
            retries=self.settings.llm_max_retries,
        )
        result: dict[str, Chunk] = {}
        for doc in payload.get("docs", []):
            if doc.get("found"):
                chunk = _source_to_chunk(doc["_source"])
                result[chunk.chunk_id] = chunk
        return result

    async def put_many(self, chunks: Sequence[Chunk]) -> int:
        """批量写入（按 chunk_id 幂等覆盖）。"""
        if not chunks:
            return 0
        lines: list[str] = []
        for chunk in chunks:
            lines.append('{"index": {"_index": "%s", "_id": "%s"}}' % (self.index_for(chunk.tenant_id), chunk.chunk_id))
            lines.append(chunk.model_dump_json())
        body = "\n".join(lines) + "\n"
        payload = await request_json(
            self._client,
            "POST",
            f"{self.settings.es_url.rstrip('/')}/_bulk",
            content=body.encode("utf-8"),
            headers={"Content-Type": "application/x-ndjson"},
            retries=self.settings.llm_max_retries,
        )
        if payload.get("errors"):
            raise RetrievalError("ES 批量写入存在失败项", details={"errors": payload.get("items", [])[:3]})
        return len(chunks)

    async def list_all(self, tenant_id: str) -> list[Chunk]:
        """列出全部 chunk（评估与重建索引用）。"""
        payload = await request_json(
            self._client,
            "POST",
            f"{self.settings.es_url.rstrip('/')}/{self.index_for(tenant_id)}/_search",
            json={"size": 10000, "query": {"match_all": {}}},
            retries=self.settings.llm_max_retries,
        )
        return [_source_to_chunk(hit["_source"]) for hit in payload.get("hits", {}).get("hits", [])]

    async def aclose(self) -> None:
        """释放连接池。"""
        await self._client.aclose()
