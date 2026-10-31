"""SPARQL 只读守卫（工具侧硬闸门）。

四道防线，缺一不可。顺序即强度：越靠前越不依赖语义理解。

1. 词法归一：先把注释与字符串字面量整段抹成空格（**保持字符位置不变**），
   后续所有判定都基于"只剩代码"的副本。这样 `FILTER(?x = "delete")`
   不会误伤，而 `#` 注释里藏关键字也躲不过。
2. 形态白名单：剥离前导 PREFIX/BASE 后，首个词必须是白名单内的查询形态。
   工具默认只放行 `SELECT`（CONSTRUCT/ASK/DESCRIBE 留给内部链路）。
3. 单语句：顶层分号多于一个即拒绝。`SELECT ...; DROP ALL` 这类拼接
   在形态白名单下本已进不来，但不允许"一条合法语句 + 一条非法语句"
   这种形态存在，否则每一处新增校验都要重新推演一遍。
4. 数据集强约束：显式 `FROM` / `GRAPH` 只允许指向本租户图；
   没有 `FROM` 的查询一律注入 `FROM <租户图>`。

第 4 条尤其重要：本项目的 Fenix 数据集开启了 `unionDefaultGraph`，
无 `FROM` 时默认图是**所有租户图的并集**。也就是说"不写 FROM"不是
"查得少"，而是"查到别人的数据"。所以注入不是优化，是隔离本身。

另有两个易被忽略的越权面，一并在此关闭：
- `SELECT * { ?s ?p ?o }`（无 WHERE 关键字）：注入点不能只找 WHERE，
  必须退回第一个顶层 `{`，否则整条查询绕过注入。
- 已有 `LIMIT 999999`：旧实现"检测到 LIMIT 就不动"，等于上限可被调用方
  自选。现在改为按顶层深度归一化，超限即改小。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .errors import QueryError

# 工具侧默认只放行 SELECT。需要 CONSTRUCT/DESCRIBE 的场景走内部链路
# （fetch_context_graph 取上下文子图、检索层拼模板），不经由模型可调的工具体。
_DEFAULT_FORMS: tuple[str, ...] = ("select",)

# 内部链路可用的形态。模型看不到这些入口，所以放宽到"只读"而不是"只 SELECT"。
INTERNAL_FORMS: tuple[str, ...] = ("select", "ask", "construct", "describe")

# 更新类与危险关键字。`add`/`move`/`copy` 之所以也在列，
# 是因为它们在 SPARQL Update 里是不带 DELETE 字样的图管理动作。
_FORBIDDEN: tuple[str, ...] = (
    "insert",
    "delete",
    "drop",
    "clear",
    "load",
    "create",
    "add",
    "move",
    "copy",
    "with",
    "into",
    "silent",
    "using",
    "service",
)

_PROLOGUE_RE = re.compile(r"^\s*(?:prefix|base)\s+(?:[A-Za-z_][\w.-]*:\s*)?<[^<>]*>", re.IGNORECASE)
# 就地匹配 IRI：内部不含空白的 `<...>` 才算 IRI，`?a < ?b` 这类比较运算不会误判
_IRI_AT_RE = re.compile(r"<[^<>\"'{}|^`\\\s]*>")
_FROM_RE = re.compile(r"\bFROM\s+(NAMED\s+)?<([^<>]*)>", re.IGNORECASE)
_GRAPH_RE = re.compile(r"\bGRAPH\s*(<[^<>]*>|\?\w+|[A-Za-z_][\w-]*:[^\s{};]*)", re.IGNORECASE)
_WHERE_RE = re.compile(r"\bwhere\b", re.IGNORECASE)
_LIMIT_RE = re.compile(r"\blimit\s+(\d+)", re.IGNORECASE)
_OFFSET_RE = re.compile(r"\boffset\s+\d+", re.IGNORECASE)

# 关键字边界：前面不能是 `?`/`$`（否则 `?add` 这种变量名会被误判为更新关键字）
_KEYWORD_BOUNDARY_BEFORE = r"(?<![\w?$])"


@dataclass(frozen=True, slots=True)
class SparqlPolicy:
    """工具侧查询策略。集中一处，避免每个调用点各写一遍上限。"""

    # 允许的查询形态（小写）。默认只有 select。
    allowed_forms: tuple[str, ...] = _DEFAULT_FORMS
    # 单次返回行数硬上限
    max_rows: int = 500
    # 单次查询耗时上限（秒），由调用方用 asyncio.wait_for 落实
    timeout_seconds: float = 15.0
    # 允许访问的额外图（例如评估脚本需要 scratch 图）；默认空
    extra_graphs: tuple[str, ...] = field(default_factory=tuple)


# --------------------------------------------------------------------------
# 词法
# --------------------------------------------------------------------------


def blank_noncode(sparql: str) -> str:
    """把注释与字符串字面量抹成空格，长度与原文完全一致。

    位置一致是刻意的：后续所有切片（注入点、LIMIT 替换）都基于这份副本
    计算下标，再作用到原文上。若用 `re.sub` 压缩长度，下标就会错位，
    这类 bug 在生产里表现为"偶发把 LIMIT 插进了字符串里"。
    """
    out = list(sparql)
    index = 0
    total = len(sparql)
    while index < total:
        char = sparql[index]
        if char == "#":
            while index < total and sparql[index] != "\n":
                out[index] = " "
                index += 1
        elif char == "<":
            # 本体命名空间普遍带 `#`（如 http://ontorag.local/contract#），
            # 若先判注释就会把 IRI 里的 `#` 之后全部抹掉。必须先识别 IRI。
            iri = _IRI_AT_RE.match(sparql, index)
            index = iri.end() if iri is not None else index + 1
        elif char in {'"', "'"}:
            quote = char * 3 if sparql[index : index + 3] == char * 3 else char
            start = index
            index += len(quote)
            while index < total:
                if sparql[index] == "\\":
                    index += 2
                    continue
                if sparql[index : index + len(quote)] == quote:
                    index += len(quote)
                    break
                index += 1
            for position in range(start, min(index, total)):
                out[position] = " "
        else:
            index += 1
    return "".join(out)


def strip_prologue(sparql: str) -> str:
    """去掉前导 PREFIX / BASE 声明，便于判定真正的查询形态。"""
    text = sparql.lstrip()
    while True:
        match = _PROLOGUE_RE.match(text)
        if match is None:
            return text
        text = text[match.end() :].lstrip()


def sanitize(sparql: str) -> str:
    """兼容旧调用点：返回抹掉注释与字面量后的文本。"""
    return blank_noncode(sparql)


def _depth_map(code: str) -> list[int]:
    """每个字符所处的花括号深度（用于定位顶层 LIMIT / OFFSET）。"""
    depths: list[int] = []
    depth = 0
    for char in code:
        if char == "{":
            depths.append(depth)
            depth += 1
        elif char == "}":
            depth = max(0, depth - 1)
            depths.append(depth)
        else:
            depths.append(depth)
    return depths


def _top_level_positions(code: str, pattern: re.Pattern[str]) -> list[re.Match[str]]:
    """只返回位于花括号深度 0 的匹配。子查询里的 LIMIT 不算数。"""
    depths = _depth_map(code)
    return [
        match
        for match in pattern.finditer(code)
        if match.start() < len(depths) and depths[match.start()] == 0
    ]


def split_statements(sparql: str) -> list[str]:
    """按**顶层**分号切分语句。

    必须看深度：`;` 在 SPARQL 里还是三元组块的谓宾列表分隔符
    （`?s a con:Contract ; con:contractAmount ?a`），一律当语句分隔会
    把任何带列表简写的查询误判成多语句。语句边界只可能出现在花括号之外。
    """
    code = blank_noncode(sparql)
    depths = _depth_map(code)
    parts: list[str] = []
    start = 0
    for index, char in enumerate(code):
        if char == ";" and index < len(depths) and depths[index] == 0:
            parts.append(sparql[start:index])
            start = index + 1
    parts.append(sparql[start:])
    return [part for part in parts if part.strip()]


# --------------------------------------------------------------------------
# 判定
# --------------------------------------------------------------------------


def assert_single_statement(sparql: str) -> str:
    """只允许一条语句。多语句一律拒绝，不做"取第一条"的宽容处理。"""
    statements = split_statements(sparql)
    if len(statements) > 1:
        raise QueryError(
            "禁止一次提交多条 SPARQL 语句",
            details={"statements": len(statements)},
        )
    return sparql


def assert_read_only(sparql: str, allowed_forms: tuple[str, ...] = _DEFAULT_FORMS) -> str:
    """校验查询形态与关键字，返回去掉尾部空白的原文。"""
    text = sparql.strip().rstrip(";").strip()
    if not text:
        raise QueryError("SPARQL 为空")

    body = strip_prologue(text)
    code = blank_noncode(body).lstrip()
    head = code[:16].lower()
    allowed = tuple(form.lower() for form in allowed_forms)
    if not any(re.match(rf"{form}\b", head) for form in allowed):
        raise QueryError(
            f"只允许 {' / '.join(form.upper() for form in allowed)} 查询",
            details={"allowed_forms": list(allowed)},
        )

    lowered = code.lower()
    for keyword in _FORBIDDEN:
        if re.search(rf"{_KEYWORD_BOUNDARY_BEFORE}{keyword}\b", lowered):
            raise QueryError(
                f"SPARQL 含被禁止的关键字：{keyword.upper()}",
                details={"keyword": keyword},
            )
    return text


def assert_tenant_scoped(sparql: str, graph_uri: str) -> None:
    """显式指定的数据集与命名图必须都属于本租户。

    这里不"改写成租户图"，而是**拒绝**。理由：调用方写了别的图，
    说明它对数据范围的预期与租户隔离冲突，静默改写会让它拿到
    一个"看起来查到了、其实查的是别处"的结果。
    """
    code = blank_noncode(sparql)

    for match in _FROM_RE.finditer(code):
        if match.group(1) is not None:
            raise QueryError("禁止使用 FROM NAMED")
        target = match.group(2)
        if target != graph_uri:
            raise QueryError(
                "禁止访问租户图之外的数据集",
                details={"requested": target, "tenant_graph": graph_uri},
            )

    for match in _GRAPH_RE.finditer(code):
        target = match.group(1).strip()
        if not target.startswith("<"):
            # GRAPH ?g / GRAPH ns:name：无法静态确认指向哪张图，直接拒绝。
            # 允许它等于把"能读哪些图"的决定权交还给查询串。
            raise QueryError(
                "GRAPH 子句必须显式写出本租户图 IRI",
                details={"clause": target, "tenant_graph": graph_uri},
            )
        iri = target[1:-1]
        if iri != graph_uri:
            raise QueryError(
                "禁止访问租户图之外的命名图",
                details={"requested": iri, "tenant_graph": graph_uri},
            )


def _injection_point(code: str) -> int:
    """找 FROM 的插入位置：顶层 WHERE 之前，否则第一个顶层 `{` 之前。"""
    where = _top_level_positions(code, _WHERE_RE)
    if where:
        return where[0].start()
    depths = _depth_map(code)
    for index, char in enumerate(code):
        # `{` 记录的深度是外层深度，顶层查询体的 `{` 深度即为 0
        if char == "{" and index < len(depths) and depths[index] == 0:
            return index
    raise QueryError("无法定位查询体，拒绝执行")


def scope_to_tenant(sparql: str, graph_uri: str) -> str:
    """把查询限定到租户图（宽松版：调用方已判过权限时使用）。

    已有 `FROM <...>` 的查询保持原样；其余在查询体之前注入 `FROM <租户图>`。
    适配器层会再调一次做纵深防御，因此这里必须幂等。
    """
    code = blank_noncode(sparql)
    if _FROM_RE.search(code):
        return sparql
    position = _injection_point(code)
    return f"{sparql[:position]}FROM <{graph_uri}> {sparql[position:]}"


def enforce_limit(sparql: str, max_rows: int) -> str:
    """把顶层 LIMIT 归一到上限之内；没有就补一个。

    旧实现"检测到 LIMIT 就跳过"会让 `LIMIT 999999` 直接通过，
    等于行数上限由调用方决定。
    """
    if not strip_prologue(sparql).lstrip().lower().startswith("select"):
        return sparql
    code = blank_noncode(sparql)
    limits = _top_level_positions(code, _LIMIT_RE)
    if not limits:
        return f"{sparql.rstrip()}\nLIMIT {max_rows}"

    limit = limits[-1]
    value = int(limit.group(1))
    if value <= max_rows:
        return sparql
    start, end = limit.span(1)
    return f"{sparql[:start]}{max_rows}{sparql[end:]}"


def prepare(
    sparql: str,
    graph_uri: str,
    max_rows: int | SparqlPolicy = 500,
    *,
    allowed_forms: tuple[str, ...] | None = None,
) -> str:
    """完整预处理：单语句 + 形态白名单 + 租户作用域 + 行数上限。

    顺序不可调换：先判形态（最便宜的拒绝），再判数据集（最危险的越权），
    最后才是 LIMIT（纯资源约束）。
    """
    policy = max_rows if isinstance(max_rows, SparqlPolicy) else None
    limit = policy.max_rows if policy is not None else int(max_rows)
    forms = (
        allowed_forms
        or (policy.allowed_forms if policy is not None else _DEFAULT_FORMS)
    )

    text = assert_read_only(assert_single_statement(sparql), forms)
    assert_tenant_scoped(text, graph_uri)
    return enforce_limit(scope_to_tenant(text, graph_uri), limit)
