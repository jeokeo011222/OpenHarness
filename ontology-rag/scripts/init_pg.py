#!/usr/bin/env python
"""PostgreSQL + pgvector 初始化：建表、导入种子分块、写入向量、引导租户。

用法（宿主机）：
    backend/.venv/Scripts/python.exe scripts/init_pg.py --tenant demo --tenant other

用法（容器内）：
    docker compose exec backend python /srv/scripts/init_pg.py --tenant demo

设计取舍：
- 建表幂等（schema.sql 全是 IF NOT EXISTS），可反复执行；
- `--recreate` 先清空租户分块再导入，用于改完分块策略后重建；
- 向量器与查询期必须同源，所以 `model` 取自 `settings.embedder_name`，
  不在这里另算一份，避免两处漂移。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

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
)
from app.compat import use_psycopg_compatible_loop  # noqa: E402
from app.schemas import Chunk  # noqa: E402
from app.settings import Settings  # noqa: E402

# Windows 开发机上必须换事件循环策略，否则 psycopg 异步连接直接失败
use_psycopg_compatible_loop()


def parse_args() -> argparse.Namespace:
    """命令行参数。"""
    parser = argparse.ArgumentParser(description="初始化 PostgreSQL + pgvector")
    parser.add_argument("--tenant", action="append", default=[], help="要导入的租户，可重复；缺省导入全部种子")
    parser.add_argument("--seed", default=str(ROOT / "data" / "seed"), help="种子分块目录")
    parser.add_argument("--dsn", default="", help="覆盖 PG_DSN")
    parser.add_argument("--recreate", action="store_true", help="先清空该租户的分块再导入")
    parser.add_argument("--skip-vectors", action="store_true", help="只导分块，不算向量")
    parser.add_argument(
        "--embedder",
        choices=["auto", "hash", "deepseek"],
        default="auto",
        help="auto：有 DEEPSEEK_API_KEY 用真实 embedding，否则用确定性哈希向量",
    )
    return parser.parse_args()


def load_seed(seed_dir: Path, tenants: list[str]) -> dict[str, list[Chunk]]:
    """读取 `{tenant}.chunks.jsonl`。"""
    result: dict[str, list[Chunk]] = {}
    for path in sorted(seed_dir.glob("*.chunks.jsonl")):
        tenant = path.name.split(".")[0]
        if tenants and tenant not in tenants:
            continue
        chunks = [
            Chunk.model_validate({**json.loads(line), "tenant_id": tenant})
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        result[tenant] = chunks
    return result


def build_embedder(settings: Settings, mode: str) -> tuple[object, str]:
    """按模式挑向量器，返回 (embedder, model 名称)。"""
    use_deepseek = mode == "deepseek" or (mode == "auto" and bool(settings.deepseek_api_key))
    if not use_deepseek:
        return HashingEmbedder(settings.embedding_dim), f"hash-bigram:{settings.embedding_dim}"
    from app.adapters.deepseek import DeepSeekEmbedder

    return DeepSeekEmbedder(settings), f"deepseek:{settings.embedding_model}"


async def run(args: argparse.Namespace) -> int:
    """执行初始化。"""
    settings = Settings(pg_dsn=args.dsn) if args.dsn else Settings()
    pool = PgPool(settings)
    await pool.open()
    try:
        await apply_schema(pool, settings.pg_schema_path, settings.embedding_dim)
        print(f"[pg] schema 就绪（vector({settings.embedding_dim})）")

        tenants = PgTenantStore(pool)
        seeded = await tenants.bootstrap(settings.tenant_keys)
        if seeded:
            print(f"[pg] 引导 {seeded} 个租户入库（来源 TENANT_KEYS）")

        repository = PgChunkRepository(pool)
        embedder, model = build_embedder(settings, args.embedder)
        vectors = PgVectorIndex(settings, pool, model=model)

        seeds = load_seed(Path(args.seed), args.tenant)
        if not seeds:
            print("[pg] 没有匹配的种子文件，仅完成建表")
            return 0

        for tenant, chunks in seeds.items():
            if args.recreate:
                removed = await repository.delete_tenant(tenant)
                print(f"[pg] 租户 {tenant} 清空旧分块 {removed} 条")
            written = await repository.put_many(chunks)
            print(f"[pg] 租户 {tenant} 写入分块 {written} 条")

            if args.skip_vectors:
                continue
            embedded = await embedder.embed([chunk.text for chunk in chunks])  # type: ignore[attr-defined]
            pairs = [(chunk.chunk_id, vector) for chunk, vector in zip(chunks, embedded)]
            count = await vectors.upsert(tenant, pairs, model=model)
            print(f"[pg] 租户 {tenant} 写入向量 {count} 条（model={model}）")

        rows = await pool.fetch_all(
            "SELECT tenant_id, COUNT(*) AS chunks FROM ontology_chunk GROUP BY tenant_id ORDER BY tenant_id"
        )
        for row in rows:
            print(f"[pg] 汇总 tenant={row['tenant_id']} chunks={row['chunks']}")
        vector_rows = await pool.fetch_all(
            "SELECT tenant_id, COUNT(*) AS vectors FROM chunk_vector GROUP BY tenant_id ORDER BY tenant_id"
        )
        for row in vector_rows:
            print(f"[pg] 汇总 tenant={row['tenant_id']} vectors={row['vectors']}")
        close = getattr(embedder, "aclose", None)
        if close is not None:
            await close()
        return 0
    finally:
        await pool.aclose()


def main() -> int:
    """入口。"""
    return asyncio.run(run(parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
