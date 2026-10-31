"""健康检查。"""

from __future__ import annotations

from fastapi import APIRouter

from ..deps import ContainerDep

router = APIRouter(tags=["health"])


def _count_shapes(graph: object) -> int:
    """统计具名 NodeShape 数量（不是三元组数量）。"""
    from rdflib import URIRef
    from rdflib.namespace import RDF

    sh = "http://www.w3.org/ns/shacl#NodeShape"
    return sum(1 for s in graph.subjects(RDF.type, URIRef(sh)) if isinstance(s, URIRef))  # type: ignore[attr-defined]


@router.get("/healthz")
async def healthz(container: ContainerDep) -> dict[str, object]:
    """存活探针：不依赖外部系统，只报告装配状态。"""
    return {
        "status": "ok",
        "mode": container.settings.rag_mode,
        "classes": len(container.ontology.classes),
        "shapes": _count_shapes(container.ontology.claim_shapes),
        # 实际生效的校验引擎必须可见：闸门"看起来在工作"和"真的在工作"是两件事，
        # 排障第一步永远是确认这一点。
        "shacl_engine": container.shacl_engine,
        "sparql_forms": list(container.settings.sparql_forms),
    }


@router.get("/readyz")
async def readyz(container: ContainerDep) -> dict[str, object]:
    """就绪探针：本体必须可用，且审计后端真正连得上。

    审计有两种落点：PostgreSQL 连接池（测试/生产）与 SQLite 单文件（memory 模式）。
    探针不能假设是哪一种，否则换了后端就会假报就绪。
    """
    if container.pool is not None:
        audit_ok = await container.pool.ping()
    else:
        path = getattr(container.audit, "path", None)
        audit_ok = bool(path is not None and path.exists())
    checks = {
        "ontology": len(container.ontology.classes) > 0,
        "shapes": _count_shapes(container.ontology.claim_shapes) > 0,
        "audit": audit_ok,
    }
    return {
        "ready": all(checks.values()),
        "checks": checks,
        "retrieval": container.settings.effective_retrieval_backend,
        "audit_backend": container.settings.effective_audit_backend,
    }
