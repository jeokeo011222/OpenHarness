"""结构化查询契约：检索层的唯一输入。

设计取舍：**不复用自然语言字符串做输入**，而是要求上游（本体解析 / 外部调用方）
把查询拆成实体、约束、时间范围三样东西。理由很实际——

  * 「实体」决定图谱查询的主体空间，含糊的字符串无法构造 VALUES；
  * 「约束」决定要投影哪些属性，也决定本体兼容性的属性维度；
  * 「时间范围」必须作用在**本体声明的时态属性**上，而不是猜文本里的年份。

有了这三样，检索才可能做到"同样的输入必然得到同样的证据集"。
自然语言只是 `raw` 字段，仅用于关键词检索与审计留痕。
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any, Iterable, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from . import constraints as registry

_IRI_RE = re.compile(r"^(https?://|urn:)[^\s<>\"{}|\\^`]+$")


def local_of(value: str) -> str:
    """IRI 或 `con:Foo` -> 本地名。

    与 `OntologyModel.local` 同一口径，实现保持独立以避免循环依赖；
    额外支持前缀形式，因为约束注册表里写的是 `con:contractAmount`。
    """
    text = value.strip()
    if text.startswith(("http://", "https://")):
        if "#" in text:
            return text.rsplit("#", 1)[-1]
        return text.rstrip("/").rsplit("/", 1)[-1]
    if ":" in text:
        return text.split(":", 1)[1]
    return text


class EntityRef(BaseModel):
    """查询里点名的本体对象。"""

    iri: str
    # class：概念（走 rdf:type 检索）；individual：具体实例（走 VALUES）；
    # property：属性（只参与兼容性判定，不单独成为查询主体）
    kind: Literal["class", "individual", "property"] = "class"
    local: str = ""
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    surface: str = ""

    @field_validator("iri")
    @classmethod
    def _validate_iri(cls, value: str) -> str:
        """拒绝非 IRI 输入：这是把用户文本直接拼进 SPARQL 的唯一入口。"""
        text = value.strip()
        if not _IRI_RE.match(text):
            raise ValueError(f"不是合法 IRI：{value!r}")
        return text

    @model_validator(mode="after")
    def _fill_local(self) -> "EntityRef":
        if not self.local:
            self.local = local_of(self.iri)
        return self


class ConstraintRef(BaseModel):
    """查询引用的业务约束（对应一条 SHACL 形状）。"""

    name: str
    # 允许调用方补属性；留空则按注册表推导
    properties: list[str] = Field(default_factory=list)
    # 硬约束：命中失败必须阻断。检索层只记录，判定交给 SHACL
    hard: bool = True

    @model_validator(mode="after")
    def _fill_properties(self) -> "ConstraintRef":
        spec = registry.spec_for(self.name)
        if spec is not None and not self.properties:
            self.properties = list(spec.properties)
        return self

    @property
    def resolved(self) -> bool:
        """是否能在注册表里找到规格。找不到说明约束名写错了或尚未登记。"""
        return registry.spec_for(self.name) is not None


class TimeRange(BaseModel):
    """时间范围约束。

    `field` 是可选的属性本地名；为空时由 planner 按目标类的时态属性推断。
    刻意不接受"2024年"这种模糊表达：解析层的职责是把模糊表达变成确定的日期，
    检索层不能替它猜。
    """

    start: date | None = None
    end: date | None = None
    field: str | None = None

    @model_validator(mode="after")
    def _validate_order(self) -> "TimeRange":
        if self.start and self.end and self.start > self.end:
            raise ValueError(f"时间范围起止颠倒：{self.start} > {self.end}")
        return self

    def is_empty(self) -> bool:
        return self.start is None and self.end is None

    def sparql_bounds(self) -> list[tuple[str, str, date]]:
        """(比较符, 日期字面量, 值) 三元组，供 planner 拼 FILTER。"""
        bounds: list[tuple[str, str, date]] = []
        if self.start is not None:
            bounds.append((">=", self.start.isoformat(), self.start))
        if self.end is not None:
            bounds.append(("<=", self.end.isoformat(), self.end))
        return bounds


class StructuredQuery(BaseModel):
    """本体解析后的结构化查询。"""

    # 原始问句：只用于关键词检索与审计，不参与结构化判断
    raw: str = ""
    domain: str = "contract"
    entities: list[EntityRef] = Field(default_factory=list)
    constraints: list[ConstraintRef] = Field(default_factory=list)
    time_range: TimeRange | None = None
    identifiers: list[str] = Field(default_factory=list)
    # 下推到存储层的过滤条件（doc_types / priority_max / include_history 等）
    filters: dict[str, Any] = Field(default_factory=dict)

    # ------------------------------ 派生视图 ------------------------------

    def class_locals(self) -> set[str]:
        """点名的类（本地名）。"""
        return {entity.local for entity in self.entities if entity.kind == "class"}

    def property_locals(self) -> set[str]:
        """点名的属性（本地名）。"""
        return {entity.local for entity in self.entities if entity.kind == "property"}

    def individual_iris(self) -> tuple[str, ...]:
        """点名的实例 IRI（去重保序）。"""
        seen: dict[str, None] = {}
        for entity in self.entities:
            if entity.kind == "individual":
                seen.setdefault(entity.iri, None)
        return tuple(seen)

    def constraint_property_locals(self) -> set[str]:
        """约束隐含的属性（本地名）——兼容性判定必须有这一维。

        只看点名实体是不够的：问"是否超付"时用户不会说"合同金额"，
        但任何讲到合同金额的条款都该算相关证据。
        """
        locals_: set[str] = set()
        for constraint in self.constraints:
            for prop in constraint.properties:
                locals_.add(local_of(prop))
        return locals_

    def effective_classes(self) -> set[str]:
        """查询主体类：显式实体优先，缺失时用约束的目标类兜底。"""
        explicit = self.class_locals()
        if explicit:
            return explicit
        return set(registry.target_classes_for(tuple(c.name for c in self.constraints)))

    def unknown_constraints(self) -> tuple[str, ...]:
        """未登记的约束名——必须显式披露，不能当成"没有约束"。"""
        return tuple(c.name for c in self.constraints if not c.resolved)

    def all_filter_terms(self) -> set[str]:
        """兼容性判定用的全部查询词（类 + 属性 + 约束隐含属性）。"""
        return self.class_locals() | self.property_locals() | self.constraint_property_locals()

    # ------------------------------ 构造 ------------------------------

    @classmethod
    def from_intent(cls, intent: Any) -> "StructuredQuery":
        """从 `QueryIntent` 构造。

        只搬运已经对齐过 IRI 的部分：`kind=unknown` 的提及一律丢弃，
        否则未对齐的表面形式会变成"看起来有实体、实际查不到"的假输入。
        """
        entities: list[EntityRef] = []
        for mention in getattr(intent, "entities", []) or []:
            iri = getattr(mention, "iri", None)
            kind = getattr(mention, "kind", "unknown")
            if not iri or kind not in {"class", "individual", "property"}:
                continue
            entities.append(
                EntityRef(
                    iri=iri,
                    kind=kind,
                    confidence=float(getattr(mention, "confidence", 1.0)),
                    surface=str(getattr(mention, "surface", "")),
                )
            )
        filters = dict(getattr(intent, "filters", {}) or {})
        time_range = _time_range_from_filters(filters)
        filters.pop("time_range", None)
        return cls(
            raw=str(getattr(intent, "query", "") or ""),
            domain=str(getattr(intent, "domain", "contract") or "contract"),
            entities=entities,
            constraints=[ConstraintRef(name=name) for name in (getattr(intent, "constraints", []) or [])],
            time_range=time_range,
            identifiers=[str(item) for item in (filters.get("identifiers") or [])],
            filters=filters,
        )

    def with_entities(self, entities: Iterable[EntityRef]) -> "StructuredQuery":
        """返回替换实体后的副本（调用方补充实体而不污染原对象）。"""
        return self.model_copy(update={"entities": list(entities)})


def _time_range_from_filters(filters: dict[str, Any]) -> TimeRange | None:
    """从 filters 里读出结构化时间范围。

    只接受明确的三元组结构；解析不了就返回 None，绝不从文本里猜日期——
    "猜错的时间范围"会静默过滤掉正确证据，比没有过滤更糟。
    """
    payload = filters.get("time_range")
    if not isinstance(payload, dict):
        return None
    try:
        start = date.fromisoformat(str(payload["start"])) if payload.get("start") else None
        end = date.fromisoformat(str(payload["end"])) if payload.get("end") else None
    except (KeyError, TypeError, ValueError):
        return None
    field = payload.get("field")
    time_range = TimeRange(start=start, end=end, field=str(field) if field else None)
    return None if time_range.is_empty() else time_range
