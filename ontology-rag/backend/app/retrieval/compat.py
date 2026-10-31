"""本体兼容性判定：召回后过滤的唯一口径。

判定目标不是"字面相同"，而是**同一业务语义分支**。因此这里做三件事：

1. 用 `rdfs:subClassOf` 的传递闭包判断"可比较"：`PaymentApplication` 与
   `Contract` 只有公共祖先 `top:Entity`，不可比较；`ContractClause` 与
   `top:Clause` 可比较。**公共祖先只有根类不算相关**——否则所有类都通过，
   过滤等于没做。
2. 用 `rdfs:subPropertyOf` 与 `owl:inverseOf` 判断属性等价：`appliesToContract`
   与 `hasPaymentApplication` 互为逆属性，讲其中一个的条款对另一个同样有效。
3. 用 `rdfs:domain` 搭桥：只打了属性标签的分块（如 `con:contractAmount`），
   按属性定义域判断它讲的是不是查询关心的类。

三条原则之外还有一条刻意的宽容：**图谱命中的分块不参与判定**。它是由事实链
（实例 -> 条款 -> 分块）直接支撑的，可能只覆盖问题的一个侧面（问超付时命中
发票条款），按标签误杀会丢掉交叉证据。宽容只给"有链路证据"的那一路，
这正是三级检索顺序本身的价值。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

from rdflib import URIRef
from rdflib.namespace import OWL, RDFS

from ..ontology.model import OntologyModel
from .contract import local_of

# 这些条件成立时，判定结论必须能解释清楚，reason 会写进审计
Tier = str


@dataclass(frozen=True, slots=True)
class CompatVerdict:
    """兼容性结论 + 可解释依据。"""

    compatible: bool
    reason: str
    matched_classes: tuple[str, ...] = ()
    matched_properties: tuple[str, ...] = ()
    # 无法判定（既不能确认兼容，也没有证据说不兼容）与"判定为兼容"要分开，
    # 这样严格租户可以只收紧 unknown，而不影响已确认的兼容
    unknown: bool = False

    def __bool__(self) -> bool:
        return self.compatible


@dataclass(slots=True)
class OntologyCompatibility:
    """基于本体公理的兼容性判定器（图结构只读，构造一次复用）。"""

    ontology: OntologyModel
    _parents: dict[str, set[str]] = field(default_factory=dict, repr=False)
    _sub_properties: dict[str, set[str]] = field(default_factory=dict, repr=False)
    _inverses: dict[str, set[str]] = field(default_factory=dict, repr=False)
    _domains: dict[str, set[str]] = field(default_factory=dict, repr=False)
    _ancestor_cache: dict[str, frozenset[str]] = field(default_factory=dict, repr=False)
    _roots: frozenset[str] = frozenset({"Thing", "Entity"})

    def __post_init__(self) -> None:
        graph = self.ontology.graph
        for sub, sup in graph.subject_objects(RDFS.subClassOf):
            if isinstance(sub, URIRef) and isinstance(sup, URIRef):
                self._parents.setdefault(local_of(str(sub)), set()).add(local_of(str(sup)))
        for sub, sup in graph.subject_objects(RDFS.subPropertyOf):
            if isinstance(sub, URIRef) and isinstance(sup, URIRef):
                self._sub_properties.setdefault(local_of(str(sub)), set()).add(local_of(str(sup)))
        for left, right in graph.subject_objects(OWL.inverseOf):
            if isinstance(left, URIRef) and isinstance(right, URIRef):
                a, b = local_of(str(left)), local_of(str(right))
                self._inverses.setdefault(a, set()).add(b)
                self._inverses.setdefault(b, set()).add(a)
        for prop, domain in graph.subject_objects(RDFS.domain):
            if isinstance(prop, URIRef) and isinstance(domain, URIRef):
                self._domains.setdefault(local_of(str(prop)), set()).add(local_of(str(domain)))
        # 根类动态判定：本体里没有父类的类就是根（top:Entity），
        # 再加 owl:Thing 兜底。硬编码类名会在换本体时悄悄失效。
        declared = {local_of(info.iri) for info in self.ontology.classes.values()}
        self._roots = frozenset({name for name in declared if not self._parents.get(name)} | {"Thing"})

    # ------------------------------ 结构判定 ------------------------------

    def ancestors(self, local: str) -> frozenset[str]:
        """含自身的祖先闭包（记忆化，环安全）。"""
        cached = self._ancestor_cache.get(local)
        if cached is not None:
            return cached
        seen: set[str] = set()
        stack = [local]
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            stack.extend(self._parents.get(current, ()))
        frozen = frozenset(seen)
        self._ancestor_cache[local] = frozen
        return frozen

    def comparable(self, left: str, right: str) -> bool:
        """两个类是否在同一语义分支（祖先/后代关系）。"""
        if left == right:
            return True
        left_anc, right_anc = self.ancestors(left), self.ancestors(right)
        if right in left_anc or left in right_anc:
            return True
        # 共同祖先必须是"有信息量"的子类，根类不算
        return bool((left_anc & right_anc) - self._roots)

    def property_compatible(self, left: str, right: str) -> bool:
        """属性是否等价：同名 / 子属性 / 逆属性。"""
        if left == right:
            return True
        if right in self.ancestors_of_property(left) or left in self.ancestors_of_property(right):
            return True
        return right in self._inverses.get(left, set())

    def ancestors_of_property(self, local: str) -> frozenset[str]:
        seen: set[str] = set()
        stack = [local]
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            stack.extend(self._sub_properties.get(current, ()))
        return frozenset(seen)

    def domains(self, local: str) -> frozenset[str]:
        return frozenset(self._domains.get(local, ()))

    # ------------------------------ 结论 ------------------------------

    def check(
        self,
        *,
        chunk_classes: Iterable[str],
        chunk_properties: Iterable[str],
        query_classes: Iterable[str],
        query_properties: Iterable[str],
        tier: Tier,
    ) -> CompatVerdict:
        """判定一个分块能否回答该查询。"""
        if tier == "graph":
            # 事实链已经不是"标签相关"，而是"被这条查询的证据链直接支撑"
            return CompatVerdict(True, "graph-fact-chain")

        q_classes = {local_of(item) for item in query_classes if item}
        q_props = {local_of(item) for item in query_properties if item}
        if not q_classes and not q_props:
            return CompatVerdict(True, "no-query-terms", unknown=True)

        c_classes = {local_of(item) for item in chunk_classes if item}
        c_props = {local_of(item) for item in chunk_properties if item}
        if not c_classes and not c_props:
            # 无标签分块只有向量通道会遇到：它无法被任何业务约束解释。
            # 关键词通道保留它，因为原文命中本身就是证据（制度原文常没有标签）。
            if tier == "vector":
                return CompatVerdict(False, "untagged-vector", unknown=True)
            return CompatVerdict(True, "untagged-tolerated", unknown=True)

        name = sorted(c_classes & q_classes)
        if name:
            return CompatVerdict(True, f"class-exact:{name[0]}", matched_classes=tuple(name))

        for chunk_class in sorted(c_classes):
            for query_class in sorted(q_classes):
                if self.comparable(chunk_class, query_class):
                    return CompatVerdict(
                        True,
                        f"class-hierarchy:{chunk_class}~{query_class}",
                        matched_classes=(chunk_class, query_class),
                    )

        prop_match = sorted(c_props & q_props)
        if prop_match:
            return CompatVerdict(True, f"property-exact:{prop_match[0]}", matched_properties=tuple(prop_match))

        for chunk_prop in sorted(c_props):
            for query_prop in sorted(q_props):
                if self.property_compatible(chunk_prop, query_prop):
                    return CompatVerdict(
                        True,
                        f"property-hierarchy:{chunk_prop}~{query_prop}",
                        matched_properties=(chunk_prop, query_prop),
                    )

        # 属性域搭桥：分块只打了属性标签时，用 rdfs:domain 判断它在讲哪个类
        for chunk_prop in sorted(c_props):
            for domain in sorted(self.domains(chunk_prop)):
                for query_class in sorted(q_classes):
                    if self.comparable(domain, query_class):
                        return CompatVerdict(
                            True,
                            f"property-domain:{chunk_prop}->{domain}~{query_class}",
                            matched_properties=(chunk_prop,),
                            matched_classes=(query_class,),
                        )
        for query_prop in sorted(q_props):
            for domain in sorted(self.domains(query_prop)):
                for chunk_class in sorted(c_classes):
                    if self.comparable(domain, chunk_class):
                        return CompatVerdict(
                            True,
                            f"class-domain:{chunk_class}~{domain}<-{query_prop}",
                            matched_classes=(chunk_class,),
                            matched_properties=(query_prop,),
                        )

        return CompatVerdict(False, "no-overlap")

    def check_chunk(
        self,
        chunk: object,
        *,
        query_classes: Iterable[str],
        query_properties: Iterable[str],
        tier: Tier,
    ) -> CompatVerdict:
        """`Chunk` 便捷入口。属性传 IRI，内部转本地名比对。"""
        return self.check(
            chunk_classes=getattr(chunk, "classes", []) or [],
            chunk_properties=getattr(chunk, "properties", []) or [],
            query_classes=query_classes,
            query_properties=query_properties,
            tier=tier,
        )
