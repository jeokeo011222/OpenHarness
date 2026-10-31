"""测试夹具：全部使用 memory 适配器，不依赖任何外部服务。"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.container import Container, build_container
from app.settings import Settings
from app.tenancy import TenantContext, build_tenant_context


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    """隔离的测试配置：独立审计库、显式租户密钥。"""
    return Settings(
        rag_mode="memory",
        environment="dev",
        audit_db_path=tmp_path / "audit.db",
        tenant_keys_json='{"demo": "key-demo", "other": "key-other"}',
        daily_token_budget=1000,
        task_token_limit=500,
    )


@pytest.fixture()
def container(settings: Settings) -> Container:
    """装配好的容器。"""
    built = build_container(settings)
    try:
        yield built
    finally:
        asyncio.run(built.aclose())


@pytest.fixture()
def tenant(settings: Settings) -> TenantContext:
    """租户 demo。"""
    return build_tenant_context("demo", "trace-demo", settings)


@pytest.fixture()
def tenant_other(settings: Settings) -> TenantContext:
    """租户 other。"""
    return build_tenant_context("other", "trace-other", settings)
