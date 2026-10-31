"""答案生成。

硬约束：模型只能基于给定证据作答，且必须输出结构化断言。
解析失败即阻断——绝不把模型的自由文本直接透传给用户，
因为未结构化的文本无法被 SHACL 校验，也就不可能被拦截。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Sequence

from rdflib import Graph, Literal, URIRef
from rdflib.namespace import RDF

from ..errors import OntologyGuardError
from ..ontology.model import CAR, CON, OntologyModel
from ..schemas import Chunk, Citation, Claim, QueryIntent, ScoredChunk, Usage
from ..settings import Settings

MAX_EVIDENCE_CHARS = 700
MAX_FACT_TRIPLES = 120

SYSTEM_PROMPT = """你是政企合同付款与碳核算领域的业务助手。

规则（违反任意一条即视为失败）：
1. 只能使用用户消息中 <evidence> 与 <facts> 给出的内容，禁止引入外部知识。
2. 每条业务结论都必须给出 claims，claims 的 subject 必须是 <facts> 中出现的 IRI。
3. predicate 必须是本体属性（如 con:paymentVerdict / con:paymentAmount / car:boundaryVerdict / car:claimedEmission）。
4. 不得编造事实；证据不足时 answer 直接说明"现有材料不足以判断"。
5. 只输出 JSON，不要 markdown 代码块，不要解释你的推理过程。

