# 本体制导 RAG（基于 DeepSeek Harness）

[English](README.md) | 中文

## 概述

OntoRAG 先看本体再看向量：用户问题先被本体解析器拆成实体、属性、关系与业务约束，再走三级加权召回（图谱 0.60 > 精准原文 0.25 > 向量 0.15），每一条候选结论在返回给用户之前必须重新通过 SHACL 规则引擎校验。校验不通过即阻断返回，改为输出冲突三元组、冲突规则与证据原文。本仓库是在 DeepSeek Harness 上的二次开发：FastAPI 服务承载语义栈，TypeScript 插件把语义栈接进 Harness 的工具体系与 agent 生命周期。当前测试阶段的部署形态是：图数据在 Fuseki，其余全部（分块、向量、审计、租户）落在同一个启用 pgvector 的 PostgreSQL 16 库里。

> **运行时已迁移。** 本目录的 FastAPI 服务不再随产品交付：检索、本体兼容性过滤、SHACL 闸门与溯源链已在
> `packages/context/ontology-injector` 内用 TypeScript + oxigraph 重新实现，客户端只需要 Node，
> 不需要 Python 解释器、Fuseki 或 JVM。此处的 Python 实现保留为**参考实现与离线评测基准**
> （十二题问答集、指标定义、pg/Fuseki 适配器），用于对照新实现的口径，不参与运行时；
> 原来的 `/debug` 演示站也由本体中心的「检索验证」页签取代。

## 目录

