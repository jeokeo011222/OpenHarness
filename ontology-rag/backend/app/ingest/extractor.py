"""三元组抽取：把非结构化文本抽成 RDF 实例。

反幻觉要求：模型只能使用本体中已存在的类与属性，任何越界候选一律丢弃并记录，
所以抽取结果天然受本体约束，不会污染实例图。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from rdflib import Graph, Literal, Namespace, URIRef
from rdflib.namespace import RDF, XSD

from ..errors import OntoRagError
from ..ontology.model import CAR, CON, TOP, OntologyModel

_IRI_BASE = "http://ontorag.local/tenant/{tenant}/{domain}/{id}"
_DATATYPE = {
    "decimal": XSD.decimal,
    "integer": XSD.integer,
    "date": XSD.date,
    "string": XSD.string,
    "boolean": XSD.boolean,
}

EXTRACT_SYSTEM = """你是企业合同与碳核算领域的三元组抽取器。

规则：
1. 只能使用给定的类与属性候选，不得自造。
2. 每个实体必须有稳定的业务编号 id（如合同号、付款单号、发票号）。
3. 金额一律输出为十进制数字字符串，日期输出为 YYYY-MM-DD。
4. 只输出 JSON，不要解释。

输出结构：
{"entities": [
  {
    "id": "C-2024-001",
    "class": "con:Contract",
    "label": "2024 年设备采购合同",
    "properties": {"con:contractAmount": "10000000", "con:contractStatus": "active"},
    "links": {"con:signedWith": "SUP-A"}
  }
], "clauses": [{"no": "第三条", "text": "原文"}]}"""


@dataclass(slots=True)
class ExtractionResult:
    """一次抽取的结果。"""

    graph: Graph
    entities: int
    dropped: list[str]


class TripleExtractor:
    """基于模型的实例抽取，输出可直接入库的 RDF。"""

    def __init__(self, ontology: OntologyModel, llm_service: Any | None = None) -> None:
        self.ontology = ontology
        self.llm = llm_service

    async def extract(self, tenant_id: str, text: str, *, doc_id: str, doc_title: str) -> ExtractionResult:
        """抽取并校验。"""
        if self.llm is None:
            raise OntoRagError(
                "三元组抽取需要模型支持，请配置 DEEPSEEK_API_KEY 并以 RAG_MODE=live 运行",
                details={"doc_id": doc_id},
            )
        candidates = self._candidates()
        user = json.dumps(
            {"document": {"id": doc_id, "title": doc_title, "text": text[:12000]}, **candidates},
            ensure_ascii=False,
        )
        result, _ = await self.llm.complete(
            tenant_id=tenant_id,
            task="extract",
            system=EXTRACT_SYSTEM,
            user=user,
            temperature=0.0,
            max_tokens=3000,
        )
        payload = _parse_json(result.text)
        if payload is None:
            raise OntoRagError("抽取结果不是合法 JSON", details={"raw": result.text[:500]})
        return self.build_graph(tenant_id, payload)

    def _candidates(self) -> dict[str, list[str]]:
        """给模型的候选空间：只含本体的类与属性。"""
        classes = [f"{prefix}:{info.local}" for prefix, ns in (("con", CON), ("car", CAR), ("top", TOP))
                   for info in self.ontology.classes.values() if info.iri.startswith(str(ns))]
        properties = [f"{prefix}:{info.local}" for prefix, ns in (("con", CON), ("car", CAR), ("top", TOP))
                      for info in self.ontology.properties.values() if info.iri.startswith(str(ns))]
        return {"class_candidates": classes, "property_candidates": properties}

    def build_graph(self, tenant_id: str, payload: dict[str, Any]) -> ExtractionResult:
        """把模型 JSON 转成 RDF，越界项丢弃。"""
        graph = Graph()
        dropped: list[str] = []
        entities = [item for item in payload.get("entities", []) if isinstance(item, dict)]
        known: dict[str, URIRef] = {}

        # 第一遍：建实体与字面量属性
        for entity in entities:
            entity_id = str(entity.get("id", "")).strip()
            class_name = str(entity.get("class", "")).strip()
            if not entity_id:
                dropped.append("缺少业务编号的实体")
                continue
            class_iri = self.ontology.iri_of(class_name)
            if class_iri is None or self.ontology.class_of(class_iri) is None:
                dropped.append(f"未知类 {class_name}（{entity_id}）")
                continue
            domain = next(
                (name for name, prefixes in self.ontology.domain_namespaces.items() if class_iri.startswith(prefixes)),
                "contract",
            )
            subject = URIRef(_IRI_BASE.format(tenant=tenant_id, domain=domain, id=_safe(entity_id)))
            known[entity_id] = subject
            graph.add((subject, RDF.type, URIRef(class_iri)))
            label = entity.get("label")
            if label:
                graph.add((subject, TOP.identifier, Literal(entity_id)))
                graph.add((subject, URIRef("http://www.w3.org/2000/01/rdf-schema#label"), Literal(str(label))))
            for predicate, value in (entity.get("properties") or {}).items():
                prop_iri = self.ontology.iri_of(str(predicate))
                info = self.ontology.property_of(prop_iri) if prop_iri else None
                if prop_iri is None or info is None or info.object_property:
                    dropped.append(f"未知数据属性 {predicate}")
                    continue
                graph.add((subject, URIRef(prop_iri), _literal(value, info.range)))

        # 第二遍：建对象属性（目标必须同批出现，否则视为悬空引用）
        for entity in entities:
            subject = known.get(str(entity.get("id", "")).strip())
            if subject is None:
                continue
            for predicate, target in (entity.get("links") or {}).items():
                prop_iri = self.ontology.iri_of(str(predicate))
                info = self.ontology.property_of(prop_iri) if prop_iri else None
                if prop_iri is None or info is None or not info.object_property:
                    dropped.append(f"未知对象属性 {predicate}")
                    continue
                target_subject = known.get(str(target))
                if target_subject is None:
                    dropped.append(f"悬空引用 {predicate} -> {target}")
                    continue
                graph.add((subject, URIRef(prop_iri), target_subject))
        return ExtractionResult(graph=graph, entities=len(known), dropped=dropped)


def _literal(value: Any, ranges: list[str]) -> Literal:
    """按属性 range 构造带类型的字面量。"""
    local = next((item for item in ranges if item in _DATATYPE), "string")
    return Literal(value, datatype=_DATATYPE.get(local, XSD.string))


def _safe(text: str) -> str:
    """IRI 片段只保留安全字符。"""
    return re.sub(r"[^A-Za-z0-9._~-]", "-", text)


def _parse_json(text: str) -> dict[str, Any] | None:
    """容错 JSON 解析。"""
    stripped = text.strip()
    if stripped.startswith("```"):
        parts = stripped.split("```")
        if len(parts) >= 2:
            stripped = parts[1].lstrip()
            if stripped.startswith("json"):
                stripped = stripped[4:]
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        start, end = stripped.find("{"), stripped.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            parsed = json.loads(stripped[start : end + 1])
        except json.JSONDecodeError:
            return None
    return parsed if isinstance(parsed, dict) else None
