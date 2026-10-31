#!/usr/bin/env python
"""MySQL -> RDF 增量同步。

设计要点：
- 每张表按 `updated_at` 水位增量拉取，水位落盘到 var/mysql_sync_state.json；
- 一行生成一个主语，属性由映射配置声明，禁止在代码里硬编码业务字段；
- 默认只产出 Turtle；加 `--push` 才写入 Fuseki 租户图。

用法：
    backend/.venv/Scripts/python.exe scripts/mysql_to_rdf.py \
        --tenant demo --mapping config/mysql_mapping.json --push
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
from _bootstrap import ensure_backend_path  # noqa: E402

ensure_backend_path()

import httpx  # noqa: E402
from rdflib import Graph, Literal, URIRef  # noqa: E402
from rdflib.namespace import RDF, XSD  # noqa: E402

from app.ontology.model import load_ontology  # noqa: E402
from app.settings import Settings  # noqa: E402

DATATYPES = {"decimal": XSD.decimal, "integer": XSD.integer, "date": XSD.date, "string": XSD.string}


def parse_args() -> argparse.Namespace:
    """命令行参数。"""
    parser = argparse.ArgumentParser(description="MySQL 增量同步到 RDF")
    parser.add_argument("--tenant", default="demo")
    parser.add_argument("--mapping", default=str(ROOT / "config" / "mysql_mapping.json"))
    parser.add_argument("--state", default=str(ROOT / "var" / "mysql_sync_state.json"))
    parser.add_argument("--out", default=str(ROOT / "var" / "mysql_sync.ttl"))
    parser.add_argument("--full", action="store_true", help="忽略水位全量同步")
    parser.add_argument("--push", action="store_true", help="写入 Fuseki")
    return parser.parse_args()


def connect(settings: Settings) -> Any:
    """建立 MySQL 连接。连接参数全部来自环境变量。"""
    import pymysql

    return pymysql.connect(
        host=os.getenv("MYSQL_HOST", "localhost"),
        port=int(os.getenv("MYSQL_PORT", "3306")),
        user=os.getenv("MYSQL_USER", ""),
        password=os.getenv("MYSQL_PASSWORD", ""),
        database=os.getenv("MYSQL_DATABASE", ""),
        cursorclass=pymysql.cursors.DictCursor,
        charset="utf8mb4",
        connect_timeout=10,
        read_timeout=30,
    )


def load_state(path: Path) -> dict[str, str]:
    """读取同步水位。"""
    if not path.exists():
        return {}
    return dict(json.loads(path.read_text(encoding="utf-8")))


def save_state(path: Path, state: dict[str, str]) -> None:
    """保存同步水位。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def to_literal(value: Any, datatype: str) -> Literal:
    """按声明类型构造字面量。"""
    if value is None:
        return Literal("", datatype=XSD.string)
    if datatype == "decimal":
        return Literal(Decimal(str(value)), datatype=XSD.decimal)
    if datatype == "integer":
        return Literal(int(value), datatype=XSD.integer)
    if datatype == "date":
        if isinstance(value, (date, datetime)):
            return Literal(value.isoformat()[:10], datatype=XSD.date)
    return Literal(str(value), datatype=XSD.string)


def sync_table(
    connection: Any,
    tenant: str,
    spec: dict[str, Any],
    ontology: Any,
    graph: Graph,
    watermark: str | None,
) -> tuple[int, str | None]:
    """同步一张表，返回行数与新的水位。"""
    sql: str = spec["query"]
    params: tuple[Any, ...] = ()
    updated_column = spec.get("updated_column")
    if updated_column and watermark and not spec.get("full_scan"):
        sql = f"SELECT * FROM ({sql}) AS src WHERE {updated_column} > %s"
        params = (watermark,)

    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        rows = cursor.fetchall()

    subject_template: str = spec["subject"]
    class_iri = ontology.iri_of(spec["class"])
    if class_iri is None:
        raise SystemExit(f"映射中的类不在本体中：{spec['class']}")

    new_watermark = watermark
    for row in rows:
        subject = URIRef(subject_template.format(tenant=tenant, id=row[spec["id_column"]]))
        graph.add((subject, RDF.type, URIRef(class_iri)))
        for predicate, rule in spec.get("properties", {}).items():
            prop_iri = ontology.iri_of(predicate)
            if prop_iri is None:
                raise SystemExit(f"映射中的属性不在本体中：{predicate}")
            graph.add((subject, URIRef(prop_iri), to_literal(row.get(rule["column"]), rule.get("type", "string"))))
        for predicate, rule in spec.get("links", {}).items():
            prop_iri = ontology.iri_of(predicate)
            if prop_iri is None:
                raise SystemExit(f"映射中的属性不在本体中：{predicate}")
            target_value = row.get(rule["column"])
            if target_value is None:
                continue
            target = URIRef(rule["subject"].format(tenant=tenant, value=target_value))
            graph.add((subject, URIRef(prop_iri), target))
            target_class = ontology.iri_of(rule.get("class", ""))
            if target_class is not None:
                graph.add((target, RDF.type, URIRef(target_class)))

        if updated_column and row.get(updated_column) is not None:
            value = str(row[updated_column])
            if new_watermark is None or value > new_watermark:
                new_watermark = value
    return len(rows), new_watermark


def main() -> int:
    """执行同步。"""
    args = parse_args()
    settings = Settings()
    ontology = load_ontology(settings.ontology_dir)
    mapping = json.loads(Path(args.mapping).read_text(encoding="utf-8"))
    state_path = Path(args.state)
    state = {} if args.full else load_state(state_path)

    graph = Graph()
    connection = connect(settings)
    total = 0
    try:
        for spec in mapping["tables"]:
            watermark = state.get(spec["name"])
            count, new_watermark = sync_table(connection, args.tenant, spec, ontology, graph, watermark)
            total += count
            if new_watermark:
                state[spec["name"]] = new_watermark
            print(f"[sync] {spec['name']}: {count} 行，水位 -> {new_watermark}")
    finally:
        connection.close()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    graph.serialize(destination=str(out_path), format="turtle")
    save_state(state_path, state)
    print(f"[write] {total} 行 -> {out_path}（{len(graph)} 条三元组）")

    if args.push:
        url = f"{settings.fuseki_url.rstrip('/')}/{settings.fuseki_dataset}/data"
        auth = (settings.fuseki_user, settings.fuseki_password) if settings.fuseki_user else None
        with httpx.Client(timeout=120.0, auth=auth) as client:
            response = client.post(
                url,
                params={"graph": f"urn:ontorag:tenant:{args.tenant}:graph"},
                content=out_path.read_bytes(),
                headers={"Content-Type": "text/turtle"},
            )
            response.raise_for_status()
        print(f"[push] 已写入 {url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
