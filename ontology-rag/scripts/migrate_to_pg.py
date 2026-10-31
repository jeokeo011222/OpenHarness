#!/usr/bin/env python
"""把既有 SQLite 审计库与种子分块迁移到 PostgreSQL（幂等）。

迁移范围明确划三条线：
1. `audit_run`（SQLite）        → `audit_run`（PostgreSQL），按 trace_id 去重，不覆盖库中已有行；
2. `*.chunks.jsonl`（文件）      → `ontology_chunk` + `chunk_vector`，按 (tenant_id, chunk_id) upsert；
3. RDF 实例数据**不迁移** —— 它本来就在 Fuseki，不在 SQLite 里。

用法：
    backend/.venv/Scripts/python.exe scripts/migrate_to_pg.py --dry-run
    backend/.venv/Scripts/python.exe scripts/migrate_to_pg.py --verify

退出码：0 表示迁移完成且行数核对一致，1 表示核对有差异。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
from _bootstrap import ensure_backend_path  # noqa: E402

ensure_backend_path()

from app.adapters.memory import HashingEmbedder  # noqa: E402
from app.adapters.pg import (  # noqa: E402
    PgChunkRepository,
    PgPool,
    PgTenantStore,
    PgVectorIndex,
    apply_schema,
    bigram_text,
)
from app.compat import use_psycopg_compatible_loop  # noqa: E402
from app.schemas import Chunk  # noqa: E402
from app.settings import Settings  # noqa: E402

use_psycopg_compatible_loop()

_AUDIT_COLUMNS = (
    "trace_id",
    "tenant_id",
    "created_at",
    "question",
    "intent_json",
    "recall_json",
    "sparql",
    "prompt",
    "llm_output",
    "answer",
    "prompt_tokens",
    "completion_tokens",
    "model",
    "guard_ok",
    "guard_json",
    "blocked",
    "latency_ms",
    "error",
)

# SQLite 的 JSON 列是文本、布尔是 0/1；PG 对应 jsonb 与 boolean。
# 显式转换而不是靠隐式转换，避免 '0' 被当成非空字符串而误判为 true。
_INSERT_AUDIT = """
INSERT INTO audit_run (
    trace_id, tenant_id, created_at, question, intent, recall, sparql,
    prompt, llm_output, answer, prompt_tokens, completion_tokens,
    model, guard_ok, guard_json, blocked, latency_ms, error
) VALUES (
    %(trace_id)s, %(tenant_id)s, %(created_at)s, %(question)s,
    %(intent)s::jsonb, %(recall)s::jsonb, %(sparql)s,
    %(prompt)s, %(llm_output)s, %(answer)s, %(prompt_tokens)s, %(completion_tokens)s,
    %(model)s, %(guard_ok)s, %(guard)s::jsonb, %(blocked)s, %(latency_ms)s, %(error)s
)
ON CONFLICT (trace_id) DO NOTHING
"""


def parse_args() -> argparse.Namespace:
    """命令行参数。"""
    parser = argparse.ArgumentParser(description="SQLite / JSONL → PostgreSQL 迁移")
    parser.add_argument("--sqlite", default=str(ROOT / "var" / "audit.db"), help="SQLite 审计库路径")
    parser.add_argument("--seed", default=str(ROOT / "data" / "seed"), help="种子分块目录")
    parser.add_argument("--dsn", default="", help="覆盖 PG_DSN")
    parser.add_argument("--dry-run", action="store_true", help="只统计不写库")
    parser.add_argument("--skip-audit", action="store_true")
    parser.add_argument("--skip-chunks", action="store_true")
    parser.add_argument("--skip-vectors", action="store_true", help="迁移分块但不算向量")
    return parser.parse_args()


def read_sqlite_audit(path: Path) -> list[dict[str, Any]]:
    """读取 SQLite 审计行；库不存在时返回空列表而不是报错。"""
    if not path.exists():
        print(f"[迁移] SQLite 不存在，跳过审计迁移：{path}")
        return []
    connection = sqlite3.connect(path, timeout=10.0)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            f"SELECT {', '.join(_AUDIT_COLUMNS)} FROM audit_run ORDER BY created_at"
        ).fetchall()
    except sqlite3.OperationalError as error:
        print(f"[迁移] 读取 SQLite 失败（{error}），跳过审计迁移")
        return []
    finally:
        connection.close()
    return [dict(row) for row in rows]


def to_pg_audit(row: dict[str, Any]) -> dict[str, Any]:
    """把一行 SQLite 审计转成 PG 参数。"""
    return {
        "trace_id": row["trace_id"],
        "tenant_id": row["tenant_id"],
        "created_at": row["created_at"],
        "question": row.get("question") or "",
        "intent": row.get("intent_json"),
        "recall": row.get("recall_json"),
        "sparql": row.get("sparql"),
        "prompt": row.get("prompt"),
        "llm_output": row.get("llm_output"),
        "answer": row.get("answer"),
        "prompt_tokens": int(row.get("prompt_tokens") or 0),
        "completion_tokens": int(row.get("completion_tokens") or 0),
        "model": row.get("model"),
        "guard_ok": bool(row.get("guard_ok")),
        "guard": row.get("guard_json"),
        "blocked": bool(row.get("blocked")),
        "latency_ms": int(row.get("latency_ms") or 0),
        "error": row.get("error"),
    }


def load_seed(seed_dir: Path) -> dict[str, list[Chunk]]:
    """读取全部种子分块。"""
    result: dict[str, list[Chunk]] = {}
    for path in sorted(seed_dir.glob("*.chunks.jsonl")):
        tenant = path.name.split(".")[0]
        result[tenant] = [
            Chunk.model_validate({**json.loads(line), "tenant_id": tenant})
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    return result


async def count_audit(pool: PgPool, source: list[dict[str, Any]]) -> dict[str, int]:
    """按租户统计目标库行数，用于核对。"""
    if not source:
        return {}
    tenants = sorted({row["tenant_id"] for row in source})
    rows = await pool.fetch_all(
        "SELECT tenant_id, COUNT(*) AS n FROM audit_run WHERE tenant_id = ANY(%s) GROUP BY tenant_id",
        (tenants,),
    )
    return {row["tenant_id"]: int(row["n"]) for row in rows}


async def run(args: argparse.Namespace) -> int:
    """执行迁移并核对。"""
    settings = Settings(pg_dsn=args.dsn) if args.dsn else Settings()
    pool = PgPool(settings)
    await pool.open()
    mismatched = 0
    try:
        await apply_schema(pool, settings.pg_schema_path, settings.embedding_dim)
        print(f"[迁移] 目标库 schema 就绪：{settings.pg_dsn.split('@')[-1]}")

        tenants = PgTenantStore(pool)
        seeded = await tenants.bootstrap(settings.tenant_keys)
        if seeded:
            print(f"[迁移] 引导 {seeded} 个租户入库")

        # ---------- 1. 审计 ----------
        if not args.skip_audit:
            source = read_sqlite_audit(Path(args.sqlite))
            print(f"[迁移] SQLite 审计行 {len(source)} 条")
            if source and not args.dry_run:
                for row in source:
                    await pool.execute(_INSERT_AUDIT, to_pg_audit(row))
            if source:
                target = await count_audit(pool, source)
                expect: dict[str, int] = {}
                for row in source:
                    expect[row["tenant_id"]] = expect.get(row["tenant_id"], 0) + 1
                for tenant, want in sorted(expect.items()):
                    got = target.get(tenant, 0)
                    flag = "OK" if got >= want else "差异"
                    if got < want:
                        mismatched += 1
                    print(f"[迁移] 审计核对 tenant={tenant} 源={want} 目标={got} {flag}")

        # ---------- 2. 分块 + 向量 ----------
        if not args.skip_chunks:
            repository = PgChunkRepository(pool)
            embedder = HashingEmbedder(settings.embedding_dim)
            model = f"hash-bigram:{settings.embedding_dim}"
            if settings.deepseek_api_key:
                from app.adapters.deepseek import DeepSeekEmbedder

                embedder = DeepSeekEmbedder(settings)  # type: ignore[assignment]
                model = f"deepseek:{settings.embedding_model}"
            vectors = PgVectorIndex(settings, pool, model=model)

            for tenant, chunks in load_seed(Path(args.seed)).items():
                if args.dry_run:
                    print(f"[迁移] 分块 tenant={tenant} 待写入 {len(chunks)} 条（dry-run）")
                    continue
                written = await repository.put_many(chunks)
                rows = await pool.fetch_all(
                    "SELECT COUNT(*) AS n FROM ontology_chunk WHERE tenant_id = %s", (tenant,)
                )
                got = int(rows[0]["n"] or 0)
                if got < len(chunks):
                    mismatched += 1
                print(f"[迁移] 分块 tenant={tenant} 写入 {written} 条，目标库共 {got} 条")
                if args.skip_vectors:
                    continue
                embedded = await embedder.embed([chunk.text for chunk in chunks])  # type: ignore[attr-defined]
                pairs = [(chunk.chunk_id, vector) for chunk, vector in zip(chunks, embedded)]
                count = await vectors.upsert(tenant, pairs, model=model)
                print(f"[迁移] 向量 tenant={tenant} 写入 {count} 条（model={model}）")
            close = getattr(embedder, "aclose", None)
            if close is not None:
                await close()

        # ---------- 3. 关键词索引自检 ----------
        if not args.dry_run and not args.skip_chunks:
            rows = await pool.fetch_all(
                "SELECT tenant_id, COUNT(*) AS n FROM ontology_chunk WHERE token_doc @@ to_tsquery('simple', %s) "
                "GROUP BY tenant_id",
                (" | ".join(bigram_text("付款申请").split()),),
            )
            for row in rows:
                print(f"[迁移] 关键词自检 tenant={row['tenant_id']} 命中「付款申请」{row['n']} 条")

        print("[迁移] 完成" if mismatched == 0 else f"[迁移] 完成，但有 {mismatched} 处行数差异")
        return 0 if mismatched == 0 else 1
    finally:
        await pool.aclose()


def main() -> int:
    """入口。"""
    return asyncio.run(run(parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
