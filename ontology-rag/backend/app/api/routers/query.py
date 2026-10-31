"""问答主接口。"""

from __future__ import annotations

from fastapi import APIRouter

from ...schemas import QueryRequest, QueryResponse
from ..deps import ContainerDep, TenantDep

router = APIRouter(prefix="/v1", tags=["query"])


@router.post("/query", response_model=QueryResponse)
async def query(payload: QueryRequest, tenant: TenantDep, container: ContainerDep) -> QueryResponse:
    """执行本体优先检索 + SHACL 闸门的完整问答。

    校验不通过时返回 422，body 中包含 `blocked` 与冲突明细。
    """
    return await container.pipeline.answer(
        tenant,
        payload.question,
        domain=payload.domain,
        top_k=payload.top_k,
    )


@router.post("/query/preview", response_model=QueryResponse)
async def preview(payload: QueryRequest, tenant: TenantDep, container: ContainerDep) -> QueryResponse:
    """只检索不生成：用于调参与 POC 演示证据链。"""
    return await container.pipeline.preview(
        tenant,
        payload.question,
        domain=payload.domain,
        top_k=payload.top_k,
    )
