"""POC 调试面板接口。

三个端点，各自只做一件事：

  POST /v1/debug/trace     跑一次完整链路，返回全部中间态（解析 / 三级召回 /
                           闸门 / 答案 / 溯源链 / 纯向量基线对照）
  GET  /v1/debug/examples  演示问题清单（每条都说明它想展示什么）
  GET  /v1/debug/ontology  本体概况（类、属性、形状名），供面板左侧参考

**不复用 `/v1/query`**：那个接口按产品语义返回"答案或 422"，被闸门拦下时
不给中间态。演示要的恰恰是"拦在哪、为什么拦"，所以必须走 `pipeline.inspect()`，
它与 `answer()` 共用同一条链路（见 `orchestrator._execute`），不是另一套实现。
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Any, Iterable

from fastapi import APIRouter

from ...ontology.model import SH, count_node_shapes
from ...retrieval import StructuredQuery, TierReport
from ...schemas import (
    BaselineSide,
    ChainStep,
    Citation,
    Claim,
    DebugTraceRequest,
    DebugTraceResponse,
    GuardReport,
    QueryIntent,
    RecallStats,
    SparqlTrace,
    StageTimingOut,
    TierChunk,
    TierDetail,
)
from ..deps import ContainerDep, TenantDep

router = APIRouter(prefix="/v1/debug", tags=["debug"])

_TIER_LABELS: dict[str, str] = {
    "graph": "本体图谱（SPARQL）",
    "keyword": "关键词（ES/pg）",
    "vector": "向量（兜底）",
}

# 演示问题：每条都对应一种"普通 RAG 会翻车、本体制导不会"的形态。
# 写在服务端而不是前端，是为了让演示脚本与数据集（tests/eval/qa_set.jsonl）
# 保持同一批问题——演示用的例子和验收用的例子不该是两个世界。
_EXAMPLES: tuple[dict[str, str], ...] = (
    {
        "question": "C-2024-001 这笔 700 万的付款申请是否超付？",
        "domain": "contract",
        "note": "图谱通道主导：付款单→合同→剩余应付由 SPARQL 事实链算出，超付结论有算式可复核",
    },
    {
        "question": "付款申请需要校验合同剩余应付吗",
        "domain": "contract",
        "note": "关键词通道主导：问题里没有业务编号，靠条款原话命中制度，再经本体过滤剔除跨域分块",
    },
    {
        "question": "S-BOILER 的核算边界是否冲突？",
        "domain": "carbon",
        "note": "跨域对照：同库里既有合同也有碳核算，普通 RAG 会把合同条款一并召回",
    },
    {
        "question": "历史 旧版 付款审批流程是什么",
        "domain": "contract",
        "note": "时效与废止：归档资料可进证据，已废止版本永不进入",
    },
)


@router.get("/examples")
async def examples() -> dict[str, Any]:
    """演示问题清单。无需鉴权：它只是静态文本。"""
    return {"items": list(_EXAMPLES)}


@router.get("/ontology")
async def ontology(container: ContainerDep) -> dict[str, Any]:
    """本体概况：面板顶部那几个"我们有这么多类/形状"的角标就靠它。"""
    from rdflib import URIRef
    from rdflib.namespace import RDF

    model = container.ontology
    shape_names = sorted(
        str(subject).rsplit("#", 1)[-1]
        for subject in model.claim_shapes.subjects(RDF.type, SH.NodeShape)
        if isinstance(subject, URIRef)
    )
    return {
        "classes": len(model.classes),
        "properties": len(model.properties),
        "aliases": len(model.aliases()),
        "shapes": count_node_shapes(model.shapes),
        "claim_shapes": count_node_shapes(model.claim_shapes),
        "shape_names": shape_names,
        "domains": sorted({iri.rsplit("#", 1)[0] for iri in (c.iri for c in model.classes.values())}),
        "shacl_engine": container.shacl_engine,
    }


@router.post("/trace", response_model=DebugTraceResponse)
async def trace(payload: DebugTraceRequest, tenant: TenantDep, container: ContainerDep) -> DebugTraceResponse:
    """跑一次完整链路并把中间态全部端出来。

    单阶段失败不影响返回：`error` 给出原因、`stages` 指出卡在哪一步，
    前面已经跑完的部分照常展示——"看到一半断掉"本身就是最有用的调试信息。
    """
    settings = container.settings
    bundle = await container.pipeline.inspect(
        tenant,
        payload.question,
        domain=payload.domain,
        top_k=payload.top_k,
    )

    retrieval = bundle.retrieval
    intent = bundle.intent
    trace_out = retrieval.trace if retrieval else SparqlTrace(query="", graph_uri=tenant.graph_uri)
    recall: RecallStats | None = retrieval.stats if retrieval else None

    tiers: list[TierDetail] = []
    if retrieval is not None:
        final_ids = {item.chunk.chunk_id for item in retrieval.items}
        survivors = set(retrieval.survivors)
        final_scores = {item.chunk.chunk_id: item.weighted_score for item in retrieval.items}
        tiers = [
            _tier_detail(
                report,
                retrieval.tier_items.get(report.tier, []),
                final_ids=final_ids,
                survivors=survivors,
                dropped=retrieval.dropped,
                seed_paths=retrieval.seed_paths,
                final_scores=final_scores,
                weight=recall.weights.get(report.tier, 0.0) if recall else 0.0,
            )
            for report in retrieval.tiers
        ]

    baseline = BaselineSide(enabled=False, reason="未启用")
    if payload.compare_baseline:
        baseline = await _baseline(
            container,
            tenant,
            payload.question,
            top_k=payload.top_k,
            intent=intent,
            final_ids={item.chunk.chunk_id for item in retrieval.items} if retrieval else set(),
        )

    guard: GuardReport | None = bundle.guard
    answer = bundle.response.answer if bundle.response else (
        bundle.generation.answer if bundle.generation else ""
    )
    claims: list[Claim] = list(bundle.generation.claims) if bundle.generation else []
    citations: list[Citation] = list(bundle.generation.citations) if bundle.generation else []

    return DebugTraceResponse(
        trace_id=bundle.trace_id,
        question=payload.question,
        parsed=intent,
        stages=[StageTimingOut(**asdict(stage)) for stage in bundle.stages],
        tiers=tiers,
        seeds=list(retrieval.seeds) if retrieval else [],
        sparql=trace_out,
        guard=guard,
        answer=answer,
        claims=claims,
        citations=citations,
        recall=recall,
        chain=_chain(bundle, baseline),
        baseline=baseline,
        blocked=bundle.blocked,
        block_reason=_block_reason(bundle),
        error=str(bundle.error) if bundle.error else "",
        model=settings.effective_llm_provider,
        total_ms=bundle.total_ms,
        weights=recall.weights if recall else {},
        provider=settings.effective_llm_provider,
        ontology={
            "classes": len(container.ontology.classes),
            "properties": len(container.ontology.properties),
            "claim_shapes": count_node_shapes(container.ontology.claim_shapes),
            "shacl_engine": container.shacl_engine,
        },
        prompt=(bundle.generation.prompt if bundle.generation and payload.expose_prompt else ""),
    )


# ------------------------------ 组装 ------------------------------


def _tier_detail(
    report: TierReport,
    items: Iterable[Any],
    *,
    final_ids: set[str],
    survivors: set[str],
    dropped: dict[str, str],
    seed_paths: dict[str, tuple[str, int]],
    final_scores: dict[str, float],
    weight: float,
) -> TierDetail:
    """把一个通道的执行结论和它的候选组装成面板能直接渲染的结构。"""
    chunks: list[TierChunk] = []
    for item in items:
        chunk_id = item.chunk.chunk_id
        if chunk_id in final_ids:
            status, reason = "final", ""
        elif chunk_id in dropped:
            status, reason = "dropped", dropped[chunk_id]
        elif chunk_id in survivors:
            # 通过了全部过滤，只是排序靠后被 top_k 截掉
            status, reason = "cut", "rank-cut"
        else:
            status, reason = "cut", "not-ranked"
        # 种子路径只属于图谱通道：关键词命中的同一分块没有"跳数"可言，
        # 把图的路径挂到关键词行上会让人以为它是顺着关系找出来的
        seed, depth = seed_paths.get(chunk_id, ("", 0)) if report.tier == "graph" else ("", 0)
        chunks.append(
            _chunk(
                item.chunk,
                score=item.normalized_score,
                final_score=final_scores.get(chunk_id, 0.0),
                matched_on=list(item.matched_on),
                breakdown=dict(item.breakdown),
                status=status,
                drop_reason=reason,
                verdict=item.reason,
                seed=seed,
                depth=depth,
            )
        )
    chunks.sort(key=lambda entry: (-entry.score, entry.chunk_id))
    return TierDetail(
        tier=report.tier,
        label=_TIER_LABELS.get(report.tier, report.tier),
        weight=weight,
        executed=report.executed,
        reason=report.reason,
        fetched=report.fetched,
        kept=report.kept,
        survived=report.survived,
        elapsed_ms=report.elapsed_ms,
        chunks=chunks,
    )


def _chunk(
    chunk: Any,
    *,
    score: float,
    final_score: float,
    matched_on: list[str],
    breakdown: dict[str, float],
    status: str,
    drop_reason: str,
    verdict: str,
    seed: str = "",
    depth: int = 0,
) -> TierChunk:
    return TierChunk(
        chunk_id=chunk.chunk_id,
        doc_id=chunk.doc_id,
        doc_title=chunk.doc_title,
        doc_type=chunk.doc_type,
        clause_no=chunk.clause_no,
        text=chunk.text,
        priority=chunk.priority,
        classes=list(chunk.classes),
        properties=list(chunk.properties),
        effective_from=chunk.effective_from,
        effective_to=chunk.effective_to,
        deprecated=chunk.deprecated,
        score=round(float(score), 6),
        final_score=round(float(final_score), 6),
        matched_on=matched_on,
        breakdown={key: round(float(value), 6) for key, value in breakdown.items()},
        status=status,  # type: ignore[arg-type]
        drop_reason=drop_reason,
        verdict=verdict,
        seed=seed,
        depth=depth,
    )


async def _baseline(
    container: Any,
    tenant: Any,
    question: str,
    *,
    top_k: int,
    intent: QueryIntent | None,
    final_ids: set[str],
) -> BaselineSide:
    """普通 RAG 的对照：纯向量 top-k，不做本体过滤、不用 SPARQL 事实。

    `dirty` 只统计"本体判定与本题不兼容"的条数，判据直接调用检索层的
    `OntologyCompatibility`——对照组的判定口径必须和被对照组同源，
    否则"差异"只是两套阈值之差，证明不了本体制导有用。
    """
    try:
        vectors = await container.embedder.embed([question])
        if not vectors:
            return BaselineSide(enabled=False, reason="向量化不可用（未取到向量）")
        hits = await container.vector.search(tenant.tenant_id, vectors[0], top_k=top_k)
    except Exception as error:  # noqa: BLE001 —— 对照失败不能拖垮主结论
        return BaselineSide(enabled=False, reason=f"向量检索不可用：{type(error).__name__}")

    query = StructuredQuery.from_intent(intent) if intent is not None else None
    classes = query.effective_classes() if query else set()
    properties = (query.property_locals() | query.constraint_property_locals()) if query else set()

    chunks: list[TierChunk] = []
    dirty = 0
    for item in hits:
        verdict = container.retriever.service.compat.check_chunk(
            item.chunk,
            query_classes=classes,
            query_properties=properties,
            tier="vector",
        )
        if not verdict.compatible:
            dirty += 1
        chunks.append(
            _chunk(
                item.chunk,
                score=item.raw_score,
                final_score=float(item.raw_score),
                matched_on=["vector"],
                breakdown={"cosine": round(float(item.raw_score), 4)},
                status="final",
                drop_reason="" if verdict.compatible else "incompatible",
                verdict=verdict.reason,
            )
        )

    naive_ids = [entry.chunk_id for entry in chunks]
    return BaselineSide(
        enabled=True,
        chunks=chunks,
        total=len(chunks),
        dirty=dirty,
        overlap=[cid for cid in naive_ids if cid in final_ids],
        only_naive=[cid for cid in naive_ids if cid not in final_ids],
        only_ontology=sorted(final_ids - set(naive_ids)),
    )


def _chain(bundle: Any, baseline: BaselineSide) -> list[ChainStep]:
    """把一次链路压成一条可读的链：问题 → 实体 → 事实 → 条款 → 断言 → 闸门 → 答案。"""
    steps: list[ChainStep] = [ChainStep(kind="query", title="问题", detail=bundle.question)]
    intent = bundle.intent
    if intent is not None:
        aligned = [mention for mention in intent.entities if mention.iri]
        steps.append(
            ChainStep(
                kind="entity",
                title="实体对齐",
                detail=f"{len(aligned)}/{len(intent.entities)} 个表面形式对齐到本体；"
                f"类 {len(intent.classes)} 个、属性 {len(intent.properties)} 个、约束 {len(intent.constraints)} 条",
                refs=[mention.iri for mention in aligned if mention.iri][:6],
            )
        )

    retrieval = bundle.retrieval
    if retrieval is not None:
        steps.append(
            ChainStep(
                kind="fact",
                title="SPARQL 事实",
                detail=f"返回 {retrieval.trace.row_count} 行，取到 {len(retrieval.seeds)} 个实体种子；"
                f"图谱证据 {len(retrieval.tier_items.get('graph', []))} 条",
                refs=retrieval.seeds[:4],
            )
        )
        for item in retrieval.items[:3]:
            seed, depth = retrieval.seed_paths.get(item.chunk.chunk_id, ("", 0))
            hop = f" · {depth} 跳命中 {seed.rsplit('/', 1)[-1]}" if seed else ""
            steps.append(
                ChainStep(
                    kind="clause",
                    title=f"{item.chunk.doc_title} {item.chunk.clause_no}",
                    detail=f"融合分 {item.weighted_score:.3f} · 通道 {'+'.join(item.matched_on)}{hop}",
                    refs=[item.chunk.chunk_id],
                )
            )

    if bundle.generation is not None:
        claims = bundle.generation.claims
        preview = "；".join(f"{claim.subject.rsplit('#', 1)[-1]} {claim.predicate.rsplit('#', 1)[-1]} {claim.object}" for claim in claims[:3])
        steps.append(
            ChainStep(
                kind="claim",
                title="结论断言",
                detail=f"{len(claims)} 条结构化断言：{preview or '（无）'}",
                refs=[claim.subject for claim in claims[:3]],
            )
        )

    guard = bundle.guard
    if guard is not None:
        counts = "、".join(f"{key} {value}" for key, value in sorted(guard.counts.items())) or "无结果"
        steps.append(
            ChainStep(
                kind="guard",
                title="SHACL 闸门",
                detail=f"{'通过' if guard.conforms else '阻断'} · 引擎 {guard.engine} · "
                f"校验 {guard.checked_triples} 条三元组 · {counts}",
                refs=list(guard.shapes_checked),
            )
        )

    if bundle.error is not None:
        steps.append(ChainStep(kind="answer", title="链路中断", detail=str(bundle.error)))
    elif bundle.response is not None:
        steps.append(
            ChainStep(
                kind="answer",
                title="最终答案",
                detail=f"{len(bundle.response.citations)} 条溯源 · 模型 {bundle.response.model}",
            )
        )
    if baseline.enabled:
        steps.append(
            ChainStep(
                kind="fact",
                title="对照：普通 RAG",
                detail=f"纯向量召回 {baseline.total} 条，其中 {baseline.dirty} 条被本体判定为不兼容；"
                f"与本体制导重合 {len(baseline.overlap)} 条",
            )
        )
    return steps


def _block_reason(bundle: Any) -> str:
    """给"为什么没出答案"一句人话。被闸门拦下与链路报错必须能区分。"""
    if not bundle.blocked:
        return ""
    guard = bundle.guard
    if guard is not None and not guard.conforms:
        return f"SHACL 校验未通过（{guard.counts.get('Violation', 0)} 条 Violation），回答已阻断"
    if bundle.error is not None:
        return str(bundle.error)
    return "已被阻断"
