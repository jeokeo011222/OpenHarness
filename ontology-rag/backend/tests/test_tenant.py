"""租户隔离测试：图、分块、审计三层都必须住手。"""

from __future__ import annotations

import asyncio

import pytest

from app.container import Container
from app.errors import TenantError
from app.tenancy import TenantContext, build_tenant_context, verify_tenant


def test_graph_isolation(container: Container, tenant: TenantContext, tenant_other: TenantContext) -> None:
    """demo 的图里不能出现 other 的合同。"""
    rows = asyncio.run(
        container.graph.select(
            tenant.graph_uri,
            "SELECT ?s WHERE { ?s a <http://ontorag.local/contract#Contract> }",
            max_rows=50,
        )
    )
    subjects = {row["s"] for row in rows if row.get("s")}
    assert all("/tenant/demo/" in subject for subject in subjects)
    assert not any("C-OTHER-001" in subject for subject in subjects)


def test_answer_does_not_leak_across_tenants(
    container: Container, tenant: TenantContext, tenant_other: TenantContext
) -> None:
    """向 other 提问不能拿到 demo 的合同结论。"""
    response = asyncio.run(container.pipeline.answer(tenant_other, "C-OTHER-001 的付款是否超付？"))
    assert "C-OTHER-001" in response.answer
    assert "C-2024-001" not in response.answer


def test_audit_cross_tenant_access_rejected(container: Container, tenant: TenantContext) -> None:
    """审计按 trace 读取时，跨租户必须报错而不是返回数据。"""
    response = asyncio.run(container.pipeline.answer(tenant, "C-2024-001 的付款是否超付？"))
    with pytest.raises(TenantError):
        asyncio.run(container.audit.get("other", response.trace_id))


def test_unknown_tenant_rejected(container: Container) -> None:
    """未登记租户密钥一律拒绝。"""
    with pytest.raises(TenantError):
        verify_tenant("intruder", "whatever", container.settings)
    with pytest.raises(TenantError):
        verify_tenant("demo", "wrong-key", container.settings)


def test_invalid_tenant_id_rejected(container: Container) -> None:
    """租户 id 必须能安全拼进图名与索引名。"""
    with pytest.raises(TenantError):
        build_tenant_context("../etc", "trace", container.settings)
