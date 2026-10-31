"""PostgreSQL + pgvector 适配器：关系数据、向量、审计、租户统一落一个库。

设计原则与 memory / ES / Milvus 适配器完全一致——只实现 `ports.py` 里的协议，
管线代码一行不改。测试阶段用它替换 ES + Milvus + SQLite 三件套，
把外部依赖从 4 个容器收敛到 1 个（Fuseki 仍然独立承担图数据）。

三个容易踩的点，代码里都做了处置：

1. **中文分词**。pg 内置分词器不切中文，直接把原句写进 `tsvector` 会让关键词层
   在中文语料上退化为「整段一个词」。所以入库前用与 memory 适配器相同的
   bigram 规则切好，再交给 `to_tsvector('simple', ...)`——词元是切好的，
   配置用 simple 即可，行为可预期。
2. **向量维度**。pgvector 的列维度必须在 DDL 期固定，无法参数化，
   因此由 `apply_schema()` 替换 `__EMBEDDING_DIM__` 占位符。
3. **租户隔离**。向量检索不走 partition key，而是 `JOIN ... ON tenant_id`，
   所以两表的租户条件都必须在 WHERE 里出现——只写一侧等于没隔离。
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, AsyncIterator, Iterable, Sequence

from ..compat import is_proactor_loop
from ..errors import RetrievalError, TenantError
from ..schemas import Chunk, ScoredChunk
from ..settings import Settings
from .memory import tokenize

# pgvector 默认 hnsw 索引的 ef_search；测试期数据量小，够用
_HNSW_EF_SEARCH = 64


def bigram_text(text: str) -> str:
    """把文本切成空格分隔的词元串，供 `to_tsvector` 使用。

    与 `memory.tokenize` 同一套规则（拉丁词 + 中文二元组），
    保证两条检索路径的词元空间一致，切换后端不会悄悄改变召回质量。
    """
    return " ".join(tokenize(text))


def hash_api_key(tenant_id: str, api_key: str) -> str:
    """租户密钥摘要。只存摘要，不存明文。"""
    payload = f"{tenant_id}\x1f{api_key}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def vector_literal(vector: Sequence[float]) -> str:
    """把向量序列化成 pgvector 的文本字面量 `[a,b,c]`。

    直接用文本传输而不是引入 pgvector 的 Python 适配器：
    查询侧只需要写入和距离排序，不需要读回向量，少一个依赖。
    """
    return "[" + ",".join(f"{value:.7g}" for value in vector) + "]"


class PgPool:
    """psycopg 异步连接池的薄封装。

    连接池是长生命周期对象，必须显式 `open()` / `aclose()`；
    没有 pg 的环境（memory 模式、单元测试）根本不会构造它。
    """

    def __init__(self, settings: Settings) -> None:
        self.dsn = settings.pg_dsn
        self._pool: Any = None
        self._min_size = settings.pg_pool_min
        self._max_size = settings.pg_pool_max
        self._timeout = settings.pg_connect_timeout

    async def open(self) -> None:
        """建立连接池并等到至少一条连接可用。"""
        if self._pool is not None:
            return
        # 先做一次可读断言：否则 Windows 上会被 pool 超时掩盖成"连不上库"
        if is_proactor_loop():
            raise RetrievalError(
                "Windows 的 ProactorEventLoop 不支持 psycopg 异步连接，"
                "请改用 SelectorEventLoop（见 app.compat.use_psycopg_compatible_loop）"
            )
        try:
            from psycopg.rows import dict_row
            from psycopg_pool import AsyncConnectionPool
        except ImportError as error:  # pragma: no cover - 仅在缺依赖时触发
            raise RetrievalError("未安装 psycopg / psycopg_pool，无法使用 PostgreSQL 后端") from error
        self._pool = AsyncConnectionPool(
            conninfo=self.dsn,
            min_size=self._min_size,
            max_size=self._max_size,
            timeout=self._timeout,
            open=False,
            kwargs={"autocommit": True, "row_factory": dict_row},
        )
        await self._pool.open(wait=True, timeout=self._timeout)

    @asynccontextmanager
    async def connection(self) -> AsyncIterator[Any]:
        """借一条连接；未初始化时自动初始化，避免启动顺序耦合。"""
        await self.open()
        async with self._pool.connection() as conn:
            yield conn

    async def fetch_all(self, sql: str, params: Sequence[Any] | None = None) -> list[dict[str, Any]]:
        """执行查询并返回行字典列表。"""
        async with self.connection() as conn:
            cursor = await conn.execute(sql, params)
            return list(await cursor.fetchall())

    async def execute(self, sql: str, params: Sequence[Any] | None = None) -> int:
        """执行写语句，返回受影响行数。"""
        async with self.connection() as conn:
            cursor = await conn.execute(sql, params)
            return cursor.rowcount

    async def ping(self) -> bool:
        """就绪探针用：能跑一条最轻的查询即视为可用。"""
        try:
            await self.fetch_all("SELECT 1 AS ok")
            return True
        except Exception:  # noqa: BLE001 - 探针不允许抛出去
            return False

    async def aclose(self) -> None:
        """关闭连接池。"""
        if self._pool is None:
            return
        pool, self._pool = self._pool, None
        await pool.close()


async def apply_schema(pool: PgPool, schema_path: Path, embedding_dim: int) -> None:
    """按 schema.sql 建表（幂等），并把向量维度占位符替换成实际维度。"""
    if not schema_path.exists():
        raise RetrievalError(f"找不到 schema 文件：{schema_path}")
    script = schema_path.read_text(encoding="utf-8").replace("__EMBEDDING_DIM__", str(int(embedding_dim)))
    async with pool.connection() as conn:
        await conn.execute(script)


def _row_to_chunk(row: dict[str, Any]) -> Chunk:
    """把一行 `ontology_chunk` 转成领域对象。"""
    return Chunk(
        chunk_id=row["chunk_id"],
        tenant_id=row["tenant_id"],
        doc_id=row["doc_id"],
        doc_title=row["doc_title"],
        doc_type=row["doc_type"],
        clause_no=row["clause_no"] or "",
        text=row["body"],
        classes=list(row["classes"] or []),
        properties=list(row["properties"] or []),
        priority=int(row["priority"]),
        effective_from=row["effective_from"],
        effective_to=row["effective_to"],
        version=row["version"] or "v1",
        deprecated=bool(row["deprecated"]),
    )


# 写入时同时刷新 token_doc：用与检索相同的 bigram 规则，
# 并借 setweight 复刻 ES mapping 里的字段权重（正文 > 条款号 ≈ 标题）。
_UPSERT_CHUNK_SQL = """
INSERT INTO ontology_chunk (
    tenant_id, chunk_id, doc_id, doc_title, doc_type, clause_no, body,
    classes, properties, priority, effective_from, effective_to, version,
    deprecated, token_doc, updated_at
) VALUES (
    %(tenant_id)s, %(chunk_id)s, %(doc_id)s, %(doc_title)s, %(doc_type)s, %(clause_no)s, %(body)s,
    %(classes)s, %(properties)s, %(priority)s, %(effective_from)s, %(effective_to)s, %(version)s,
    %(deprecated)s,
    setweight(to_tsvector('simple', %(body_tokens)s), 'A') ||
    setweight(to_tsvector('simple', %(clause_tokens)s), 'B') ||
    setweight(to_tsvector('simple', %(title_tokens)s), 'B'),
    now()
)
ON CONFLICT (tenant_id, chunk_id) DO UPDATE SET
    doc_id = EXCLUDED.doc_id,
    doc_title = EXCLUDED.doc_title,
    doc_type = EXCLUDED.doc_type,
    clause_no = EXCLUDED.clause_no,
    body = EXCLUDED.body,
    classes = EXCLUDED.classes,
    properties = EXCLUDED.properties,
    priority = EXCLUDED.priority,
    effective_from = EXCLUDED.effective_from,
    effective_to = EXCLUDED.effective_to,
    version = EXCLUDED.version,
    deprecated = EXCLUDED.deprecated,
    token_doc = EXCLUDED.token_doc,
    updated_at = now()
