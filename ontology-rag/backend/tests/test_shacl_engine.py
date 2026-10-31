"""双引擎等价性测试：pyshacl 与 Fuseki 必须对同一份数据给出同一组结论。

这条断言的价值在于：闸门的可信度建立在"换个后端结论不变"之上。
一旦两个引擎在某个方向上分叉——尤其是"Jena 漏报、rdflib 报出"这种
漏报方向——同一个业务问题就会因为部署形态不同而得到不同的放行结果，
而这类问题在线上极难被发现，因为它只在特定数据形态下出现。

需要真实 Fuseki 才能跑：设置 `ONTORAG_FUSEKI_URL=http://127.0.0.1:3030`
（以及 `FUSEKI_USER` / `FUSEKI_PASSWORD`）后启用，否则整组跳过。
"""

from __future__ import annotations

import asyncio
import os
import time

import pytest
from rdflib import Graph, Literal, URIRef
from rdflib.namespace import XSD

from app.adapters.fuseki import FusekiGraphStore
from app.container import Container
from app.errors import RetrievalError
from app.ontology.model import CON
from app.shacl.compiler import ShapeCompiler
from app.shacl.engine import FusekiShaclEngine, LocalShaclEngine
from app.ontology.validator import ShaclValidator
from app.settings import Settings

FUSEKI_URL = os.environ.get("ONTORAG_FUSEKI_URL", "")
requires_fuseki = pytest.mark.skipif(not FUSEKI_URL, reason="未配置 ONTORAG_FUSEKI_URL，跳过 Fuseki 引擎对比")

CONTRACT = URIRef("http://ontorag.local/tenant/demo/contract#C-2024-001")
PAYMENT = URIRef("http://ontorag.local/tenant/demo/contract#PAY-1001")


def _settings() -> Settings:
    return Settings(
        fuseki_url=FUSEKI_URL,
        fuseki_user=os.environ.get("FUSEKI_USER", ""),
        fuseki_password=os.environ.get("FUSEKI_PASSWORD", ""),
    )


def _seed_graph(container: Container) -> Graph:
    graph = Graph()
    for triple in container.graph.graph("urn:ontorag:tenant:demo:graph"):
        graph.add(triple)
    return graph


def _rules(report_violations: object) -> list[str]:
    return sorted({item.rule for item in report_violations})  # type: ignore[attr-defined]


@requires_fuseki
@pytest.mark.parametrize(
    "value",
    [
        Literal("0.25", datatype=XSD.decimal),
        Literal("0.25"),
        Literal("不适用"),
    ],
    ids=["typed-decimal", "untyped-string", "non-numeric"],
)
def test_engines_agree_on_literal_typing(container: Container, value: Literal) -> None:
    """未加类型标注的数字字面量曾让两引擎分叉（rdflib 隐式提升 vs Jena 抛错）。

    形状里已统一用 `xsd:decimal()` 强制数值化；这个用例锁住该行为。
    """
    data = _seed_graph(container)
    data.remove((CONTRACT, CON.retentionRate, None))
    data.add((CONTRACT, CON.retentionRate, value))

    settings = _settings()

    async def run() -> tuple[list[str], list[str]]:
        store = FusekiGraphStore(settings)
        try:
            local = ShaclValidator(container.ontology, LocalShaclEngine(container.ontology))
            remote = ShaclValidator(
                container.ontology,
                FusekiShaclEngine(store, container.ontology, timeout_seconds=20.0),
            )
            left = await local.validate_async(data, [])
            right = await remote.validate_async(data, [])
            assert right.engine == "fuseki"
            return _rules(left.violations), _rules(right.violations)
        finally:
            await store.aclose()

    local_rules, remote_rules = asyncio.run(run())
    assert local_rules == remote_rules, f"引擎分叉：pyshacl={local_rules} fuseki={remote_rules}"


