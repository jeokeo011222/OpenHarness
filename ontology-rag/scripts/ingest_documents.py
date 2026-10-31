#!/usr/bin/env python
"""文档入库：解析 PDF/Word/文本 -> 本体感知分块 -> 三元组抽取 -> 写入 ES / TTL。

用法（在 ontology-rag 目录下）：
    backend/.venv/Scripts/python.exe scripts/ingest_documents.py \
        --tenant demo --source data/docs --doc-type regulation \
        --effective-from 2024-01-01 --push

产物：
    var/chunks_<tenant>.jsonl   检索分块
    var/instances_<tenant>.ttl  实例三元组（需模型支持）
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
from _bootstrap import ensure_backend_path  # noqa: E402

ensure_backend_path()

import httpx  # noqa: E402

from app.container import build_container  # noqa: E402
from app.ingest import TripleExtractor, extract_text, iter_documents  # noqa: E402
from app.ontology.chunker import DocumentMeta  # noqa: E402
from app.settings import Settings  # noqa: E402


def parse_args() -> argparse.Namespace:
    """命令行参数。"""
    parser = argparse.ArgumentParser(description="文档入库：分块 + 三元组抽取")
    parser.add_argument("--tenant", default="demo", help="租户 id")
    parser.add_argument("--source", required=True, help="文档文件或目录")
    parser.add_argument("--doc-type", default="regulation", choices=["regulation", "contract", "ledger", "standard", "archive"])
    parser.add_argument("--version", default="v1")
    parser.add_argument("--effective-from", default=None, help="YYYY-MM-DD")
    parser.add_argument("--effective-to", default=None, help="YYYY-MM-DD")
    parser.add_argument("--superseded-by", default=None, help="替代版本号，填写即标记作废")
    parser.add_argument("--extract", action="store_true", help="同时抽取实例三元组（需要模型）")
    parser.add_argument("--push", action="store_true", help="写入 ES 与 Fuseki")
    parser.add_argument("--out-dir", default=str(ROOT / "var"))
    return parser.parse_args()


async def push_graph(graph_path: Path, settings: Settings, tenant: str) -> None:
    """通过 Graph Store Protocol 把 Turtle 写入租户图。"""
    url = f"{settings.fuseki_url.rstrip('/')}/{settings.fuseki_dataset}/data"
    auth = (settings.fuseki_user, settings.fuseki_password) if settings.fuseki_user else None
    async with httpx.AsyncClient(timeout=60.0, auth=auth) as client:
        response = await client.post(
            url,
            params={"graph": f"urn:ontorag:tenant:{tenant}:graph"},
            content=graph_path.read_bytes(),
            headers={"Content-Type": "text/turtle"},
        )
        response.raise_for_status()
    print(f"[push] 三元组写入 {url} graph=urn:ontorag:tenant:{tenant}:graph")


async def main() -> int:
    """执行入库。"""
    args = parse_args()
    settings = Settings()
    container = build_container(settings)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    chunks_path = out_dir / f"chunks_{args.tenant}.jsonl"
    graph_path = out_dir / f"instances_{args.tenant}.ttl"

    paths = iter_documents(Path(args.source))
    if not paths:
        print(f"未找到受支持的文档：{args.source}")
        return 2

    all_chunks = []
    extractor = TripleExtractor(container.ontology, container.llm_service) if args.extract else None
    merged = container.ontology.graph.__class__()

    for path in paths:
        text = extract_text(path)
        meta = DocumentMeta(
            tenant_id=args.tenant,
            doc_id=path.stem,
            title=path.stem,
            doc_type=args.doc_type,
            version=args.version,
            effective_from=date.fromisoformat(args.effective_from) if args.effective_from else None,
            effective_to=date.fromisoformat(args.effective_to) if args.effective_to else None,
            superseded_by=args.superseded_by,
        )
        chunks = container.chunker.chunk(text, meta)
        all_chunks.extend(chunks)
        print(f"[chunk] {path.name}: {len(chunks)} 个业务单元")

        if extractor is not None:
            result = await extractor.extract(args.tenant, text, doc_id=path.stem, doc_title=path.stem)
            for triple in result.graph:
                merged.add(triple)
            if result.dropped:
                print(f"[extract] 丢弃 {len(result.dropped)} 项：{result.dropped[:5]}")

    with chunks_path.open("w", encoding="utf-8", newline="\n") as handle:
        for chunk in all_chunks:
            handle.write(chunk.model_dump_json() + "\n")
    print(f"[write] 分块 -> {chunks_path} ({len(all_chunks)} 条)")

    if len(merged) > 0:
        merged.serialize(destination=str(graph_path), format="turtle")
        print(f"[write] 三元组 -> {graph_path} ({len(merged)} 条)")

    if args.push:
        await container.chunks.put_many(all_chunks)
        print(f"[push] 分块写入 ES 索引 {settings.es_index_prefix}_{args.tenant}_chunks")
        if graph_path.exists() and settings.rag_mode == "live":
            await push_graph(graph_path, settings, args.tenant)

    await container.aclose()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
