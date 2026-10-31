"""进程内适配器：本地演示与自动化测试用，实现与生产适配器完全相同的协议。

注意：这不是「假数据」。图存储是真的 rdflib SPARQL 引擎，关键词检索是真的 BM25，
向量检索是真的余弦相似度，只是数据放在内存而不是 Fuseki / ES / Milvus。
"""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Sequence

from rdflib import Dataset, Graph, URIRef

from ..schemas import Chunk, ScoredChunk
from ..sparql_guard import scope_to_tenant

_LATIN_RE = re.compile(r"[a-z0-9_]+")
_CJK_RE = re.compile(r"[\u4e00-\u9fff]+")


def tokenize(text: str) -> list[str]:
    """中英文混合分词：拉丁词按空白切，中文按二元组切。

    二元组对政策文本足够稳，且不需要引入额外分词模型依赖。
    """
    lowered = text.lower()
    tokens = _LATIN_RE.findall(lowered)
    for run in _CJK_RE.findall(lowered):
        if len(run) == 1:
            tokens.append(run)
        else:
            tokens.extend(run[i : i + 2] for i in range(len(run) - 1))
    return tokens


class MemoryGraphStore:
    """按租户命名图存放 RDF 的进程内图存储。"""

    def __init__(self) -> None:
        self._dataset = Dataset(default_union=False)

    def load_turtle(self, tenant_graph: str, source: Path | str) -> int:
        """把 Turtle 文件或字符串装入指定租户图。"""
        graph = self._dataset.graph(URIRef(tenant_graph))
        if isinstance(source, Path):
            graph.parse(source, format="turtle")
        else:
            graph.parse(data=source, format="turtle")
        return len(graph)

    def load_quads(self, path: Path) -> int:
        """加载 N-Quads（多租户实例可放同一文件，按图名隔离）。"""
        self._dataset.parse(path, format="nquads")
        return sum(len(g) for g in self._dataset.graphs())

    def graph(self, tenant_graph: str) -> Graph:
        """取某租户图的只读视图。"""
        return self._dataset.graph(URIRef(tenant_graph))

    async def select(
        self, tenant_graph: str, sparql: str, *, timeout: float = 15.0, max_rows: int = 500
    ) -> list[dict[str, Any]]:
        """执行 SELECT；`GRAPH <uri>` 与默认图（union）都支持。"""
        del timeout  # 内存查询没有网络超时语义
        # 防御性作用域：即使调用方忘了带 FROM，也不允许跨租户读取
        result = self._dataset.query(scope_to_tenant(sparql, tenant_graph))
        rows: list[dict[str, Any]] = []
        for row in result:
            record: dict[str, Any] = {}
            for var in result.vars or []:
                value = row[var]
                record[str(var)] = None if value is None else str(value)
            rows.append(record)
            if len(rows) >= max_rows:
                break
        return rows

    async def construct(self, tenant_graph: str, sparql: str, *, timeout: float = 15.0) -> Graph:
        """执行 CONSTRUCT，返回子图（租户图为空时回退到全库）。"""
        del timeout
        result = self._dataset.query(scope_to_tenant(sparql, tenant_graph))
        out = Graph()
        graph = getattr(result, "graph", None)
        if isinstance(graph, Graph):
            for triple in graph:
                out.add(triple)
        if len(out) == 0:
            target = self._dataset.graph(URIRef(tenant_graph))
            for triple in target:
                out.add(triple)
        return out


class MemoryChunkRepository:
    """chunk 主数据的内存实现。"""

    def __init__(self) -> None:
        self._chunks: dict[str, dict[str, Chunk]] = {}

    async def get_many(self, tenant_id: str, chunk_ids: Sequence[str]) -> dict[str, Chunk]:
        bucket = self._chunks.get(tenant_id, {})
        return {cid: bucket[cid] for cid in chunk_ids if cid in bucket}

    async def put_many(self, chunks: Sequence[Chunk]) -> int:
        count = 0
        for chunk in chunks:
            self._chunks.setdefault(chunk.tenant_id, {})[chunk.chunk_id] = chunk
            count += 1
        return count

    async def list_all(self, tenant_id: str) -> list[Chunk]:
        return list(self._chunks.get(tenant_id, {}).values())

    def put_chunks_sync(self, chunks: Iterable[Chunk]) -> int:
        """同步写入，供启动期种子数据装载使用。"""
        count = 0
        for chunk in chunks:
            self._chunks.setdefault(chunk.tenant_id, {})[chunk.chunk_id] = chunk
            count += 1
        return count


