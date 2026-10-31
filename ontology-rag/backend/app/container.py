"""依赖装配：按 RAG_MODE 选择 memory 或 live 实现，其余代码完全不变。"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from .adapters.audit import SqliteAuditStore
from .adapters.deepseek import DeepSeekEmbedder, DeepSeekLLM
from .adapters.elasticsearch import ElasticsearchKeywordIndex
from .adapters.fuseki import FusekiGraphStore
from .adapters.memory import (
    HashingEmbedder,
    MemoryChunkRepository,
    MemoryGraphStore,
    MemoryKeywordIndex,
    MemoryVectorIndex,
)
from .adapters.milvus import MilvusVectorIndex
from .adapters.pg import (
    PgAuditStore,
    PgChunkRepository,
    PgKeywordIndex,
    PgPool,
    PgTenantStore,
    PgVectorIndex,
    apply_schema,
)
from .llm import CircuitBreaker, LLMService, ModelRouter, ResponseCache, TokenBudget
from .ontology import (
    EntityLinker,
    HybridEntityLinker,
    OntologyChunker,
    OntologyModel,
    ShaclValidator,
    domain_sources,
    load_ontology,
)
from .pipeline.generator import AnswerGenerator
from .pipeline.intent import QueryParser
from .pipeline.orchestrator import RagPipeline
from .pipeline.retrieval import HybridRetriever
from .schemas import Chunk
from .settings import Settings
from .shacl import build_engine

logger = logging.getLogger("ontorag.container")


@dataclass(slots=True)
class Container:
    """一次进程生命周期内的全部依赖。"""

    settings: Settings
    ontology: Any
    linker: EntityLinker
    entity_linker: HybridEntityLinker
    chunker: OntologyChunker
    validator: ShaclValidator
    graph: Any
    chunks: Any
    keyword: Any
    vector: Any
    embedder: Any
    audit: Any
    parser: QueryParser
    generator: AnswerGenerator
    retriever: HybridRetriever
    pipeline: RagPipeline
    llm_service: LLMService | None = None
    # PostgreSQL 连接池；memory 模式为 None
    pool: PgPool | None = None
    # 租户密钥库；为 None 时回落到 TENANT_KEYS 环境变量
    tenants: PgTenantStore | None = None
    # 实际使用的 SHACL 引擎名（pyshacl / fuseki），进审计与健康检查
    shacl_engine: str = "pyshacl"
    # 按需切换引擎时的缓存（同一引擎复用已编译的形状）
    _alt_validators: dict[str, ShaclValidator] = field(default_factory=dict, repr=False)
    # 本体的加载代次与时间：面板靠它回答"现在跑的是哪一版"
    ontology_generation: int = 0
    ontology_loaded_at: str = ""
    # 域 -> 实际加载的相对路径（runtime 接管会改变它）
    ontology_sources: dict[str, str] = field(default_factory=dict)
    # 发布与检索并发时，重建必须串行，否则读到一半的本体会被换掉
    _reload_lock: Any = field(default_factory=asyncio.Lock, repr=False)

    def _rebuild(self, model: OntologyModel) -> None:
        """按新本体重建全部依赖本体的组件。

        索引与图存储原样复用：换本体不需要重算向量（embedding 只和文本有关），
        需要重建的是词表、类/属性视图、SPARQL 规划器、兼容性判定与闸门。

        @param model - 新加载的本体视图。
        """
        cfg = self.settings
        engine = build_engine(
            cfg.effective_shacl_backend,
            model,
            store=self.graph if isinstance(self.graph, FusekiGraphStore) else None,
            timeout_seconds=cfg.sparql_timeout_seconds,
            max_rows=cfg.shacl_max_rows,
        )
        self.ontology = model
        self.linker = EntityLinker(model)
        self.chunker = OntologyChunker(model)
        self.entity_linker = HybridEntityLinker(model, self.llm_service, vocab_limit=cfg.entity_link_vocab_limit)
        self.validator = ShaclValidator(model, engine)
        self.shacl_engine = engine.name
        self._alt_validators.clear()
        self.parser = QueryParser(model, self.linker, cfg, self.llm_service)
        self.retriever = HybridRetriever(cfg, model, self.graph, self.chunks, self.keyword, self.vector, self.embedder)
        self.generator = AnswerGenerator(cfg, model, self.llm_service)
        self.pipeline = RagPipeline(
            settings=cfg,
            ontology=model,
            parser=self.parser,
            retriever=self.retriever,
            generator=self.generator,
            validator=self.validator,
            audit=self.audit,
            graph_store=self.graph,
        )

    async def reload_ontology(self) -> dict[str, Any]:
        """按磁盘上的本体文件重建组件，供"发布即生效"使用。

        chunk 上索引期落下的类标签不会自动跟着变：新本体改名或删类之后，
        旧标签会被判为不兼容。这是**安全方向**的失败（少召回，而不是混入
        错误证据），但必须让面板看得见，所以代次会随指纹一起返回。

        @returns 新的代次与加载时间。
        """
        async with self._reload_lock:
            model = load_ontology(self.settings.ontology_dir)
            self._rebuild(model)
            self.ontology_generation += 1
            self.ontology_loaded_at = datetime.now().astimezone().isoformat(timespec="seconds")
            self.ontology_sources = {
                domain: str(path.relative_to(self.settings.ontology_dir)).replace("\\", "/")
                for domain, path in domain_sources(self.settings.ontology_dir).items()
            }
            logger.info(
                "本体已重载：代次 %d，域 %s",
                self.ontology_generation,
                ",".join(sorted(self.ontology_sources)) or "<none>",
            )
            return {"generation": self.ontology_generation, "loadedAt": self.ontology_loaded_at}

    def validator_for(self, backend: str | None) -> ShaclValidator:
        """取指定引擎的校验器。

        `None` / `auto` 用服务默认；显式指定 `local` / `fuseki` 时按需构建并缓存。
        允许按请求切换引擎，是为了能对同一批候选三元组做**双引擎比对**——
        结论不一致时以 pyshacl 为准并报警，而不是"谁先跑完听谁的"。
        """
        if backend in (None, "", "auto") or backend == self.shacl_engine:
            return self.validator
        cached = self._alt_validators.get(backend)
        if cached is not None:
            return cached
        engine = build_engine(
            backend,
            self.ontology,
            store=self.graph if isinstance(self.graph, FusekiGraphStore) else None,
            timeout_seconds=self.settings.sparql_timeout_seconds,
            max_rows=self.settings.shacl_max_rows,
        )
        validator = ShaclValidator(self.ontology, engine)
        self._alt_validators[backend] = validator
        return validator

    async def startup(self) -> None:
        """启动期动作：连库、建表、引导租户。

        memory 模式下全部跳过，因此单测与本地演示仍然零外部依赖。
        """
        if self.pool is None:
            return
        await self.pool.open()
        if self.settings.pg_auto_migrate:
            await apply_schema(self.pool, self.settings.pg_schema_path, self.settings.embedding_dim)
            logger.info("pg schema 已就绪（向量维度 %d）", self.settings.embedding_dim)
        if self.tenants is not None:
            seeded = await self.tenants.bootstrap(self.settings.tenant_keys)
            if seeded:
                logger.info("已把 %d 个环境变量租户引导入库", seeded)

    async def aclose(self) -> None:
        """释放可能存在的连接池。"""
        for component in (self.graph, self.keyword, self.embedder, self.pool):
            close = getattr(component, "aclose", None)
            if close is not None:
                await close()


def _load_seed(seed_dir: Path, graph: Any, repository: MemoryChunkRepository) -> None:
    """装载本地种子：{tenant}.ttl 入图，{tenant}.chunks.jsonl 入 chunk 库。"""
    if not seed_dir.exists():
        logger.warning("seed 目录不存在：%s", seed_dir)
        return
    for path in sorted(seed_dir.glob("*.ttl")):
        tenant = path.stem.split(".")[0]
        triples = graph.load_turtle(f"urn:ontorag:tenant:{tenant}:graph", path)
        logger.info("装载租户 %s 实例数据 %d 条三元组", tenant, triples)
    for path in sorted(seed_dir.glob("*.chunks.jsonl")):
        tenant = path.name.split(".")[0]
        chunks: list[Chunk] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            payload = json.loads(line)
            payload.setdefault("tenant_id", tenant)
            chunks.append(Chunk.model_validate(payload))
        repository.put_chunks_sync(chunks)
        logger.info("装载租户 %s 证据分块 %d 条", tenant, len(chunks))


def build_container(settings: Settings | None = None) -> Container:
    """构建依赖图。

    三种组合，其余代码一律不变：
    - `RAG_MODE=memory`：全进程内，单测与本地演示；
    - `RAG_MODE=live` + `RETRIEVAL_BACKEND=pg`：Fuseki + PostgreSQL(pgvector)，测试期部署；
    - `RAG_MODE=live` + `RETRIEVAL_BACKEND=es`：Fuseki + ES + Milvus，保留给已有部署。
    """
    cfg = settings or Settings()
    cfg.require_weight_integrity()
    ontology = load_ontology(cfg.ontology_dir)
    ontology_paths = domain_sources(cfg.ontology_dir)
    linker = EntityLinker(ontology)
    chunker = OntologyChunker(ontology)

    pool: PgPool | None = PgPool(cfg) if cfg.uses_pg else None
    tenants: PgTenantStore | None = None
    if cfg.effective_tenant_store == "db" and pool is not None:
        tenants = PgTenantStore(pool)

    if cfg.effective_audit_backend == "pg" and pool is not None:
        audit: Any = PgAuditStore(cfg, pool)
    else:
        audit = SqliteAuditStore(cfg)

    backend = cfg.effective_retrieval_backend
    # 索引期与查询期必须用同一个向量器，否则向量层召回的是另一套空间里的邻居。
    # 名称写进 chunk_vector.model，查询时按名字过滤：不匹配就返回空，
    # 让 15% 权重缺席（可观测），而不是混入错误邻居（不可观测）。
    embedder_name = cfg.embedder_name

    llm_service: LLMService | None = None
    if cfg.rag_mode == "live":
        graph: Any = FusekiGraphStore(cfg)
        if backend == "pg" and pool is not None:
            repository: Any = PgChunkRepository(pool)
            keyword_index: Any = PgKeywordIndex(cfg, pool)
            vector: Any = PgVectorIndex(cfg, pool, model=embedder_name)
        else:
            keyword_index = ElasticsearchKeywordIndex(cfg)
            repository = keyword_index
            vector = MilvusVectorIndex(cfg, repository)
        embedder: Any = DeepSeekEmbedder(cfg) if cfg.deepseek_api_key else HashingEmbedder(cfg.embedding_dim)
        # 没有密钥时不装配 LLMService：生成器会自动退回确定性实现，
        # 这样内网测试能跑通完整链路（含 SHACL 闸门），但不会伪造模型质量
        if cfg.effective_llm_provider == "deepseek":
            client = DeepSeekLLM(cfg)
            llm_service = LLMService(
                client=client,
                router=ModelRouter(cfg),
                cache=ResponseCache(ttl_seconds=cfg.cache_ttl_seconds, max_entries=cfg.cache_max_entries),
                budget=TokenBudget(cfg, audit),
                breaker=CircuitBreaker(
                    threshold=cfg.breaker_failure_threshold,
                    reset_seconds=cfg.breaker_reset_seconds,
                ),
                settings=cfg,
            )
        else:
            logger.warning("LLM provider=offline：使用确定性生成器，仅供测试与 POC，不代表真实模型质量")
    else:
        graph = MemoryGraphStore()
        repository = MemoryChunkRepository()
        keyword_index = MemoryKeywordIndex(repository)
        embedder = HashingEmbedder(cfg.embedding_dim)
        vector = MemoryVectorIndex(repository, embedder)
        _load_seed(cfg.seed_dir, graph, repository)

    # SHACL 引擎必须在图存储之后装配：fuseki 引擎需要往图库里投递临时图。
    # 校验器本身与引擎解耦，memory 模式拿到的是 pyshacl，行为不变。
    engine = build_engine(
        cfg.effective_shacl_backend,
        ontology,
        store=graph if isinstance(graph, FusekiGraphStore) else None,
        timeout_seconds=cfg.sparql_timeout_seconds,
        max_rows=cfg.shacl_max_rows,
    )
    validator = ShaclValidator(ontology, engine)
    entity_linker = HybridEntityLinker(ontology, llm_service, vocab_limit=cfg.entity_link_vocab_limit)

    logger.info(
        "装配完成：mode=%s retrieval=%s audit=%s tenant_store=%s embedder=%s shacl=%s",
        cfg.rag_mode,
        backend,
        cfg.effective_audit_backend,
        cfg.effective_tenant_store,
        embedder_name,
        engine.name,
    )

    parser = QueryParser(ontology, linker, cfg, llm_service)
    retriever = HybridRetriever(cfg, ontology, graph, repository, keyword_index, vector, embedder)
    generator = AnswerGenerator(cfg, ontology, llm_service)
    pipeline = RagPipeline(
        settings=cfg,
        ontology=ontology,
        parser=parser,
        retriever=retriever,
        generator=generator,
        validator=validator,
        audit=audit,
        graph_store=graph,
    )
    return Container(
        settings=cfg,
        ontology=ontology,
        linker=linker,
        entity_linker=entity_linker,
        chunker=chunker,
        validator=validator,
        shacl_engine=engine.name,
        graph=graph,
        chunks=repository,
        keyword=keyword_index,
        vector=vector,
        embedder=embedder,
        audit=audit,
        parser=parser,
        generator=generator,
        retriever=retriever,
        pipeline=pipeline,
        llm_service=llm_service,
        pool=pool,
        tenants=tenants,
        ontology_loaded_at=datetime.now().astimezone().isoformat(timespec="seconds"),
        ontology_sources={
            domain: str(path.relative_to(cfg.ontology_dir)).replace("\\", "/")
            for domain, path in ontology_paths.items()
        },
    )
