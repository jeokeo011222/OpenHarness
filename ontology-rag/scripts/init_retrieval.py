#!/usr/bin/env python
"""检索层初始化：ES 索引映射、Milvus 集合与索引、种子分块导入。

用法：
    backend/.venv/Scripts/python.exe scripts/init_retrieval.py --tenant demo --embed
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

import httpx  # noqa: E402

from app.schemas import Chunk  # noqa: E402
from app.settings import Settings  # noqa: E402


def parse_args() -> argparse.Namespace:
    """命令行参数。"""
    parser = argparse.ArgumentParser(description="初始化 ES 与 Milvus")
    parser.add_argument("--tenant", action="append", default=[], help="要建索引的租户，可重复")
    parser.add_argument("--seed", default=str(ROOT / "data" / "seed"), help="种子分块目录")
    parser.add_argument("--embed", action="store_true", help="把种子分块向量化写入 Milvus")
    parser.add_argument("--skip-es", action="store_true")
    parser.add_argument("--skip-milvus", action="store_true")
    return parser.parse_args()


def ensure_index(settings: Settings, tenant: str, mapping: dict[str, object]) -> None:
    """创建 ES 索引（幂等）。"""
    url = f"{settings.es_url.rstrip('/')}/{settings.es_index_prefix}_{tenant}_chunks"
    auth = (settings.es_username, settings.es_password) if settings.es_username else None
    with httpx.Client(timeout=30.0, auth=auth) as client:
        response = client.put(url, json=mapping)
        if response.status_code == 200:
            print(f"[es] 创建索引 {url}")
        elif response.status_code == 400 and "resource_already_exists_exception" in response.text:
            print(f"[es] 索引已存在，跳过 {url}")
        else:
            response.raise_for_status()


def bulk_index(settings: Settings, tenant: str, chunks: list[Chunk]) -> None:
    """把分块写入 ES。"""
    if not chunks:
        return
    lines: list[str] = []
    index = f"{settings.es_index_prefix}_{tenant}_chunks"
    for chunk in chunks:
        lines.append(json.dumps({"index": {"_index": index, "_id": chunk.chunk_id}}, ensure_ascii=False))
        lines.append(chunk.model_dump_json())
    body = "\n".join(lines) + "\n"
    auth = (settings.es_username, settings.es_password) if settings.es_username else None
    with httpx.Client(timeout=60.0, auth=auth) as client:
        response = client.post(
            f"{settings.es_url.rstrip('/')}/_bulk",
            content=body.encode("utf-8"),
            headers={"Content-Type": "application/x-ndjson"},
        )
        response.raise_for_status()
    print(f"[es] 写入 {len(chunks)} 条分块到 {index}")


def ensure_collection(settings: Settings) -> None:
    """创建 Milvus 集合与 IVF_FLAT 索引（幂等）。"""
    from pymilvus import Collection, CollectionSchema, DataType, FieldSchema, connections, utility

    connections.connect(alias="ontorag", uri=settings.milvus_uri, token=settings.milvus_token or None)
    if utility.has_collection(settings.milvus_collection, using="ontorag"):
        print(f"[milvus] 集合已存在：{settings.milvus_collection}")
        return
    fields = [
        FieldSchema(name="chunk_id", dtype=DataType.VARCHAR, is_primary=True, max_length=256),
        # 分区键：查询必须带 tenant_id 过滤，物理上按租户聚集
        FieldSchema(name="tenant_id", dtype=DataType.VARCHAR, max_length=64, is_partition_key=True),
        FieldSchema(name="vector", dtype=DataType.FLOAT_VECTOR, dim=settings.milvus_dim),
    ]
    collection = Collection(
        name=settings.milvus_collection,
        schema=CollectionSchema(fields, description="OntoRAG chunk vectors"),
        using="ontorag",
    )
    collection.create_index(
        field_name="vector",
        index_params={"index_type": "IVF_FLAT", "metric_type": "COSINE", "params": {"nlist": 1024}},
    )
    collection.load()
    print(f"[milvus] 创建集合 {settings.milvus_collection}（dim={settings.milvus_dim}）")


async def embed_chunks(settings: Settings, chunks: list[Chunk]) -> None:
    """向量化并写入 Milvus。"""
    from pymilvus import Collection, connections

    from app.adapters.deepseek import DeepSeekEmbedder

    embedder = DeepSeekEmbedder(settings)
    vectors = await embedder.embed([chunk.text for chunk in chunks])
    connections.connect(alias="ontorag", uri=settings.milvus_uri, token=settings.milvus_token or None)
    collection = Collection(settings.milvus_collection, using="ontorag")
    collection.upsert(
        [
            [chunk.chunk_id for chunk in chunks],
            [chunk.tenant_id for chunk in chunks],
            vectors,
        ]
    )
    collection.flush()
    await embedder.aclose()
    print(f"[milvus] 写入 {len(chunks)} 条向量")


def load_seed(seed_dir: Path, tenants: list[str]) -> dict[str, list[Chunk]]:
    """读取种子分块。"""
    result: dict[str, list[Chunk]] = {}
    for path in sorted(seed_dir.glob("*.chunks.jsonl")):
        tenant = path.name.split(".")[0]
        if tenants and tenant not in tenants:
            continue
        chunks = [
            Chunk.model_validate(json.loads(line))
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        result[tenant] = chunks
    return result


def main() -> int:
    """执行初始化。"""
    args = parse_args()
    settings = Settings()
    mapping = json.loads((ROOT / "retrieval" / "es" / "chunks.mapping.json").read_text(encoding="utf-8"))
    seeds = load_seed(Path(args.seed), args.tenant)

    if not args.skip_es:
        for tenant, chunks in seeds.items():
            ensure_index(settings, tenant, mapping)
            bulk_index(settings, tenant, chunks)
    if not args.skip_milvus:
        ensure_collection(settings)
        if args.embed:
            for chunks in seeds.values():
                asyncio.run(embed_chunks(settings, chunks))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
