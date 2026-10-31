"""输出闸门：候选三元组的结构校验 + SHACL 强制校验。

顺序不可颠倒：
1. 结构校验先做——谓词必须在本体里存在，主语必须在租户实例图里存在，
   对象属性必须指向已知个体。这一步挡的是"凭空造实体/造关系"。
   它不依赖 SHACL 引擎，因此任何引擎下都生效。
2. SHACL 后做——把候选三元组并入租户事实后跑业务约束。引擎可插拔：
   `pyshacl`（进程内）或 `fuseki`（形状编译成 SPARQL 交给图库执行），
   见 `app/shacl/engine.py`。

严重级别决定后果：
- `Violation` → `blocked=True`，整条回答被阻断，返回冲突三元组与冲突规则；
- `Warning` / `Info` → 只进报告，不阻断（除非租户策略为 strict）。
"""

from __future__ import annotations

from time import perf_counter
from typing import Iterable, Sequence

from rdflib import Graph, Literal, URIRef
from rdflib.namespace import XSD

from ..errors import ShapeCompileError
from ..schemas import Claim, GuardReport, Violation
from ..shacl import BLOCKING_SEVERITY, LocalShaclEngine, ShaclEngine, severity_rank
from .model import OntologyModel

# 谓词 -> 期望的 XSD 数据类型（未列出的按属性 range 推导）
_XSD_BY_LOCAL = {
    "decimal": XSD.decimal,
    "integer": XSD.integer,
    "date": XSD.date,
    "string": XSD.string,
    "boolean": XSD.boolean,
}