输出 JSON 结构：
{"answer": "中文回答", "claims": [{"subject": "IRI", "predicate": "con:xxx", "object": "值", "datatype": "decimal|string"}], "citations": ["chunk_id"]}"""


@dataclass(slots=True)
class GenerationResult:
    """生成阶段产物，逐项对应审计字段。"""

    answer: str
    claims: list[Claim]
    citations: list[Citation]
    prompt: str
    raw_output: str
    usage: Usage
    model: str
    reasoning: str = ""
    meta: dict[str, Any] = field(default_factory=dict)


class AnswerGenerator:
    """按证据生成答案与结论断言。"""

    def __init__(self, settings: Settings, ontology: OntologyModel, llm_service: Any | None = None) -> None:
        self.settings = settings
        self.ontology = ontology
        self.llm = llm_service

    async def generate(
        self,
        *,
        tenant_id: str,
        intent: QueryIntent,
        evidence: Sequence[ScoredChunk],
        facts: Graph,
    ) -> GenerationResult:
        """生成结构化答案。"""
        if not evidence:
            raise OntologyGuardError(
                "没有可用证据，拒绝生成",
                details={"reason": "insufficient-evidence", "query": intent.query},
            )
        if self.settings.rag_mode == "memory" or self.llm is None:
            return self._deterministic(intent, evidence, facts)
        return await self._llm_generate(tenant_id, intent, evidence, facts)

    # ------------------------------ 生产路径 ------------------------------

    async def _llm_generate(
        self,
        tenant_id: str,
        intent: QueryIntent,
        evidence: Sequence[ScoredChunk],
        facts: Graph,
    ) -> GenerationResult:
        """调用模型生成 JSON，并做结构解析。"""
        prompt = self._build_prompt(intent, evidence, facts)
        result, choice = await self.llm.complete(
            tenant_id=tenant_id,
            task="answer",
            system=SYSTEM_PROMPT,
            user=prompt,
            query=intent.query,
            complexity=intent.complexity,
            temperature=0.0,
            max_tokens=1600,
        )
        payload = _parse_json(result.text)
        if payload is None:
            raise OntologyGuardError(
                "模型输出不是合法 JSON，已阻断（未结构化的文本无法送检）",
                details={"raw": result.text[:800]},
            )
        answer = str(payload.get("answer", "")).strip()
        if not answer:
            raise OntologyGuardError("模型未给出答案正文", details={"raw": result.text[:400]})

        claims = [self._to_claim(item) for item in payload.get("claims", []) if isinstance(item, dict)]
        citations = self._citations(evidence, payload.get("citations", []))
        claims = self._attach_evidence(claims, citations, evidence)
        return GenerationResult(
            answer=answer,
            claims=claims,
            citations=citations,
            prompt=prompt,
            raw_output=result.text,
            usage=Usage(
                prompt_tokens=result.prompt_tokens,
                completion_tokens=result.completion_tokens,
                total_tokens=result.total_tokens,
                model=result.model or choice.model,
            ),
            model=choice.model,
            reasoning=choice.reason,
            meta={"cached": result.cached},
        )

    def _build_prompt(self, intent: QueryIntent, evidence: Sequence[ScoredChunk], facts: Graph) -> str:
        """拼接证据与事实。证据带编号，事实用三元组，便于模型引用而不改写。"""
        lines: list[str] = [f"<question>{intent.query}</question>"]
        if intent.constraints:
            lines.append(f"<constraints>{', '.join(intent.constraints)}</constraints>")
        lines.append("<evidence>")
        for index, item in enumerate(evidence, start=1):
            chunk = item.chunk
            text = chunk.text[:MAX_EVIDENCE_CHARS]
            lines.append(
                f"[{chunk.chunk_id}] {chunk.doc_title} {chunk.clause_no} "
                f"(优先级{chunk.priority}, 版本{chunk.version}): {text}"
            )
        lines.append("</evidence>")
        lines.append("<facts>")
        lines.extend(self._facts_lines(facts))
        lines.append("</facts>")
        return "\n".join(lines)

    def _facts_lines(self, facts: Graph) -> list[str]:
        """把事实图压成可读三元组，屏蔽 rdf:type 之外的元数据噪声。"""
        lines: list[str] = []
        for subject, predicate, obj in facts:
            if len(lines) >= MAX_FACT_TRIPLES:
                break
            if isinstance(obj, Literal):
                lines.append(f"<{subject}> {_short(predicate)} {json.dumps(str(obj), ensure_ascii=False)}")
            else:
                lines.append(f"<{subject}> {_short(predicate)} <{obj}>")
        return lines

    # ------------------------------ 本地演示路径 ------------------------------

    def _deterministic(
        self,
        intent: QueryIntent,
        evidence: Sequence[ScoredChunk],
        facts: Graph,
    ) -> GenerationResult:
        """无模型模式：从事实图直接推导结论，再引用证据成文。

        这不是"降级成模板"，而是把本应由模型完成的判定换成确定式计算，
        结论仍然要过 SHACL，因此链路与生产模式完全一致。
        """
        claims: list[Claim] = []
        statements: list[str] = []
        self._findings: list[str] = []

        for subject, verdict, detail in self._payment_verdicts(facts):
            claims.append(Claim(subject=subject, predicate="con:paymentVerdict", object=verdict))
            statements.append(detail)
        for subject, verdict, detail in self._boundary_verdicts(facts):
            claims.append(Claim(subject=subject, predicate="car:boundaryVerdict", object=verdict))
            statements.append(detail)
        for subject, amount in self._emission_claims(facts):
            claims.append(Claim(subject=subject, predicate="car:claimedEmission", object=amount, datatype="decimal"))
            statements.append(f"{_local(subject)} 按活动数据与因子复算，排放量为 {amount} tCO2e。")
        statements.extend(self._contract_lines(facts))
        statements.extend(self._findings)

        # 无论是否已推出结论，都附一条最相关原文：用户需要看到依据，评估脚本也依赖它判定命中
        top = evidence[0].chunk
        quote = top.text[:160].replace("\n", " ")
        statements.append(f"依据《{top.doc_title}》{top.clause_no}：{quote}…")

        citations = self._citations(evidence, [item.chunk.chunk_id for item in evidence[:3]])
        claims = self._attach_evidence(claims, citations)
        answer = "\n".join(f"- {line}" for line in statements)
        prompt = self._build_prompt(intent, evidence, facts)
        return GenerationResult(
            answer=answer,
            claims=claims,
            citations=citations,
            prompt=prompt,
            raw_output=answer,
            usage=Usage(model="deterministic-extractive"),
            model="deterministic-extractive",
            reasoning="memory 模式：确定性推导，仍强制过 SHACL",
        )

    def _payment_verdicts(self, facts: Graph) -> list[tuple[str, str, str]]:
        """按合同剩余应付给出付款结论。"""
        out: list[tuple[str, str, str]] = []
        for payment in facts.subjects(RDF.type, CON.PaymentApplication):
            amount = facts.value(payment, CON.paymentAmount)
            contract = facts.value(payment, CON.appliesToContract)
            if amount is None or contract is None:
                continue
            total = facts.value(contract, CON.contractAmount)
            if total is None:
                continue
            paid = facts.value(contract, CON.paidAmount)
            retention = facts.value(contract, CON.retentionRate)
            remaining = float(total) * (1 - float(retention or 0)) - float(paid or 0)
            verdict = "exceeds-remaining" if float(amount) > remaining else "within-remaining"
            detail = (
                f"{_local(str(payment))} 申请 {float(amount):,.2f} 元，合同 {_local(str(contract))} "
                f"剩余应付 {remaining:,.2f} 元，结论：{'超付' if verdict == 'exceeds-remaining' else '未超付'}。"
            )
            out.append((str(payment), verdict, detail))
        out.sort(key=lambda item: item[0])
        return out[:5]

    def _boundary_verdicts(self, facts: Graph) -> list[tuple[str, str, str]]:
        """按互斥组统计给出边界结论。"""
        out: list[tuple[str, str, str]] = []
        for source in facts.subjects(RDF.type, CAR.EmissionSource):
            groups: dict[str, set[str]] = {}
            for boundary in facts.objects(source, CAR.belongsToBoundary):
                group = facts.value(boundary, CAR.exclusivityGroup)
                if group is None:
                    # 上下文里没有互斥组信息就不能下边界结论，否则就是无依据断言
                    continue
                groups.setdefault(str(group), set()).add(str(boundary))
            if not groups:
                continue
            conflicting = [key for key, boundaries in groups.items() if len(boundaries) > 1]
            verdict = "conflicting" if conflicting else "exclusive"
            detail = (
                f"{_local(str(source))} 在互斥组 {', '.join(conflicting) if conflicting else '-'} 内归属 "
                f"{sum(len(v) for v in groups.values())} 个边界，结论："
                f"{'边界冲突' if conflicting else '边界唯一'}。"
            )
            out.append((str(source), verdict, detail))
        out.sort(key=lambda item: item[0])
        return out[:5]

    def _contract_lines(self, facts: Graph) -> list[str]:
        """复述合同基础事实：金额、已付、状态。仅作陈述，不产生结论断言。"""
        lines: list[str] = []
        for contract in facts.subjects(RDF.type, CON.Contract):
            amount = facts.value(contract, CON.contractAmount)
            if amount is None:
                continue
            paid = facts.value(contract, CON.paidAmount)
            status = facts.value(contract, CON.contractStatus)
            label = facts.value(contract, URIRef("http://www.w3.org/2000/01/rdf-schema#label"))
            lines.append(
                f"合同 {_local(str(contract))}（{label or '未命名'}）金额 {float(amount):,.2f} 元，"
                f"已付 {float(paid or 0):,.2f} 元，状态 {status or '未登记'}。"
            )
        lines.sort()
        return lines[:5]

    def _emission_claims(self, facts: Graph) -> list[tuple[str, float]]:
        """按活动数据 × 因子 × GWP 复算，只对"自洽"的值下结论。

        存量数据本身可能算错。把错值当作结论断言，会被 SHACL 拦下并使整条回答失效；
        正确做法是把它作为"核算错误"报出来，而不是替它背书。
        """
        out: list[tuple[str, float]] = []
        for record in facts.subjects(RDF.type, CAR.EmissionRecord):
            amount = facts.value(record, CAR.emissionAmount)
            activity = facts.value(record, CAR.activityData)
            factor = facts.value(record, CAR.usesFactor)
            if amount is None:
                continue
            if activity is not None and factor is not None:
                value = facts.value(factor, CAR.factorValue)
                gwp = facts.value(factor, CAR.gwp)
                expected = float(activity) * float(value or 0) * float(gwp or 1)
                if abs(float(amount) - expected) > 0.01 * abs(expected) + 0.0001:
                    self._findings.append(
                        f"{_local(str(record))} 填报排放量 {float(amount):,.2f}，"
                        f"按活动数据与因子应为 {expected:,.2f}，存在核算错误。"
                    )
                    continue
            out.append((str(record), round(float(amount), 4)))
        return out[:5]

    # ------------------------------ 辅助 ------------------------------

    def _to_claim(self, payload: dict[str, Any]) -> Claim:
        """把模型 JSON 转成 Claim，缺字段时保留空值让结构校验去拦。"""
        return Claim(
            subject=str(payload.get("subject", "")),
            predicate=str(payload.get("predicate", "")),
            object=payload.get("object", ""),
            datatype=payload.get("datatype"),
        )

    def _citations(self, evidence: Sequence[ScoredChunk], chunk_ids: Any) -> list[Citation]:
        """只接受证据集合内的引用，拒绝模型"发明"引用。"""
        allowed = {item.chunk.chunk_id: item.chunk for item in evidence}
        wanted = [str(cid) for cid in chunk_ids if str(cid) in allowed] if isinstance(chunk_ids, list) else []
        if not wanted:
            wanted = [item.chunk.chunk_id for item in evidence[:3]]
        return [
            Citation(
                chunk_id=cid,
                doc_id=allowed[cid].doc_id,
                doc_title=allowed[cid].doc_title,
                clause_no=allowed[cid].clause_no,
                quote=allowed[cid].text[:300],
                priority=allowed[cid].priority,
            )
            for cid in wanted[:5]
        ]

    def _attach_evidence(
        self,
        claims: list[Claim],
        citations: list[Citation],
        evidence: Sequence[ScoredChunk] | None = None,
    ) -> list[Claim]:
        """给每个结论补 `doc:basedOnChunk`，并尽量指向语义最贴近的证据。

        做法：按结论谓词找到该结论依赖的属性，再挑第一条带该属性标签的证据。
        找不到时才回退到首条引用，避免"所有结论都引用同一段无关文字"。
        """
        if not citations:
            return claims
        preferred = {
            "con:paymentVerdict": "paymentAmount",
            "car:boundaryVerdict": "exclusivityGroup",
            "car:claimedEmission": "emissionAmount",
        }
        by_id = {item.chunk.chunk_id: item.chunk for item in (evidence or [])}
        links: list[Claim] = []
        for claim in claims:
            if claim.predicate.startswith("doc:"):
                continue
            want = preferred.get(claim.predicate)
            chosen = citations[0].chunk_id
            if want is not None:
                for citation in citations:
                    chunk = by_id.get(citation.chunk_id)
                    if chunk is None:
                        continue
                    if any(prop.endswith(want) for prop in chunk.properties):
                        chosen = citation.chunk_id
                        break
            links.append(Claim(subject=claim.subject, predicate="doc:basedOnChunk", object=chosen))
        return [*claims, *links]


def _parse_json(text: str) -> dict[str, Any] | None:
    """容错解析：允许模型多包一层代码块，但只接受对象。"""
    stripped = text.strip()
    if stripped.startswith("```"):
        parts = stripped.split("```")
        if len(parts) >= 2:
            stripped = parts[1]
            if stripped.lstrip().startswith("json"):
                stripped = stripped.lstrip()[4:]
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


def _short(term: Any) -> str:
    """IRI 缩写，便于模型阅读。"""
    text = str(term)
    for namespace, prefix in ((str(CON), "con:"), (str(CAR), "car:")):
        if text.startswith(namespace):
            return prefix + text[len(namespace) :]
    return text


def _local(iri: str) -> str:
    """取 IRI 本地名。"""
    return iri.rsplit("#", 1)[-1].rsplit("/", 1)[-1]


def chunk_reference(chunk: Chunk) -> str:
    """给外部展示的引用串。"""
    return f"{chunk.doc_title} {chunk.clause_no} ({chunk.chunk_id})"


def claim_subject_iri(claim: Claim) -> URIRef:
    """断言主语转 IRI（调用方保证已校验）。"""
    return URIRef(claim.subject)
