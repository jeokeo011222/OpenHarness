"""运维接口：用量、成本、审计回放、本体概况与发布。"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query

from ...ontology import OntologyPublishError, fingerprint, revert, save
from ...ontology.model import count_node_shapes
from ...schemas import OntologyPublishRequest
from ..deps import ContainerDep, TenantDep

logger = logging.getLogger("ontorag.admin")

router = APIRouter(prefix="/v1/admin", tags=["admin"])


def _fingerprint_payload(container: ContainerDep) -> dict[str, object]:
    """指纹 + 代次：面板顶部那句"当前跑的是哪一版"就靠它。"""
    payload = fingerprint(container.settings.ontology_dir)
    return {
        **payload,
        "generation": container.ontology_generation,
        "loadedAt": container.ontology_loaded_at,
        "sources": container.ontology_sources,
        "shacl_engine": container.shacl_engine,
        "classes": len(container.ontology.classes),
        "properties": len(container.ontology.properties),
    }


@router.get("/usage")
async def usage(tenant: TenantDep, container: ContainerDep, days: int = Query(default=1, ge=1, le=31)) -> dict[str, object]:
    """租户 token 与阻断次数看板。"""
    data = await container.audit.usage(tenant.tenant_id, days=days)
    return {
        **data,
        "budget": container.settings.daily_token_budget,
        "mode": container.settings.rag_mode,
    }


@router.get("/audit/recent")
async def recent_audits(tenant: TenantDep, container: ContainerDep, limit: int = Query(default=20, ge=1, le=100)) -> dict[str, object]:
    """最近审计列表（只返回本租户）。"""
    return {"items": await container.audit.recent(tenant.tenant_id, limit=limit)}


@router.get("/audit/{trace_id}")
async def audit_detail(trace_id: str, tenant: TenantDep, container: ContainerDep) -> dict[str, object]:
    """按 trace 回放一次完整链路。跨租户访问会被拒绝。"""
    record = await container.audit.get(tenant.tenant_id, trace_id)
    if record is None:
        return {"found": False, "trace_id": trace_id}
    return {"found": True, "record": record}


@router.get("/ontology")
async def ontology_summary(tenant: TenantDep, container: ContainerDep) -> dict[str, object]:
    """本体概况：类、属性、形状数量与领域划分。"""
    del tenant
    model = container.ontology
    return {
        "classes": len(model.classes),
        "properties": len(model.properties),
        "aliases": len(model.aliases()),
        "shapes": count_node_shapes(model.shapes),
        "claim_shapes": count_node_shapes(model.claim_shapes),
        # 域清单以加载时登记的命名空间为准：从类 IRI 反推域名，遇到 `/` 结尾的
        # 命名空间会把整条路径当域名，和检索过滤用的口径对不上。
        "domains": sorted(model.domain_namespaces),
        "namespaces": {domain: list(prefixes) for domain, prefixes in model.domain_namespaces.items()},
    }


@router.get("/ontology/fingerprint")
async def ontology_fingerprint(tenant: TenantDep, container: ContainerDep) -> dict[str, object]:
    """本体指纹：每个域的来源（内置/接管）、摘要、版本与加载代次。

    面板必须能回答"改了本体为什么检索没变"：要么没发布（摘要不变），
    要么发布后没重载（代次不变）。少了这两个字段，人只会怀疑检索坏了。
    """
    del tenant
    return _fingerprint_payload(container)


@router.post("/ontology/{domain}")
async def publish_ontology(
    domain: str,
    payload: OntologyPublishRequest,
    tenant: TenantDep,
    container: ContainerDep,
) -> dict[str, object]:
    """接管一个域的本体并立即重载。

    重载失败会**自动回滚**到发布前的文件：否则一个校验漏掉的本体会把服务留在
    "下次启动起不来"的状态，而这跟本次请求成不成功已经没关系了。
    """
    if not container.settings.ontology_publish_enabled:
        raise HTTPException(status_code=403, detail="本体发布已被禁用（ONTOLOGY_PUBLISH_ENABLED=false）")

    settings = container.settings
    try:
        entry = save(
            settings.ontology_dir,
            domain,
            payload.turtle,
            version=payload.version,
            label=payload.label,
            note=payload.note,
        )
    except OntologyPublishError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    try:
        reloaded = await container.reload_ontology()
    except Exception as error:  # 落盘成功但加载失败：回滚，别把服务留在坏状态
        revert(settings.ontology_dir, entry["domain"])
        try:
            await container.reload_ontology()
        except Exception:  # pragma: no cover - 内置本体本身坏了才会走到
            logger.exception("回滚后仍无法加载本体，服务需要人工介入")
        raise HTTPException(status_code=422, detail=f"新本体无法加载，已回滚：{error}") from error

    logger.info(
        "本体已发布：domain=%s version=%s tenant=%s triples=%d",
        entry["domain"],
        entry["version"] or "-",
        tenant.tenant_id,
        entry["triples"],
    )
    return {
        "published": entry,
        **reloaded,
        **_fingerprint_payload(container),
    }


@router.delete("/ontology/{domain}")
async def withdraw_ontology(domain: str, tenant: TenantDep, container: ContainerDep) -> dict[str, object]:
    """撤销接管，回落到内置本体并重载。"""
    del tenant
    if not container.settings.ontology_publish_enabled:
        raise HTTPException(status_code=403, detail="本体发布已被禁用（ONTOLOGY_PUBLISH_ENABLED=false）")
    removed = revert(container.settings.ontology_dir, domain)
    reloaded = await container.reload_ontology()
    return {"reverted": removed, **reloaded, **_fingerprint_payload(container)}
