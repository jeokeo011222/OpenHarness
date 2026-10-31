"""三级混合检索的适配层。

真正的实现拆在 `app/retrieval/` 里，各自有独立职责与单测：

  contract.py     输入契约（实体 / 约束 / 时间范围）
  constraints.py  业务约束 -> 目标类 + 待投影属性
  planner.py      结构化查询 -> 只读 SPARQL
  compat.py       本体兼容性判定（唯一口径）
  scoring.py      全部打分函数（唯一口径）
  service.py      三通道编排 + 触发门槛 + 过滤排序

这一层只做一件事：把编排层的 `QueryIntent` 适配成 `StructuredQuery`，
再把结果映射回编排层需要的四元组。**不在这里放任何检索逻辑**——
之前正是"检索逻辑和编排逻辑混在一个类里"，才让打分口径没法单独测试。
"""

from __future__ import annotations

from datetime import date
from typing import Any

from ..ontology.model import OntologyModel
from ..retrieval import HybridRetrievalService, RetrievalResult, StructuredQuery
from ..schemas import Chunk, QueryIntent, RecallStats, ScoredChunk, SparqlTrace
from ..settings import Settings


class HybridRetriever:
    """三级检索的门面，保持编排层原有签名不变。"""

    def __init__(
        self,
        settings: Settings,
        ontology: OntologyModel,
        graph: Any,
        chunks: Any,
        keyword: Any,
        vector: Any,
        embedder: Any,
    ) -> None:
        self.settings = settings
        self.ontology = ontology
        self.graph = graph
        self.chunks = chunks
        self.keyword = keyword
        self.vector = vector
        self.embedder = embedder
        self.service = HybridRetrievalService(settings, ontology, graph, chunks, keyword, vector, embedder)

    async def retrieve(
        self,
        tenant: Any,
        intent: QueryIntent,
        *,
        top_k: int,
        today: date | None = None,
    ) -> tuple[list[ScoredChunk], RecallStats, SparqlTrace, list[str]]:
        """执行三级检索并返回排序后的候选、统计、SPARQL 路径与事实主语。"""
        result = await self.retrieve_full(tenant, intent, top_k=top_k, today=today)
        return result.items, result.stats, result.trace, result.seeds

    async def retrieve_full(
        self,
        tenant: Any,
        intent: QueryIntent,
        *,
        top_k: int,
        today: date | None = None,
    ) -> RetrievalResult:
        """完整结果（含分通道候选、丢弃原因、种子路径）。

        调试面板必须走这条：`retrieve` 的四元组丢掉了"每条候选来自哪一层"，
        拿它拼不出一致的分通道视图。
        """
        query = StructuredQuery.from_intent(intent)
        return await self.service.retrieve(tenant, query, top_k=top_k, today=today)

    # ------------------------------ 兼容入口 ------------------------------

    def _is_dirty(
        self,
        chunk: Chunk,
        intent_classes: set[str],
        intent_props: set[str],
        tier: str,
    ) -> bool:
        """本体不兼容判定（保留旧签名，供既有测试与调用方使用）。

        实现直接委托给 `OntologyCompatibility`，保证"过滤口径只有一处"。
        """
        verdict = self.service.compat.check_chunk(
            chunk,
            query_classes=intent_classes,
            query_properties=intent_props,
            tier=tier,
        )
        return not verdict.compatible
