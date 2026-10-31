"""SHACL → SPARQL 编译器。

为什么需要它：本项目的图数据在 Fuseki 里，而 Apache Jena 的 Fuseki 5.x
**不提供 SHACL HTTP 端点**（SHACL 是 Jena 的库/CLI 能力，不是 servlet）。
想把校验放到 Fuseki 侧执行，只有两条路：起一个 JVM sidecar，或者把形状
翻译成 SPARQL 直接打给 `/query`。后者不引入新进程，且本项目的阻断型约束
本来就全部写成 SHACL-SPARQL（`sh:sparql`），翻译是等价变换而非近似。

同时它也是"形状必须可编译"的门禁：遇到不支持的约束组件一律抛
`ShapeCompileError`，绝不静默跳过。一条被悄悄忽略的约束，比一条写错的
约束更危险——前者会让闸门看起来在工作。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

from rdflib import BNode, Graph, URIRef
from rdflib.namespace import RDF

from ..errors import ShapeCompileError
from ..ontology.model import SH, OntologyModel
from ..sparql_guard import blank_noncode

# 支持的目标选择器：恰好一个
_TARGETS = {
    SH.targetSubjectsOf: "subjects",
    SH.targetObjectsOf: "objects",
    SH.targetClass: "class",
}

# 属性形状上已支持的约束组件
_PROPERTY_COMPONENTS = (
    SH.minCount,
    SH.maxCount,
    SH.datatype,
    SH["in"],
    SH["class"],
)


@dataclass(frozen=True, slots=True)
class CompiledConstraint:
    """一条可独立执行的约束。`query` 返回的每一行都是一处冲突。"""

    shape: str
    severity: str
    message: str
    query: str
    path: str | None = None
    component: str = "sparql"


def _local(node: object) -> str:
    """取 IRI 的本地名，用于报告里可读的规则名。"""
    text = str(node)
    for separator in ("#", "/"):
        if separator in text:
            return text.rsplit(separator, 1)[-1]
    return text


def _prefix_block(shapes: Graph, names: set[str]) -> str:
    """只把形状里**真正用到**的命名空间声明搬进生成查询。

    `sh:select` 体里用的是 QName（`con:paymentVerdict`），而生成查询要独立
    发到 Fuseki，那边不共享本进程的绑定，所以必须自带 PREFIX。
    只挑用到的（而不是把 rdflib 默认绑定的 30 多个全写上），
    是为了让审计里记录的 SPARQL 还能被人读懂。
    """
    bindings = {prefix or "": str(namespace) for prefix, namespace in shapes.namespaces()}
    missing = sorted(name for name in names if name not in bindings)
    if missing:
        # 形状里写了未声明的前缀，编译出的查询在 Fuseki 会直接语法错误。
        # 与其等到运行期报 400，不如在编译期把配置错误摊开。
        raise ShapeCompileError(
            f"形状使用了未声明的前缀：{', '.join(missing)}",
            details={"prefixes": missing},
        )
    lines: list[str] = []
    for name in sorted(names):
        namespace = bindings[name]
        lines.append(f"PREFIX {name}: <{namespace}>")
    return "\n".join(lines)


# QName 前缀：前面不能是 `:`（排除 IRI 里的 `http://`）也不能是单词字符
_QNAME_RE = re.compile(r"(?<![\w:])([A-Za-z_][\w.-]*):")


def _matching_brace(code: str, open_index: int) -> int:
    """从 `{` 找到配对的 `}`（基于抹掉字面量的副本，位置与原文一致）。"""
    depth = 0
    for index in range(open_index, len(code)):
        char = code[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
    raise ShapeCompileError("形状里的 SPARQL 花括号不配对")


def _inject_pattern(select_text: str, pattern: str) -> str:
    """把目标模式并入 `sh:select` 的 WHERE 组，保留其后的 GROUP BY / HAVING。"""
    code = blank_noncode(select_text)
    open_index = code.find("{")
    if open_index < 0:
        raise ShapeCompileError("sh:select 缺少查询体")
    close_index = _matching_brace(code, open_index)
    inner = select_text[open_index + 1 : close_index]
    tail = select_text[close_index + 1 :]
    head = select_text[: open_index + 1]
    return f"{head}\n  {pattern} .\n{inner}\n}}{tail}"


class ShapeCompiler:
    """把一个形状图编译成一组可执行 SPARQL。"""

    def __init__(self, shapes: Graph, ontology: OntologyModel) -> None:
        self.shapes = shapes
        self.ontology = ontology
        self.prefixes = _prefix_block(shapes, self._used_prefixes())

    def _used_prefixes(self) -> set[str]:
        """形状里出现过的 QName 前缀，加上报告与类型判定必需的几个。

        扫描前必须先抹掉注释、字符串字面量与 IRI（`blank_noncode` 保持长度不变，
        因此不影响其余逻辑）。否则两类合法写法会让编译直接失败：
        - `"T00:00:00"` 里的 `T00` 被当成前缀；
        - `<http://example.org/x>` 里的 `http` 被当成前缀。
        字面量内部的前缀本来也不需要声明——它不参与查询解析。
        """
        used: set[str] = {"sh", "rdf", "rdfs", "xsd"}
        for shape in self.shapes.subjects(RDF.type, SH.NodeShape):
            for node in self.shapes.objects(shape, SH.sparql):
                select = self.shapes.value(node, SH.select)
                if select is not None:
                    used |= {match.group(1) for match in _QNAME_RE.finditer(blank_noncode(str(select)))}
        return used

    def compile(self) -> list[CompiledConstraint]:
        """编译全部具名 NodeShape。匿名形状无法独立定位，直接报错。"""
        compiled: list[CompiledConstraint] = []
        for shape in self.shapes.subjects(RDF.type, SH.NodeShape):
            if isinstance(shape, BNode):
                raise ShapeCompileError("不支持匿名的顶层 NodeShape（无法在报告中定位）")
            compiled.extend(self._compile_shape(shape))
        if not compiled:
            raise ShapeCompileError("形状图中没有任何可编译的约束")
        return compiled

    # ------------------------------ 单个形状 ------------------------------

    def _compile_shape(self, shape: URIRef) -> list[CompiledConstraint]:
        name = _local(shape)
        severity = self._severity(shape)
        target = self._target_pattern(shape, name)
        default_message = str(self.shapes.value(shape, SH.message) or f"{name} 未通过校验")
        out: list[CompiledConstraint] = []

        for node in self.shapes.objects(shape, SH.sparql):
            select = self.shapes.value(node, SH.select)
            if select is None:
                raise ShapeCompileError(f"{name} 的 sh:sparql 缺少 sh:select")
            message = str(self.shapes.value(node, SH.message) or default_message)
            body = str(select).replace("$this", "?this")
            out.append(
                CompiledConstraint(
                    shape=name,
                    severity=self._severity(node, fallback=severity),
                    message=message,
                    query=f"{self.prefixes}\n{_inject_pattern(body, target)}",
                    component="sparql",
                )
            )

        for node in self.shapes.objects(shape, SH.property):
            out.extend(self._compile_property(shape, node, target, default_message, severity, name))

        if not out:
            raise ShapeCompileError(f"{name} 既没有 sh:sparql 也没有可编译的 sh:property 约束")
        return out

    def _compile_property(
        self,
        shape: URIRef,
        node: object,
        target: str,
        default_message: str,
        severity: str,
        shape_name: str,
    ) -> list[CompiledConstraint]:
        """属性形状：把 minCount / maxCount / datatype / sh:in / sh:class 展开成 SPARQL。"""
        path_node = self.shapes.value(node, SH.path)
        if path_node is None:
            raise ShapeCompileError(f"{shape_name} 的 sh:property 缺少 sh:path")
        if not isinstance(path_node, URIRef):
            raise ShapeCompileError(f"{shape_name} 使用了非 IRI 的 sh:path（属性路径暂不支持）")

        predicates = set(self.shapes.predicates(node, None))
        unsupported = {
            predicate for predicate in predicates
            if predicate not in _PROPERTY_COMPONENTS
            and predicate not in {SH.path, SH.message, SH.severity, RDF.type}
        }
        if unsupported:
            names = ", ".join(sorted(_local(item) for item in unsupported))
            raise ShapeCompileError(
                f"{shape_name} 的属性约束含未支持组件：{names}",
                details={"shape": shape_name, "components": sorted(names.split(", "))},
            )

        message = str(self.shapes.value(node, SH.message) or default_message)
        local_severity = self._severity(node, fallback=severity)
        path = f"<{path_node}>"
        path_label = _local(path_node)
        out: list[CompiledConstraint] = []

        def emit(where: str, suffix: str = "", component: str = "") -> None:
            # 目标模式后面必须补一个 `.`：它本身是一条完整的三元组模式，
            # 若紧随其后的又是三元组模式（maxCount / class / in 都是这种），
            # 拼出来会变成 `?this a <C> ?this <p> ?v` —— 两个模式之间没有分隔符，
            # Jena 直接报 Parse error。minCount 恰好以 `OPTIONAL` 开头才侥幸没事。
            query = f"{self.prefixes}\nSELECT ?this WHERE {{ {target} . {where} }}{suffix}"
            out.append(
                CompiledConstraint(
                    shape=shape_name,
                    severity=local_severity,
                    message=message,
                    query=query,
                    path=path_label,
                    component=component or "property",
                )
            )

        min_count = self.shapes.value(node, SH.minCount)
        if min_count is not None:
            emit(
                f"OPTIONAL {{ ?this {path} ?v }}",
                f" GROUP BY ?this HAVING (COUNT(?v) < {int(str(min_count))})",
                "minCount",
            )

        max_count = self.shapes.value(node, SH.maxCount)
        if max_count is not None:
            emit(
                f"?this {path} ?v",
                f" GROUP BY ?this HAVING (COUNT(?v) > {int(str(max_count))})",
                "maxCount",
            )

        datatype = self.shapes.value(node, SH.datatype)
        if datatype is not None:
            emit(
                f"?this {path} ?v . FILTER(datatype(?v) != <{datatype}>)",
                "",
                "datatype",
            )

        allowed = self.shapes.value(node, SH["in"])
        if allowed is not None:
            values = []
            for item in self.shapes.items(allowed):
                if isinstance(item, URIRef):
                    values.append(f"<{item}>")
                else:
                    values.append(f'"{item}"')
            if not values:
                raise ShapeCompileError(f"{shape_name} 的 sh:in 为空列表")
            emit(
                f"?this {path} ?v . FILTER(?v NOT IN ({', '.join(values)}))",
                "",
                "in",
            )

        klass = self.shapes.value(node, SH["class"])
        if klass is not None:
            emit(
                f"?this {path} ?v . FILTER NOT EXISTS {{ ?v a <{klass}> }}",
                "",
                "class",
            )

        return out

    # ------------------------------ 目标与级别 ------------------------------

    def _target_pattern(self, shape: URIRef, name: str) -> str:
        """把目标选择器翻译成绑定 `?this` 的三元组模式。"""
        patterns: list[str] = []
        for predicate, kind in _TARGETS.items():
            for value in self.shapes.objects(shape, predicate):
                if kind == "subjects":
                    patterns.append(f"?this <{value}> ?anyTarget")
                elif kind == "objects":
                    patterns.append(f"?anyTarget <{value}> ?this")
                else:
                    patterns.append(f"?this a <{value}>")
        if not patterns:
            raise ShapeCompileError(f"{name} 缺少目标选择器（targetSubjectsOf/targetObjectsOf/targetClass）")
        if len(patterns) > 1:
            raise ShapeCompileError(f"{name} 声明了多个目标选择器，本编译器要求唯一")
        return patterns[0]

    def _severity(self, node: object, fallback: str = "Violation") -> str:
        value = self.shapes.value(node, SH.severity)
        return _local(value) if value is not None else fallback


def compile_shapes(shapes: Graph, ontology: OntologyModel) -> list[CompiledConstraint]:
    """便捷入口。"""
    return ShapeCompiler(shapes, ontology).compile()


def substitute(message: str, row: dict[str, str]) -> str:
    """把 `{?var}` 占位符替换为查询结果里的值。

    SHACL 的消息模板语法就是 `{?name}` / `{$this}`，这里按同一约定处理，
    未绑定的变量保持原样（便于人看出"这条消息缺了哪个字段"）。
    """
    def replace(match: re.Match[str]) -> str:
        key = match.group(1)
        return str(row.get(key, match.group(0)))

    return re.sub(r"\{[?$](\w+)\}", replace, message)


def iter_components(constraints: Iterable[CompiledConstraint]) -> list[str]:
    """本次参与校验的组件类型，写入报告便于核对覆盖面。"""
    return sorted({item.component for item in constraints})
