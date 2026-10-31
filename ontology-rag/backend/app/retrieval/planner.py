"""结构化查询 -> SPARQL 规划。

只做一件事：把「实体 + 约束 + 时间范围」翻译成一条**只读 SELECT**。
三条硬性纪律：

1. **只取事实，不做判定**。约束在这里只贡献"要投影哪些属性"，
   不生成"是否超付"这类断言——判定必须留给 SHACL，否则闸门就没有独立对象。
2. **不拼接未校验的文本**。IRI 走 `EntityRef` 的正则校验，日期走 `date.isoformat()`，
   变量名由属性本地名清洗而来。用户文本永远不进 SPARQL。
3. **时间比较先转 xsd:date**。直接比 `xsd:dateTime` 与 `xsd:date` 在 Jena 上是类型错误，
   `FILTER` 求值失败会让整行被丢弃——表现为"时间过滤一开，违规就静默漏报"。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from ..ontology.model import CAR, CON, DOC, TOP, OntologyModel
from . import constraints as registry
from .contract import StructuredQuery, TimeRange, local_of

PREFIX_BLOCK = f"""PREFIX con: <{CON}>
PREFIX car: <{CAR}>
PREFIX top: <{TOP}>
PREFIX doc: <{DOC}>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>"""

# 时态属性的 range 本地名，用来推断"时间范围该作用在哪个属性上"
_TEMPORAL_RANGES = frozenset({"date", "dateTime", "dateTimeStamp"})
_VAR_SAFE = re.compile(r"[^0-9A-Za-z_]")


@dataclass(frozen=True, slots=True)
class PlannedQuery:
    """规划结果。`sparql` 尚未注入租户图，必须再经 `sparql_guard.prepare`。"""

    sparql: str
    target_classes: tuple[str, ...]
    # 被投影的属性变量名（不含 `?`），用于计算"事实完整度"
    projected: tuple[str, ...]
    temporal_property: str | None = None
    notes: tuple[str, ...] = ()

    @property
    def usable(self) -> bool:
        """没有实体空间就没有图谱召回——空查询不是"查到了 0 条"，是"没查"。"""
        return bool(self.sparql)


class SparqlPlanner:
    """把结构化查询编译成 SPARQL。"""

    def __init__(self, ontology: OntologyModel, *, max_rows: int = 200, max_properties: int = 12) -> None:
        self.ontology = ontology
        self.max_rows = max_rows
        # 属性投影上限：SUPER 属性越界会把 SELECT 变成宽表，行数膨胀且没什么收益
        self.max_properties = max_properties

    def plan(self, query: StructuredQuery) -> PlannedQuery | None:
        """返回规划结果；缺实体空间时返回 None 并给出原因备注。

        主体类的来源有三个，按可靠性排序，**前两个是并集**：

        1. 点名实体（最可靠）；
        2. 约束的目标类——约束作用在谁身上，谁就是本题的主体。
           这一条不能只在"没有点名实体时"才用：问"核算边界是否冲突"时，
           点名的是 AccountingBoundary，但冲突发生在 EmissionSource 上，
           漏掉后者就取不到冲突证据，结论会退化成一句泛泛的规定复述；
        3. 属性的 rdfs:domain——只点了属性（如"合同金额"）时，
           属性的定义域就是主体类。这是本体公理给出的答案，不是猜命名空间。
        """
        notes: list[str] = []
        subject: dict[str, str] = {}
        for local in sorted(query.class_locals()):
            subject.setdefault(local, "explicit")
        for local in registry.target_classes_for(tuple(c.name for c in query.constraints)):
            subject.setdefault(local, "constraint")
        if not subject:
            for local in sorted(query.property_locals()):
                info = self.ontology.property_of(local)
                if info is None:
                    continue
                for domain in info.domain:
                    subject.setdefault(domain, "domain")

        classes: list[str] = []
        for local, origin in subject.items():
            iri = self.ontology.iri_of(local)
            if iri is None:
                # 不猜命名空间：`con:NoSuchClass` 这种形式能无条件拼出 IRI，
                # 拼出来也查不到任何东西，只会把"类名写错"伪装成"库里没有数据"
                notes.append(f"unknown-class:{local}")
                continue
            if iri not in classes:
                classes.append(iri)
                if origin != "explicit":
                    notes.append(f"class-from-{origin}:{local}")

        individuals = query.individual_iris()
        if not classes and not individuals:
            return None
        for name in query.unknown_constraints():
            notes.append(f"unknown-constraint:{name}")

        properties = self._properties(query, notes)
        time_property = self._temporal_property(query.time_range, classes, notes)

        where: list[str] = []
        if individuals:
            where.append(_values("entity", individuals))
        elif classes:
            # 多类用 VALUES + ?type：写成多个 `?entity a <C>` 会变成"同时属于所有类"
            where.append(_values("type", classes))
            where.append("?entity a ?type .")

        if time_property:
            # 时间过滤是**必需连接**：没有时间戳的实体无法证明落在范围内，
            # 让它静默通过等于把"无法证明"当成"合规"
            where.append(f"?entity <{time_property}> ?time_value .")
            where.append(self._time_filter(query.time_range, time_property))
        elif query.time_range is not None and not query.time_range.is_empty():
            notes.append("time-range-unbound")

        projected: list[str] = []
        for local, iri in properties:
            var = f"v_{_VAR_SAFE.sub('_', local)}"
            if var in projected:
                continue
            projected.append(var)
            where.append(f"OPTIONAL {{ ?entity <{iri}> ?{var} }}")

        body = "\n  ".join(where)
        sparql = (
            f"{PREFIX_BLOCK}\n"
            f"SELECT DISTINCT ?entity"
            + (" " + " ".join(f"?{var}" for var in projected) if projected else "")
            + f" WHERE {{\n  {body}\n}}\nLIMIT {self.max_rows}"
        )
        return PlannedQuery(
            sparql=sparql,
            target_classes=tuple(local_of(iri) for iri in classes),
            projected=tuple(projected),
            temporal_property=local_of(time_property) if time_property else None,
            notes=tuple(notes),
        )

    # ------------------------------ 内部 ------------------------------

    def _properties(self, query: StructuredQuery, notes: list[str]) -> list[tuple[str, str]]:
        """要投影的属性：点名属性 + 约束隐含属性。"""
        ordered: dict[str, str] = {}
        # 点名属性按 IRI 精确取（EntityRef 已校验）
        for entity in query.entities:
            if entity.kind == "property":
                ordered.setdefault(entity.local, entity.iri)
        for constraint in query.constraints:
            for prop in constraint.properties:
                iri = self.ontology.iri_of(prop)
                if iri is None:
                    notes.append(f"unknown-property:{prop}")
                    continue
                ordered.setdefault(local_of(iri), iri)
        items = list(ordered.items())
        if len(items) > self.max_properties:
            notes.append(f"properties-truncated:{len(items)}>{self.max_properties}")
            items = items[: self.max_properties]
        return items

    def _temporal_property(
        self, time_range: TimeRange | None, classes: list[str], notes: list[str]
    ) -> str | None:
        """确定时间过滤作用的属性。

        显式 `field` 优先；否则在目标类的时态属性里找**唯一**一个——
        找到两个就说明有歧义，此时宁可不过滤（并留下 note），也不猜一个。
        """
        if time_range is None or time_range.is_empty():
            return None
        if time_range.field:
            iri = self.ontology.iri_of(time_range.field)
            if iri is None:
                notes.append(f"unknown-time-field:{time_range.field}")
                return None
            return iri
        target_locals = {local_of(iri) for iri in classes}
        candidates: list[str] = []
        for info in self.ontology.properties.values():
            if not any(local.rsplit("#", 1)[-1] in _TEMPORAL_RANGES for local in info.range):
                continue
            if target_locals & set(info.domain) and info.iri not in candidates:
                candidates.append(info.iri)
        if len(candidates) == 1:
            return candidates[0]
        notes.append("time-field-ambiguous" if candidates else "time-field-missing")
        return None

    @staticmethod
    def _time_filter(time_range: TimeRange | None, property_iri: str | None) -> str:
        """构造时间过滤表达式。

        `IF(...)` 的分支是惰性求值的，所以类型不对的字面量不会把整条表达式变错误，
        而是稳定地判为 false——这正是我们要的：无法比较的时间不进入结果，
        但不会连累同一实体上的其他断言。
        """
        assert time_range is not None  # 调用方保证非空
        comparisons = [
            f'xsd:date(?time_value) {operator} "{literal}"^^xsd:date'
            for operator, literal, _ in time_range.sparql_bounds()
        ]
        expression = " && ".join(comparisons) or "true"
        return (
            "FILTER(IF(datatype(?time_value) IN (xsd:date, xsd:dateTime), "
            f"{expression}, false))"
        )


def _values(variable: str, iris: list[str] | tuple[str, ...]) -> str:
    """生成 VALUES 子句。IRI 已在 EntityRef / ontology.iri_of 处校验过。"""
    joined = " ".join(f"<{iri}>" for iri in iris)
    return f"VALUES ?{variable} {{ {joined} }}"
