"""PostgreSQL + pgvector 适配器集成测试。

有库才跑，没库就跳过——默认测试集不依赖外部服务，这是硬约束。
要跑这组：

    ONTORAG_PG_DSN=postgresql://ontorag:ontorag@127.0.0.1:5432/ontorag \
        backend/.venv/Scripts/python.exe -m pytest tests/test_pg.py -q

覆盖面刻意压在「换存储后端最容易悄悄坏掉」的四处：
租户隔离、本体标签下推、向量器同源校验、审计跨租户拒绝。

关于连接池：psycopg 的异步连接绑定在创建它的事件循环上，跨 `asyncio.run`
复用同一个池会炸。所以这里每个用例在自己的循环里建池、用完即关，
而不是共享一个模块级池。
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import date
from typing import Any, Awaitable, Callable

import pytest

from app.adapters.memory import HashingEmbedder
from app.adapters.pg import (
    PgAuditStore,
    PgChunkRepository,
    PgKeywordIndex,
    PgPool,
    PgTenantStore,
    PgVectorIndex,
    apply_schema,
    bigram_text,
)
from app.compat import use_psycopg_compatible_loop
from app.errors import TenantError
from app.schemas import Chunk
from app.settings import Settings

# Windows 下 psycopg 异步连接要 Selector 循环；测试同样适用
use_psycopg_compatible_loop()

PG_DSN = os.environ.get("ONTORAG_PG_DSN", "").strip()
pytestmark = pytest.mark.skipif(not PG_DSN, reason="未设置 ONTORAG_PG_DSN，跳过 PostgreSQL 集成测试")

TENANT = "pgtest"
CON = "http://ontorag.local/contract#"
CAR = "http://ontorag.local/carbon#"
# 与 schema.sql 的实际列维度一致；改这里就要同步重建 chunk_vector
DIM = 1024


def _settings() -> Settings:
    """指向被测库的配置。"""
    return Settings(
        rag_mode="live",
        retrieval_backend="pg",
        tenant_store="db",
        pg_dsn=PG_DSN,
        embedding_dim=DIM,
    )


def run_pg(flow: Callable[[Settings, PgPool], Awaitable[Any]]) -> Any:
    """在一个事件循环内建池、执行、关池。"""
    settings = _settings()

    async def wrapper() -> Any:
        pool = PgPool(settings)
        await pool.open()
        try:
            await apply_schema(pool, settings.pg_schema_path, settings.embedding_dim)
            return await flow(settings, pool)
        finally:
            await pool.aclose()

    return asyncio.run(wrapper())


@pytest.fixture(autouse=True, scope="module")
def _clean_tenant() -> Any:
    """用例前后清掉测试租户，避免与种子数据互相干扰。"""

    async def cleanup(settings: Settings, pool: PgPool) -> None:
        del settings
        await pool.execute("DELETE FROM ontology_chunk WHERE tenant_id = %s", (TENANT,))
        await pool.execute("DELETE FROM audit_run WHERE tenant_id = %s", (TENANT,))
        await pool.execute("DELETE FROM app_tenant WHERE tenant_id = %s", (TENANT,))

    run_pg(cleanup)
    yield
    run_pg(cleanup)


def _chunk(
    chunk_id: str,
    text: str,
    *,
    classes: list[str],
    doc_type: str = "regulation",
    deprecated: bool = False,
) -> Chunk:
    """构造一条测试分块。"""
    return Chunk(
        chunk_id=chunk_id,
        tenant_id=TENANT,
        doc_id=chunk_id.split("#")[0],
        doc_title="测试制度",
        doc_type=doc_type,  # type: ignore[arg-type]
        clause_no=chunk_id.split("#")[-1],
        text=text,
        classes=classes,
        properties=[f"{CON}paymentAmount"],
        priority=10,
        effective_from=date(2024, 1, 1),
        deprecated=deprecated,
    )


def test_chunk_roundtrip_keeps_labels_and_dates() -> None:
    """写入再读出，本体标签与生效日期不能走形。"""
    chunk = _chunk("rt#1", "付款申请金额不得超过合同剩余应付。", classes=[f"{CON}PaymentApplication"])

    async def flow(settings: Settings, pool: PgPool) -> Chunk:
        del settings
        repository = PgChunkRepository(pool)
        await repository.put_many([chunk])
        found = await repository.get_many(TENANT, [chunk.chunk_id])
        return found[chunk.chunk_id]

    loaded = run_pg(flow)
    assert loaded.classes == [f"{CON}PaymentApplication"]
    assert loaded.properties == [f"{CON}paymentAmount"]
    assert loaded.effective_from == date(2024, 1, 1)
    assert loaded.text == chunk.text


def test_keyword_pushes_ontology_filter_into_sql() -> None:
    """本体标签过滤必须下推：不同类的分块不应被同一查询召回。"""

    async def flow(settings: Settings, pool: PgPool) -> tuple[list[str], list[str]]:
        repository = PgChunkRepository(pool)
        keyword = PgKeywordIndex(settings, pool)
        await repository.put_many([
            _chunk("kw#1", "付款申请需要合同剩余应付校验。", classes=[f"{CON}PaymentApplication"]),
            _chunk("kw#2", "排放源不得同时属于两个核算边界。", classes=[f"{CAR}EmissionSource"]),
        ])
        contract_rows = await keyword.search(
            TENANT, "付款申请 核算边界", filters={"ontology_classes": [f"{CON}PaymentApplication"]}, top_k=5
        )
        carbon_rows = await keyword.search(
            TENANT, "付款申请 核算边界", filters={"ontology_classes": [f"{CAR}EmissionSource"]}, top_k=5
        )
        return [item.chunk.chunk_id for item in contract_rows], [item.chunk.chunk_id for item in carbon_rows]

    contract_hits, carbon_hits = run_pg(flow)
    assert "kw#1" in contract_hits and "kw#2" not in contract_hits
    assert "kw#2" in carbon_hits and "kw#1" not in carbon_hits


def test_keyword_is_tenant_scoped() -> None:
    """同一条查询在另一个租户下必须查不到。"""

    async def flow(settings: Settings, pool: PgPool) -> list[str]:
        keyword = PgKeywordIndex(settings, pool)
        rows = await keyword.search("nobody", "付款申请", filters={}, top_k=10)
        return [item.chunk.chunk_id for item in rows]

    assert run_pg(flow) == []


def test_doc_type_filter_still_applies() -> None:
    """文档类型过滤与本体过滤要能叠加，archive 只回历史资料。"""

    async def flow(settings: Settings, pool: PgPool) -> list[str]:
        repository = PgChunkRepository(pool)
        keyword = PgKeywordIndex(settings, pool)
        await repository.put_many([
            _chunk("dt#cur", "付款申请的现行流程说明。", classes=[f"{CON}PaymentApplication"]),
            _chunk("dt#old", "付款申请的旧版流程说明。", classes=[f"{CON}PaymentApplication"], doc_type="archive"),
        ])
        rows = await keyword.search(TENANT, "付款申请 流程", filters={"doc_types": ["archive"]}, top_k=5)
        return [item.chunk.chunk_id for item in rows]

    assert run_pg(flow) == ["dt#old"]


def test_vector_search_requires_same_embedder() -> None:
    """向量器不同源时必须召回为空，而不是给出另一套空间里的邻居。"""

    async def flow(settings: Settings, pool: PgPool) -> tuple[list[str], list[str]]:
        repository = PgChunkRepository(pool)
        embedder = HashingEmbedder(settings.embedding_dim)
        chunk = _chunk("vec#1", "合同剩余应付金额校验。", classes=[f"{CON}Contract"])
        await repository.put_many([chunk])
        vector = (await embedder.embed([chunk.text]))[0]
        matcher = PgVectorIndex(settings, pool, model="hash-bigram:1024")
        await matcher.upsert(TENANT, [(chunk.chunk_id, vector)], model="hash-bigram:1024")
        query = (await embedder.embed(["剩余应付多少"]))[0]
        same = await matcher.search(TENANT, query, top_k=3)
        other = PgVectorIndex(settings, pool, model="deepseek:other-model")
        mismatched = await other.search(TENANT, query, top_k=3)
        return [item.chunk.chunk_id for item in same], [item.chunk.chunk_id for item in mismatched]

    same_hits, mismatched_hits = run_pg(flow)
    assert "vec#1" in same_hits
    assert mismatched_hits == []


def test_deprecated_chunk_is_not_vector_recalled() -> None:
    """废弃分块不得进入向量召回，哪怕向量还在库里。"""

    async def flow(settings: Settings, pool: PgPool) -> list[str]:
        repository = PgChunkRepository(pool)
        embedder = HashingEmbedder(settings.embedding_dim)
        chunk = _chunk("vec#old", "付款申请旧版口径。", classes=[f"{CON}PaymentApplication"], deprecated=True)
        await repository.put_many([chunk])
        vector = (await embedder.embed([chunk.text]))[0]
        index = PgVectorIndex(settings, pool, model="hash-bigram:1024")
        await index.upsert(TENANT, [(chunk.chunk_id, vector)], model="hash-bigram:1024")
        probe = (await embedder.embed(["付款申请口径"]))[0]
        return [item.chunk.chunk_id for item in await index.search(TENANT, probe, top_k=5)]

    assert "vec#old" not in run_pg(flow)


def test_audit_roundtrip_and_tenant_isolation() -> None:
    """审计写入可回放；跨租户读取必须被拒。"""
    trace_id = f"trace-{uuid.uuid4().hex[:12]}"

    async def flow(settings: Settings, pool: PgPool) -> dict[str, Any]:
        audit = PgAuditStore(settings, pool)
        await audit.append(
            {
                "trace_id": trace_id,
                "tenant_id": TENANT,
                "question": "测试问题",
                "answer": "测试答案",
                "guard_ok": True,
                "blocked": False,
                "intent": {"domain": "contract"},
                "guard": {"conforms": True},
                "prompt_tokens": 12,
                "completion_tokens": 8,
            }
        )
        record = await audit.get(TENANT, trace_id)
        usage = await audit.usage(TENANT)
        cross: object = None
        try:
            await audit.get("someone-else", trace_id)
        except TenantError as error:
            cross = error
        return {"record": record, "usage": usage, "cross": cross}

    outcome = run_pg(flow)
    record = outcome["record"]
    assert isinstance(record, dict)
    assert record["answer"] == "测试答案"
    assert record["guard_ok"] == 1
    # jsonb 读回后仍是字符串形态，与 SQLite 版的对外契约保持一致
    assert isinstance(record["guard_json"], str)
    assert outcome["cross"] is not None
    usage = outcome["usage"]
    assert isinstance(usage, dict)
    assert usage["total_tokens"] >= 20


def test_tenant_store_verifies_and_rejects() -> None:
    """租户密钥只存摘要；错 key 与停用租户都要拒绝。"""

    async def flow(settings: Settings, pool: PgPool) -> tuple[bool, bool, bool]:
        del settings
        store = PgTenantStore(pool)
        await store.upsert(TENANT, "right-key")
        await store.verify(TENANT, "right-key")
        wrong_rejected = False
        try:
            await store.verify(TENANT, "wrong-key")
        except TenantError:
            wrong_rejected = True
        await pool.execute("UPDATE app_tenant SET status = 'disabled' WHERE tenant_id = %s", (TENANT,))
        store._loaded_at = 0.0  # 强制刷新缓存，模拟 TTL 过期
        disabled_rejected = False
        try:
            await store.verify(TENANT, "right-key")
        except TenantError:
            disabled_rejected = True
        return True, wrong_rejected, disabled_rejected

    loaded, wrong_rejected, disabled_rejected = run_pg(flow)
    assert loaded and wrong_rejected and disabled_rejected


def test_bigram_tokens_match_stored_tsvector() -> None:
    """入库词元与查询词元必须同源，否则关键词层会静默失效。"""

    async def flow(settings: Settings, pool: PgPool) -> list[dict[str, Any]]:
        del settings
        repository = PgChunkRepository(pool)
        await repository.put_many([_chunk("tok#1", "付款申请超付校验", classes=[f"{CON}PaymentApplication"])])
        return await pool.fetch_all(
            "SELECT chunk_id FROM ontology_chunk WHERE tenant_id = %s AND chunk_id = %s "
            "AND token_doc @@ to_tsquery('simple', %s)",
            (TENANT, "tok#1", " | ".join(bigram_text("付款申请").split())),
        )

    assert len(run_pg(flow)) == 1