"""


class PgChunkRepository:
    """chunk 主数据（PostgreSQL 实现）。"""

    def __init__(self, pool: PgPool) -> None:
        self.pool = pool

    async def get_many(self, tenant_id: str, chunk_ids: Sequence[str]) -> dict[str, Chunk]:
        if not chunk_ids:
            return {}
        rows = await self.pool.fetch_all(
            """
            SELECT * FROM ontology_chunk
            WHERE tenant_id = %s AND chunk_id = ANY(%s)
            """,
            (tenant_id, list(chunk_ids)),
        )
        return {row["chunk_id"]: _row_to_chunk(row) for row in rows}

    async def put_many(self, chunks: Sequence[Chunk]) -> int:
        if not chunks:
            return 0
        async with self.pool.connection() as conn:
            for chunk in chunks:
                await conn.execute(_UPSERT_CHUNK_SQL, self._params(chunk))
        return len(chunks)

    def put_chunks_sync(self, chunks: Iterable[Chunk]) -> int:
        """本实现不提供同步写入。

        种子装载只在 memory 模式走 `put_chunks_sync`；pg 模式的种子由
        `scripts/init_pg.py` 显式导入，避免启动期隐式写库。
        """
        raise RuntimeError("PgChunkRepository 只支持异步写入，请使用 put_many 或 scripts/init_pg.py")

    async def list_all(self, tenant_id: str) -> list[Chunk]:
        rows = await self.pool.fetch_all(
            "SELECT * FROM ontology_chunk WHERE tenant_id = %s ORDER BY chunk_id",
            (tenant_id,),
        )
        return [_row_to_chunk(row) for row in rows]

    async def delete_tenant(self, tenant_id: str) -> int:
        """清空某租户全部分块（重建索引用；向量随外键级联删除）。"""
        return await self.pool.execute("DELETE FROM ontology_chunk WHERE tenant_id = %s", (tenant_id,))

    @staticmethod
    def _params(chunk: Chunk) -> dict[str, Any]:
        """把 chunk 摊平成 SQL 参数，词元在此处算好。"""
        return {
            "tenant_id": chunk.tenant_id,
            "chunk_id": chunk.chunk_id,
            "doc_id": chunk.doc_id,
            "doc_title": chunk.doc_title,
            "doc_type": chunk.doc_type,
            "clause_no": chunk.clause_no,
            "body": chunk.text,
            "classes": list(chunk.classes),
            "properties": list(chunk.properties),
            "priority": chunk.priority,
            "effective_from": chunk.effective_from,
            "effective_to": chunk.effective_to,
            "version": chunk.version,
            "deprecated": chunk.deprecated,
            "body_tokens": bigram_text(chunk.text),
            "clause_tokens": bigram_text(chunk.clause_no),
            "title_tokens": bigram_text(chunk.doc_title),
        }


class PgKeywordIndex:
    """关键词/原文精准检索（`tsvector` + `ts_rank_cd`）。

    与 BM25 的差别要说清楚：`ts_rank_cd` 是覆盖率模型，不是概率 BM25，
    因此同分更常见。但它只在本层内使用，融合前会被归一化，
    排序稳定性由 `priority ASC, chunk_id ASC` 兜底，不依赖打分精度。
    """

    def __init__(self, settings: Settings, pool: PgPool) -> None:
        self.settings = settings
        self.pool = pool

    async def search(
        self, tenant_id: str, query: str, *, filters: dict[str, Any], top_k: int
    ) -> list[ScoredChunk]:
        tokens = tokenize(query)
        if not tokens:
            return []
        # 词元已由 tokenize 归一（小写、去标点），不含 tsquery 元字符，
        # 因此可以用 OR 直接拼接；一旦改动 tokenize 必须重新评估这一点。
        tsquery = " | ".join(tokens)

        clauses = ["c.tenant_id = %s", "c.deprecated = FALSE", "c.token_doc @@ q.tsq"]
        params: list[Any] = [tsquery, tenant_id]

        doc_types = filters.get("doc_types")
        if doc_types:
            clauses.append("c.doc_type = ANY(%s)")
            params.append(list(doc_types))
        priority_max = filters.get("priority_max")
        if priority_max is not None:
            clauses.append("c.priority <= %s")
            params.append(int(priority_max))
        wanted_classes = list(filters.get("ontology_classes") or [])
        wanted_props = list(filters.get("ontology_properties") or [])
        # 本体标签过滤下推到 SQL：域外分块在存储层被拒绝，而不是在排序层被降权
        if wanted_classes or wanted_props:
            clauses.append("(c.classes && %s::text[] OR c.properties && %s::text[])")
            params.extend([wanted_classes, wanted_props])

        params.append(max(1, top_k))
        sql = f"""
            WITH q AS (SELECT to_tsquery('simple', %s) AS tsq)
            SELECT c.*, ts_rank_cd(c.token_doc, q.tsq, 32) AS score
            FROM ontology_chunk c, q
            WHERE {' AND '.join(clauses)}
            ORDER BY score DESC, c.priority ASC, c.chunk_id ASC
            LIMIT %s
        """
        rows = await self.pool.fetch_all(sql, params)
        out: list[ScoredChunk] = []
        lowered = query.lower()
        for row in rows:
            chunk = _row_to_chunk(row)
            out.append(
                ScoredChunk(
                    chunk=chunk,
                    tier="keyword",
                    raw_score=float(row["score"] or 0.0),
                    matched_on=sorted({t for t in tokens if t in lowered})[:8],
                )
            )
        return out


class PgVectorIndex:
    """向量检索（pgvector 余弦距离，仅作第三级补全）。"""

    def __init__(self, settings: Settings, pool: PgPool, *, model: str = "") -> None:
        self.settings = settings
        self.pool = pool
        # 只召回与当前查询向量器同源的向量，避免跨空间混检
        self.model = model

    async def search(self, tenant_id: str, vector: Sequence[float], *, top_k: int) -> list[ScoredChunk]:
        literal = vector_literal(vector)
        rows = await self.pool.fetch_all(
            """
            SELECT c.*, 1 - (v.embedding <=> %s::vector) AS score
            FROM chunk_vector v
            JOIN ontology_chunk c
              ON c.tenant_id = v.tenant_id AND c.chunk_id = v.chunk_id
            WHERE v.tenant_id = %s AND c.tenant_id = %s
              AND c.deprecated = FALSE AND v.model = %s
            ORDER BY v.embedding <=> %s::vector
            LIMIT %s
            """,
            (literal, tenant_id, tenant_id, self.model, literal, max(1, top_k)),
        )
        return [
            ScoredChunk(chunk=_row_to_chunk(row), tier="vector", raw_score=float(row["score"] or 0.0))
            for row in rows
        ]

    async def upsert(self, tenant_id: str, items: Sequence[tuple[str, Sequence[float]]], *, model: str) -> int:
        """写入/覆盖向量。供初始化与重建脚本使用。"""
        if not items:
            return 0
        async with self.pool.connection() as conn:
            for chunk_id, vector in items:
                await conn.execute(
                    """
                    INSERT INTO chunk_vector (tenant_id, chunk_id, embedding, model, updated_at)
                    VALUES (%s, %s, %s::vector, %s, now())
                    ON CONFLICT (tenant_id, chunk_id) DO UPDATE SET
                        embedding = EXCLUDED.embedding,
                        model = EXCLUDED.model,
                        updated_at = now()
                    """,
                    (tenant_id, chunk_id, vector_literal(vector), model),
                )
        return len(items)


class PgAuditStore:
    """全链路审计（PostgreSQL 实现），语义与 SQLite 版逐字段对齐。"""

    def __init__(self, settings: Settings, pool: PgPool) -> None:
        self.settings = settings
        self.pool = pool

    async def append(self, record: dict[str, Any]) -> None:
        await self.pool.execute(
            """
            INSERT INTO audit_run (
                trace_id, tenant_id, created_at, question, intent, recall, sparql,
                prompt, llm_output, answer, prompt_tokens, completion_tokens,
                model, guard_ok, guard_json, blocked, latency_ms, error
            ) VALUES (
                %(trace_id)s, %(tenant_id)s, %(created_at)s, %(question)s, %(intent)s, %(recall)s, %(sparql)s,
                %(prompt)s, %(llm_output)s, %(answer)s, %(prompt_tokens)s, %(completion_tokens)s,
                %(model)s, %(guard_ok)s, %(guard)s, %(blocked)s, %(latency_ms)s, %(error)s
            )
            ON CONFLICT (trace_id) DO UPDATE SET
                created_at = EXCLUDED.created_at,
                question = EXCLUDED.question,
                intent = EXCLUDED.intent,
                recall = EXCLUDED.recall,
                sparql = EXCLUDED.sparql,
                prompt = EXCLUDED.prompt,
                llm_output = EXCLUDED.llm_output,
                answer = EXCLUDED.answer,
                prompt_tokens = EXCLUDED.prompt_tokens,
                completion_tokens = EXCLUDED.completion_tokens,
                model = EXCLUDED.model,
                guard_ok = EXCLUDED.guard_ok,
                guard_json = EXCLUDED.guard_json,
                blocked = EXCLUDED.blocked,
                latency_ms = EXCLUDED.latency_ms,
                error = EXCLUDED.error
            """,
            {
                "trace_id": record["trace_id"],
                "tenant_id": record["tenant_id"],
                "created_at": _as_datetime(record.get("created_at")),
                "question": record.get("question", ""),
                "intent": _as_json(record.get("intent")),
                "recall": _as_json(record.get("recall")),
                "sparql": record.get("sparql"),
                "prompt": record.get("prompt"),
                "llm_output": record.get("llm_output"),
                "answer": record.get("answer"),
                "prompt_tokens": int(record.get("prompt_tokens", 0) or 0),
                "completion_tokens": int(record.get("completion_tokens", 0) or 0),
                "model": record.get("model"),
                "guard_ok": bool(record.get("guard_ok")),
                "guard": _as_json(record.get("guard")),
                "blocked": bool(record.get("blocked")),
                "latency_ms": int(record.get("latency_ms", 0) or 0),
                "error": record.get("error"),
            },
        )

    async def get(self, tenant_id: str, trace_id: str) -> dict[str, Any] | None:
        rows = await self.pool.fetch_all("SELECT * FROM audit_run WHERE trace_id = %s", (trace_id,))
        if not rows:
            return None
        # 跨租户读取一律拒绝：先取到再比对，才能区分"不存在"与"不属于你"
        if rows[0]["tenant_id"] != tenant_id:
            raise TenantError("跨租户访问被拒绝")
        return _audit_row(rows[0])

    async def usage(self, tenant_id: str, *, days: int = 1) -> dict[str, Any]:
        since = datetime.now(UTC) - timedelta(days=days)
        rows = await self.pool.fetch_all(
            """
            SELECT to_char(created_at, 'YYYY-MM-DD') AS day,
                   COUNT(*) AS runs,
                   COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                   COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                   COUNT(*) FILTER (WHERE blocked) AS blocked_runs
            FROM audit_run
            WHERE tenant_id = %s AND created_at >= %s
            GROUP BY day ORDER BY day
            """,
            (tenant_id, since),
        )
        days_out = [
            {
                "day": row["day"],
                "runs": int(row["runs"] or 0),
                "prompt_tokens": int(row["prompt_tokens"] or 0),
                "completion_tokens": int(row["completion_tokens"] or 0),
                "blocked_runs": int(row["blocked_runs"] or 0),
            }
            for row in rows
        ]
        return {
            "tenant_id": tenant_id,
            "days": days_out,
            "total_tokens": sum(item["prompt_tokens"] + item["completion_tokens"] for item in days_out),
        }

    async def recent(self, tenant_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
        rows = await self.pool.fetch_all(
            """
            SELECT trace_id, created_at, question, model, guard_ok, blocked,
                   prompt_tokens, completion_tokens, latency_ms
            FROM audit_run WHERE tenant_id = %s
            ORDER BY created_at DESC LIMIT %s
            """,
            (tenant_id, limit),
        )
        return [
            {
                **row,
                "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            }
            for row in rows
        ]

    async def total_tokens(self, tenant_id: str) -> int:
        """当日已消耗 token（LLM 预算熔断用）。"""
        rows = await self.pool.fetch_all(
            """
            SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total
            FROM audit_run WHERE tenant_id = %s AND created_at >= %s
            """,
            (tenant_id, datetime.now(UTC) - timedelta(days=1)),
        )
        return int(rows[0]["total"] or 0) if rows else 0


class PgTenantStore:
    """租户与密钥（原 `TENANT_KEYS` 环境变量入库）。

    密钥只存摘要；校验时重算摘要再常数时间比对。
    索引缓存 60 秒：鉴权在每个请求上，不打库是硬要求，
    但又不能长到改了密钥不生效。
    """

    _CACHE_TTL = 60.0

    def __init__(self, pool: PgPool) -> None:
        self.pool = pool
        self._cache: dict[str, str] = {}
        self._status: dict[str, str] = {}
        self._loaded_at = 0.0

    async def bootstrap(self, keys: dict[str, str]) -> int:
        """把环境变量里的租户写入库（只在库为空时执行），并落一条起始记录。"""
        if not keys:
            return 0
        existing = await self.pool.fetch_all("SELECT COUNT(*) AS n FROM app_tenant")
        if int(existing[0]["n"] or 0) > 0:
            return 0
        async with self.pool.connection() as conn:
            for tenant_id, api_key in keys.items():
                await conn.execute(
                    """
                    INSERT INTO app_tenant (tenant_id, api_key_hash, display_name)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (tenant_id) DO NOTHING
                    """,
                    (tenant_id.lower(), hash_api_key(tenant_id.lower(), api_key), tenant_id),
                )
        return len(keys)

    async def _refresh(self) -> None:
        rows = await self.pool.fetch_all("SELECT tenant_id, api_key_hash, status FROM app_tenant")
        self._cache = {row["tenant_id"]: row["api_key_hash"] for row in rows}
        self._status = {row["tenant_id"]: row["status"] for row in rows}
        self._loaded_at = time.monotonic()

    async def verify(self, tenant_id: str, api_key: str | None) -> None:
        """校验租户；失败抛 `TenantError`，与环境变量路径同语义。"""
        key = tenant_id.strip().lower()
        if time.monotonic() - self._loaded_at > self._CACHE_TTL:
            await self._refresh()
        expected = self._cache.get(key)
        if expected is None:
            raise TenantError(f"未知租户：{tenant_id}")
        if self._status.get(key, "active") != "active":
            raise TenantError(f"租户已停用：{tenant_id}")
        if api_key is None or not hmac.compare_digest(expected, hash_api_key(key, api_key)):
            raise TenantError("租户密钥不正确")

    async def upsert(self, tenant_id: str, api_key: str, *, display_name: str = "") -> None:
        """新增或轮换密钥。"""
        key = tenant_id.strip().lower()
        await self.pool.execute(
            """
            INSERT INTO app_tenant (tenant_id, api_key_hash, display_name, updated_at)
            VALUES (%s, %s, %s, now())
            ON CONFLICT (tenant_id) DO UPDATE SET
                api_key_hash = EXCLUDED.api_key_hash,
                display_name = EXCLUDED.display_name,
                updated_at = now()
            """,
            (key, hash_api_key(key, api_key), display_name or tenant_id),
        )
        self._loaded_at = 0.0


def _as_json(value: Any) -> Any:
    """把任意结构转成可以塞进 jsonb 的值。"""
    if value is None:
        return None
    from psycopg.types.json import Jsonb

    return Jsonb(value)


def _as_datetime(value: Any) -> datetime:
    """接受 ISO 字符串或 datetime，统一成带时区的 datetime。"""
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return datetime.now(UTC)
        return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)
    return datetime.now(UTC)


def _audit_row(row: dict[str, Any]) -> dict[str, Any]:
    """审计行转 dict：时间与 jsonb 字段还原成 API 一直以来的形态。"""
    out = dict(row)
    created = out.get("created_at")
    out["created_at"] = created.isoformat() if isinstance(created, datetime) else created
    for field in ("intent", "recall", "guard_json"):
        value = out.get(field)
        if isinstance(value, (dict, list)):
            out[field] = json.dumps(value, ensure_ascii=False)
    if "guard_ok" in out:
        out["guard_ok"] = 1 if out["guard_ok"] else 0
    if "blocked" in out:
        out["blocked"] = 1 if out["blocked"] else 0
    return out