@requires_fuseki
def test_engines_agree_on_blocking_violation(container: Container) -> None:
    """阻断型结论（超付说成未超付）在两个引擎上都必须被识别。"""
    data = _seed_graph(container)
    data.add((PAYMENT, CON.paymentVerdict, Literal("within-remaining")))

    settings = _settings()

    async def run() -> tuple[list[str], list[str]]:
        store = FusekiGraphStore(settings)
        try:
            local = ShaclValidator(container.ontology, LocalShaclEngine(container.ontology))
            remote = ShaclValidator(
                container.ontology,
                FusekiShaclEngine(store, container.ontology, timeout_seconds=20.0),
            )
            left = await local.validate_async(data, [])
            right = await remote.validate_async(data, [])
            return _rules(left.violations), _rules(right.violations)
        finally:
            await store.aclose()

    local_rules, remote_rules = asyncio.run(run())
    assert "PaymentVerdictConsistency" in local_rules
    assert local_rules == remote_rules


@requires_fuseki
def test_scratch_graph_is_removed_after_validation(container: Container) -> None:
    """校验用的一次性图必须在 finally 里删掉。

    这条用例覆盖的是"不报错但会持续变脏"的失效：临时图残留不会让任何业务
    请求失败，只会让数据集里的命名图数量随请求量线性增长。此前该清理路径
    失败时只记一条 warning，测试全绿——等于闸门在悄悄漏垃圾。
    """
    data = _seed_graph(container)
    store = FusekiGraphStore(_settings())

    async def run() -> tuple[dict[str, int], list[str]]:
        try:
            engine = FusekiShaclEngine(store, container.ontology, timeout_seconds=20.0)
            before = await store.list_graphs()
            await engine.evaluate(data, container.ontology.claim_shapes)
            after = await store.list_graphs()
            return before, [graph for graph in after if graph not in before]
        finally:
            await store.aclose()

    before, added = asyncio.run(run())
    assert all("scratch" not in graph for graph in added), f"临时图残留：{added}"
    assert before  # 数据集本身不是空的，说明上面的断言不是因为连不上


@requires_fuseki
def test_put_failure_is_reported_with_status(container: Container) -> None:
    """写通道失败必须带状态码上抛，不能退化成一句"调用失败"。

    用错误凭据触发 401：这是确定性失败，必须一次就失败并说明原因
    （重试 6 次才报"调用失败"会把配置错误伪装成网络抖动）。
    """
    data = _seed_graph(container)
    broken = Settings(
        fuseki_url=FUSEKI_URL,
        fuseki_user=os.environ.get("FUSEKI_USER", ""),
        fuseki_password="definitely-wrong-password",
    )
    store = FusekiGraphStore(broken)

    async def run() -> None:
        try:
            engine = FusekiShaclEngine(store, container.ontology, timeout_seconds=20.0)
            await engine.evaluate(data, container.ontology.claim_shapes)
        finally:
            await store.aclose()

    started = time.perf_counter()
    try:
        asyncio.run(run())
    except RetrievalError as error:
        elapsed = time.perf_counter() - started
        assert "401" in str(error), f"错误里必须带状态码：{error}"
        assert error.details.get("status") == 401
        # 401 是确定性失败。若被塞进 6 次退避（0.3+0.6+1.2+2.4+4.8 ≈ 9s），
        # 配置错误就会伪装成网络抖动。留 3 秒余量，足够区分两种行为。
        assert elapsed < 3.0, f"401 被重试了：耗时 {elapsed:.1f}s"
    else:
        pytest.skip("当前 Fuseki 未启用认证，无法用错误凭据构造 401")


def test_compiled_queries_carry_their_own_prefixes(container: Container) -> None:
    """编译产物必须自带 PREFIX：Fuseki 不共享本进程的命名空间绑定。"""
    constraints = ShapeCompiler(container.ontology.claim_shapes, container.ontology).compile()
    assert constraints
    for constraint in constraints:
        assert constraint.query.lstrip().startswith("PREFIX ")
        assert "SELECT" in constraint.query
        # $this 是 SHACL 的焦点变量语法，未替换会让查询在 SPARQL 侧直接语法错误
        assert "$this" not in constraint.query
