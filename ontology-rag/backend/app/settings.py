"""运行期配置。

约束：所有敏感配置与外部地址一律来自环境变量，代码里不出现任何默认密钥。
本地开发用 `.env`，容器部署用 compose 的 env_file。
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# 仓库内 ontology 目录：backend/app/settings.py -> backend/app -> backend -> ontology-rag
PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """服务配置。字段名即环境变量名（大写不敏感）。"""

    model_config = SettingsConfigDict(
        env_file=(PROJECT_ROOT / "backend" / ".env", PROJECT_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    app_name: str = "ontorag"
    environment: Literal["dev", "staging", "prod"] = "dev"
    # memory：进程内实现，本地演示与自动化测试；live：Fuseki（图）+ 检索后端 + 模型
    rag_mode: Literal["memory", "live"] = "memory"

    # ---------------- 检索与存储后端 ----------------
    # pg：PostgreSQL + pgvector 承担分块、关键词、向量（测试阶段默认）
    # es：Elasticsearch 关键词 + Milvus 向量（保留给已有部署）
    # memory：进程内，仅 rag_mode=memory 时生效
    retrieval_backend: Literal["memory", "pg", "es"] = "pg"
    # auto：检索走 pg 时审计也落 pg，否则退回 SQLite
    audit_backend: Literal["auto", "sqlite", "pg"] = "auto"
    # auto：检索走 pg 时租户密钥从库读（首次用 TENANT_KEYS 引导入库），否则读环境变量
    tenant_store: Literal["auto", "env", "db"] = "auto"

    # ---------------- 多租户 ----------------
    # JSON 对象：{"tenant-a": "key-a", "tenant-b": "key-b"}，禁止写进代码
    tenant_keys_json: str = Field(default="", alias="TENANT_KEYS")
    require_auth: bool = True
    # 调试面板（POC 演示）。开启后 /debug 页面与 /v1/debug/* 可用，
    # 会把分块原文、命中理由、SPARQL、闸门明细一并返回。
    # 鉴权仍按租户走，但暴露面明显大于 /v1/query —— 正式环境请置 false。
    debug_panel_enabled: bool = True

    # 运行期接管本体：`POST /v1/admin/ontology/{domain}` 落盘并立即重载。
    # 本体是部署级共享资源，一次发布会改变所有租户的检索行为；正式环境应由
    # 发布流水线控制，接口本身关掉，而不是靠"记得别调用"。
    ontology_publish_enabled: bool = True

    # ---------------- 语料与本体 ----------------
    ontology_dir: Path = PROJECT_ROOT / "ontology"
    seed_dir: Path = PROJECT_ROOT / "data" / "seed"
    audit_db_path: Path = PROJECT_ROOT / "var" / "audit.db"
    pg_schema_path: Path = PROJECT_ROOT / "retrieval" / "pg" / "schema.sql"

    # ---------------- PostgreSQL + pgvector ----------------
    # 关系数据、向量、审计、租户统一落这一个库；图数据仍在 Fuseki
    pg_dsn: str = "postgresql://ontorag:ontorag@localhost:5432/ontorag"
    pg_pool_min: int = 1
    pg_pool_max: int = 8
    pg_connect_timeout: float = 10.0
    # 建表时替换 schema.sql 里的向量维度占位符
    pg_auto_migrate: bool = True

    # ---------------- Fuseki ----------------
    fuseki_url: str = "http://localhost:3030"
    fuseki_dataset: str = "ontorag"
    fuseki_user: str = ""
    fuseki_password: str = ""
    sparql_timeout_seconds: float = 15.0
    # 单次查询可申请的最大耗时；调用方只能调小，不能调大
    sparql_max_timeout_seconds: float = 30.0
    sparql_max_rows: int = 500
    # 面向模型的 SPARQL 工具允许的查询形态（逗号分隔，小写）
    # 收紧到 select 是产品决定：CONSTRUCT/DESCRIBE 会把大段子图塞进上下文，
    # 既贵又容易让模型"看图说话"，绕开证据链。
    sparql_allowed_forms: str = "select"

    # ---------------- SHACL 校验引擎 ----------------
    # auto：live 模式且有图存储时用 fuseki（形状编译成 SPARQL 交给图库），
    #       否则用进程内 pyshacl。显式指定可用于排障与结果比对。
    shacl_backend: Literal["auto", "fuseki", "local"] = "auto"
    shacl_max_rows: int = 1000

    # ---------------- 实体链接 ----------------
    # True：先用 DeepSeek Flash 抽取候选术语，再由词表对齐到 IRI
    # （模型只负责"找出哪些词是业务概念"，不负责决定映射到哪个 IRI）
    entity_link_use_llm: bool = True
    # 提示词里给出的本体词表条目上限，防止超长提示词
    entity_link_vocab_limit: int = 240

    # ---------------- Elasticsearch ----------------
    es_url: str = "http://localhost:9200"
    es_username: str = ""
    es_password: str = ""
    es_index_prefix: str = "ontorag"
    es_timeout_seconds: float = 10.0

    # ---------------- Milvus ----------------
    milvus_uri: str = "http://localhost:19530"
    milvus_token: str = ""
    milvus_collection: str = "ontorag_chunks"
    milvus_dim: int = 1024

    # ---------------- 模型 ----------------
    # auto：有 DEEPSEEK_API_KEY 用真实模型，否则退回确定性生成器
    # offline：不连外部模型，仅用于内网测试/POC（输出只代表管线正确性，不代表模型质量）
    llm_provider: Literal["auto", "deepseek", "offline"] = "auto"
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_api_key: str = ""
    llm_model_flash: str = "deepseek-4.1-flash"
    llm_model_strong: str = "deepseek-reasoner"
    embedding_model: str = "deepseek-embedding"
    embedding_dim: int = 1024
    llm_timeout_seconds: float = 60.0
    llm_max_retries: int = 3

    # ---------------- 成本与熔断 ----------------
    daily_token_budget: int = 2_000_000
    task_token_limit: int = 24_000
    cache_ttl_seconds: int = 900
    cache_max_entries: int = 512
    breaker_failure_threshold: int = 5
    breaker_reset_seconds: float = 30.0

    # ---------------- 检索权重（硬性配比，不允许运行期随意漂移） ----------------
    weight_graph: float = 0.60
    weight_keyword: float = 0.25
    weight_vector: float = 0.15

    # ---------------- 三级检索：窗口、触发门槛与打分参数 ----------------
    # 候选窗口倍数。召回层必须留过滤余量：兼容性过滤一删就凑不满 top_k，
    # 等于把过滤成本转嫁给下游（下游只能要么少给证据、要么放宽过滤）
    retrieval_keyword_window: int = Field(default=3, ge=1, le=10)
    retrieval_vector_window: int = Field(default=3, ge=1, le=10)
    # 向量触发门槛：前两级"条数 ≥ top_k 且 最高分 ≥ 该值"时不跑向量。
    # 0.45 ≈ 一次图谱命中（0.6 权重）的典型得分，即"有实打实的事实支撑"
    retrieval_sufficiency_score: float = Field(default=0.45, ge=0.0, le=1.0)
    # 关键词饱和点 k（x/(x+k) 的 k）。BM25 典型命中落在 3~12，k=6 时命中 6 次得 0.5
    retrieval_keyword_half_saturation: float = Field(default=6.0, gt=0.0)
    # 向量噪声基线：余弦低于该值直接丢弃，不让它稀释候选
    retrieval_vector_floor: float = Field(default=0.30, ge=0.0, lt=1.0)
    # 向量信任折扣（<1）：保证同分情况下向量排在图谱与关键词之后
    retrieval_vector_trust: float = Field(default=0.85, gt=0.0, le=1.0)
    # 本体重合度加成（每命中一个类 +10%，属性按 0.5 计）
    retrieval_ontology_bonus: float = Field(default=0.10, ge=0.0, le=0.5)
    # 交叉验证加分：同一分块被多通道命中时的小额奖励，须远小于单通道权重
    retrieval_cross_validation_bonus: float = Field(default=0.05, ge=0.0, le=0.2)
    # 临期降权：30 天内到期的现行文件降 10%（提示"别当长期依据"，不等于排除）
    retrieval_freshness_window_days: int = Field(default=30, ge=0, le=365)
    retrieval_freshness_penalty: float = Field(default=0.10, ge=0.0, le=0.5)

    @field_validator("tenant_keys_json")
    @classmethod
    def _validate_tenant_json(cls, value: str) -> str:
        if value.strip() == "":
            return ""
        parsed = json.loads(value)
        if not isinstance(parsed, dict) or not all(isinstance(v, str) for v in parsed.values()):
            raise ValueError("TENANT_KEYS 必须是 {tenantId: apiKey} 形式的 JSON 对象")
        return value

    @property
    def tenant_keys(self) -> dict[str, str]:
        """租户 -> API Key 映射。"""
        if not self.tenant_keys_json:
            return {}
        return dict(json.loads(self.tenant_keys_json))

    def require_weight_integrity(self) -> None:
        """权重必须归一：任何改动都要在这里被拦下，避免"悄悄调权重"导致验收失真。"""
        total = self.weight_graph + self.weight_keyword + self.weight_vector
        if abs(total - 1.0) > 1e-6:
            raise ValueError(f"三级检索权重之和必须为 1.0，当前为 {total}")

    # ---------------- 后端解析（避免三处开关各说各话） ----------------
    @property
    def effective_retrieval_backend(self) -> str:
        """memory 模式下无论配什么都不连外部检索组件。"""
        return "memory" if self.rag_mode == "memory" else self.retrieval_backend

    @property
    def effective_audit_backend(self) -> str:
        """审计后端：auto 时与检索后端保持一致。"""
        if self.audit_backend != "auto":
            return self.audit_backend
        return "pg" if self.effective_retrieval_backend == "pg" else "sqlite"

    @property
    def effective_tenant_store(self) -> str:
        """租户密钥来源：auto 时凡是连了 pg 就从库读。"""
        if self.tenant_store != "auto":
            return self.tenant_store
        return "db" if self.effective_retrieval_backend == "pg" else "env"

    @property
    def uses_pg(self) -> bool:
        """是否需要一条 PostgreSQL 连接池。"""
        return self.effective_retrieval_backend == "pg" or self.effective_audit_backend == "pg"

    @property
    def effective_llm_provider(self) -> str:
        """模型来源：auto 时有密钥就走真实模型，否则退回确定性生成器。"""
        if self.llm_provider != "auto":
            return self.llm_provider
        return "deepseek" if self.deepseek_api_key else "offline"

    @property
    def sparql_forms(self) -> tuple[str, ...]:
        """解析成元组；空值或只剩空白时退回 select（收紧而不是放开）。"""
        forms = tuple(item.strip().lower() for item in self.sparql_allowed_forms.split(",") if item.strip())
        return forms or ("select",)

    @property
    def effective_shacl_backend(self) -> str:
        """SHACL 引擎解析：memory 模式没有图存储，只能进程内校验。"""
        if self.shacl_backend != "auto":
            return self.shacl_backend
        return "fuseki" if self.rag_mode == "live" else "local"

    @property
    def embedder_name(self) -> str:
        """向量器身份，写进 `chunk_vector.model`。

        索引期与查询期必须同名，否则向量层会召回另一套空间里的邻居。
        名称单点定义在这里，容器与初始化脚本共用，避免两边各算一次而漂移。
        """
        if self.deepseek_api_key:
            return f"deepseek:{self.embedding_model}"
        return f"hash-bigram:{self.embedding_dim}"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """进程级单例配置。"""
    settings = Settings()
    settings.require_weight_integrity()
    return settings
