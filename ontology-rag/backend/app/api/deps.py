"""API 依赖：容器与租户上下文。"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request

from ..container import Container
from ..tenancy import TenantContext, tenant_dependency


def get_container(request: Request) -> Container:
    """取进程级依赖容器。"""
    container: Container = request.app.state.container
    return container


TenantDep = Annotated[TenantContext, Depends(tenant_dependency)]
ContainerDep = Annotated[Container, Depends(get_container)]
