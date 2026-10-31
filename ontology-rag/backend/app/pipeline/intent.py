"""Query 本体解析：实体、属性、关系、业务约束，以及术语归一消歧。

确定性优先：同义词匹配 + 领域关键词 + 编号模式先给出「可解释的底座」，
LLM 只在底座之上补充，且补充结果必须能对齐到本体，否则丢弃。
这样即使模型抽风，解析结果也不会脱离本体自由发挥。
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..errors import QueryError
from ..ontology.linker import EntityLinker
from ..ontology.model import CAR, CON, OntologyModel
from ..retrieval.constraints import properties_for
from ..schemas import QueryIntent
from ..settings import Settings

# 业务约束线索 -> 对应 SHACL 形状（只用于提示与召回过滤，不参与判定）
#
# 线索必须"够具体"：这里用的是子串匹配，"核算" 会被 "核算边界" 命中，
# 于是问边界冲突时也会挂上"排放量核算"的约束，把排放记录整批拉进证据集，
# 答案里就会多出一堆与提问无关的复算结论。所以把它收窄成 "核算因子"，
# 覆盖面由 "排放量" 这条更高信号的线索兜住。
_CONSTRAINT_HINTS: dict[str, str] = {
    "超付": "PaymentWithinRemaining",
    "剩余应付": "PaymentWithinRemaining",
    "质保金": "PaymentWithinRemaining",
    "发票": "InvoiceTotalWithinPayment",
    "链路": "InvoiceTotalWithinPayment",
    "边界": "EmissionSourceSingleBoundary",
    "互斥": "EmissionSourceSingleBoundary",
    "核算因子": "EmissionAmountMatchesFactor",
    "排放量": "EmissionAmountMatchesFactor",
}

# 文档范围线索 -> ES 过滤条件
_DOC_SCOPE: tuple[tuple[str, dict[str, Any]], ...] = (
    ("制度", {"doc_types": ["regulation"]}),
    ("规范", {"doc_types": ["regulation", "standard"]}),
    ("国标", {"doc_types": ["standard"]}),
    ("历史", {"include_history": True, "priority_max": 40}),
    ("旧版", {"include_history": True, "priority_max": 40}),
)

_ID_RE = re.compile(r"\b[A-Z]{1,6}(?:[-_]\d{2,}){1,3}\b")


class QueryParser:
    """把自然语言查询翻译成受本体约束的检索意图。"""

    def __init__(
        self,
        ontology: OntologyModel,
        linker: EntityLinker,
        settings: Settings,
        llm_service: Any | None = None,
    ) -> None:
        self.ontology = ontology
        self.linker = linker
        self.settings = settings
        self.llm = llm_service

    async def parse(self, tenant_id: str, query: str, domain_hint: str | None = None) -> QueryIntent:
        """解析查询。任何情况下都返回可执行意图，不因模型不可用而失败。"""
        mentions, normalized = self.linker.link(query)
        domain = self._infer_domain(query, mentions, domain_hint)
        classes = [m.iri for m in mentions if m.kind == "class" and m.iri]
        properties = [m.iri for m in mentions if m.kind == "property" and m.iri]

        if self.llm is not None and self.settings.rag_mode == "live":
            refined = await self._llm_refine(tenant_id, query, domain)
            classes = list(dict.fromkeys([*classes, *refined.get("classes", [])]))
            properties = list(dict.fromkeys([*properties, *refined.get("properties", [])]))

        constraints = [shape for hint, shape in _CONSTRAINT_HINTS.items() if hint in query]
        constraints = list(dict.fromkeys(constraints))
        # 约束隐含属性来自统一注册表 `retrieval.constraints`：
        # 解析层和检索层必须用同一张表，否则"约束命中但属性没跟上"会让
        # 兼容性判定少一整个维度，且两边各改各的永远对不齐
        for prop in properties_for(tuple(constraints)):
            iri = self.ontology.iri_of(prop)
            if iri is not None and iri not in properties:
                properties.append(iri)
        filters: dict[str, Any] = {}
        for hint, scope in _DOC_SCOPE:
            if hint in query:
                filters.update(scope)

        identifiers = _ID_RE.findall(query)
        if identifiers:
            filters["identifiers"] = identifiers
        # 把本体标签下推到检索层：从源头减少不兼容召回，而不是召回后全丢
        if classes:
            filters["ontology_classes"] = list(dict.fromkeys(classes))
        if properties:
            filters["ontology_properties"] = list(dict.fromkeys(properties))

        complexity = "complex" if constraints or "为什么" in query or "是否" in query else "simple"
        # 解析层**不产出 SPARQL**：查询由检索层的 SparqlPlanner 依据结构化输入生成。
        # 解析层一旦自己拼模板，就会出现"意图里的查询"和"实际执行的查询"两套口径，
        # 审计里记的和真正跑的不是一条语句——这类偏差极难排查。
        return QueryIntent(
            query=query,
            domain=domain,
            classes=classes,
            properties=properties,
            entities=mentions,
            constraints=list(dict.fromkeys(constraints)),
            filters=filters,
            complexity=complexity,
            normalized_query=normalized,
        )

    # ------------------------------ 内部 ------------------------------

    def _infer_domain(self, query: str, mentions: list[Any], hint: str | None) -> str:
        """领域判定：显式 hint > 实体所属命名空间 > 关键词 > 默认合同。"""
        if hint in {"contract", "carbon"}:
            return hint
        for mention in mentions:
            iri = mention.iri or ""
            if iri.startswith(str(CAR)):
                return "carbon"
            if iri.startswith(str(CON)):
                return "contract"
        if any(word in query for word in ("碳", "排放", "核算边界", "tCO2e", "因子")):
            return "carbon"
        return "contract"

    async def _llm_refine(self, tenant_id: str, query: str, domain: str) -> dict[str, list[str]]:
        """让模型补充实体/属性候选；候选必须存在于本体，否则丢弃。"""
        candidates = [info.local for info in self.ontology.classes_for_domain(domain)][:40]
        properties = [p.local for p in self.ontology.properties.values() if p.iri.startswith(
            (str(CON), str(CAR), str(TOP))
        )][:60]
        system = (
            "你是业务本体解析器。只能从给定候选里选择，禁止发明新词。"
            '输出严格 JSON：{"classes": [...], "properties": [...], "constraints": [...]}。'
        )
        user = json.dumps(
            {"query": query, "class_candidates": candidates, "property_candidates": properties},
            ensure_ascii=False,
        )
        try:
            result, _ = await self.llm.complete(
                tenant_id=tenant_id,
                task="intent",
                system=system,
                user=user,
                query=query,
                temperature=0.0,
                max_tokens=512,
            )
        except Exception:
            # 模型不可用不阻断解析：确定性底座已经够用
            return {}
        parsed = _loads(result.text)
        if not isinstance(parsed, dict):
            return {}
        classes = [self._iri(item, "class", domain) for item in parsed.get("classes", [])]
        props = [self._iri(item, "property", domain) for item in parsed.get("properties", [])]
        return {
            "classes": [iri for iri in classes if iri],
            "properties": [iri for iri in props if iri],
        }

    def _iri(self, name: str, kind: str, domain: str) -> str | None:
        """把候选名对齐到本体 IRI，不认识的直接丢弃。"""
        iri = self.ontology.iri_of(str(name))
        if iri is None:
            return None
        local = self.ontology.local(iri)
        table = self.ontology.classes if kind == "class" else self.ontology.properties
        return iri if local in table else None

def _loads(text: str) -> Any:
    """容错解析 JSON（模型可能包一层代码块）。"""
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("```")[1]
        if stripped.startswith("json"):
            stripped = stripped[4:]
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(stripped[start : end + 1])
            except json.JSONDecodeError:
                return None
        return None
