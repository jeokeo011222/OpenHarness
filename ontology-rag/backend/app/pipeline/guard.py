"""事实上下文装配：把校验所需的最小事实子图取出来。

为什么不把整库拉进内存：SHACL 校验只需要「断言主语 + 一跳邻居」。
按需取子图既能让算术约束成立，也不会在百万级实例上把服务打爆。
"""

from __future__ import annotations

from typing import Any, Sequence

from rdflib import Graph

from ..sparql_guard import INTERNAL_FORMS, prepare

_CONSTRUCT = """CONSTRUCT { ?seed ?p ?o . ?o ?p2 ?o2 }
WHERE {
  VALUES ?seed { %s }
  ?seed ?p ?o .
  OPTIONAL {
    ?o ?p2 ?o2 .
    FILTER(isIRI(?o))
  }
}"""


async def fetch_context_graph(
    store: Any,
    tenant_graph: str,
    seeds: Sequence[str],
    *,
    timeout: float = 15.0,
    limit: int = 40,
) -> Graph:
    """取断言主语的一跳事实子图。没有主语时返回空图。"""
    unique = list(dict.fromkeys(seed for seed in seeds if seed.startswith(("http://", "https://", "urn:"))))
    if not unique:
        return Graph()
    values = " ".join(f"<{iri}>" for iri in unique[:limit])
    sparql = prepare(_CONSTRUCT % values, tenant_graph, limit * 20, allowed_forms=INTERNAL_FORMS)
    return await store.construct(tenant_graph, sparql, timeout=timeout)
