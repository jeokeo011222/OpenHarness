"""Harness 工具插件的服务端实现：SPARQL / SHACL / 实体链接。

这三个端点就是插件侧三个工具的**唯一落地实现**。插件（TypeScript）只做
参数校验、渲染与生命周期编排，任何业务判定都在这里完成——这样换前端、
换宿主都不影响闸门语义。

共同约束：
- 租户来自请求头，由 `TenantDep` 校验，工具本身没有"切换租户"的入口；
- 每个端点都有显式耗时上限，超时一律转 400/503，不返回半成品；
- 校验失败不是异常而是结论：SHACL 不过 → 422 + 冲突明细。
"""

from __future__ import annotations

import asyncio
from time import perf_counter

from fastapi import APIRouter
from rdflib import Graph

from ...errors import OntologyGuardError, QueryError
from ...pipeline.guard import fetch_context_graph
from ...schemas import (
    EntityLinkRequest,
    EntityLinkResponse,
    GuardReport,
    ShaclToolRequest,
    SparqlToolRequest,
    SparqlToolResponse,
)
from ...sparql_guard import prepare
from ..deps import ContainerDep, TenantDep

router = APIRouter(prefix="/v1/tools", tags=["tools"])


@router.post("/sparql", response_model=SparqlToolResponse)
async def sparql_query(
    payload: SparqlToolRequest, tenant: TenantDep, container: ContainerDep
) -> SparqlToolResponse:
    """只读 SPARQL：单语句 + 形态白名单 + 租户图强约束 + 行数与耗时上限。"""
    settings = container.settings
    limit = min(payload.limit, settings.sparql_max_rows)

    # 调用方只能把超时调小：显式 timeout_ms 与全局上限取小，再与配置取小
    timeout = min(settings.sparql_timeout_seconds, settings.sparql_max_timeout_seconds)
    if payload.timeout_ms is not None:
        timeout = min(timeout, payload.timeout_ms / 1000)

    started = perf_counter()
    prepared = prepare(
        payload.sparql,
        tenant.graph_uri,
        limit,
        allowed_forms=settings.sparql_forms,
    )
    try:
        rows = await asyncio.wait_for(
            container.graph.select(
                tenant.graph_uri,
                prepared,
                timeout=timeout,
                max_rows=limit,
            ),
            timeout=timeout,
        )
    except TimeoutError as error:
        # 超时不当成"空结果"：返回空列表会让模型以为"查过了没有"，
        # 进而编造一个"没有相关记录"的结论。
        raise QueryError(
            "SPARQL 超出执行时间上限",
            details={"timeout_seconds": timeout},
        ) from error

    elapsed = round((perf_counter() - started) * 1000, 2)
    columns = list(rows[0].keys()) if rows else []
    return SparqlToolResponse(
        query=prepared,
        graph=tenant.graph_uri,
        count=len(rows),
        rows=rows,
        columns=columns,
        truncated=len(rows) >= limit,
        elapsed_ms=elapsed,
    )


@router.post("/shacl", response_model=GuardReport)
async def shacl_validate(
    payload: ShaclToolRequest, tenant: TenantDep, container: ContainerDep
) -> GuardReport:
    """校验候选三元组；出现 Violation 即 422（阻断），Warning 只进报告。"""
    validator = container.validator_for(payload.engine)
    seeds = [claim.subject for claim in payload.triples if claim.subject.startswith(("http://", "https://"))]
    facts = (
        await fetch_context_graph(container.graph, tenant.graph_uri, seeds)
        if payload.include_tenant_facts
        else Graph()
    )
    report = await validator.validate_async(
        facts,
        payload.triples,
        include_tenant_facts=payload.include_tenant_facts,
        fail_on_warning=payload.fail_on_warning,
    )
    if report.blocked:
        raise OntologyGuardError(
            "候选三元组未通过 SHACL 校验",
            details={"guard": report.model_dump(mode="json")},
        )
    # 通过但带提示：正常返回，warnings 字段里能看到"有哪些风险需要人复核"
    return report


@router.post("/entity-link", response_model=EntityLinkResponse)
async def entity_link(
    payload: EntityLinkRequest, tenant: TenantDep, container: ContainerDep
) -> EntityLinkResponse:
    """实体链接与术语归一：词表对齐为主，模型抽取为辅。"""
    settings = container.settings
    started = perf_counter()
    result = await container.entity_linker.link(
        payload.text,
        tenant_id=tenant.tenant_id,
        domain=payload.domain,
        use_llm=payload.use_llm and settings.entity_link_use_llm,
    )
    return EntityLinkResponse(
        mentions=result.mentions,
        normalized_text=result.normalized_text,
        extractor=result.extractor,
        unmapped=result.unmapped,
        elapsed_ms=round((perf_counter() - started) * 1000, 2),
    )
