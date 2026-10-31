"""编排中枢：固定九步链路，顺序不可更改。

  Query
  → 本体解析（pre_retrieval_hook）
  → 三级加权混合检索
  → 召回后过滤
  → 文档优先级排序
  → LLM 生成初稿
  → SHACL 强制校验（post_generation_hook，不通过即阻断）
  → 结构化输出（答案 + 溯源 + SPARQL 路径 + 审计）
  → 全链路落审计

任何一步失败都必须留下审计记录，包括被阻断的请求。

链路只有一份：`answer()`（对外，失败抛异常）与 `inspect()`（调试面板，
失败也返回中间态）都走 `_execute()`。**不做两套实现**——演示时看到的
执行顺序、SQL/SPARQL、评分与线上必须逐字相同，否则演示的价值为零。
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from rdflib import Graph

from ..errors import OntoRagError, OntologyGuardError
from ..ontology.model import OntologyModel
from ..retrieval import RetrievalResult
from ..schemas import Citation, GuardReport, QueryIntent, QueryResponse, Usage
from ..settings import Settings
from .generator import AnswerGenerator, GenerationResult
from .guard import fetch_context_graph
from .intent import QueryParser
from .retrieval import HybridRetriever

# 阶段的展示名与顺序。失败时用它把"卡在哪一步"翻成人话。
_STAGE_LABELS: tuple[tuple[str, str], ...] = (
    ("parse", "本体解析"),
    ("retrieve", "三级检索"),
    ("facts", "事实上下文"),
    ("generate", "生成"),
    ("guard", "SHACL 闸门"),
)


@dataclass(slots=True)
class StageTiming:
    """单阶段耗时。`ok=False` 表示这一阶段抛了异常，`note` 记异常类型。"""

    stage: str
    label: str
    elapsed_ms: float = 0.0
    ok: bool = True
    note: str = ""


@dataclass(slots=True)
class TraceBundle:
    """一次链路的全部中间产物。

    与 `QueryResponse` 的区别是"失败也有内容"：调试面板要能展示
    "解析成功了、检索也成功了，闸门把它拦了"，而不是只拿到一个 422。
    """

    trace_id: str
    question: str
    intent: QueryIntent | None = None
    retrieval: RetrievalResult | None = None
    facts: Graph | None = None
    generation: GenerationResult | None = None
    guard: GuardReport | None = None
    response: QueryResponse | None = None
    stages: list[StageTiming] = field(default_factory=list)
    total_ms: float = 0.0
    blocked: bool = False
    # 失败原因（原样保留异常对象，由 answer() 重新抛出，语义不变）
    error: Exception | None = None


class RagPipeline:
    """把解析、检索、生成、校验、审计串成一条不可跳步的链路。"""

    def __init__(
        self,
        settings: Settings,
        ontology: OntologyModel,
        parser: QueryParser,
        retriever: HybridRetriever,
        generator: AnswerGenerator,
        validator: Any,
        audit: Any,
        graph_store: Any,
    ) -> None:
        self.settings = settings
        self.ontology = ontology
        self.parser = parser
        self.retriever = retriever
        self.generator = generator
        self.validator = validator
        self.audit = audit
        self.graph_store = graph_store

    # ------------------------------ 对外两个入口 ------------------------------

    async def answer(self, tenant: Any, question: str, *, domain: str | None = None, top_k: int = 8) -> QueryResponse:
        """执行完整链路。校验不通过抛 `OntologyGuardError`，其余失败原样抛出。"""
        bundle = await self._execute(tenant, question, domain=domain, top_k=top_k)
        if bundle.error is not None:
            raise bundle.error
        if bundle.response is None:  # pragma: no cover - _execute 保证二者必居其一
            raise OntoRagError("链路未产出结果", details={"trace_id": bundle.trace_id})
        return bundle.response

    async def inspect(self, tenant: Any, question: str, *, domain: str | None = None, top_k: int = 8) -> TraceBundle:
        """执行完整链路并返回中间态。**失败不抛**，由调用方决定如何呈现。

        审计照写：演示轨迹也必须可回放，否则"演示时好好的、事后查不到"。
        """
        return await self._execute(tenant, question, domain=domain, top_k=top_k)

    async def preview(self, tenant: Any, question: str, *, domain: str | None = None, top_k: int = 8) -> QueryResponse:
        """只做检索预览：不生成、不校验，用于调参与 POC 演示证据链。

        与 `_execute()` 的前四步完全同源（同一解析器、同一检索服务），
        区别只是**到此为止**：不取事实子图、不调模型、不跑闸门。
        """
        intent = await self.parser.parse(tenant.tenant_id, question, domain)
        result = await self.retriever.retrieve_full(tenant, intent, top_k=top_k)

        return QueryResponse(
            trace_id=tenant.trace_id,
            tenant_id=tenant.tenant_id,
            answer="",
            citations=[
                Citation(
                    chunk_id=item.chunk.chunk_id,
                    doc_id=item.chunk.doc_id,
                    doc_title=item.chunk.doc_title,
                    clause_no=item.chunk.clause_no,
                    quote=item.chunk.text[:300],
                    priority=item.chunk.priority,
                )
                for item in result.items
            ],
            claims=[],
            sparql=result.trace,
            guard=GuardReport(conforms=True, shapes_checked=[]),
            recall=result.stats,
            usage=Usage(model="retrieval-only"),
            model="retrieval-only",
            blocked=False,
            created_at=datetime.now(UTC),
        )

    # ------------------------------ 链路本体 ------------------------------

    async def _execute(self, tenant: Any, question: str, *, domain: str | None, top_k: int) -> TraceBundle:
        started = time.perf_counter()
        trace_id = tenant.trace_id or str(uuid.uuid4())
        bundle = TraceBundle(trace_id=trace_id, question=question)
        record: dict[str, Any] = {
            "trace_id": trace_id,
            "tenant_id": tenant.tenant_id,
            "created_at": datetime.now(UTC).isoformat(),
            "question": question,
        }
        marks: dict[str, float] = {}

        def begin(stage: str) -> None:
            marks[stage] = time.perf_counter()

        def end(stage: str, note: str = "", ok: bool = True) -> None:
            label = dict(_STAGE_LABELS)[stage]
            began = marks.pop(stage, None)
            bundle.stages.append(
                StageTiming(
                    stage=stage,
                    label=label,
                    elapsed_ms=round((time.perf_counter() - began) * 1000, 2) if began else 0.0,
                    ok=ok,
                    note=note,
                )
            )

        try:
            # 1. Query 本体解析
            begin("parse")
            intent = await self.parser.parse(tenant.tenant_id, question, domain)
            end("parse", note=f"{len(intent.entities)} 实体 / {len(intent.constraints)} 约束")
            bundle.intent = intent
            record["intent"] = intent.model_dump(mode="json")

            # 2-4. 三级检索 + 召回过滤 + 优先级排序
            begin("retrieve")
            retrieval = await self.retriever.retrieve_full(tenant, intent, top_k=top_k)
            end("retrieve", note=f"融合 {retrieval.stats.fused} → 保留 {len(retrieval.items)}")
            bundle.retrieval = retrieval
            evidence = retrieval.items
            recall = retrieval.stats
            trace = retrieval.trace
            seeds = retrieval.seeds
            record["recall"] = recall.model_dump(mode="json")
            record["sparql"] = trace.query

            if not evidence:
                raise OntoRagError(
                    "检索未命中任何可用证据，拒绝生成",
                    details={"reason": "no-evidence", "intent": intent.model_dump(mode="json")},
                )

            # 5. 事实上下文（供生成与校验共用，避免两处口径不一致）
            begin("facts")
            facts = await fetch_context_graph(
                self.graph_store,
                tenant.graph_uri,
                seeds,
                timeout=self.settings.sparql_timeout_seconds,
            )
            end("facts", note=f"{len(facts)} 三元组")
            bundle.facts = facts

            # 6. 生成初稿（结构化断言）
            begin("generate")
            generation = await self.generator.generate(
                tenant_id=tenant.tenant_id,
                intent=intent,
                evidence=evidence,
                facts=facts,
            )
            end("generate", note=generation.model)
            bundle.generation = generation
            record["prompt"] = generation.prompt
            record["llm_output"] = generation.raw_output
            record["answer"] = generation.answer
            record["model"] = generation.model
            record["prompt_tokens"] = generation.usage.prompt_tokens
            record["completion_tokens"] = generation.usage.completion_tokens

            # 7. SHACL 强制校验：不通过即阻断，不返回任何正文
            begin("guard")
            report = await self.validator.validate_async(
                facts,
                generation.claims,
                include_tenant_facts=True,
            )
            end("guard", note=f"{report.engine} / {len(report.violations)} 条结果")
            bundle.guard = report
            record["guard"] = report.model_dump(mode="json")
            record["guard_ok"] = report.conforms
            if not report.conforms:
                bundle.blocked = True
                record["blocked"] = True
                raise OntologyGuardError(
                    "SHACL 校验未通过，回答已阻断",
                    details={
                        "guard": report.model_dump(mode="json"),
                        "trace_id": trace_id,
                    },
                )

            # 8. 结构化输出
            usage = generation.usage
            if usage.total_tokens == 0:
                usage = Usage(model=generation.model)
            bundle.response = QueryResponse(
                trace_id=trace_id,
                tenant_id=tenant.tenant_id,
                answer=generation.answer,
                citations=generation.citations,
                claims=generation.claims,
                sparql=trace,
                guard=report,
                recall=recall,
                usage=usage,
                model=generation.model,
                blocked=False,
                created_at=datetime.now(UTC),
            )
            return bundle
        except Exception as error:  # noqa: BLE001 —— 任何失败都要留审计后原样上抛
            bundle.error = error
            bundle.blocked = True
            record.setdefault("error", str(error))
            # 把"卡在哪个阶段"补进阶段表：否则面板只能看到一个红叉
            for stage, label in _STAGE_LABELS:
                if stage in marks:
                    began = marks.pop(stage)
                    bundle.stages.append(
                        StageTiming(
                            stage=stage,
                            label=label,
                            elapsed_ms=round((time.perf_counter() - began) * 1000, 2),
                            ok=False,
                            note=type(error).__name__,
                        )
                    )
                    break
            return bundle
        finally:
            # 审计只写一次：成功、被阻断、链路异常都是同一份记录
            record["latency_ms"] = int((time.perf_counter() - started) * 1000)
            record.setdefault("blocked", False)
            try:
                await self.audit.append(record)
            except Exception:  # noqa: BLE001 —— 审计失败不能改变主链路的结论
                bundle.stages.append(
                    StageTiming(stage="audit", label="审计", ok=False, note="append-failed")
                )
            bundle.total_ms = round((time.perf_counter() - started) * 1000, 2)
