"""本体模型：类、属性、同义词与 SHACL 形状的统一加载入口。

只使用 OWL 2 RL 可判定子集（子类、domain/range、逆属性），不做 OWL DL 全推理：
业务规则一律落在 SHACL 上，推理只用于补全类型，保证响应时间可预期。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from rdflib import Graph, Namespace, URIRef
from rdflib.namespace import OWL, RDF, RDFS, SKOS

TOP = Namespace("http://ontorag.local/top#")
CON = Namespace("http://ontorag.local/contract#")
CAR = Namespace("http://ontorag.local/carbon#")
DOC = Namespace("http://ontorag.local/doc#")
SH = Namespace("http://www.w3.org/ns/shacl#")

# 领域 id -> 该领域使用的命名空间
DOMAIN_NAMESPACES: dict[str, Namespace] = {"contract": CON, "carbon": CAR}

# 域标识 -> 本体文件名（新增子本体只需在此登记）
DOMAIN_FILES: dict[str, tuple[str, ...]] = {
    "contract": ("domain/domain_contract.owl",),
    "carbon": ("domain/domain_carbon.ttl",),
}

_NORMALIZE_RE = re.compile(r"[\s\u3000()（）【】\[\]「」『』，,。.;；:：、\-—_/\\]+")


def normalize_term(text: str) -> str:
    """术语归一：全角转半角、去标点、统一小写。

    这是实体链接与同义词匹配的共同前置步骤，必须只有一处实现。
    """
    if not text:
        return ""
    chars: list[str] = []
    for ch in text.strip():
        code = ord(ch)
        if code == 0x3000:
            chars.append(" ")
        elif 0xFF01 <= code <= 0xFF5E:
            chars.append(chr(code - 0xFEE0))
        else:
            chars.append(ch)
    return _NORMALIZE_RE.sub("", "".join(chars)).lower()


@dataclass(slots=True)
class ClassInfo:
    """一个本体类的可检索信息。"""

    iri: str
    local: str
    labels: list[str] = field(default_factory=list)
    parents: list[str] = field(default_factory=list)

    @property
    def terms(self) -> list[str]:
        """类名与全部标签，用于分块打标与实体链接。"""
        return [self.local, *self.labels]


@dataclass(slots=True)
class PropertyInfo:
    """一个属性的可检索信息。"""

    iri: str
    local: str
    labels: list[str] = field(default_factory=list)
    domain: list[str] = field(default_factory=list)
    range: list[str] = field(default_factory=list)
    object_property: bool = False

    @property
    def terms(self) -> list[str]:
        """属性名与全部标签。"""
        return [self.local, *self.labels]


class OntologyModel:
    """顶层 + 领域本体的内存视图。"""

    def __init__(
        self,
        graph: Graph,
        shapes: Graph,
        claim_shapes: Graph | None = None,
        *,
        domain_namespaces: dict[str, tuple[str, ...]] | None = None,
    ) -> None:
        self.graph = graph
        # 全量形状：数据质检 / 动作提交时使用
        self.shapes = shapes
        # 结论形状：生成后闸门使用
        self.claim_shapes = claim_shapes if claim_shapes is not None else shapes
        # 域 -> 该域独占的 IRI 命名空间。域过滤靠它，不靠写死的三个前缀：
        # 本体中心发布的域未必用内置命名空间，写死的话新域会被整体过滤成空集。
        self.domain_namespaces: dict[str, tuple[str, ...]] = dict(domain_namespaces or {})
        # 前缀表来自实际解析过的 Turtle（@prefix 声明），不是写死的四个。
        # 本体中心发布的域常用自己的前缀，写死的话 `iri_of('pay:X')` 永远解析不到。
        self.prefixes: dict[str, str] = {}
        for prefix, namespace in self.graph.namespaces():
            text = str(namespace)
            if prefix and ":" in text:
                self.prefixes.setdefault(prefix, text)
        # 类与属性以 **IRI** 为键：不同域可以有同名类（`pay:Contract` 与 `con:Contract`），
        # 以本地名为键会互相覆盖，而覆盖顺序取决于文件加载顺序——这种不确定性
        # 在演示时表现为"同一个问题今天查得到、明天查不到"。
        self.classes: dict[str, ClassInfo] = {}
        self.properties: dict[str, PropertyInfo] = {}
        # 本地名 -> 同名类列表，供只拿到本地名的展示层使用
        self.classes_by_local: dict[str, list[ClassInfo]] = {}
        self.properties_by_local: dict[str, list[PropertyInfo]] = {}
        # 归一化后的别名 -> (iri, kind)
        self._aliases: dict[str, tuple[str, str]] = {}
        self._load_classes()
        self._load_properties()
        self._load_aliases()

    # ------------------------------ 加载 ------------------------------

    def _load_classes(self) -> None:
        for subject in self.graph.subjects(RDF.type, OWL.Class):
            if not isinstance(subject, URIRef):
                continue
            local = self._local(subject)
            info = ClassInfo(
                iri=str(subject),
                local=local,
                labels=[str(o) for o in self.graph.objects(subject, RDFS.label)],
                parents=[self._local(p) for p in self.graph.objects(subject, RDFS.subClassOf) if isinstance(p, URIRef)],
            )
            self.classes[info.iri] = info
            self.classes_by_local.setdefault(local, []).append(info)

    def _load_properties(self) -> None:
        kinds = ((OWL.ObjectProperty, True), (OWL.DatatypeProperty, False))
        for predicate, is_object in kinds:
            for subject in self.graph.subjects(RDF.type, predicate):
                if not isinstance(subject, URIRef):
                    continue
                local = self._local(subject)
                info = PropertyInfo(
                    iri=str(subject),
                    local=local,
                    labels=[str(o) for o in self.graph.objects(subject, RDFS.label)],
                    domain=[self._local(d) for d in self.graph.objects(subject, RDFS.domain) if isinstance(d, URIRef)],
                    range=[self._local(r) for r in self.graph.objects(subject, RDFS.range) if isinstance(r, URIRef)],
                    object_property=is_object,
                )
                self.properties[info.iri] = info
                self.properties_by_local.setdefault(local, []).append(info)

    def _load_aliases(self) -> None:
        """把 rdfs:label 与 skos:altLabel 都登记为别名。"""
        for info in self.classes.values():
            for term in info.terms:
                self._aliases.setdefault(normalize_term(term), (info.iri, "class"))
        for prop in self.properties.values():
            for term in prop.terms:
                self._aliases.setdefault(normalize_term(term), (prop.iri, "property"))
        for subject, label in self.graph.subject_objects(SKOS.altLabel):
            if not isinstance(subject, URIRef):
                continue
            kind = "class" if str(subject) in self.classes else "property"
            self._aliases.setdefault(normalize_term(str(label)), (str(subject), kind))

    # ------------------------------ 查询 ------------------------------

    @staticmethod
    def _local(iri: URIRef | str) -> str:
        """取 IRI 的本地名。"""
        text = str(iri)
        for sep in ("#", "/"):
            if sep in text:
                return text.rsplit(sep, 1)[-1]
        return text

    def local(self, iri: str) -> str:
        """IRI -> 本地名。"""
        return self._local(iri)

    def namespace_pool(self) -> tuple[str, ...]:
        """全部可用命名空间：各域声明的前缀 + 顶层 + 文档。

        用于"只拿到本地名时挨个拼接试一下"。顺序稳定，结果可复现。
        """
        seen: list[str] = []
        for prefixes in self.domain_namespaces.values():
            for prefix in prefixes:
                if prefix and prefix not in seen:
                    seen.append(prefix)
        for extra in (str(CON), str(CAR), str(TOP), str(DOC)):
            if extra not in seen:
                seen.append(extra)
        return tuple(seen)

    def iri_of(self, local_or_iri: str) -> str | None:
        """本地名或缩写（con:Foo / pay:Foo）-> 完整 IRI。

        缩写走解析时记录的前缀表；本地名逐个命名空间试拼，命中图里存在的节点才返回。
        """
        if local_or_iri.startswith(("http://", "https://", "urn:")):
            return local_or_iri
        if ":" in local_or_iri:
            prefix, _, local = local_or_iri.partition(":")
            namespace = self.prefixes.get(prefix)
            return f"{namespace}{local}" if namespace else None
        for namespace in self.namespace_pool():
            candidate = f"{namespace}{local_or_iri}"
            if (URIRef(candidate), None, None) in self.graph:
                return candidate
        return None

    def lookup_alias(self, text: str) -> tuple[str, str] | None:
        """精确别名匹配。"""
        return self._aliases.get(normalize_term(text))

    def class_of(self, local_or_iri: str) -> ClassInfo | None:
        """按 IRI 或本地名取类。

        本地名可能对应多个域的类（`con:Contract` / `pay:Contract`），此时返回
        加载顺序上的第一个——调用方若需要确定的那一个，应传完整 IRI。

        @param local_or_iri - 完整 IRI 或本地名。
        @returns 类信息，未命中返回 `None`。
        """
        if local_or_iri.startswith(("http://", "https://", "urn:")):
            return self.classes.get(local_or_iri)
        matches = self.classes_by_local.get(local_or_iri)
        return matches[0] if matches else None

    def property_of(self, local_or_iri: str) -> PropertyInfo | None:
        """按 IRI 或本地名取属性。

        @param local_or_iri - 完整 IRI 或本地名。
        @returns 属性信息，未命中返回 `None`。
        """
        if local_or_iri.startswith(("http://", "https://", "urn:")):
            return self.properties.get(local_or_iri)
        matches = self.properties_by_local.get(local_or_iri)
        return matches[0] if matches else None

    def local_classes(self) -> set[str]:
        """全部类的本地名集合（用于兼容性判定这类只看名字的场景）。"""
        return set(self.classes_by_local)

    def local_properties(self) -> set[str]:
        """全部属性的本地名集合。"""
        return set(self.properties_by_local)

    def aliases(self) -> dict[str, tuple[str, str]]:
        """全部别名（只读副本）。"""
        return dict(self._aliases)

    def classes_for_domain(self, domain: str) -> list[ClassInfo]:
        """某领域可用的类，用于 Query 解析时约束候选空间。

        未知域返回全部类：静默缩小到某个默认域，会让"新加的域查不到东西"
        表现成"检索坏了"，而根因在过滤条件上。
        """
        prefixes = self.namespaces_for(domain)
        if not prefixes:
            return list(self.classes.values())
        return [info for info in self.classes.values() if info.iri.startswith(prefixes)]

    def namespaces_for(self, domain: str | None) -> tuple[str, ...]:
        """某域独占的命名空间集合；未知域或未设域时返回空元组。

        @param domain - 域标识，`None` 表示不限定。
        @returns 可用于 `str.startswith` 的前缀元组。
        """
        if not domain:
            return ()
        return self.domain_namespaces.get(domain.strip().lower(), ())

    def has_domain(self, domain: str | None) -> bool:
        """该域是否已在本体里登记过。"""
        if not domain:
            return False
        return domain.strip().lower() in self.domain_namespaces

    def type_of(self, graph: Graph, iri: str) -> list[str]:
        """在实例图中读取某节点的 rdf:type 本地名。"""
        return [self._local(t) for t in graph.objects(URIRef(iri), RDF.type) if isinstance(t, URIRef)]


def domain_sources(ontology_dir: Path) -> dict[str, Path]:
    """域标识 → 实际加载的领域本体文件。

    运行期接管优先于内置文件：本体中心发布某个域后，重启后仍然用发布的那一版，
    而不是静默退回包内自带版本。`runtime/` 下不属于内置域的 Turtle 视为新增域，
    这样"加一个业务域"不需要改代码也不需要在发布时重启。

    @param ontology_dir - 本体根目录。
    @returns 域标识到文件的映射，按标识排序。
    """
    from .runtime import RUNTIME_DIR

    runtime = ontology_dir / RUNTIME_DIR
    sources: dict[str, Path] = {}
    for domain, files in DOMAIN_FILES.items():
        override = runtime / f"{domain}.ttl"
        sources[domain] = override if override.is_file() else ontology_dir / files[0]
    if runtime.is_dir():
        for path in sorted(runtime.glob("*.ttl")):
            sources.setdefault(path.stem, path)
    return dict(sorted(sources.items()))


def detect_namespaces(path: Path) -> tuple[str, ...]:
    """从文件内容推导该域独占的 IRI 命名空间。

    取全部 `owl:Class` 的公共前缀（到最后一个 `#` 或 `/`）。域边界本质上是
    命名空间边界，从数据里读出来才不会和"发布者用了什么前缀"耦合。

    @param path - 领域本体文件。
    @returns 命名空间前缀元组；没有类时为空。
    """
    graph = Graph()
    try:
        graph.parse(path, format="turtle")
    except Exception:
        return ()
    prefixes: set[str] = set()
    for subject in graph.subjects(RDF.type, OWL.Class):
        if not isinstance(subject, URIRef):
            continue
        text = str(subject)
        cut = max(text.rfind("#"), text.rfind("/"))
        if cut > 0:
            prefixes.add(text[: cut + 1])
    return tuple(sorted(prefixes))


def domain_namespaces(ontology_dir: Path, sources: dict[str, Path]) -> dict[str, tuple[str, ...]]:
    """域标识 → 命名空间。内置域用登记值，被接管或新增的域从文件内容推导。

    接管后必须重新推导：发布者可能整体换了命名空间，继续用登记值会把新本体的类
    全部过滤掉，症状是"本体发布了但一条都检索不到"。

    @param ontology_dir - 本体根目录。
    @param sources - 域到文件的映射。
    @returns 域标识到命名空间元组的映射。
    """
    from .runtime import RUNTIME_DIR

    runtime = ontology_dir / RUNTIME_DIR
    resolved: dict[str, tuple[str, ...]] = {}
    for domain, path in sources.items():
        taken_over = path.parent == runtime
        registered = DOMAIN_NAMESPACES.get(domain)
        if registered is not None and not taken_over:
            resolved[domain] = (str(registered),)
        else:
            detected = detect_namespaces(path)
            if detected:
                resolved[domain] = detected
            elif registered is not None:
                resolved[domain] = (str(registered),)
            else:
                resolved[domain] = ()
    return resolved


def load_ontology(ontology_dir: Path) -> OntologyModel:
    """加载顶层 + 全部领域本体 + 同义词 + SHACL 形状。

    形状图会并入本体三元组，这样 `sh:prefixes` 能在同一张图内解析。
    领域本体按 `domain_sources` 解析：运行期接管的文件覆盖同名内置文件。
    """
    graph = Graph()
    sources = domain_sources(ontology_dir)
    names: list[Path] = [ontology_dir / "top/top_core.ttl", *sources.values(), ontology_dir / "vocab/synonyms.ttl"]
    for path in names:
        if not path.exists():
            raise FileNotFoundError(f"本体文件缺失：{path}")
        graph.parse(path, format="turtle")

    shapes = Graph()
    claim_shapes = Graph()
    for path in sorted((ontology_dir / "shacl").glob("*.ttl")):
        shapes.parse(path, format="turtle")
        if path.name == "claim_shapes.ttl":
            claim_shapes.parse(path, format="turtle")
    shapes += graph
    # 结论形状同样并入本体，保证 sh:prefixes 能在同一张图内解析
    claim_shapes += graph
    return OntologyModel(graph, shapes, claim_shapes, domain_namespaces=domain_namespaces(ontology_dir, sources))


def count_node_shapes(graph: Graph) -> int:
    """统计具名 NodeShape 数量。

    运维概览与调试面板共用这一个口径：两处各写一遍，改了一处忘了另一处，
    面板上的"形状数"就会和 /healthz 对不上——演示时最忌讳这种自相矛盾。
    """
    return sum(1 for subject in graph.subjects(RDF.type, SH.NodeShape) if isinstance(subject, URIRef))
