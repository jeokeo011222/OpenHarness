"""SHACL 校验的两个执行引擎。

- `FusekiShaclEngine`：把形状编译成 SPARQL 发给 Fuseki，待校验数据通过
  GSP 投递到一张一次性临时图。语义由 Fuseki 侧计算，本进程只做编排。
- `LocalShaclEngine`：pyshacl 进程内校验。memory 模式与无外部图库时使用。

两者必须返回同构的 `Violation` 列表，否则"换个后端结论就变了"，
闸门也就失去了可依赖的语义。`tests/test_shacl_engine.py` 用同一份数据
对两个引擎做等价性断言。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Protocol, Sequence
from uuid import uuid4

import pyshacl
from rdflib import BNode, Graph, URIRef
from rdflib.namespace import RDF

from ..errors import RetrievalError, ShapeCompileError
from ..ontology.model import SH, OntologyModel
from ..schemas import Violation
from .compiler import CompiledConstraint, ShapeCompiler, substitute

logger = logging.getLogger("ontorag.shacl")

# 只有 Violation 阻断输出；Warning / Info 进入报告但不阻断。
BLOCKING_SEVERITY = "Violation"


def severity_rank(severity: str) -> int:
    """数值越大越严重，便于排序与阈值判断。"""
    return {"Info": 0, "Warning": 1, "Violation": 2}.get(severity, 2)


def is_blocking(severity: str) -> bool:
    """未能识别的级别按最严处理（fail-closed）。"""
    return severity_rank(severity) >= severity_rank(BLOCKING_SEVERITY)


class ShaclEngine(Protocol):
    """校验引擎契约。"""

    name: str

    async def evaluate(self, data: Graph, shapes: Graph) -> tuple[list[Violation], list[str]]:
        """返回（全部结果, 参与校验的形状名）。"""
        ...


class LocalShaclEngine:
    """pyshacl 进程内实现。"""

    name = "pyshacl"

    def __init__(self, ontology: OntologyModel) -> None:
        self.ontology = ontology

    async def evaluate(self, data: Graph, shapes: Graph) -> tuple[list[Violation], list[str]]:
        """pyshacl 是同步库，放到线程里跑，避免阻塞事件循环。"""
        return await asyncio.to_thread(self._evaluate_sync, data, shapes)

    def _evaluate_sync(self, data: Graph, shapes: Graph) -> tuple[list[Violation], list[str]]:
        _, report_graph, _ = pyshacl.validate(
            data,
            shacl_graph=shapes,
            inference="none",
            advanced=True,
        )
        violations: list[Violation] = []
        for result in report_graph.subjects(RDF.type, SH.ValidationResult):
            focus = report_graph.value(result, SH.focusNode)
            path = report_graph.value(result, SH.resultPath)
            message = report_graph.value(result, SH.resultMessage)
            severity = report_graph.value(result, SH.resultSeverity)
            source = report_graph.value(result, SH.sourceShape)
            focus_iri = str(focus) if focus is not None else None
            violations.append(
                Violation(
                    rule=self._rule_name(source, shapes),
                    message=str(message) if message is not None else "SHACL 约束未通过",
                    focus_node=focus_iri,
                    path=str(path) if path is not None else None,
                    severity=self.ontology.local(str(severity)) if severity is not None else BLOCKING_SEVERITY,
                    conflicting_triples=self._triples_of(data, focus_iri),
                )
            )
        return violations, self._shape_names(shapes)

    def _rule_name(self, source: object | None, shapes: Graph) -> str:
        """把 sourceShape 归因到具名 shape（sh:property 是匿名的）。"""
        if source is None:
            return "shacl-violation"
        if not isinstance(source, BNode):
            return self.ontology.local(str(source))
        for predicate in (SH.property, SH.sparql):
            for parent in shapes.subjects(predicate, source):
                if isinstance(parent, URIRef):
                    return self.ontology.local(str(parent))
        return "shacl-anonymous-constraint"

    def _triples_of(self, graph: Graph, focus: str | None, limit: int = 8) -> list[str]:
        """取焦点节点的相关三元组作为冲突证据。"""
        if focus is None:
            return []
        node = URIRef(focus)
        out: list[str] = []
        for predicate, obj in graph.predicate_objects(node):
            out.append(f"{self.ontology.local(str(node))} {self.ontology.local(str(predicate))} {obj}")
            if len(out) >= limit:
                break
        return out

    def _shape_names(self, shapes: Graph) -> list[str]:
        names = [
            self.ontology.local(str(shape))
            for shape in shapes.subjects(RDF.type, SH.NodeShape)
            if isinstance(shape, URIRef)
        ]
        return sorted(set(names))


class FusekiShaclEngine:
    """把 SHACL-SPARQL 与常用核心组件编译后交给 Fuseki 执行。

    临时图按请求隔离（`urn:ontorag:scratch:<uuid>`），保证并发校验互不覆盖；
    校验结束在 finally 里删除，即使中途抛错也不会留下垃圾图。

    为什么临时图而不是 `INSERT DATA`：SPARQL 更新在本项目是全线禁止的，
    多开一个例外就等于多开一条越权路径。GSP 写图是独立通道，作用域仅限
    显式指定的图 IRI，且不与查询权限共享。
    """

    name = "fuseki"

    def __init__(
        self,
        store: object,
        ontology: OntologyModel,
        *,
        timeout_seconds: float = 15.0,
        max_rows: int = 500,
    ) -> None:
        self.store = store
        self.ontology = ontology
        self.timeout_seconds = timeout_seconds
        self.max_rows = max_rows
        # 形状在进程生命周期内不变，编译一次即可；键用 id(shapes) 区分数据集
        self._cache: dict[int, list[CompiledConstraint]] = {}

    def constraints(self, shapes: Graph) -> list[CompiledConstraint]:
        """编译并缓存形状。编译失败直接抛出，不降级。"""
        key = id(shapes)
        cached = self._cache.get(key)
        if cached is None:
            cached = ShapeCompiler(shapes, self.ontology).compile()
            self._cache[key] = cached
        return cached

    async def evaluate(self, data: Graph, shapes: Graph) -> tuple[list[Violation], list[str]]:
        constraints = self.constraints(shapes)
        scratch = f"urn:ontorag:scratch:{uuid4().hex}"
        put_graph = getattr(self.store, "put_graph", None)
        delete_graph = getattr(self.store, "delete_graph", None)
        select_dataset = getattr(self.store, "select_dataset", None)
        if put_graph is None or delete_graph is None or select_dataset is None:
            raise RetrievalError("图存储不支持数据集级查询，无法使用 Fuseki SHACL 引擎")

        violations: list[Violation] = []
        try:
            await put_graph(scratch, data, timeout=self.timeout_seconds)
            for constraint in constraints:
                rows = await select_dataset(
                    [scratch],
                    constraint.query,
                    timeout=self.timeout_seconds,
                    max_rows=self.max_rows,
                )
                for row in rows:
                    violations.append(
                        Violation(
                            rule=constraint.shape,
                            message=substitute(constraint.message, row),
                            focus_node=row.get("this"),
                            path=constraint.path,
                            severity=constraint.severity,
                            conflicting_triples=[f"{key}={value}" for key, value in row.items() if key != "this"],
                        )
                    )
        except ShapeCompileError:
            raise
        finally:
            # 清理失败不该掩盖真实结论，但要留下日志
            try:
                await delete_graph(scratch, timeout=self.timeout_seconds)
            except Exception as error:  # noqa: BLE001 - 清理路径，任何异常都只记录
                logger.warning("清理 SHACL 临时图失败：%s (%s)", scratch, error)
        return violations, sorted({item.shape for item in constraints})


def build_engine(
    backend: str,
    ontology: OntologyModel,
    *,
    store: object | None = None,
    timeout_seconds: float = 15.0,
    max_rows: int = 500,
) -> ShaclEngine:
    """按配置选择引擎。

    `auto`：有可用的图存储对象就用 Fuseki，否则退回 pyshacl。
    回退是**显式记录**的（返回值可查、日志可追），不是静默发生。
    """
    if backend == "fuseki" and store is not None:
        return FusekiShaclEngine(
            store, ontology, timeout_seconds=timeout_seconds, max_rows=max_rows
        )
    if backend == "fuseki" and store is None:
        logger.warning("SHACL_BACKEND=fuseki 但图存储不可用，退回 pyshacl")
    return LocalShaclEngine(ontology)


def partition(violations: Sequence[Violation]) -> tuple[list[Violation], list[Violation]]:
    """按严重级别拆分：阻断项与提示项。"""
    blocking = [item for item in violations if is_blocking(item.severity)]
    advisory = [item for item in violations if not is_blocking(item.severity)]
    return blocking, advisory
