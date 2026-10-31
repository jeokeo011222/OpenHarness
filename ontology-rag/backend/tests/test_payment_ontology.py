"""合同付款风控本体包（OWL + SHACL）的交付验收。

这个包是独立可上传的（`ontology/payment/`，不被 `load_ontology` 自动加载），
所以必须有自己的验收，否则"文件能打开"就是唯一的证据。

四条断言对应四类失效，任何一条松掉都会让包看起来还在工作：
1. 词汇缺失——类或关系写漏了，下游约束静默退化为空条件；
2. 形状不可执行——编译出的 SPARQL 语法错误，闸门直接 500 而不是判定；
3. 规则不触发——样例数据造错方向，跑出"全部合规"的假绿；
4. 引擎分叉——换个后端结论就变了，闸门的可信度归零。
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest
from rdflib import Graph, Literal, URIRef
from rdflib.namespace import OWL, RDF
from rdflib.plugins.sparql.parser import parseQuery

from app.adapters.fuseki import FusekiGraphStore
from app.container import Container
from app.shacl.compiler import ShapeCompiler
from app.shacl.engine import FusekiShaclEngine, LocalShaclEngine
from app.settings import PROJECT_ROOT, Settings

PAY = "http://ontorag.local/payment#"
PACKAGE = PROJECT_ROOT / "ontology" / "payment"
INSTANCE = "urn:ontorag:tenant:demo:payment:"

FUSEKI_URL = os.environ.get("ONTORAG_FUSEKI_URL", "")
requires_fuseki = pytest.mark.skipif(
    not FUSEKI_URL, reason="未配置 ONTORAG_FUSEKI_URL，跳过 Fuseki 引擎对比"
)

# 样例里每个案例只应触发它要证明的那条规则。期望集合写死而不是"至少包含"，
# 因为多出来的违规同样是缺陷：噪声会让人不再看报告。
EXPECTED = {
    ("PAY-002", "AppliedAmountWithinRemaining", "Violation"),          # 约束 1：超付
    ("PAY-003", "PaymentApplicationExactlyOneContract", "Violation"),  # 约束 2：0 份合同
    ("PAY-004", "PaymentApplicationExactlyOneContract", "Violation"),  # 约束 2：2 份合同
    ("PAY-005", "ClosedContractAcceptsNoNewApplication", "Violation"),  # 约束 3：关闭后提交
    ("PAY-006", "ClosedContractTimelineUnprovable", "Warning"),        # 约束 3'：时间线缺失
    ("PAY-007", "PaymentApplicationCoreFields", "Violation"),          # 类型兜底
}


@pytest.fixture(scope="module")
def package() -> tuple[Graph, Graph, Graph]:
    """（OWL, 形状, 样例数据）三张图。"""
    return (
        Graph().parse(PACKAGE / "payment_risk.owl.ttl", format="turtle"),
        Graph().parse(PACKAGE / "payment_risk_shapes.ttl", format="turtle"),
        Graph().parse(PACKAGE / "payment_risk_sample.ttl", format="turtle"),
    )


def _key(violation: object) -> tuple[str, str, str]:
    focus = str(violation.focus_node)  # type: ignore[attr-defined]
    return (
        focus.rsplit(":", 1)[-1],
        violation.rule,  # type: ignore[attr-defined]
        violation.severity,  # type: ignore[attr-defined]
    )


# --------------------------------------------------------------------------- 1


def test_ontology_declares_the_requested_vocabulary(package: tuple[Graph, Graph, Graph]) -> None:
    """五个类、四条主关系、状态词表必须齐全。"""
    owl = package[0]

    classes = {str(node) for node in owl.subjects(RDF.type, OWL.Class)}
    for name in ("Project", "Contract", "PaymentApplication", "Invoice", "ChangeOrder"):
        assert PAY + name in classes, f"缺少类 {name}"

    properties = {str(node) for node in owl.subjects(RDF.type, OWL.ObjectProperty)}
    for name in ("hasContract", "belongsToProject", "againstContract", "hasInvoice"):
        assert PAY + name in properties, f"缺少关系 {name}"

    # 状态必须是可引用的个体，不能退化成自由文本
    statuses = {str(node) for node in owl.subjects(RDF.type, URIRef(PAY + "ContractStatus"))}
    assert PAY + "StatusClosed" in statuses

    # 互斥声明缺失时，HermiT 会让"同一实体既是合同又是付款申请"静默通过
    assert list(owl.subjects(RDF.type, OWL.AllDisjointClasses))

    # 约束 2 的 OWL 侧表述：againstContract 至多一份（函数式）
    assert (URIRef(PAY + "againstContract"), RDF.type, OWL.FunctionalProperty) in owl


# --------------------------------------------------------------------------- 2


def test_shapes_compile_and_every_query_is_valid_sparql(
    package: tuple[Graph, Graph, Graph], container: Container
) -> None:
    """编译产物必须能被 SPARQL 解析器接受。

    这条断言来自一个真实缺陷：目标模式与属性模式之间少一个 `.`，
    `?this a <C> ?this <p> ?v` 这种拼法会让 maxCount / class / in 三类约束
    全部生成非法查询。minCount 因为以 OPTIONAL 开头而侥幸逃过，
    于是"部分约束能跑、部分 500"极难被注意到。
    """
    _, shapes, _ = package
    constraints = ShapeCompiler(shapes, container.ontology).compile()
    assert len(constraints) == 17, [f"{c.shape}/{c.component}" for c in constraints]

    for constraint in constraints:
        assert constraint.query.lstrip().startswith("PREFIX "), "编译产物必须自带 PREFIX"
        assert "$this" not in constraint.query, "$this 未替换会让查询在 Fuseki 语法错误"
        parseQuery(constraint.query)  # 语法错误在这里就该炸，而不是等运行期 400

    severities = {c.severity for c in constraints}
    assert severities == {"Violation", "Warning"}, "必须同时存在阻断级与告警级"


# --------------------------------------------------------------------------- 3


def test_sample_data_triggers_exactly_the_expected_rules(
    package: tuple[Graph, Graph, Graph], container: Container
) -> None:
    """样例数据必须精确命中每一条规则，且不产生额外噪声。"""
    _, shapes, data = package

    async def run() -> set[tuple[str, str, str]]:
        violations, _ = await LocalShaclEngine(container.ontology).evaluate(data, shapes)
        return {_key(violation) for violation in violations}

    assert asyncio.run(run()) == EXPECTED


def test_clean_application_is_not_flagged(
    package: tuple[Graph, Graph, Graph], container: Container
) -> None:
    """PAY-001 金额 5000000 ≤ 剩余应付 5500000，必须零违规。

    没有这条，上一条"全部命中"也可能是在无差别报错。
    """
    _, shapes, data = package

    async def run() -> set[str]:
        violations, _ = await LocalShaclEngine(container.ontology).evaluate(data, shapes)
        return {str(v.focus_node) for v in violations}

    assert INSTANCE + "PAY-001" not in asyncio.run(run())


def test_type_gate_catches_what_the_arithmetic_cannot(
    package: tuple[Graph, Graph, Graph], container: Container
) -> None:
    """千分位金额让超付规则整行被丢弃，必须由类型约束兜住。

    PAY-007 的 appliedAmount 是 `"7,000,000.00"`（普通字符串）。
    `xsd:decimal("7,000,000.00")` 在 SPARQL 里是类型错误 → FILTER 求值失败 →
    该行被丢弃 → 超付规则**不会**报出这 700 万。这正是"漏报违规"的方向。
    所以类型约束不是辅助项，而是让算术规则可信的前提。
    """
    _, shapes, data = package

    async def run() -> set[tuple[str, str, str]]:
        violations, _ = await LocalShaclEngine(container.ontology).evaluate(data, shapes)
        return {_key(violation) for violation in violations}

    keys = asyncio.run(run())
    assert ("PAY-007", "PaymentApplicationCoreFields", "Violation") in keys
    assert ("PAY-007", "AppliedAmountWithinRemaining", "Violation") not in keys


def test_closed_contract_rule_is_split_by_evidence(
    package: tuple[Graph, Graph, Graph], container: Container
) -> None:
    """关闭合同的两条规则按证据强度分级，不能合并成一条。"""
    _, shapes, data = package

    async def run() -> dict[str, str]:
        violations, _ = await LocalShaclEngine(container.ontology).evaluate(data, shapes)
        return {str(v.focus_node).rsplit(":", 1)[-1]: v.severity for v in violations}

    severities = asyncio.run(run())
    # 有 closedAt 且提交更晚 → 有证据，阻断
    assert severities.get("PAY-005") == "Violation"
    # 合同已关闭但缺 closedAt → 证据不足，只告警（否则存量数据会淹没真问题）
    assert severities.get("PAY-006") == "Warning"


# --------------------------------------------------------------------------- 4


@requires_fuseki
def test_fuseki_engine_agrees_with_pyshacl(
    package: tuple[Graph, Graph, Graph], container: Container
) -> None:
    """两个引擎对本包必须给出同一组结论。"""
    _, shapes, data = package
    store = FusekiGraphStore(
        Settings(
            fuseki_url=FUSEKI_URL,
            fuseki_user=os.environ.get("FUSEKI_USER", ""),
            fuseki_password=os.environ.get("FUSEKI_PASSWORD", ""),
        )
    )

    async def run() -> tuple[set[tuple[str, str, str]], set[tuple[str, str, str]]]:
        try:
            local, _ = await LocalShaclEngine(container.ontology).evaluate(data, shapes)
            remote, _ = await FusekiShaclEngine(
                store, container.ontology, timeout_seconds=20.0
            ).evaluate(data, shapes)
            return {_key(v) for v in local}, {_key(v) for v in remote}
        finally:
            await store.aclose()

    local_keys, remote_keys = asyncio.run(run())
    assert remote_keys == EXPECTED
    assert local_keys == remote_keys, f"引擎分叉：pyshacl-only={local_keys - remote_keys}"