- [设计](#design)
- [仓库结构](#layout)
- [部署](#deploy)
- [存储与迁移](#storage)
- [请求生命周期](#lifecycle)
- [本体建模指南](#ontology)
- [Harness 集成](#harness)
- [文档解析与分块](#ingest)
- [POC 演示流程](#poc)
- [准确率评估](#eval)
- [验收指标](#acceptance)
- [已知限制](#limits)

-----

<a id="design"></a>
## 设计

### 三级检索，权重固定

权重不按问题动态调整，也不参与训练；启动时由 `require_weight_integrity()` 断言校验，配置写错会直接启动失败，而不是悄悄退化成一次纯向量检索。

| 层级 | 存储 | 权重 | 何时执行 |
| 本体图谱 | Fuseki SPARQL | 0.60 | 结构化查询有实体空间时 |
| 精准原文 | PostgreSQL tsvector（ES 部署下为 BM25） | 0.25 | 查询有文本时 |
| 向量 | pgvector HNSW 余弦（Milvus） | 0.15 | 仅当前两级召回不足时 |

顺序是架构约束，不是性能优化。图谱层先用业务约束把候选空间压到"与本题相关的对象"，关键词与向量只在这个空间之外补全。反过来做也能跑通，但脏召回在那一刻就已经发生，过滤只能事后掩盖。

`app/retrieval/` 按"一个判断只有一个归属地"拆分：

| 模块 | 负责 |
| `contract.py` | 输入契约：实体、约束、时间范围 |
| `constraints.py` | 约束 → 目标类 + 待投影属性 |
| `planner.py` | 结构化查询 → 只读 `SELECT` |
| `compat.py` | 本体兼容性判定 |
| `scoring.py` | 全部数值因子 |
| `service.py` | 三通道编排、触发门槛、过滤、排序 |

向量层是**判定**而不是默认动作。`_need_vector` 要求同时满足"条数够"与"最高分够"，判定理由原样写进 `RecallStats.tier_decisions`（`skipped:sufficient:count=5,best=0.538`、`insufficient-count:3/5`、`insufficient-score:0.31<0.45`）。"没跑"必须能和"忘了跑"区分开。

### 打分口径，以及每个因子为什么存在

| 因子 | 形式 | 理由 |
| 图谱路径 | `0.7 × 路径强度 + 0.3 × 事实完整度` | 离实体两跳的证据弱于一跳；缺少一半约束属性的实体，支撑不起算术结论 |
| 关键词 | `0.65 × x/(x+6) + 0.35 × 词覆盖率` | BM25 与 `ts_rank_cd` 量纲不同；`x/max` 会被单个离群值压平，饱和曲线不会 |
| 向量 | `(cos − 0.30)/(1 − 0.30) × 0.85` | 0.30 以下是噪声；折扣保证同分时向量永远排在图谱之后 |
| 融合 | `Σ w_t·s_t + 0.05·(通道数−1)` | 独立通道互相印证值一点分，但必须小于任一单通道权重 |
| 本体 | `1 + 0.10 × min(重合度, 3)` | 封顶，避免长分块靠标签堆叠反超 |
| 文档 | 优先级表 × 临期降权 | 只在最后乘一次 |

文档优先级只在 `finalize` 里乘一次。在通道内也乘一遍的话，低优先级条款会因为同一个属性被罚两次——这是融合排序最常见的失真来源。关键词层的优先级只做同分裁决，防止 `top_k` 窗口把同分的现行制度挤掉。

### 本体优先，向量兜底

检索器先收窄再打分。`pre_retrieval_hook` 产出的 `QueryIntent` 携带 `ontology_classes` 与 `ontology_properties`，关键词索引与向量索引都按这些标签做过滤，因此域外 chunk 是在存储层被拒绝，而不是在排序层被降权。当问题中出现业务编号（`C-2024-001`、`PAY-1001`）时，只有能顺着图挂到该编号上的实体才留下——文本匹配会漏，因为付款单的 IRI 里并不含它所属的合同编号。

召回之后，`OntologyCompatibility` 是"这个分块能不能回答这个问题"的唯一裁决点：类比较走 `rdfs:subClassOf` 闭包（公共根类如 `top:Entity` 不算，否则所有分块都会通过），属性等价走 `subPropertyOf` 与 `owl:inverseOf`，只打了属性标签的分块用 `rdfs:domain` 搭桥。图谱命中豁免判定——事实链已经证明了它与问题的关系，回答付款问题时命中的发票条款是交叉证据而不是噪声。每条结论都带机器可读的理由（`class-hierarchy:ContractClause~Clause`），被丢弃的分块事后可以解释。效果是可度量的：评估集报告的脏召回率为 0.00%，脏召回率的定义是被本体剔除的候选占进入融合候选的比例。

### 闸门不可关闭

裸模型输出不会被返回。生成器必须输出 JSON 形式的主张集（claim set），因为自由文本无法被 SHACL 校验、也就无法被拦截；模型回包不是合法 JSON 时直接抛 `OntologyGuardError`，请求 fail-closed。主张集随后被校验两次：结构校验（未知谓词、主词未解析、宾词悬空）与语义校验（对照 `claim_shapes.ttl` 中的输出闸门形状）。两套 shape 是刻意分开的——`contract_shapes.ttl` 与 `carbon_shapes.ttl` 管的是已存数据的质量，`claim_shapes.ttl` 管的是系统说出来的结论。合并成一套会让系统无法回答那些"数据本身合规性存疑但确有其事"的问题。

<a id="layout"></a>
## 仓库结构

```text
ontology-rag/
├── backend/
│   ├── app/
│   │   ├── adapters/          # memory, Fuseki, PostgreSQL+pgvector, Elasticsearch, Milvus, DeepSeek, SQLite
│   │   ├── api/routers/       # query, hooks, tools, admin, health, debug
│   │   ├── ingest/            # PDF and Word parsing, triple extraction
│   │   ├── ontology/          # model loader, entity linker, chunker, SHACL validator
│   │   ├── pipeline/          # intent, retrieval adapter, generator, guard, orchestrator
│   │   ├── retrieval/         # contract, constraints, planner, compat, scoring, service
│   │   ├── evaluation/        # metric kernel (judging, dirty recall) + report/CSV rendering
│   │   ├── compat.py          # event-loop shim for psycopg on Windows
│   │   ├── container.py       # dependency wiring for every backend combination
│   │   ├── ports.py           # Protocol contracts every adapter satisfies
│   │   ├── settings.py        # env-driven configuration
│   │   └── sparql_guard.py    # read-only enforcement and tenant graph scoping
│   ├── tests/                 # 40 unit cases + 9 PostgreSQL integration cases
│   ├── serve.py               # launcher: sets the loop policy before uvicorn
│   └── Dockerfile
├── ontology/
│   ├── top/top_core.ttl
│   ├── domain/domain_contract.owl
│   ├── domain/domain_carbon.ttl
│   ├── vocab/synonyms.ttl
│   └── shacl/claim_shapes.ttl
├── data/seed/                 # demo and other tenant instance graphs plus chunk JSONL
├── retrieval/pg/schema.sql
├── retrieval/es/chunks.mapping.json
├── config/mysql_mapping.json
├── deploy/fuseki/ontorag.ttl
├── scripts/                   # init_pg, migrate_to_pg, ingest_documents, mysql_to_rdf, init_retrieval, eval_accuracy
├── tests/eval/qa_set.jsonl
├── harness-plugin/            # TypeScript bridge plugin for DeepSeek Harness
├── docker-compose.yml
└── .env.example
```

<a id="deploy"></a>
## 部署

### 方式 A：内存模式，零外部依赖

`RAG_MODE=memory` 用进程内适配器跑完全相同的流水线：真实的 rdflib SPARQL 引擎、真实的 BM25、真实余弦相似度（确定性哈希向量）与真实的 pyshacl 闸门，只有存储是进程内的。单元测试集跑在这个模式上，既不需要 Docker 也不需要模型密钥。

```bash
cd ontology-rag/backend
python -m venv .venv && ./.venv/Scripts/python.exe -m pip install -r requirements.txt
./.venv/Scripts/python.exe -m pytest -q
./.venv/Scripts/python.exe serve.py
```

### 方式 B：完整技术栈

Compose 拉起三个容器：承载图数据的 TDB2 Fuseki、承载其余一切并启用 pgvector 的 PostgreSQL 16，以及最上层后端。后端等待的是服务健康状态，而不是容器已启动。Elasticsearch、etcd、MinIO、Milvus 仍在编排里，但被收进 `es` profile，只有显式指定才会启动。

```bash
cd ontology-rag
cp .env.example .env    # fill TENANT_KEYS, PG_PASSWORD and DEEPSEEK_API_KEY; never commit .env
docker compose up -d --build
docker compose logs -f backend
```

服务健康后，初始化 PostgreSQL、把租户图导入 Fuseki，并按需同步业务库。

```bash
docker compose exec backend python /srv/scripts/init_pg.py --tenant demo --recreate
curl -u admin:change-me-fuseki -X PUT \
  'http://localhost:3030/ontorag/data?graph=urn:ontorag:tenant:demo:graph' \
  -H 'Content-Type: text/turtle' --data-binary @data/seed/demo.ttl
docker compose exec backend python /srv/scripts/migrate_to_pg.py
```

### 必需环境变量

所有密钥靠注入，绝不烘进镜像。

```dotenv
RAG_MODE=live
RETRIEVAL_BACKEND=pg
AUDIT_BACKEND=auto
TENANT_STORE=auto
TENANT_KEYS={"demo": "replace-with-a-random-key"}
PG_DSN=postgresql://ontorag:change-me-pg@postgres:5432/ontorag
FUSEKI_URL=http://fuseki:3030
DEEPSEEK_API_KEY=
WEIGHT_GRAPH=0.60
WEIGHT_KEYWORD=0.25
WEIGHT_VECTOR=0.15
DAILY_TOKEN_BUDGET=2000000
TASK_TOKEN_LIMIT=24000
```

有一个环境陷阱值得点名。若宿主机导出了 `HTTP_PROXY` / `HTTPS_PROXY`（终端安全软件或平台工具注入这两个变量很常见），默认配置的 `httpx` 客户端会把连 `http://fuseki:3030` 的请求也塞进代理；代理到不了内网图库，只会回 `502`，于是故障表现为"校验在我机器上好好的，换台机器就时好时坏"。因此图库与关键词适配器都用 `trust_env=False` 构造客户端：内网依赖一律直连。大模型网关则保留 `trust_env`，因为经代理出网可能正是部署方的意图。

### 健康检查

`/healthz` 汇报存活状态与已加载的 shape 数量；`/readyz` 探的是真正的存储后端——有连接池就 ping PostgreSQL，没有就检查 SQLite 文件——因此半启动的技术栈不会被路由到。

```bash
curl -s http://127.0.0.1:8000/healthz
curl -s http://127.0.0.1:8000/readyz
```

<a id="storage"></a>
## 存储与迁移

一个库里放四样东西，图数据刻意留在库外。RDF 归 Fuseki，因为 SPARQL 是本产品的主访问路径；把三元组塞回关系表等于重写一遍本体赖以存在的查询引擎。

| 表 | 存什么 | 取代了谁 |
| `app_tenant` | 租户 id 与 HMAC 摘要后的 API Key | `TENANT_KEYS` 环境变量 |
| `ontology_chunk` | 分块正文、本体标签、tsvector 索引 | 内存仓库、ES 文档 |
| `chunk_vector` | 向量，以及产生它的向量器名称 | Milvus 集合 |
| `audit_run` | 全链路审计行，载荷用 jsonb | SQLite `audit.db` |

schema 里有三处是承重的，不是装饰。中文在进 `to_tsvector('simple', ...)` 之前先切成二元组，因为内置分词器不切中文，否则一条条款只会留下一个词元。`chunk_vector.embedding` 声明成 `vector(1024)` 并靠迁移期替换占位符，因为 pgvector 的列维度无法参数化。`chunk_vector.model` 记录每行的向量器，于是换模型后的查询向量召回为空，而不是返回另一个向量空间里的邻居。

```bash
python scripts/init_pg.py --tenant demo --tenant other --recreate
python scripts/migrate_to_pg.py --dry-run
python scripts/migrate_to_pg.py
```

<a id="lifecycle"></a>
## 请求生命周期

下列步骤全部强制，顺序不可变更；编排器在每一条退出路径（包括被阻断的路径）都落一条审计记录。

1. 客户端携带 `X-Tenant-Id` 与 `X-Api-Key` 调用 `POST /v1/query`；租户依赖以常数时间比对租户表里的密钥摘要，并解析出租户图 IRI。
2. 本体解析器抽取实体、属性、关系与业务约束，并通过 SKOS 同义词库做术语归一；未解析的表面词仅在短查询时退化为模糊匹配。
3. 路由执行三级加权混合召回，返回候选与逐层 trace。
4. 召回后过滤按当前意图的本体约束校验每个 chunk 的兼容性，丢弃不兼容者并计入脏召回。
5. 结果按文档优先级排序：现行法规、现行合同或台账、国家标准、历史资料；过期与被替代文档被过滤或降权。
6. 生成器产出 JSON 主张集与引用，按任务形态路由到 flash 模型或更强模型。
7. SHACL 引擎对照 `claim_shapes.ttl` 并拉取上下文图完成校验。
8. 校验失败时请求返回 422，附冲突三元组、冲突规则与证据；任何内容都不会作为答案返回给用户。
9. 校验通过时响应携带答案、原文引用、SPARQL 推理路径与 trace id，并持久化完整审计记录。

<a id="ontology"></a>
## 本体建模指南

### 三层本体

- 顶层（`ontology/top/top_core.ttl`）：人、组织、项目、文档、条款、金额、时间区间、法规——所有域共享的词汇。
- 领域层（`ontology/domain/*.owl`、`*.ttl`）：合同风控子本体与碳核算子本体，各自随带 SHACL 形状。后续新增工程计量子本体是加第三个目录，而不是改前两个。
- 实例层（`data/seed/*.ttl`，生产中是各租户图）：每个租户从同一套领域模板获得自己的命名图 `urn:ontorag:tenant:{id}:graph`。

### 两套 shape

- 数据质量 shape 管已存数据。`con:PaymentWithinRemaining` 重算 `amount × (1 − retention) − paid` 并标记超付申请；`car:EmissionSourceSingleBoundary` 按排放源分组，标记被一个以上互斥边界同时认领的源。
- 输出闸门 shape 管系统说法。`con:PaymentVerdictConsistency` 在金额超过剩余可付时拒绝 `within-remaining` 结论，`car:EmissionClaimConsistency` 用活动数据、排放因子与 GWP 重算每一个被主张的排放量。

### 新增一个领域

1. 写领域本体，并给业务真正会说出口的每个类与属性加 `skos:altLabel`；同义词库是实体链接的唯一事实来源。
2. 用 `sh:targetSubjectsOf` 与 `sh:sparql` 写数据质量 shape，`sh:prefixes` 指向本体图，确保前缀名能解析。
3. 为每个结论属性写输出闸门 shape，并强制要求 `doc:basedOnChunk`，使无证据结论无法通过。
4. 在 `app/ontology/model.py` 注册前缀，在加载器注册 shape 文件；两个 shape 图都会与本体图合并，以便前缀解析。
5. 在 `app/retrieval/constraints.py` 登记该约束（目标类 + 需要投影的属性），并在 `tests/eval/qa_set.jsonl` 至少增加两个评估用例——一个必须通过，一个必须被阻断。不需要再写查询模板：`SparqlPlanner` 会从结构化查询推导 `SELECT`，新约束不碰 SPARQL 就能被检索到。

<a id="harness"></a>
## Harness 集成

### 工具

插件通过 `ctx.inject(['tools'], ...)` 注册进 Harness 工具体系。每次调用都带 `X-Tenant-Id` 与 `X-Api-Key`，并由 `tools.guard` 在租户或密钥缺失、或工具不在 `enabledTools` 里时拒绝全部四个工具。guard 只有"拒绝"没有"放行"，所以监听器顺序无法把拒绝改成允许。

`fuseki_sparql_query` —— 查事实。

- 只接受 `SELECT`（`SPARQL_ALLOWED_FORMS=select`）。`INSERT / DELETE / LOAD / DROP / …` 按关键字拒绝；以 `;` 拼接的第二条语句按形态违规拒绝，而不是"取第一条执行"。
- `FROM` / `GRAPH` 只能指向本租户图。`GRAPH ?g` 一律拒绝——它指向哪张图无法静态判定。
- 每条查询都会注入 `FROM <urn:ontorag:tenant:{id}:graph>`。数据集开启了 `tdb2:unionDefaultGraph`，不注入的查询读到的是所有租户三元组的并集，所以注入本身就是隔离，不是优化。
- 已有的 `LIMIT` 会被改写为不超过上限；超限的 LIMIT 是调用方给自己留的后门，不是偏好。
- 耗时在两侧同时收紧，调用方只能调小。超时返回 400 而不是空结果页——空结果页会被读成"没有这类记录"，进而催生一个编造的否定结论。

`shacl_validate` —— 验结论。

- 接收候选三元组，并入租户事实后执行结论形状。
- 结果按 `sh:severity` 分流：`Violation` 令 `blocked: true`，端点返回 422，`tools/post-execute` 把它转成 `{ kind: 'block' }`，本轮就此中止；`Warning` / `Info` 进 `warnings`，除非租户显式开启 `fail_on_warning`，否则不阻断。
- 两个引擎。`pyshacl` 进程内执行；`fuseki` 把形状编译成 SPARQL，用 GSP 把候选图投递到一次性命名图，在那边查询，并且一定会删除该图。Apache Jena 的 Fuseki 5 不提供 SHACL 端点，所以"编译成 SPARQL"是不引入 JVM sidecar 就能把校验搬进图库的唯一办法。
- 编译器不认识的形状组件会抛 `ShapeCompileError`。静默跳过会留下一个"看起来在工作"的闸门。

`ontology_entity_link` —— 对齐术语。

- DeepSeek Flash 只提候选**表面形式**，输出结构里没有 IRI 字段，因此无法凭空指定 IRI；IRI 由确定性别名表给出，其次是 0.86 以上的模糊匹配，剩下的进 `unmapped` 交给调用方追问。
- `use_llm: false`、无密钥或模型调用失败都会退回纯词表，`extractor` 字段如实说明本次走了哪条路径。

`ontology_rag_answer` —— 完整流水线：答案、引用、SPARQL 路径、闸门报告。

### 生命周期钩子

- `agent/pre-step` 在每轮第 1 步调用一次 `/v1/hooks/pre-retrieval`，先委托 `next()`，再把解析结果作为一条 user 角色消息注入，声明的来源类型为 `ontology-rag`。同一轮绝不注入两次；解析失败时降级为不注入，而不是阻断对话。
- `tools/post-execute` 拦截 `ontology_rag_answer`，检查当轮 token 预算，然后调用 `/v1/hooks/post-generation`；422 被转成 `{ kind: 'block' }` 并把违反的规则作为反馈。卡在这里而不是卡助手文本是刻意的：助手文本是流式产出、无法撤回，而作为工具结果进入上下文的答案仍然可以被拒绝。

### 模型路由与成本控制

简单抽取与摘要走 `LLM_MODEL_FLASH`；NL2SPARQL 与多跳业务推理按提示词特征路由到 `LLM_MODEL_STRONG`。按租户隔离的 TTL 加 LRU 缓存让重复提问零 token 成本，熔断器在连续失败后打开，单任务上限与日预算双约束——任一超限抛 429，而不是悄悄继续花钱。设置 `LLM_PROVIDER=offline` 则完全不连模型、退回确定性生成器，这是内网隔离测试能跑通的前提，同时它不会假装输出具备模型质量。

### 挂载方式

```yaml
- name: '@deepseek-ai/dsh-ontology-rag-bridge'
  config:
    baseUrl: 'http://127.0.0.1:8000'
    apiKey: '${ONTORAG_DEMO_KEY}'
    tenantId: 'demo'
    timeoutMs: 30000
    maxTokensPerTurn: 24000
    auditPath: './var'
    injectIntent: true
    enforceGuard: true
    requireApiKey: true
    # Empty means "all four". Narrow it per tenant when needed, e.g.
    # enabledTools: ['ontology_rag_answer'] turns off raw SPARQL for that tenant.
    enabledTools: []
```

<a id="ingest"></a>
## 文档解析与分块

禁止定长分块。`OntologyChunker` 按本体业务单元切分——单条款、单规则、单字段定义——仅当单个单元超过 1200 字符时才退化为按句子边界切分。每个 chunk 携带本体标签、文档优先级与生效窗口；带 `superseded_by` 指向或 `effective_to` 已过期的文档在分块时即标记为废弃，检索因此不必二次判断。

```bash
python scripts/ingest_documents.py --tenant demo --source ./docs --out ./data/seed --extract
python scripts/mysql_to_rdf.py --tenant demo --since 2026-01-01 --push
python scripts/init_pg.py --tenant demo
```

<a id="poc"></a>
## POC 演示流程

内置种子数据是刻意不合规的，好让闸门有真东西可抓：`PAY-1001` 对 `C-2024-001` 构成超付，`INV-1001` 金额超过其对应付款，还有一个排放源同时属于两个互斥边界。

1. 起栈后先问超付问题：答案必须说明超出金额、引用依据条款，并通过闸门。
2. 再问一笔在剩余额度内的付款：结论必须是 `within-remaining`，且算术过程一致。
3. 问边界冲突问题：答案必须拒绝归属该排放源，并点明两个边界。
4. 问一个只有废弃文档支撑的问题：当期问题不得引用历史归档 chunk。
5. 调用 `POST /v1/admin/audit/{trace_id}`，确认记录里含问题、召回清单、SPARQL、模型输入输出、token 计数、租户 id 与时间戳。

### 可视化调试面板

`GET /debug/` 提供一个自包含面板（不引 CDN、不需要构建步骤，客户断网的笔记本上也能演示）。一次运行把整条链路的中间态铺开：本体解析结果、三级召回各自的候选与得分、SHACL 报告、带溯源链的答案，以及一份纯向量基线做对照。

面板调用 `POST /v1/debug/trace`，背后是 `pipeline.inspect()`。`inspect()` 与 `answer()` 共用 `orchestrator._execute()`，所以面板上展示的 SPARQL 就是真正执行的那条——重新模拟一遍链路的演示什么也证明不了。

```bash
curl -s -X POST http://127.0.0.1:8000/v1/debug/trace \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-Id: demo' -H 'X-Api-Key: key-demo' \
  -d '{"question": "C-2024-001 这笔 700 万的付款申请是否超付？", "top_k": 5}'
```

演示真正依赖的是这份返回里的两处。每个通道都写明它为什么跑、为什么没跑（`skipped:sufficient:count=5,best=0.582`），于是"向量层不必跑"与"向量层忘了跑"可以区分。对照块则给出普通向量检索会用到、但被本体判定为不兼容的分块条数——这个数字就是本体制导与普通 RAG 之间可量的差。

`DEBUG_PANEL_ENABLED=false` 会同时移除页面与 `/v1/debug/*` 路由。默认开启，因为它会返回分块原文、命中理由与冲突明细。

`tests/smoke/bridge_smoke.mjs` 用编译后的插件客户端对着运行中的后端跑上面五条，其中包含"伪造 `within-remaining` 结论会被 `PaymentVerdictConsistency` 拦住而不是被返回"这一条。

```bash
curl -s -X POST http://127.0.0.1:8000/v1/query \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-Id: demo' -H 'X-Api-Key: key-demo' \
  -d '{"question": "C-2024-001 这笔 700 万的付款申请是否超付？"}'
```

<a id="eval"></a>
## 准确率评估

`scripts/eval_accuracy.py` 把标注集跑过真实流水线，产出两份东西：`report.md`（逐项判定、失败归因、逐用例明细、口径说明）与 `results.csv`（一行一条用例）。准确率、脏召回率或 SHACL 违规预算任一未达即以非零码退出，可直接当发布门禁。

```bash
python scripts/eval_accuracy.py --threshold 0.92 --max-dirty-recall 0.05
python scripts/eval_accuracy.py --only pay-over,closed-contract --verbose
python scripts/eval_accuracy.py --csv out/results.csv --report out/report.md
```

每条用例包含 `question`、`standard_answer`、`expected_sparql`、`expected_evidence`，以及可选的 `judge` 块（`all_of` / `any_of` / `none_of` / `expect_block`）。

三个指标回答三个不同的问题：

| 指标 | 回答什么 | 定义 |
| --- | --- | --- |
| 问答准确率 | 结论对不对？ | 闸门通过 + `all_of` 事实全中 + `any_of` 至少一中 + 不出现禁止表述 |
| 脏召回率 | 召回了多少无关内容？ | `dirty / (dirty + relevant)`，微平均。`dirty` 指显式标注的反例或跨域文档；同域未标注的 chunk 记 `unjudged`，单独披露 |
| 幻觉违规次数 | 闸门有没有被迫拦下断言？ | `Violation` 级别的 SHACL 结果条数，标注 `expect_block` 的对抗用例不计入 |

事实按数值比较而非字符串：`5,500,000`、`5500000`、`550 万` 是同一个金额，`未超付` 也不算提到 `超付`。`expected_sparql` 提供机器可校验的金标准事实（金额、数量、状态，不含内部 IRI），据此算出金标准事实覆盖率；这个比例是对**答案**算的，不是对系统自己那条查询算的——否则投影范围会直接决定分数。

```text
cases           : 12
accuracy        : 12/12 = 100.00% (>= 92%)
dirty recall    : 0/14 = 0.00% (<= 5%)
hallucinations  : 0 (SHACL Violation)
gold fact cover : 80.56%
unjudged share  : 46.15% (12/26 retrieved chunks had no ground truth)
verdict         : PASS
```

报告会写明本次回答由哪个生成器产出。`LLM_PROVIDER=offline`（未配置模型密钥）时，这些数字衡量的是检索与闸门链路，不代表模型质量——报告会显式打出这条提示，而不是让 100% 被误读。

<a id="acceptance"></a>
## 验收指标

| 指标 | 目标 | 由谁强制 |
| 业务问答准确率 | >= 92% | `scripts/eval_accuracy.py` 退出码 |
| 脏召回率 | <= 5% | 同一次运行的 `--max-dirty-recall` |
| 结论可溯源 | 100% | 要求 `doc:basedOnChunk` 的 SHACL 形状 |
| 幻觉违规次数（SHACL Violation） | 0 | `claim_shapes.ttl` 阻断响应；`--max-hallucination` 计数 |

<a id="limits"></a>
## 已知限制

- 只做 OWL 2 RL。支持子类、定义域与值域、逆关系；没有 OWL DL 全量推理，需要它的领域必须在入库前物化推理结果。
- SHACL-SPARQL 形状很强但不便宜。病态形状在大租户图上可能耗秒，因此刻意使用 `inference="none"` 与按形状定向目标。
- 离线模式的向量器是确定性哈希技巧，不是语义模型。它让演示免依赖且可复现，但该模式下的向量召回质量不代表真实 embedding 模型。
- `ts_rank_cd` 是覆盖率模型，不是概率 BM25，同分比 Elasticsearch 更常见。排序仍确定，因为排序器用优先级与 chunk id 兜底，而不只看分数。
- psycopg 的异步连接绑定在创建连接池的事件循环上，而 Windows 默认的 Proactor 循环用不了它。`serve.py` 在 uvicorn 启动前切换策略；在 Windows 上直接跑 `uvicorn app.main:app` 会得到一条可读报错，而不是莫名其妙连不上。
- Harness 插件在本仓库中以源码形态存在，由根 `tsc -b` 项目图编译，不作为独立包发布。
