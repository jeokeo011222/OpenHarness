"""Harness 生命周期钩子的服务端实现。

pre_retrieval_hook  ：Query 本体解析，把意图注入模型上下文。
post_generation_hook：生成后强制 SHACL 校验，不通过直接阻断。
"""

from __future__ import annotations

from fastapi import APIRouter

from ...errors import OntologyGuardError
from ...pipeline.guard import fetch_context_graph
from ...schemas import GuardReport, PostGenerationRequest, PreRetrievalRequest, QueryIntent
from ..deps import ContainerDep, TenantDep

router = APIRouter(prefix="/v1/hooks", tags=["hooks"])


@router.post("/pre-retrieval", response_model=QueryIntent)
async def pre_retrieval(payload: PreRetrievalRequest, tenant: TenantDep, container: ContainerDep) -> QueryIntent:
    """解析 Query：实体、属性、约束、SPARQL 模板。"""
    return await container.parser.parse(tenant.tenant_id, payload.query, payload.domain)


@router.post("/post-generation", response_model=GuardReport)
async def post_generation(
    payload: PostGenerationRequest,
    tenant: TenantDep,
    container: ContainerDep,
) -> GuardReport:
    """校验候选结论；不合规立即抛 422，绝不返回正文。"""
    seeds = [claim.subject for claim in payload.claims if claim.subject.startswith(("http://", "https://"))]
    facts = await fetch_context_graph(container.graph, tenant.graph_uri, seeds)
    report = await container.validator.validate_async(facts, payload.claims, include_tenant_facts=True)
    if not report.conforms:
        raise OntologyGuardError(
            "SHACL 校验未通过，回答已阻断",
            details={"guard": report.model_dump(mode="json"), "answer_preview": payload.answer[:200]},
        )
    return report
