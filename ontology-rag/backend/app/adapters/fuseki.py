"""Apache Jena Fuseki 适配器：只读 SPARQL 查询 + 子图导出。"""

from __future__ import annotations

from typing import Any, Sequence

import httpx
from rdflib import Graph

from ..net import internal_client, request_idempotent, request_json, request_text
from ..settings import Settings
from ..sparql_guard import blank_noncode, scope_to_tenant


class FusekiGraphStore:
    """通过 SPARQL 1.1 Protocol 访问 Fuseki 数据集。"""

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        # 直连内网图库，不吃 HTTP_PROXY：见 net.internal_client 的说明
        self._client = client or internal_client(
            timeout=settings.sparql_timeout_seconds,
            auth=(settings.fuseki_user, settings.fuseki_password) if settings.fuseki_user else None,
        )
        self._query_url = f"{settings.fuseki_url.rstrip('/')}/{settings.fuseki_dataset}/query"
        # Graph Store Protocol：SHACL 引擎用它投递待校验的临时图
        self._data_url = f"{settings.fuseki_url.rstrip('/')}/{settings.fuseki_dataset}/data"

    async def select(
        self, tenant_graph: str, sparql: str, *, timeout: float = 15.0, max_rows: int = 500
    ) -> list[dict[str, Any]]:
        """执行 SELECT，返回行字典列表。"""
        sparql = scope_to_tenant(sparql, tenant_graph)
        payload = await request_json(
            self._client,
            "POST",
            self._query_url,
            data={"query": sparql},
            headers={"Accept": "application/sparql-results+json"},
            timeout=timeout,
            retries=self.settings.llm_max_retries,
        )
        bindings = payload.get("results", {}).get("bindings", [])
        rows: list[dict[str, Any]] = []
        for binding in bindings[:max_rows]:
            rows.append({key: value.get("value") for key, value in binding.items()})
        return rows

    async def construct(self, tenant_graph: str, sparql: str, *, timeout: float = 15.0) -> Graph:
        """执行 CONSTRUCT 并解析为 rdflib Graph。"""
        sparql = scope_to_tenant(sparql, tenant_graph)
        text = await request_text(
            self._client,
            "POST",
            self._query_url,
            data={"query": sparql},
            headers={"Accept": "text/turtle"},
            timeout=timeout,
            retries=self.settings.llm_max_retries,
        )
        graph = Graph()
        graph.parse(data=text, format="turtle")
        return graph

    async def aclose(self) -> None:
        """释放连接池。"""
        await self._client.aclose()

    # ---------------------- 数据集级查询（SHACL 引擎用） ----------------------

    async def select_dataset(
        self,
        default_graphs: Sequence[str],
        sparql: str,
        *,
        timeout: float = 15.0,
        max_rows: int = 500,
    ) -> list[dict[str, Any]]:
        """在**显式指定**的数据集上执行 SELECT。

        与 `select()` 的区别：这里不注入租户图，由调用方决定数据集。
        只有校验引擎这种"数据集本身就是临时图"的场景可以用，
        面向模型的工具路径必须走 `select()`，否则等于绕过租户隔离。
        """
        if not default_graphs:
            raise ValueError("select_dataset 需要至少一个默认图")
        if " from " not in f" {blank_noncode(sparql).lower()} ":
            froms = " ".join(f"FROM <{graph}>" for graph in default_graphs)
            lowered = blank_noncode(sparql)
            anchor = lowered.lower().find("where")
            if anchor < 0:
                anchor = lowered.find("{")
            if anchor < 0:
                raise ValueError("无法定位查询体")
            sparql = f"{sparql[:anchor]}{froms} {sparql[anchor:]}"

        payload = await request_json(
            self._client,
            "POST",
            self._query_url,
            data={"query": sparql},
            headers={"Accept": "application/sparql-results+json"},
            timeout=timeout,
            retries=1,
        )
        bindings = payload.get("results", {}).get("bindings", [])
        rows: list[dict[str, Any]] = []
        for binding in bindings[:max_rows]:
            rows.append({key: value.get("value") for key, value in binding.items()})
        return rows

    async def list_graphs(self, *, timeout: float = 15.0) -> dict[str, int]:
        """列出数据集内所有命名图及三元组数。

        存在的理由只有一个：**确认临时图没有残留**。SHACL 引擎每次校验都会
        建一张 `urn:ontorag:scratch:*` 图，清理在 finally 里做；一旦清理漏掉，
        数据集会被垃圾图持续膨胀，而且这种膨胀不会触发任何业务报错。
        把这个查询做成公共方法，运维与测试才能用同一段代码检查同一件事。
        """
        payload = await request_json(
            self._client,
            "POST",
            self._query_url,
            data={"query": "SELECT ?g (COUNT(*) AS ?n) { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g"},
            headers={"Accept": "application/sparql-results+json"},
            timeout=timeout,
            retries=1,
        )
        graphs: dict[str, int] = {}
        for binding in payload.get("results", {}).get("bindings", []):
            graphs[binding["g"]["value"]] = int(binding["n"]["value"])
        return graphs

    async def put_graph(self, graph_uri: str, data: Graph, *, timeout: float = 15.0) -> None:
        """用 GSP PUT 覆盖写入一张命名图（校验用的临时图）。

        PUT 整图覆盖是幂等的，因此允许重试——TDB2 单写者，
        并发校验时偶发 5xx，不重试就会表现为"校验时好时坏"。
        """
        await request_idempotent(
            self._client,
            "PUT",
            self._data_url,
            params={"graph": graph_uri},
            content=data.serialize(format="turtle"),
            headers={"Content-Type": "text/turtle"},
            timeout=timeout,
            retries=6,
            base_delay=0.3,
        )

    async def delete_graph(self, graph_uri: str, *, timeout: float = 15.0) -> None:
        """删除命名图。临时图必须在 finally 里清掉，否则会污染数据集。

        图本来就不存在（404）也算成功：清理路径不该因为"已经干净了"而报错。
        重试预算与 `put_graph` 对齐——清理走的是同一条单写者写通道，
        预算更小就会在写入压力大时持续漏掉临时图。
        """
        await request_idempotent(
            self._client,
            "DELETE",
            self._data_url,
            params={"graph": graph_uri},
            timeout=timeout,
            retries=6,
            base_delay=0.3,
        )
