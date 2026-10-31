-- ---------------------------------------------------------------------------
-- OntoRAG 关系库 + 向量库统一 schema（PostgreSQL 16 + pgvector）
--
-- 落位说明：
--   1. app_tenant        租户与密钥（原 TENANT_KEYS 环境变量，测试期入库）
--   2. ontology_chunk    本体感知分块主数据（原 memory 仓库 / ES 文档）
--   3. chunk_vector      分块向量（原 Milvus collection）
--   4. audit_run         全链路审计（原 SQLite audit.db）
--
-- 图数据不在本库：RDF 实例仍由 Fuseki 承载，按 urn:ontorag:tenant:{id}:graph 隔离。
--
-- 维度占位符 __EMBEDDING_DIM__ 由 scripts/init_pg.py 在应用前替换：
-- pgvector 的列维度必须在 DDL 期固定，无法参数化。
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- 1. 租户
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_tenant (
    tenant_id     TEXT PRIMARY KEY,
    -- 只存 HMAC 摘要，不存明文密钥；校验时重算比对
    api_key_hash  TEXT NOT NULL,
    display_name  TEXT NOT NULL DEFAULT '',
    -- active | disabled：disabled 直接拒绝鉴权，不改数据
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. 分块主数据
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ontology_chunk (
    tenant_id       TEXT NOT NULL,
    chunk_id        TEXT NOT NULL,
    doc_id          TEXT NOT NULL,
    doc_title       TEXT NOT NULL,
    -- regulation | contract | ledger | standard | archive
    doc_type        TEXT NOT NULL,
    clause_no       TEXT NOT NULL DEFAULT '',
    body            TEXT NOT NULL,
    classes         TEXT[] NOT NULL DEFAULT '{}',
    properties      TEXT[] NOT NULL DEFAULT '{}',
    priority        INTEGER NOT NULL DEFAULT 30,
    effective_from  DATE,
    effective_to    DATE,
    version         TEXT NOT NULL DEFAULT 'v1',
    deprecated      BOOLEAN NOT NULL DEFAULT FALSE,
    -- 中文按二元组切好后写进 tsvector：pg 内置分词器不切中文，
    -- 这一步是让关键词层在中文语料上真正可用的前提，不是优化项。
    token_doc       TSVECTOR NOT NULL DEFAULT ''::tsvector,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_chunk_token ON ontology_chunk USING GIN (token_doc);
CREATE INDEX IF NOT EXISTS idx_chunk_tenant_scope ON ontology_chunk (tenant_id, doc_type, priority);
CREATE INDEX IF NOT EXISTS idx_chunk_classes ON ontology_chunk USING GIN (classes);
CREATE INDEX IF NOT EXISTS idx_chunk_properties ON ontology_chunk USING GIN (properties);
CREATE INDEX IF NOT EXISTS idx_chunk_doc ON ontology_chunk (tenant_id, doc_id);

-- ---------------------------------------------------------------------------
-- 3. 向量
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chunk_vector (
    tenant_id   TEXT NOT NULL,
    chunk_id    TEXT NOT NULL,
    embedding   vector(__EMBEDDING_DIM__) NOT NULL,
    -- 记录向量来源，避免哈希演示向量和真实 embedding 混库后无法追溯
    model       TEXT NOT NULL DEFAULT '',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, chunk_id),
    FOREIGN KEY (tenant_id, chunk_id)
        REFERENCES ontology_chunk (tenant_id, chunk_id) ON DELETE CASCADE
);

-- HNSW 建索引慢但查询快，测试期数据量小；生产按行数切 IVFFlat 更划算
CREATE INDEX IF NOT EXISTS idx_vector_cosine
    ON chunk_vector USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- 4. 审计
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_run (
    trace_id           TEXT PRIMARY KEY,
    tenant_id          TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    question           TEXT NOT NULL DEFAULT '',
    -- 意图、召回清单、校验报告按 jsonb 存：既能原样回放，也能直接查字段
    intent             JSONB,
    recall             JSONB,
    sparql             TEXT,
    prompt             TEXT,
    llm_output         TEXT,
    answer             TEXT,
    prompt_tokens      INTEGER NOT NULL DEFAULT 0,
    completion_tokens  INTEGER NOT NULL DEFAULT 0,
    model              TEXT,
    guard_ok           BOOLEAN NOT NULL DEFAULT FALSE,
    guard_json         JSONB,
    blocked            BOOLEAN NOT NULL DEFAULT FALSE,
    latency_ms         INTEGER NOT NULL DEFAULT 0,
    error              TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_run (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_guard ON audit_run (tenant_id, guard_ok);
CREATE INDEX IF NOT EXISTS idx_audit_blocked ON audit_run (tenant_id, blocked);