class MemoryKeywordIndex:
    """BM25 关键词检索。"""

    def __init__(self, repository: MemoryChunkRepository, *, k1: float = 1.5, b: float = 0.75) -> None:
        self.repository = repository
        self.k1 = k1
        self.b = b

    async def search(
        self, tenant_id: str, query: str, *, filters: dict[str, Any], top_k: int
    ) -> list[ScoredChunk]:
        chunks = await self.repository.list_all(tenant_id)
        if not chunks:
            return []
        docs = {chunk.chunk_id: tokenize(chunk.text) for chunk in chunks}
        avg_len = sum(len(tokens) for tokens in docs.values()) / max(len(docs), 1)
        df: Counter[str] = Counter()
        for tokens in docs.values():
            for term in set(tokens):
                df[term] += 1
        total_docs = len(docs)
        query_terms = tokenize(query)

        scored: list[ScoredChunk] = []
        for chunk in chunks:
            if not self._passes(chunk, filters):
                continue
            tokens = docs[chunk.chunk_id]
            tf = Counter(tokens)
            length = len(tokens) or 1
            score = 0.0
            matched: list[str] = []
            for term in query_terms:
                if term not in tf:
                    continue
                idf = math.log(1 + (total_docs - df[term] + 0.5) / (df[term] + 0.5))
                score += idf * (tf[term] * (self.k1 + 1)) / (
                    tf[term] + self.k1 * (1 - self.b + self.b * length / avg_len)
                )
                matched.append(term)
            if score <= 0:
                continue
            scored.append(
                ScoredChunk(
                    chunk=chunk,
                    tier="keyword",
                    raw_score=score,
                    matched_on=sorted(set(matched))[:8],
                )
            )
        scored.sort(key=lambda item: item.raw_score, reverse=True)
        return scored[:top_k]

    @staticmethod
    def _passes(chunk: Chunk, filters: dict[str, Any]) -> bool:
        """应用文档类型与优先级过滤。"""
        doc_types = filters.get("doc_types")
        if doc_types and chunk.doc_type not in doc_types:
            return False
        priority_max = filters.get("priority_max")
        if priority_max is not None and chunk.priority > int(priority_max):
            return False
        wanted_classes = set(filters.get("ontology_classes") or [])
        wanted_props = set(filters.get("ontology_properties") or [])
        chunk_classes = set(chunk.classes)
        chunk_props = set(chunk.properties)
        if (wanted_classes or wanted_props) and (chunk_classes or chunk_props):
            return bool(wanted_classes & chunk_classes) or bool(wanted_props & chunk_props)
        return True


class HashingEmbedder:
    """确定性特征哈希向量化。

    仅用于本地演示与测试：不需要外网、不依赖模型，结果可复现。
    生产环境应使用 DeepSeek Embedding（见 adapters/deepseek.py）。
    """

    def __init__(self, dim: int = 1024) -> None:
        self.dim = dim

    async def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [self.embed_one(text) for text in texts]

    def embed_one(self, text: str) -> list[float]:
        """把文本映射为单位向量。"""
        vector = [0.0] * self.dim
        for token in tokenize(text):
            digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
            index = int.from_bytes(digest[:4], "big") % self.dim
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vector[index] += sign
        norm = math.sqrt(sum(value * value for value in vector)) or 1.0
        return [value / norm for value in vector]


class MemoryVectorIndex:
    """向量检索的内存实现（余弦相似度）。"""

    def __init__(self, repository: MemoryChunkRepository, embedder: HashingEmbedder) -> None:
        self.repository = repository
        self.embedder = embedder
        self._cache: dict[str, list[float]] = {}

    def _vector(self, chunk: Chunk) -> list[float]:
        cached = self._cache.get(chunk.chunk_id)
        if cached is None:
            cached = self.embedder.embed_one(chunk.text)
            self._cache[chunk.chunk_id] = cached
        return cached

    async def search(self, tenant_id: str, vector: Sequence[float], *, top_k: int) -> list[ScoredChunk]:
        chunks = await self.repository.list_all(tenant_id)
        scored: list[ScoredChunk] = []
        for chunk in chunks:
            if chunk.deprecated:
                continue
            other = self._vector(chunk)
            similarity = sum(a * b for a, b in zip(vector, other))
            if similarity <= 0.05:
                continue
            scored.append(ScoredChunk(chunk=chunk, tier="vector", raw_score=similarity))
        scored.sort(key=lambda item: item.raw_score, reverse=True)
        return scored[:top_k]
