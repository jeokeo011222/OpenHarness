"""FastAPI 应用工厂。

启动时装配依赖，请求期只做鉴权、注入 trace、分派路由。
所有可预期错误都以统一 JSON 结构返回，并带上 trace_id 便于回放审计。
"""

from __future__ import annotations

import logging
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .api.routers import admin, debug, health, hooks, query, tools
from .compat import use_psycopg_compatible_loop
from .container import Container, build_container
from .errors import OntoRagError
from .logging_setup import configure_logging
from .settings import Settings, get_settings

# 在 uvicorn 建事件循环之前切换策略；放在模块导入期是唯一可靠的时机
use_psycopg_compatible_loop()

logger = logging.getLogger("ontorag")


def create_app(settings: Settings | None = None) -> FastAPI:
    """构造应用。测试可传入自定义 settings。"""
    cfg = settings or get_settings()
    configure_logging(cfg)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        """启动装配、退出释放。"""
        container = build_container(cfg)
        app.state.container = container
        app.state.settings = cfg
        await container.startup()
        logger.info(
            "ontorag 启动：mode=%s retrieval=%s audit=%s classes=%d",
            cfg.rag_mode,
            cfg.effective_retrieval_backend,
            cfg.effective_audit_backend,
            len(container.ontology.classes),
        )
        try:
            yield
        finally:
            await container.aclose()
            logger.info("ontorag 关闭")

    app = FastAPI(
        title="OntoRAG · 本体制导 RAG",
        version="1.0.0",
        description=(
            "本体优先检索（SPARQL 60%）+ ES 精准检索（25%）+ 向量补全（15%），"
            "所有结论经 SHACL 强制校验后才允许输出。"
        ),
        lifespan=lifespan,
    )

    @app.middleware("http")
    async def trace_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
        """为每个请求分配 trace_id 并透出响应头。"""
        trace_id = request.headers.get("X-Trace-Id") or str(uuid.uuid4())
        request.state.trace_id = trace_id
        response = await call_next(request)
        response.headers["X-Trace-Id"] = trace_id
        return response

    @app.exception_handler(OntoRagError)
    async def onto_rag_error_handler(request: Request, exc: OntoRagError) -> JSONResponse:
        """业务错误：带 code / message / details / trace_id。"""
        payload = exc.to_payload()
        payload["trace_id"] = getattr(request.state, "trace_id", None)
        return JSONResponse(status_code=exc.status_code, content=payload)

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        """入参校验失败也走统一错误体。

        默认的 422 是 `{"detail":[...]}`，与业务错误体结构不同，调用方（尤其是
        Harness 插件）就无法区分"参数写错"和"被 SHACL 闸门拦下"——两者都是 422，
        但后果完全不同：前者该改写参数，后者必须原样上报冲突。
        """
        issues = [
            {
                "loc": ".".join(str(part) for part in item.get("loc", ())),
                "msg": item.get("msg", ""),
                "type": item.get("type", ""),
            }
            for item in exc.errors()
        ]
        first = issues[0] if issues else {"loc": "", "msg": "参数不合法"}
        return JSONResponse(
            status_code=422,
            content={
                "code": "invalid_request",
                "message": f"参数校验失败：{first['loc']} {first['msg']}".strip(),
                "details": {"issues": issues},
                "trace_id": getattr(request.state, "trace_id", None),
            },
        )

    @app.exception_handler(Exception)
    async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
        """兜底：不泄漏堆栈，但保留 trace_id 供排查。"""
        logger.exception("未处理异常：%s", exc)
        return JSONResponse(
            status_code=500,
            content={
                "code": "internal_error",
                "message": "服务内部错误",
                "trace_id": getattr(request.state, "trace_id", None),
            },
        )

    app.include_router(health.router)
    app.include_router(query.router)
    app.include_router(hooks.router)
    app.include_router(tools.router)
    app.include_router(admin.router)

    # 调试面板：仅演示/联调开启。关掉时连静态资源都不挂载，
    # 避免"接口关了但页面还能打开"的半开状态。
    if cfg.debug_panel_enabled:
        app.include_router(debug.router)
        static_dir = Path(__file__).parent / "static" / "debug"
        if static_dir.is_dir():
            app.mount("/debug", StaticFiles(directory=str(static_dir), html=True), name="debug")
            logger.info("调试面板已挂载：/debug")
        else:  # pragma: no cover - 只在发布漏文件时触发
            logger.warning("调试面板目录缺失：%s", static_dir)
    return app


app = create_app()
