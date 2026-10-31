/** 与 OntoRAG 后端交互的数据契约（只声明插件用到的字段）。 */

export interface EntityMention {
  readonly surface: string
  readonly normalized: string
  readonly iri?: string | null
  readonly kind: string
  /** 对齐置信度：词表精确命中为 1，模糊匹配落到阈值之上，未对齐为 0 */
  readonly confidence?: number
  /** 该 mention 来自纯词表还是模型抽取后对齐 */
  readonly source?: 'lexicon' | 'llm'
  /** 命中的同义词（解释"为什么映射到这个 IRI"） */
  readonly alias?: string | null
}

export interface QueryIntent {
  readonly query: string
  readonly domain: string
  readonly classes: readonly string[]
  readonly properties: readonly string[]
  readonly entities: readonly EntityMention[]
  readonly constraints: readonly string[]
  readonly filters: Readonly<Record<string, unknown>>
  readonly sparql?: string | null
  readonly complexity: string
  readonly normalized_query: string
}

export interface Claim {
  readonly subject: string
  readonly predicate: string
  readonly object: string | number | boolean
  readonly datatype?: string | null
}

/** SHACL 结果级别。只有 Violation 阻断；Info 目前未使用但保留以免后端扩展时漏判。 */
export type Severity = 'Violation' | 'Warning' | 'Info'

export interface Violation {
  readonly rule: string
  readonly message: string
  readonly focus_node?: string | null
  readonly path?: string | null
  readonly severity?: Severity | string
  readonly conflicting_triples?: readonly string[]
}

export interface GuardReport {
  readonly conforms: boolean
  /** 本次输出是否被拦截（与 conforms 同源，但语义是产品层面） */
  readonly blocked?: boolean
  readonly checked_triples: number
  /** 全部结果，含 Warning */
  readonly violations: readonly Violation[]
  /** 仅 Warning / Info */
  readonly warnings?: readonly Violation[]
  readonly counts?: Readonly<Record<string, number>>
  readonly shapes_checked: readonly string[]
  /** 实际执行校验的引擎：pyshacl / fuseki */
  readonly engine?: string
  readonly elapsed_ms?: number
  readonly policy?: 'standard' | 'strict'
}

export interface Citation {
  readonly chunk_id: string
  readonly doc_id: string
  readonly doc_title: string
  readonly clause_no: string
  readonly quote: string
  readonly priority: number
}

/** 只读 SPARQL 工具结果。 */
export interface SparqlToolResult {
  /** 服务端实际执行的查询（已注入租户图、已归一 LIMIT） */
  readonly query: string
  readonly graph: string
  readonly count: number
  readonly rows: readonly Readonly<Record<string, unknown>>[]
  readonly columns: readonly string[]
  readonly truncated: boolean
  readonly elapsed_ms: number
}

/** 实体链接工具结果。 */
export interface EntityLinkResult {
  readonly mentions: readonly EntityMention[]
  readonly normalized_text: string
  /** lexicon / llm+lexicon */
  readonly extractor: string
  readonly unmapped: readonly string[]
  readonly elapsed_ms?: number
}

export interface AnswerPayload {
  readonly trace_id: string
  readonly tenant_id: string
  readonly answer: string
  readonly citations: readonly Citation[]
  readonly claims: readonly Claim[]
  readonly sparql: { readonly query: string; readonly row_count: number; readonly graph_uri: string }
  readonly guard: GuardReport
  readonly recall: Readonly<Record<string, unknown>>
  readonly usage: { readonly total_tokens: number; readonly model?: string }
  readonly model: string
  readonly blocked: boolean
}

/** 工具返回给模型的精简视图，避免把整份审计塞进上下文。 */
export interface AnswerView {
  readonly trace_id: string
  readonly answer: string
  readonly citations: readonly Citation[]
  readonly claims: readonly Claim[]
  readonly sparql_rows: number
  readonly guard: GuardReport
  readonly question: string
  readonly tokens: number
}
