"""租户上下文与鉴权。

隔离的三处落点：
1. RDF：每个租户一个命名图 `urn:ontorag:tenant:{id}:graph`，SPARQL 强制包裹 GRAPH。
2. 检索：PostgreSQL 每张表带 `tenant_id` 并在 WHERE 中出现（ES 部署则为每租户一个索引）。
3. 审计：`audit_run.tenant_id` 行级过滤，跨租户查询一律拒绝。

密钥来源有两条：`TENANT_KEYS` 环境变量（memory 模式与本地演示），
或 `app_tenant` 表（连了 PostgreSQL 时）。两条路径的比对语义完全一致。
"""

from __future__ import annotations

import hmac
from dataclasses import dataclass

from fastapi import Header, Request

from .errors import TenantError
from .settings import Settings, get_settings


@dataclass(frozen=True, slots=True)
class TenantContext:
    """一次请求的租户身份。"""

    tenant_id: str
    graph_uri: str
    es_index: str
    milvus_partition: str
    trace_id: str


def build_tenant_context(tenant_id: str, trace_id: str, settings: Settings | None = None) -> TenantContext:
    """由租户 id 派生全部资源命名，禁止调用方自行拼接。"""
    cfg = settings or get_settings()
    safe = tenant_id.strip().lower()
    if not safe.replace("-", "").replace("_", "").isalnum():
        raise TenantError(f"非法租户 id：{tenant_id!r}")
    return TenantContext(
        tenant_id=safe,
        graph_uri=f"urn:ontorag:tenant:{safe}:graph",
        es_index=f"{cfg.es_index_prefix}_{safe}_chunks",
        milvus_partition=safe,
        trace_id=trace_id,
    )


def verify_tenant(tenant_id: str | None, api_key: str | None, settings: Settings | None = None) -> None:
    """常量时间比对租户密钥。未配置密钥表时只在 dev 环境放行默认租户。"""
    cfg = settings or get_settings()
    if not cfg.require_auth:
        return
    if not tenant_id:
        raise TenantError("缺少 X-Tenant-Id 请求头")
    keys = cfg.tenant_keys
    if not keys:
        if cfg.environment == "dev" and tenant_id.lower() == "demo":
            return
        raise TenantError("服务端未配置 TENANT_KEYS，拒绝匿名访问")
    expected = keys.get(tenant_id.lower())
    if expected is None:
        raise TenantError(f"未知租户：{tenant_id}")
    if api_key is None or not hmac.compare_digest(expected, api_key):
        raise TenantError("租户密钥不正确")


async def tenant_dependency(
    request: Request,
    x_tenant_id: str | None = Header(default=None, alias="X-Tenant-Id"),
    x_api_key: str | None = Header(default=None, alias="X-Api-Key"),
) -> TenantContext:
    """FastAPI 依赖：解析并校验租户，写入 request.state 供审计使用。"""
    settings: Settings = getattr(request.app.state, "settings", None) or get_settings()
    container = getattr(request.app.state, "container", None)
    store = getattr(container, "tenants", None)

    # 连了 PostgreSQL 时租户在库里；否则回落到环境变量表。
    # 两条路径都不放开 require_auth，只是密钥的存放位置不同。
    if store is not None:
        if settings.require_auth:
            if not x_tenant_id:
                raise TenantError("缺少 X-Tenant-Id 请求头")
            await store.verify(x_tenant_id, x_api_key)
    else:
        verify_tenant(x_tenant_id, x_api_key, settings)

    trace_id = getattr(request.state, "trace_id", "") or "-"
    tenant_id = (x_tenant_id or "demo").lower()
    ctx = build_tenant_context(tenant_id, trace_id, settings)
    request.state.tenant = ctx
    return ctx
