"""跨层数据契约。

这些模型是全链路的公共语言：检索层产出 `Chunk`，解析层产出 `QueryIntent`，
校验层产出 `GuardReport`，最终由 `AnswerResponse` 一次性交付给调用方。
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class Chunk(BaseModel):
    """本体感知分块的最小单元。

    一个 chunk 永远对应一个业务单元（单条款 / 单规则 / 单字段定义），
    并强制携带本体标签、来源权重标签与生效时间标签。
    """

    chunk_id: str
    tenant_id: str
    doc_id: str
    doc_title: str
    # regulation=现行制度, contract=合同/台账, standard=国标规范, archive=历史资料
    doc_type: Literal["regulation", "contract", "ledger", "standard", "archive"]
    clause_no: str
    text: str
    classes: list[str] = Field(default_factory=list)
    properties: list[str] = Field(default_factory=list)
    priority: int = 30
    effective_from: date | None = None
    effective_to: date | None = None
    version: str = "v1"
    deprecated: bool = False

    def is_effective(self, today: date) -> bool:
        """是否在生效期内（含边界）。"""
        if self.effective_from is not None and today < self.effective_from:
            return False
        if self.effective_to is not None and today > self.effective_to:
            return False
        return True


class EntityMention(BaseModel):
    """查询中识别出的业务实体，已对齐到本体 IRI。

    `source` 区分"词表直接命中"与"模型抽取后对齐"：前者可复现，后者依赖
    模型输出，因此必须留下痕迹，便于评估与排障时区分两类召回质量。
    """

    surface: str
    normalized: str
    iri: str | None = None
    kind: Literal["class", "individual", "property", "unknown"] = "unknown"
    # 对齐置信度：词表精确命中 1.0，模糊匹配落在阈值之上，未对齐为 0
    confidence: float = 1.0
    source: Literal["lexicon", "llm"] = "lexicon"
    # 命中的同义词（用于解释"为什么映射到这个 IRI"）
    alias: str | None = None


class QueryIntent(BaseModel):
    """Query 本体解析结果。

    刻意**不带 SPARQL**：查询由检索层的 `SparqlPlanner` 依据结构化输入生成。
    解析层自己拼模板会让"意图里的查询"与"实际执行的查询"变成两套口径，
    审计里记的语句和真正跑的语句不一致，是最难排查的一类偏差。
    """

    query: str
    domain: str
    classes: list[str] = Field(default_factory=list)
    properties: list[str] = Field(default_factory=list)
    entities: list[EntityMention] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)
    filters: dict[str, Any] = Field(default_factory=dict)
    complexity: Literal["simple", "complex"] = "simple"
    normalized_query: str = ""

    def class_locals(self) -> set[str]:
        """取类 IRI 的本地名，便于和 chunk 标签比对。"""
        return {iri.rsplit("#", 1)[-1] for iri in self.classes}

    def property_locals(self) -> set[str]:
        """取属性 IRI 的本地名。"""
        return {iri.rsplit("#", 1)[-1] for iri in self.properties}


class ScoredChunk(BaseModel):
    """带检索来源与打分的 chunk。

    `breakdown` 保存每一个打分因子的取值：排序出问题时，能直接回答
    "这个 0.73 是哪几项乘出来的"，而不是只能重跑一遍猜。
    `reason` 是兼容性判定的结论（如 `class-hierarchy:...`），进审计。
    """

    chunk: Chunk
    tier: Literal["graph", "keyword", "vector"]
    raw_score: float
    normalized_score: float = 0.0
    weighted_score: float = 0.0
    matched_on: list[str] = Field(default_factory=list)
    breakdown: dict[str, float] = Field(default_factory=dict)
    reason: str = ""


class RecallStats(BaseModel):
    """召回阶段的可观测指标，写入审计并用于评估脏召回率。"""

    per_tier: dict[str, int] = Field(default_factory=dict)
    fused: int = 0
    after_filter: int = 0
    dropped_dirty: int = 0
    dropped_expired: int = 0
    dropped_deprecated: int = 0
    # 向量检索在进入融合前就按本体兼容性预过滤掉的条数（单独披露，避免指标失真）
    prefiltered_vector: int = 0
    dirty_recall_rate: float = 0.0
    weights: dict[str, float] = Field(default_factory=dict)
    # 每个通道"为什么跑 / 为什么没跑"，第三级尤其重要：
    # 向量未触发时，必须能看出是"已充足"而不是"忘了跑"
    tier_decisions: dict[str, str] = Field(default_factory=dict)
    vector_triggered: bool = False
    graph_seeds: int = 0
    best_score: float = 0.0


class Citation(BaseModel):
    """原文溯源。"""

    chunk_id: str
    doc_id: str
    doc_title: str
    clause_no: str
    quote: str
    priority: int


class Claim(BaseModel):
    """LLM 给出的业务断言，必须转成三元组后才能被校验。"""

    subject: str
    predicate: str
    object: str | float | int | bool
    datatype: str | None = None


class Violation(BaseModel):
    """一条 SHACL 或结构校验冲突。"""

    rule: str
    message: str
    focus_node: str | None = None
    path: str | None = None
    severity: str = "Violation"
    conflicting_triples: list[str] = Field(default_factory=list)


class GuardReport(BaseModel):
    """输出闸门的结论。

    `conforms` 与 `blocked` 不是同义词，虽然当前取值相同：
    - `conforms` 是 SHACL 语义（没有 Violation 级别结果）；
    - `blocked` 是产品语义（本次输出是否被拦截）。
    分开命名是为了在接入"仅警告也阻断"的严格租户策略时不改语义。
    """

    conforms: bool
    blocked: bool = False
    checked_triples: int = 0
    # 全部结果，含 Warning / Info，按生成顺序
    violations: list[Violation] = Field(default_factory=list)
    # 仅 Warning / Info，供前端单列"提示"而不是"错误"
    warnings: list[Violation] = Field(default_factory=list)
    counts: dict[str, int] = Field(default_factory=dict)
    shapes_checked: list[str] = Field(default_factory=list)
    # 实际执行校验的引擎：pyshacl / fuseki
    engine: str = "pyshacl"
    elapsed_ms: float = 0.0
    # standard：只有 Violation 阻断；strict：任何结果（含 Warning）都阻断
    policy: Literal["standard", "strict"] = "standard"

    @model_validator(mode="after")
    def _derive(self) -> "GuardReport":
        """由 violations 的 severity 推导 blocked / warnings / counts。

        放在模型里而不是各调用点：只要有人构造 GuardReport，口径就一致。
        历史上"某个分支忘了写 blocked"是最容易漏的一类闸门缺陷。
        """
        counts: dict[str, int] = {}
        warnings: list[Violation] = []
        for violation in self.violations:
            counts[violation.severity] = counts.get(violation.severity, 0) + 1
            if violation.severity != "Violation":
                warnings.append(violation)
        self.counts = counts
        self.warnings = warnings
        has_blocking = counts.get("Violation", 0) > 0
        strict_blocking = self.policy == "strict" and len(self.violations) > 0
        self.blocked = has_blocking or strict_blocking
        if self.blocked:
            self.conforms = False
        return self


class SparqlTrace(BaseModel):
    """SPARQL 推理路径，供人复核。"""

    query: str
    row_count: int = 0
    graph_uri: str = ""
    elapsed_ms: float = 0.0


class Usage(BaseModel):
    """token 用量，按租户累计。"""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cost_usd: float = 0.0
    model: str = ""


class QueryRequest(BaseModel):
    """对外问答请求。"""

    question: str = Field(min_length=2, max_length=2000)
    domain: str | None = None
    top_k: int = Field(default=8, ge=1, le=20)
    # 演示用：允许调用方显式要求"只检索不生成"，仍然走完整校验链
    dry_run: bool = False


class QueryResponse(BaseModel):
    """结构化问答结果：答案 + 溯源 + SPARQL 路径 + 审计标识。"""

    trace_id: str
    tenant_id: str
    answer: str
    citations: list[Citation]
    claims: list[Claim]
    sparql: SparqlTrace
    guard: GuardReport
    recall: RecallStats
    usage: Usage
    model: str
    blocked: bool = False
    created_at: datetime


class PreRetrievalRequest(BaseModel):
    """Harness pre_retrieval_hook 的入参。"""

    query: str
    domain: str | None = None


class PostGenerationRequest(BaseModel):
    """Harness post_generation_hook 的入参。"""

    query: str
    answer: str
    claims: list[Claim] = Field(default_factory=list)
    citations: list[str] = Field(default_factory=list)


class EntityLinkRequest(BaseModel):
    """实体链接工具入参。"""

    text: str = Field(min_length=1, max_length=2000)
    domain: str | None = None
    # 是否启用模型抽取（DeepSeek Flash）。关闭即退回纯词表匹配。
    use_llm: bool = True


class EntityLinkResponse(BaseModel):
    """实体链接结果。"""

    mentions: list[EntityMention]
    normalized_text: str
    # 实际生效的抽取方式：lexicon / llm+lexicon
    extractor: str = "lexicon"
    # 模型抽出来但未能对齐到本体 IRI 的表面形式（不猜、留给下游追问）
    unmapped: list[str] = Field(default_factory=list)
    elapsed_ms: float = 0.0


class SparqlToolRequest(BaseModel):
    """只读 SPARQL 工具入参。"""

    sparql: str = Field(min_length=1, max_length=8000)
    limit: int = Field(default=100, ge=1, le=500)
    # 单次执行耗时上限；由服务端再与全局上限取小，调用方无法放大
    timeout_ms: int | None = Field(default=None, ge=100, le=60_000)


class SparqlToolResponse(BaseModel):
    """只读 SPARQL 工具结果（带执行轨迹）。"""

    query: str
    graph: str
    count: int
    rows: list[dict[str, Any]] = Field(default_factory=list)
    columns: list[str] = Field(default_factory=list)
    truncated: bool = False
    elapsed_ms: float = 0.0


class ShaclToolRequest(BaseModel):
    """SHACL 校验工具入参：候选三元组列表。"""

    triples: list[Claim] = Field(min_length=1, max_length=500)
    include_tenant_facts: bool = True
    # auto：按服务配置选引擎；fuseki/local：本次显式指定
    engine: Literal["auto", "fuseki", "local"] | None = None
    # 严格租户策略：把 Warning 也当作阻断
    fail_on_warning: bool = False


# ============================ 调试面板（POC 演示） ============================


class DebugTraceRequest(BaseModel):
    """调试链路入参。与正式问答接口相比只多两个"看的开关"，不影响判定。"""

    question: str = Field(min_length=2, max_length=2000)
    domain: str | None = None
    top_k: int = Field(default=5, ge=1, le=20)
    # 是否跑一次纯向量基线做对比。会多打一次向量库，演示关闭不了才怪。
    compare_baseline: bool = True
    # 是否返回完整 prompt：可能含租户数据，默认不给
    expose_prompt: bool = False


class StageTimingOut(BaseModel):
    """链路单阶段耗时。`ok=False` 时 `note` 是异常类型。"""

    stage: str
    label: str
    elapsed_ms: float = 0.0
    ok: bool = True
    note: str = ""


class TierChunk(BaseModel):
    """分通道展示用的候选。

    `score` 是**该通道口径**的归一化分，`final_score` 才是加权排序后的最终分。
    两者混用会让人以为"图谱分 1.0 就是最终分 1.0"，从而误判权重的作用。
    `status` 三态刻意分开：`final` 进入最终证据、`cut` 被 top_k 截掉、
    `dropped` 被时效/废止/兼容性过滤删掉——"没出现"的原因必须能当场回答。
    """

    chunk_id: str
    doc_id: str
    doc_title: str
    doc_type: str
    clause_no: str
    text: str
    priority: int = 30
    classes: list[str] = Field(default_factory=list)
    properties: list[str] = Field(default_factory=list)
    effective_from: date | None = None
    effective_to: date | None = None
    deprecated: bool = False
    # 该通道口径下的归一化分
    score: float = 0.0
    # 最终排序分（融合 + 本体重合 + 文档优先级之后）。未进入最终证据时为 0：
    # 它不是"这一路给的分"，和 score 混着看会误判权重的作用。
    final_score: float = 0.0
    matched_on: list[str] = Field(default_factory=list)
    breakdown: dict[str, float] = Field(default_factory=dict)
    status: Literal["final", "cut", "dropped"] = "final"
    drop_reason: str = ""
    verdict: str = ""
    # 图谱通道专用：命中的种子实体与跳数
    seed: str = ""
    depth: int = 0


class TierDetail(BaseModel):
    """一个通道的执行结论 + 它的候选。"""

    tier: Literal["graph", "keyword", "vector"]
    label: str
    weight: float
    executed: bool
    reason: str
    fetched: int = 0
    kept: int = 0
    survived: int = 0
    elapsed_ms: float = 0.0
    chunks: list[TierChunk] = Field(default_factory=list)


class ChainStep(BaseModel):
    """溯源链路的一环。前端按顺序竖排成一条链。"""

    kind: Literal["query", "entity", "fact", "clause", "claim", "guard", "answer"]
    title: str
    detail: str = ""
    refs: list[str] = Field(default_factory=list)


class BaselineSide(BaseModel):
    """普通 RAG（纯向量）的对照结果。

    `dirty` 是"本体判定与当前问题不兼容、却被普通 RAG 当作证据"的条数——
    这个数字是"本体制导"与"普通 RAG"差异最直接的量化。
    """

    enabled: bool = True
    reason: str = ""
    chunks: list[TierChunk] = Field(default_factory=list)
    total: int = 0
    dirty: int = 0
    overlap: list[str] = Field(default_factory=list)
    only_naive: list[str] = Field(default_factory=list)
    only_ontology: list[str] = Field(default_factory=list)


class DebugTraceResponse(BaseModel):
    """一次链路调试的完整快照。失败也有内容（`error` + 已完成阶段）。"""

    trace_id: str
    question: str
    parsed: QueryIntent | None = None
    stages: list[StageTimingOut] = Field(default_factory=list)
    tiers: list[TierDetail] = Field(default_factory=list)
    seeds: list[str] = Field(default_factory=list)
    sparql: SparqlTrace
    guard: GuardReport | None = None
    answer: str = ""
    claims: list[Claim] = Field(default_factory=list)
    citations: list[Citation] = Field(default_factory=list)
    recall: RecallStats | None = None
    chain: list[ChainStep] = Field(default_factory=list)
    baseline: BaselineSide = Field(default_factory=BaselineSide)
    blocked: bool = False
    block_reason: str = ""
    error: str = ""
    model: str = ""
    total_ms: float = 0.0
    # 本次使用的检索（本体系）与生成器来源，演示时必须明示"是不是真模型"
    weights: dict[str, float] = Field(default_factory=dict)
    provider: str = ""
    ontology: dict[str, Any] = Field(default_factory=dict)
    prompt: str = ""


class OntologyPublishRequest(BaseModel):
    """本体发布入参：一个域的完整 Turtle。

    SHACL 形状可以与类、属性放在同一份文件里——`sh:prefixes` 需要在本体图内解析，
    拆成两次发布会把形状和它引用的前缀分开，加载时直接解析失败。
    """

    turtle: str = Field(min_length=1, max_length=8_000_000)
    version: str = Field(default="", max_length=64)
    label: str = Field(default="", max_length=128)
    note: str = Field(default="", max_length=512)