class ShaclValidator:
    """把 LLM 断言变成三元组，再用 SHACL 判它是否成立。"""

    def __init__(self, ontology: OntologyModel, engine: ShaclEngine | None = None) -> None:
        self.ontology = ontology
        self.engine: ShaclEngine = engine or LocalShaclEngine(ontology)

    # ------------------------------ 入口 ------------------------------

    async def validate_async(
        self,
        graph: Graph,
        claims: Sequence[Claim],
        *,
        include_tenant_facts: bool = True,
        fail_on_warning: bool = False,
    ) -> GuardReport:
        """执行输出闸门校验。"""
        started = perf_counter()
        working = self._working_graph(graph, include_tenant_facts)
        # 结构校验必须在断言并入之前跑：并入后主语自然"存在"，就查不出来了
        violations = self._check_structure(working, claims)
        for claim in claims:
            self._add_claim(working, claim)

        results, shapes = await self.engine.evaluate(working, self.ontology.claim_shapes)
        violations.extend(results)
        return self._report(violations, working, shapes, started, fail_on_warning)

    def validate(
        self,
        graph: Graph,
        claims: Sequence[Claim],
        *,
        include_tenant_facts: bool = True,
        fail_on_warning: bool = False,
    ) -> GuardReport:
        """同步入口，仅支持进程内引擎。

        远程引擎（Fuseki）需要事件循环；调用方若在同步上下文里，
        说明链路设计有问题，这里直接报错而不是偷偷 `asyncio.run`。
        """
        if not isinstance(self.engine, LocalShaclEngine):
            raise ShapeCompileError("同步校验只支持 pyshacl 引擎，请改用 validate_async")
        started = perf_counter()
        working = self._working_graph(graph, include_tenant_facts)
        violations = self._check_structure(working, claims)
        for claim in claims:
            self._add_claim(working, claim)
        results, shapes = self.engine._evaluate_sync(working, self.ontology.claim_shapes)  # noqa: SLF001
        violations.extend(results)
        return self._report(violations, working, shapes, started, fail_on_warning)

    def validate_dataset(self, graph: Graph, *, fail_on_warning: bool = False) -> GuardReport:
        """数据质检：用全量形状校验存量数据（导入、同步、动作提交前使用）。"""
        if not isinstance(self.engine, LocalShaclEngine):
            raise ShapeCompileError("validate_dataset 只支持 pyshacl 引擎，请改用 validate_dataset_async")
        started = perf_counter()
        violations, shapes = self.engine._evaluate_sync(graph, self.ontology.shapes)  # noqa: SLF001
        return self._report(violations, graph, shapes, started, fail_on_warning)

    async def validate_dataset_async(self, graph: Graph, *, fail_on_warning: bool = False) -> GuardReport:
        """数据质检的异步版，支持远程引擎。"""
        started = perf_counter()
        violations, shapes = await self.engine.evaluate(graph, self.ontology.shapes)
        return self._report(violations, graph, shapes, started, fail_on_warning)

    # ------------------------------ 组装 ------------------------------

    def _working_graph(self, graph: Graph, include_tenant_facts: bool) -> Graph:
        """构造工作图：命名空间 + 可选租户事实。"""
        working = Graph()
        for prefix, namespace in graph.namespaces():
            working.bind(prefix, namespace)
        if include_tenant_facts:
            for triple in graph:
                working.add(triple)
        return working

    def _report(
        self,
        violations: list[Violation],
        working: Graph,
        shapes: list[str],
        started: float,
        fail_on_warning: bool,
    ) -> GuardReport:
        """按严重级别组装报告。严重者排在前，便于调用方只读首条。"""
        violations.sort(key=lambda item: -severity_rank(item.severity))
        conforms = not any(item.severity == BLOCKING_SEVERITY for item in violations)
        return GuardReport(
            conforms=conforms,
            checked_triples=len(working),
            violations=violations,
            shapes_checked=shapes,
            engine=getattr(self.engine, "name", "unknown"),
            elapsed_ms=round((perf_counter() - started) * 1000, 2),
            policy="strict" if fail_on_warning else "standard",
        )

    # ------------------------------ 结构校验 ------------------------------

    def _check_structure(self, graph: Graph, claims: Sequence[Claim]) -> list[Violation]:
        """谓词/主语/宾语三元结构的存在性检查。"""
        violations: list[Violation] = []
        existing_subjects = {s for s in graph.subjects() if isinstance(s, URIRef)}
        for claim in claims:
            predicate_iri = self.ontology.iri_of(claim.predicate)
            if predicate_iri is None:
                violations.append(
                    Violation(
                        rule="unknown-predicate",
                        message=f"谓词 {claim.predicate} 不在本体中，禁止用未建模的关系下结论",
                        focus_node=claim.subject,
                        path=claim.predicate,
                        conflicting_triples=[f"{claim.subject} {claim.predicate} {claim.object}"],
                    )
                )
                continue
            local_predicate = self.ontology.local(predicate_iri)
            info = self.ontology.property_of(predicate_iri)
            if info is None:
                is_class = self.ontology.class_of(predicate_iri) is not None
                violations.append(
                    Violation(
                        rule="not-a-property" if is_class else "unknown-predicate",
                        message=(
                            f"{claim.predicate} 是类而不是属性，不能作为断言谓词"
                            if is_class
                            else f"谓词 {claim.predicate} 不在本体中，禁止用未建模的关系下结论"
                        ),
                        focus_node=claim.subject,
                        path=claim.predicate,
                        conflicting_triples=[f"{claim.subject} {claim.predicate} {claim.object}"],
                    )
                )
                continue
            subject_iri = self.ontology.iri_of(claim.subject) or claim.subject
            if not str(subject_iri).startswith(("http://", "https://", "urn:")):
                violations.append(
                    Violation(
                        rule="unresolved-subject",
                        message=f"主语 {claim.subject} 不是可解析的业务对象 IRI",
                        focus_node=claim.subject,
                        path=claim.predicate,
                    )
                )
                continue
            if URIRef(str(subject_iri)) not in existing_subjects:
                violations.append(
                    Violation(
                        rule="unresolved-subject",
                        message=f"主语 {claim.subject} 不在租户实例数据中，疑似凭空构造",
                        focus_node=str(subject_iri),
                        path=claim.predicate,
                    )
                )
                continue
            if info.object_property:
                obj_iri = self.ontology.iri_of(str(claim.object))
                if obj_iri is None or URIRef(obj_iri) not in existing_subjects:
                    violations.append(
                        Violation(
                            rule="dangling-object",
                            message=f"对象属性 {claim.predicate} 指向的个体 {claim.object} 不存在",
                            focus_node=str(subject_iri),
                            path=claim.predicate,
                        )
                    )
        return violations

    # ------------------------------ 三元组构造 ------------------------------

    def _add_claim(self, graph: Graph, claim: Claim) -> None:
        """把一条断言并入图，按属性 range 补齐数据类型。"""
        predicate_iri = self.ontology.iri_of(claim.predicate)
        if predicate_iri is None:
            return
        subject = URIRef(self.ontology.iri_of(claim.subject) or claim.subject)
        predicate = URIRef(predicate_iri)
        info = self.ontology.property_of(predicate_iri)
        if info is not None and info.object_property:
            obj_iri = self.ontology.iri_of(str(claim.object))
            if obj_iri is not None:
                graph.add((subject, predicate, URIRef(obj_iri)))
            return
        graph.add((subject, predicate, self._literal(claim, info.range if info else [])))

    def _literal(self, claim: Claim, ranges: Iterable[str]) -> Literal:
        """按显式 datatype 或属性 range 构造 Literal。"""
        datatype = claim.datatype
        if datatype is None:
            local_range = next((r for r in ranges if r in _XSD_BY_LOCAL), "string")
            datatype = local_range
        xsd_type = _XSD_BY_LOCAL.get(datatype, XSD.string) if datatype else XSD.string
        return Literal(claim.object, datatype=xsd_type)
