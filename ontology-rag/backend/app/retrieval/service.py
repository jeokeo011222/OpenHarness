"""本体制导的三级混合检索服务。

执行顺序是**架构约束**，不是性能优化：

  1. 图谱（SPARQL）：用业务约束把候选空间压到"与本题相关的对象"，权重最高；
  2. 关键词（ES/pg）：在压好的空间之外补条款原话，权重次之；
  3. 向量：**只在图谱+关键词不足时**触发，补同义表达，权重最低。

反过来做（先向量、再过滤）也能跑通，但那等于先把整库的语义邻居拉进来再删，
脏召回在源头就已经发生，过滤只能事后掩盖——这正是本系统要避免的。

三处关键实现：

* **向量触发是判定，不是默认**：`_need_vector` 给出"数量不足"或"最高分不足"
  的明确理由，写进 `RecallStats.tier_decisions`，可审计；
* **兼容性过滤只有一处口径**：`OntologyCompatibility`，图谱通道因有事实链豁免；
* **文档优先级只乘一次**：在 `finalize` 里，避免同一因子在通道内与通道外重复计权。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Iterable, Sequence

from ..ontology.model import DOC, TOP, OntologyModel
from ..schemas import Chunk, RecallStats, ScoredChunk, SparqlTrace
from ..settings import Settings
from ..sparql_guard import INTERNAL_FORMS, prepare
from .compat import CompatVerdict, OntologyCompatibility
from .contract import StructuredQuery, local_of
from .planner import PlannedQuery, SparqlPlanner
from .scoring import (
    ScoringConfig,
    finalize,
    fuse,
    graph_score,
    keyword_score,
    ontology_overlap,
    path_strength,
    term_coverage,
    vector_score,
)

# 实体 -> 条款 -> 分块。深度写进结果，用于给"证据离实体有多近"打分。
# 三跳以上不再展开：那已经是"邻居的邻居的邻居"，与本题的相关性靠关键词补，
# 继续扩会让图谱通道退化成全库扫描。
_SEED_CHUNK_QUERY = """PREFIX doc: <{doc}>
SELECT DISTINCT ?seed ?chunk ?depth WHERE {{
  VALUES ?seed {{ {values} }}
  {{ ?seed doc:chunkId ?chunk . BIND(0 AS ?depth) }}
  UNION {{ ?seed ?p1 ?mid . ?mid doc:chunkId ?chunk . BIND(1 AS ?depth) }}
  UNION {{ ?mid2 ?p2 ?seed . ?mid2 doc:chunkId ?chunk . BIND(2 AS ?depth) }}
}}"""

# 业务编号收窄：用户点名 C-2024-001 时，只保留能挂到这个编号上的实体。
# 图层面做而不是对结果行做文本匹配，是因为编号常常不直接被投影出来
# （付款单的 IRI 里没有合同编号，但 appliesToContract 指着它）。
_IDENTIFIER_QUERY = """PREFIX top: <{top}>
SELECT DISTINCT ?seed WHERE {{
  VALUES ?seed {{ {values} }}
  {{ ?seed top:identifier ?ident }}
  UNION {{ ?seed ?p ?neighbor . ?neighbor top:identifier ?ident }}
  FILTER(?ident IN ({identifiers}))
}}"""

# 单个 seed 的展开上限：防止某个枢纽实体（被上千条款引用）把查询拖死
_MAX_SEEDS = 40


@dataclass(slots=True)
class TierReport:
    """单通道的执行结论。`reason` 是排障时最先要看的东西。

    `fetched` 是后端返回条数，`kept` 是进入融合的条数，`survived` 是通过
    时效与兼容性过滤的条数。三者的差就是"这一层丢掉多少"，必须分开看：
    把过滤损失算到召回头上，是调检索参数时最常见的误判。
    """

    tier: str
    executed: bool
    reason: str
    fetched: int = 0
    kept: int = 0
    survived: int = 0
    elapsed_ms: float = 0.0


@dataclass(slots=True)
class FilterOutcome:
    """过滤与排序的结论。

    `survivors` 是**过滤后、截断前**的全部 chunk_id：区分"被本体删掉"与
    "排序靠后被 top_k 截掉"必须靠它，两者在调试面板上的含义完全不同。
    """

    items: list[ScoredChunk]
    survivors: list[str]
    dropped: dict[str, str]


@dataclass(slots=True)
class RetrievalResult:
    """三级检索的完整产出。

    `tier_items` / `dropped` / `seed_paths` 是**调试观测用**的中间态，
    不参与排序也不进审计。之所以由服务层一并返回、而不是让调试端重跑一遍：
    重跑会得到另一批中间结果（向量门槛、图库时序都会变），
    "看到的"和"跑出来的"就成了两回事。
    """

    items: list[ScoredChunk]
    stats: RecallStats
    trace: SparqlTrace
    seeds: list[str]
    tiers: list[TierReport] = field(default_factory=list)
    # 每个通道的原始候选（未融合、未过滤）；分通道展示必须用这个
    tier_items: dict[str, list[ScoredChunk]] = field(default_factory=dict)
    # 融合阶段被丢弃的分块 -> 原因（deprecated / expired / incompatible）
    dropped: dict[str, str] = field(default_factory=dict)
    # 图谱通道：chunk_id -> (命中的种子实体, 跳数)
    seed_paths: dict[str, tuple[str, int]] = field(default_factory=dict)
    # 过滤后、top_k 截断前的全部 chunk_id
    survivors: list[str] = field(default_factory=list)

    def chunk_ids(self) -> list[str]:
        return [item.chunk.chunk_id for item in self.items]


class HybridRetrievalService:
    """把结构化查询变成一组有排序、有理由的证据分块。"""

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
        self.config = ScoringConfig.from_settings(settings)
        self.compat = OntologyCompatibility(ontology)
        self.planner = SparqlPlanner(ontology, max_rows=settings.sparql_max_rows)
        # 关键词与向量的候选窗口：召回层要留出过滤余量，
        # 否则兼容性过滤一删就凑不满 top_k，等于把过滤成本转嫁给下游
        self.keyword_window = int(getattr(settings, "retrieval_keyword_window", 3))
        self.vector_window = int(getattr(settings, "retrieval_vector_window", 3))
        self.sufficiency = float(getattr(settings, "retrieval_sufficiency_score", 0.45))

    # ------------------------------ 入口 ------------------------------

    async def retrieve(
        self,
        tenant: Any,
        query: StructuredQuery,
        *,
        top_k: int,
        today: date | None = None,
    ) -> RetrievalResult:
        """执行三级检索。任何单通道失败都降级为空召回，不让整单失败。"""
        today = today or date.today()
        stats = RecallStats(weights=self.config.weights())
        tiers: list[TierReport] = []

        graph_items, trace, seeds, seed_paths = await self._run_graph(tenant, query, stats, tiers)

        keyword_items = await self._run_keyword(tenant, query, top_k, stats, tiers)

        # 先只看前两级：向量要不要跑，取决于它们的表现
        stage_one = self._merge([*graph_items, *keyword_items])
        need_vector, gate_reason = self._need_vector(stage_one, top_k)
        if need_vector:
            vector_items = await self._run_vector(tenant, query, top_k, stats, tiers)
        else:
            vector_items = []
            tiers.append(TierReport("vector", False, f"skipped:{gate_reason}"))

        fused = self._merge([*graph_items, *keyword_items, *vector_items])
        stats.vector_triggered = bool(vector_items) or need_vector
        stats.graph_seeds = len(seeds)
        stats.tier_decisions = {report.tier: report.reason for report in tiers}

        ranked, stats, outcome = self._filter_and_rank(fused, query, stats, today, top_k, tiers)
        return RetrievalResult(
            items=ranked,
            stats=stats,
            trace=trace,
            seeds=seeds,
            tiers=tiers,
            tier_items={
                "graph": graph_items,
                "keyword": keyword_items,
                "vector": vector_items,
            },
            dropped=outcome.dropped,
            seed_paths=seed_paths,
            survivors=outcome.survivors,
        )

    # ------------------------------ 第一级：图谱 ------------------------------

    async def _run_graph(
        self, tenant: Any, query: StructuredQuery, stats: RecallStats, tiers: list[TierReport]
    ) -> tuple[list[ScoredChunk], SparqlTrace, list[str], dict[str, tuple[str, int]]]:
        """SPARQL 取事实，再顺着证据链映射到分块。"""
        empty_trace = SparqlTrace(query="", graph_uri=tenant.graph_uri)
        planned = self.planner.plan(query)
        if planned is None:
            tiers.append(TierReport("graph", False, "skipped:no-entity-space"))
            return [], empty_trace, [], {}
        if planned.notes:
            # 备注不阻断检索，但必须留痕：否则"查询没带时间过滤"这类偏差无从发现
            tiers.append(TierReport("graph", True, "notes:" + ",".join(planned.notes)))
        else:
            tiers.append(TierReport("graph", True, "planned"))

        sparql = prepare(
            planned.sparql,
            tenant.graph_uri,
            self.settings.sparql_max_rows,
            allowed_forms=INTERNAL_FORMS,
        )
        started = time.perf_counter()
        try:
            rows = await self.graph.select(
                tenant.graph_uri,
                sparql,
                timeout=self.settings.sparql_timeout_seconds,
                max_rows=self.settings.sparql_max_rows,
            )
        except Exception as error:  # noqa: BLE001 - 图谱失败降级，由后面的通道兜底
            tiers[-1].reason = f"failed:{type(error).__name__}"
            tiers[-1].elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
            return [], SparqlTrace(query=sparql, graph_uri=tenant.graph_uri), [], {}

        elapsed_ms = (time.perf_counter() - started) * 1000
        rows = [row for row in rows if row.get("entity")]
        rows = self._narrow_rows(rows, query.identifiers)
        coverage = self._coverage_by_entity(rows, planned)
        seeds = self._seed_iris(rows)

        if query.identifiers and seeds:
            narrowed = await self._narrow_seeds(tenant, seeds, query.identifiers)
            if narrowed:
                seeds = narrowed
            elif seeds:
                tiers[-1].reason += "|identifier-unmatched"

        trace = SparqlTrace(
            query=sparql,
            row_count=len(rows),
            graph_uri=tenant.graph_uri,
            elapsed_ms=round(elapsed_ms, 2),
        )
        # 通道耗时必须落在这条通道上：0.0 会被读成"立即返回"，掩盖真实开销
        tiers[-1].elapsed_ms = round(elapsed_ms, 2)
        tiers[-1].fetched = len(rows)
        if not seeds:
            tiers[-1].reason += "|no-seed"
            return [], trace, [], {}

        paths = await self._chunks_for_seeds(tenant, seeds)
        if not paths:
            tiers[-1].reason += "|no-chunk-link"
            return [], trace, [], {}

        found = await self.chunks.get_many(tenant.tenant_id, list(paths))
        items: list[ScoredChunk] = []
        for chunk_id, (seed, depth) in paths.items():
            chunk = found.get(chunk_id)
            if chunk is None:
                continue
            property_coverage = coverage.get(seed, 0.0)
            raw = graph_score(depth, property_coverage)
            items.append(
                ScoredChunk(
                    chunk=chunk,
                    tier="graph",
                    raw_score=raw,
                    normalized_score=raw,
                    matched_on=["sparql"],
                    breakdown={
                        "path_strength": round(path_strength(depth), 4),
                        "property_coverage": round(property_coverage, 4),
                        "depth": float(depth),
                    },
                )
            )
        tiers[-1].kept = len(items)
        stats.per_tier["graph"] = len(items)
        return items, trace, seeds, paths

    def _coverage_by_entity(self, rows: Sequence[dict[str, Any]], planned: PlannedQuery) -> dict[str, float]:
        """每个实体的"事实完整度"：约束要求的属性中真正取回的比例。

        取到 3/4 个属性的实体，说明它的数据不全，回答依赖它的算术结论就要谨慎。
        这比"有事实就给满分"多了一层信息，而且完全由图结构决定，不受行序影响。
        """
        if not planned.projected:
            return {str(row["entity"]): 1.0 for row in rows if row.get("entity")}
        coverage: dict[str, float] = {}
        for row in rows:
            entity = str(row.get("entity") or "")
            if not entity:
                continue
            bound = sum(1 for var in planned.projected if row.get(var))
            ratio = bound / len(planned.projected)
            coverage[entity] = max(coverage.get(entity, 0.0), ratio)
        return coverage

    # ------------------------------ 第二级：关键词 ------------------------------

    async def _run_keyword(
        self, tenant: Any, query: StructuredQuery, top_k: int, stats: RecallStats, tiers: list[TierReport]
    ) -> list[ScoredChunk]:
        """ES / pg 全文检索：匹配条款原话。"""
        if not query.raw.strip():
            tiers.append(TierReport("keyword", False, "skipped:no-query-text"))
            return []
        started = time.perf_counter()
        try:
            items = await self.keyword.search(
                tenant.tenant_id,
                query.raw,
                filters=query.filters,
                top_k=max(top_k * self.keyword_window, top_k),
            )
        except Exception as error:  # noqa: BLE001
            tiers.append(
                TierReport("keyword", False, f"failed:{type(error).__name__}", elapsed_ms=round((time.perf_counter() - started) * 1000, 2))
            )
            return []

        terms = self._query_terms(query)
        for item in items:
            coverage = term_coverage(item.chunk.text, terms)
            item.normalized_score = keyword_score(item.raw_score, coverage, self.config)
            item.breakdown = {
                "rank_score": round(item.raw_score, 4),
                "term_coverage": round(coverage, 4),
            }
        tiers.append(
            TierReport(
                "keyword",
                True,
                "executed",
                fetched=len(items),
                kept=len(items),
                elapsed_ms=round((time.perf_counter() - started) * 1000, 2),
            )
        )
        stats.per_tier["keyword"] = len(items)
        return items

    # ------------------------------ 第三级：向量 ------------------------------

    def _need_vector(self, stage_one: list[ScoredChunk], top_k: int) -> tuple[bool, str]:
        """判定向量是否需要触发。

        充足 = 条数够 **且** 最高分够。只看条数会被"一堆弱相关分块"骗过，
        只看分数会在命中一条极强证据时忽略覆盖不足。
        """
        count = len(stage_one)
        best = max((item.weighted_score for item in stage_one), default=0.0)
        if count >= top_k and best >= self.sufficiency:
            return False, f"sufficient:count={count},best={best:.3f}"
        if count < top_k:
            return True, f"insufficient-count:{count}/{top_k}"
        return True, f"insufficient-score:{best:.3f}<{self.sufficiency}"

    async def _run_vector(
        self, tenant: Any, query: StructuredQuery, top_k: int, stats: RecallStats, tiers: list[TierReport]
    ) -> list[ScoredChunk]:
        """向量补全。任何一步失败都降级为空，不阻断主链路。"""
        text = query.raw.strip() or " ".join(entity.surface for entity in query.entities if entity.surface)
        if not text:
            tiers.append(TierReport("vector", False, "skipped:no-text"))
            return []
        started = time.perf_counter()
        try:
            vectors = await self.embedder.embed([text])
            if not vectors:
                tiers.append(TierReport("vector", False, "skipped:no-embedding"))
                return []
            candidates = await self.vector.search(
                tenant.tenant_id, vectors[0], top_k=max(top_k * self.vector_window, top_k)
            )
        except Exception as error:  # noqa: BLE001
            tiers.append(
                TierReport("vector", False, f"failed:{type(error).__name__}", elapsed_ms=round((time.perf_counter() - started) * 1000, 2))
            )
            return []

        kept: list[ScoredChunk] = []
        incompatible = 0
        weak = 0
        for item in candidates:
            verdict = self.compat.check_chunk(
                item.chunk,
                query_classes=query.effective_classes(),
                query_properties=self._query_properties(query),
                tier="vector",
            )
            if not verdict.compatible:
                incompatible += 1
                continue
            score = vector_score(item.raw_score, self.config)
            if score <= 0.0:
                # 低于基线是"弱"，不是"脏"：混进脏召回率会让这个指标失去意义
                weak += 1
                continue
            item.normalized_score = score
            item.breakdown = {"cosine": round(item.raw_score, 4), "trust": self.config.vector_trust}
            item.reason = verdict.reason
            kept.append(item)

        # 向量在融合**之前**就过滤，单独披露条数，否则脏召回率会被这块稀释
        stats.prefiltered_vector += incompatible
        tiers.append(
            TierReport(
                "vector",
                True,
                f"executed:incompatible={incompatible},weak={weak}",
                fetched=len(candidates),
                kept=len(kept),
                elapsed_ms=round((time.perf_counter() - started) * 1000, 2),
            )
        )
        stats.per_tier["vector"] = len(kept)
        return kept

    # ------------------------------ 融合 ------------------------------

    def _merge(self, items: Iterable[ScoredChunk]) -> list[ScoredChunk]:
        """同一分块被多通道命中时合流：权重相加 + 交叉验证加分。"""
        groups: dict[str, ScoredChunk] = {}
        contributions: dict[str, list[tuple[str, float]]] = {}
        for item in items:
            key = item.chunk.chunk_id
            existing = groups.get(key)
            if existing is None:
                item.matched_on = list(dict.fromkeys([*(item.matched_on or []), item.tier]))
                groups[key] = item
                contributions[key] = [(item.tier, item.normalized_score)]
                continue
            for tag in item.matched_on or [item.tier]:
                if tag not in existing.matched_on:
                    existing.matched_on.append(tag)
            if item.tier not in existing.matched_on:
                existing.matched_on.append(item.tier)
            contributions[key].append((item.tier, item.normalized_score))
            # 保留更强的通道分，避免"先到的弱命中"压住后到的强命中
            if item.normalized_score > existing.normalized_score:
                existing.raw_score = item.raw_score
                existing.normalized_score = item.normalized_score
                existing.breakdown = {**existing.breakdown, **item.breakdown}

        for key, item in groups.items():
            score, breakdown = fuse(contributions[key], self.config)
            item.weighted_score = score
            item.breakdown.update(breakdown)
        return sorted(groups.values(), key=lambda entry: (-entry.weighted_score, entry.chunk.chunk_id))

    # ------------------------------ 过滤与排序 ------------------------------

    def _filter_and_rank(
        self,
        fused: list[ScoredChunk],
        query: StructuredQuery,
        stats: RecallStats,
        today: date,
        top_k: int,
        tiers: list[TierReport],
    ) -> tuple[list[ScoredChunk], RecallStats, FilterOutcome]:
        """召回后：时效/废止 → 本体兼容性 → 业务加权 → 稳定排序。

        `dropped` 记录每个被剔除分块的原因。只写进返回结构、不进审计：
        它的用途是让"这条为什么没出现"当场可答，而不是靠重跑猜。
        """
        include_history = bool(query.filters.get("include_history"))
        priority_max = query.filters.get("priority_max")
        query_classes = query.effective_classes()
        query_properties = self._query_properties(query)

        stats.fused = len(fused)
        kept: list[ScoredChunk] = []
        dropped: dict[str, str] = {}
        compat_dropped = 0
        for item in fused:
            chunk = item.chunk
            if chunk.deprecated:
                stats.dropped_deprecated += 1
                dropped[chunk.chunk_id] = "deprecated"
                continue
            if not include_history and not chunk.is_effective(today):
                stats.dropped_expired += 1
                dropped[chunk.chunk_id] = "expired"
                continue
            if priority_max is not None and chunk.priority > int(priority_max):
                stats.dropped_expired += 1
                dropped[chunk.chunk_id] = "priority-exceeded"
                continue

            verdict = self._verdict_for(item, query_classes, query_properties)
            if not verdict.compatible:
                compat_dropped += 1
                item.breakdown["compat"] = 0.0
                dropped[chunk.chunk_id] = f"incompatible:{verdict.reason}"
                continue
            item.reason = verdict.reason

            overlap = ontology_overlap(
                chunk.classes, chunk.properties, query_classes, query_properties
            )
            score, detail = finalize(
                item.weighted_score, overlap=overlap, chunk=chunk, today=today, config=self.config
            )
            item.weighted_score = score
            item.breakdown.update(detail)
            kept.append(item)

        stats.dropped_dirty += compat_dropped
        stats.after_filter = len(kept)
        stats.dirty_recall_rate = round(compat_dropped / stats.fused, 4) if stats.fused else 0.0

        # 稳定排序：文档优先级参与"同分裁决"，最后才用 chunk_id —— 保证同一输入
        # 无论后端返回顺序如何都得到同一份证据列表
        kept.sort(key=lambda entry: (-entry.weighted_score, entry.chunk.priority, entry.chunk.chunk_id))
        stats.best_score = round(kept[0].weighted_score, 6) if kept else 0.0

        for report in tiers:
            report.survived = _count_tier(kept, report.tier)
        return kept[:top_k], stats, FilterOutcome(
            items=kept[:top_k],
            survivors=[entry.chunk.chunk_id for entry in kept],
            dropped=dropped,
        )

    def _verdict_for(
        self, item: ScoredChunk, query_classes: set[str], query_properties: set[str]
    ) -> CompatVerdict:
        """图谱命中豁免判定；其余按本体兼容性裁决。"""
        tier = "graph" if "graph" in item.matched_on else item.tier
        return self.compat.check_chunk(
            item.chunk,
            query_classes=query_classes,
            query_properties=query_properties,
            tier=tier,
        )

    # ------------------------------ 图内辅助查询 ------------------------------

    async def _chunks_for_seeds(self, tenant: Any, seeds: Sequence[str]) -> dict[str, tuple[str, int]]:
        """实体 -> 分块，返回 `chunk_id -> (最强 seed, 最短深度)`。"""
        values = " ".join(f"<{iri}>" for iri in seeds[:_MAX_SEEDS])
        sparql = prepare(
            _SEED_CHUNK_QUERY.format(doc=DOC, values=values),
            tenant.graph_uri,
            400,
            allowed_forms=INTERNAL_FORMS,
        )
        try:
            rows = await self.graph.select(
                tenant.graph_uri,
                sparql,
                timeout=self.settings.sparql_timeout_seconds,
                max_rows=400,
            )
        except Exception:  # noqa: BLE001 - 链路查询失败只是"没有图谱证据"，不阻断
            return {}

        paths: dict[str, tuple[str, int]] = {}
        for row in rows:
            chunk_id = row.get("chunk")
            seed = row.get("seed")
            if not isinstance(chunk_id, str) or not isinstance(seed, str):
                continue
            try:
                depth = int(str(row.get("depth") or 0))
            except ValueError:
                depth = 2
            current = paths.get(chunk_id)
            if current is None or depth < current[1]:
                paths[chunk_id] = (seed, depth)
        return paths

    async def _narrow_seeds(self, tenant: Any, seeds: Sequence[str], identifiers: Sequence[str]) -> list[str]:
        """业务编号收窄。匹配不到就返回空，由调用方决定是否保留全集。"""
        values = " ".join(f"<{iri}>" for iri in seeds[:_MAX_SEEDS])
        literals = ", ".join(f'"{_escape(str(item))}"' for item in identifiers)
        sparql = prepare(
            _IDENTIFIER_QUERY.format(top=TOP, values=values, identifiers=literals),
            tenant.graph_uri,
            _MAX_SEEDS * 4,
            allowed_forms=INTERNAL_FORMS,
        )
        try:
            rows = await self.graph.select(
                tenant.graph_uri,
                sparql,
                timeout=self.settings.sparql_timeout_seconds,
                max_rows=_MAX_SEEDS * 4,
            )
        except Exception:  # noqa: BLE001
            return []
        allowed = {str(row["seed"]) for row in rows if row.get("seed")}
        return [seed for seed in seeds if seed in allowed]

    @staticmethod
    def _narrow_rows(rows: list[dict[str, Any]], identifiers: Sequence[str]) -> list[dict[str, Any]]:
        """行级收窄（第一道）。命中不到时保留全集，交给图层面的精确收窄。"""
        if not identifiers:
            return rows
        narrowed = [
            row
            for row in rows
            if any(identifier in str(value) for identifier in identifiers for value in row.values() if value)
        ]
        return narrowed or rows

    @staticmethod
    def _seed_iris(rows: Iterable[dict[str, Any]]) -> list[str]:
        """从结果行里挑出属于本租户的实例 IRI。

        投影出来的对象 IRI 也算种子：付款单行里的 `appliesToContract` 指向的合同
        本身就是一份证据来源，漏掉它会把"合同条款"整段丢掉。
        """
        seeds: list[str] = []
        for row in rows:
            for value in row.values():
                if not isinstance(value, str) or not value.startswith(("http://", "https://", "urn:")):
                    continue
                if "/tenant/" not in value and "ontorag.local" not in value:
                    continue
                if value.endswith(("#", "/")):
                    continue
                if value in seeds:
                    continue
                seeds.append(value)
        return seeds[:_MAX_SEEDS]

    # ------------------------------ 查询侧辅助 ------------------------------

    def _query_properties(self, query: StructuredQuery) -> set[str]:
        """兼容性判定用的属性集合：点名属性 + 约束隐含属性。"""
        return query.property_locals() | query.constraint_property_locals()

    @staticmethod
    def _query_terms(query: StructuredQuery) -> list[str]:
        """关键词覆盖率用的"查询概念"。

        优先用已对齐的实体表面形式（"付款申请""超付"），它比原始问句更能代表
        "这条查询在问什么"；没有实体时退回问句本身，保证覆盖率不会恒为 0。
        """
        terms = [entity.surface or entity.local for entity in query.entities if (entity.surface or entity.local)]
        terms.extend(query.identifiers)
        if not terms and query.raw.strip():
            terms = [query.raw.strip()[:64]]
        return list(dict.fromkeys(terms))[:8]


def _count_tier(items: Sequence[ScoredChunk], tier: str) -> int:
    return sum(1 for item in items if tier in item.matched_on or item.tier == tier)


def _escape(text: str) -> str:
    """SPARQL 字符串字面量转义。业务编号已由解析层用正则限定字符集，这里是第二道。"""
    return text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
