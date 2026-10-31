/**
 * 本体中心的三个自定义工具（外加一个走完整链路的问答工具）。
 *
 * 分工：
 * - `fuseki_sparql_query` —— 查事实。只读、租户图内、有耗时与行数上限。
 * - `shacl_validate`      —— 验结论。候选三元组送后端做 SHACL，
 *                            `Violation` 级结果会被 post-execute 转成 block，
 *                            这一轮任务就此中止（不是"提示一下，请你注意"）。
 * - `ontology_entity_link`—— 对齐术语。DeepSeek Flash 抽面、本体词表定 IRI。
 * - `ontology_rag_answer` —— 走完整九步链路，答案必须再过一次闸门。
 *
 * 一条贯穿全部工具的约束：**判定权在后端**。插件只做参数校验、渲染与
 * 生命周期编排；SPARQL 白名单、租户图注入、SHACL 分级全部在 Python 侧
 * 单点实现。插件里若复制一份规则，两边迟早会漂移，而漂移的那一天
 * 通常正是有人绕过了闸门的那一天。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'

import type { AuditLog } from './audit.ts'
import { RagApiError, type RagClient } from './client.ts'
import type {
  AnswerPayload,
  AnswerView,
  Claim,
  EntityLinkResult,
  GuardReport,
  SparqlToolResult,
  Violation,
} from './types.ts'

/** 本插件注册的全部工具名。启停与权限判定都以这份清单为准。 */
export const RAG_TOOL_NAMES = [
  'fuseki_sparql_query',
  'shacl_validate',
  'ontology_entity_link',
  'ontology_rag_answer',
] as const

export type RagToolName = (typeof RAG_TOOL_NAMES)[number]

/** 待复检的一次调用。 */
export interface PendingCheck {
  /** answer：完整链路答案；shacl：候选三元组校验 */
  readonly kind: 'answer' | 'shacl'
  readonly guard: GuardReport
  readonly question: string
  readonly traceId: string
  readonly tokens: number
  /** 完整链路答案正文，供 post-generation 钩子复检 */
  readonly answer?: string
  readonly claims?: readonly Claim[]
  readonly citations?: readonly string[]
}

const pending = new Map<string, PendingCheck>()

/**
 * 待复检条目的上限。
 *
 * 正常路径下 post-execute 会取走并删除；若某次执行在钩子之前就失败
 * （宿主取消、进程内异常），条目会残留。留上限做兜底，避免长会话涨内存。
 */
const PENDING_LIMIT = 64

function stash(token: ToolExecutionToken, check: PendingCheck): void {
  if (pending.size >= PENDING_LIMIT) {
    const oldest = pending.keys().next()
    if (!oldest.done) pending.delete(oldest.value)
  }
  pending.set(String(token), check)
}

/** 取出并清除某次执行的待复检项（post_generation 钩子调用）。 */
export function takeCheck(token: ToolExecutionToken): PendingCheck | undefined {
  const key = String(token)
  const value = pending.get(key)
  pending.delete(key)
  return value
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** IRI 取本地名，报告里给人看的是 `PaymentApplication` 而不是一长串 http。 */
function localName(iri: string): string {
  const hash = iri.lastIndexOf('#')
  if (hash >= 0) return iri.slice(hash + 1)
  const slash = iri.lastIndexOf('/')
  return slash >= 0 ? iri.slice(slash + 1) : iri
}

/** 把 SPARQL 结果渲染成紧凑表。 */
function renderRows(result: SparqlToolResult): string {
  const shown = result.rows.slice(0, 20)
  const header = [
    `命中 ${result.count} 行（展示 ${shown.length} 行，耗时 ${result.elapsed_ms}ms）${result.truncated ? '，已达行数上限' : ''}`,
    `租户图：${result.graph}`,
  ].join('\n')
  if (shown.length === 0) return `${header}\n（无结果）`

  const columns = result.columns.length > 0 ? result.columns : Object.keys(shown[0] ?? {})
  const body = shown
    .map(row => columns.map(column => String(row[column] ?? '')).join(' | '))
    .join('\n')
  return `${header}\n实际执行：${result.query}\n${columns.join(' | ')}\n${body}`
}

/** 渲染实体链接结果。 */
function renderMentions(result: EntityLinkResult): string {
  const lines: string[] = [`抽取方式：${result.extractor}`]
  if (result.mentions.length === 0) {
    lines.push(`未识别到本体实体（归一化文本：${result.normalized_text}）`)
  } else {
    for (const mention of result.mentions) {
      const iri = mention.iri === null || mention.iri === undefined ? '(未对齐)' : localName(mention.iri)
      const score = mention.confidence === undefined ? '' : ` conf=${mention.confidence}`
      lines.push(`- ${mention.surface} → ${iri} [${mention.kind}${score}]`)
    }
  }
  if (result.unmapped.length > 0) {
    lines.push(`未能对齐（不要臆测其含义，必要时向用户确认）：${result.unmapped.join('、')}`)
  }
  return lines.join('\n')
}

/** 按级别分组渲染 SHACL 报告。 */
function renderGuard(report: GuardReport): string {
  const engine = report.engine === undefined ? '' : `，引擎 ${report.engine}`
  const elapsed = report.elapsed_ms === undefined ? '' : `，耗时 ${report.elapsed_ms}ms`
  const blocking = report.violations.filter(item => (item.severity ?? 'Violation') === 'Violation')
  const advisory = report.warnings ?? report.violations.filter(item => (item.severity ?? 'Violation') !== 'Violation')

  const head = report.conforms
    ? `SHACL 校验通过：${report.checked_triples} 条三元组 / ${report.shapes_checked.length} 个形状${engine}${elapsed}`
    : `SHACL 校验未通过：${blocking.length} 项阻断级冲突${engine}${elapsed}`

  const render = (item: Violation): string => {
    const evidence = item.conflicting_triples !== undefined && item.conflicting_triples.length > 0
      ? `\n    证据：${item.conflicting_triples.join(' ; ')}`
      : ''
    const where = item.focus_node === null || item.focus_node === undefined ? '' : `${localName(item.focus_node)} `
    return `- [${item.severity ?? 'Violation'}] ${item.rule}：${where}${item.message}${evidence}`
  }

  const sections: string[] = [head]
  if (blocking.length > 0) sections.push(blocking.map(render).join('\n'))
  if (advisory.length > 0) sections.push(`提示（不阻断，供人工复核）：\n${advisory.map(render).join('\n')}`)
  return sections.join('\n')
}

/** 把不可用错误（5xx / 网络）与闸门阻断（422）区分开。 */
function describeError(error: unknown): string {
  if (error instanceof RagApiError) {
    if (error.status === 0) return `本体服务不可用：${error.message}`
    return `${error.code}（HTTP ${error.status}）：${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

/** 从 422 错误体里取 guard 报告。 */
function guardFromError(error: RagApiError): GuardReport | undefined {
  const details = error.details as { guard?: GuardReport } | undefined
  return details?.guard
}

// ---------------------------------------------------------------------------
// 参数归一（schema 只声明形态，取值范围在代码里收口）
// ---------------------------------------------------------------------------

const LIMIT_MIN = 1
const LIMIT_MAX = 200
const TIMEOUT_MIN_MS = 1_000
const TIMEOUT_MAX_MS = 20_000

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 把工具入参里的三元组转成后端 `Claim`，非法值就地报错。 */
function toClaims(raw: readonly { subject: string; predicate: string; object: unknown; datatype?: string }[]): Claim[] {
  if (raw.length === 0) throw new Error('triples 不能为空：至少给出一条候选三元组')
  if (raw.length > 200) throw new Error('triples 最多 200 条，请分批校验')

  return raw.map((item, index) => {
    const subject = item.subject.trim()
    const predicate = item.predicate.trim()
    if (subject.length === 0) throw new Error(`第 ${index + 1} 条三元组缺少 subject`)
    if (predicate.length === 0) throw new Error(`第 ${index + 1} 条三元组缺少 predicate`)

    const value = item.object
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      // 对象/数组当宾语没有业务含义，且后端无法区分是"字面量"还是"实体"
      throw new Error(`第 ${index + 1} 条三元组的 object 必须是字符串、数字或布尔值`)
    }
    const base = { subject, predicate, object: value }
    return item.datatype === undefined ? base : { ...base, datatype: item.datatype }
  })
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

/** 工具注册所需的依赖。 */
export interface ToolDeps {
  readonly client: RagClient
  readonly audit: AuditLog
  readonly tenantId: string
  /** 后端单次请求超时；工具自身的 timeoutMs 略大于它，让后端先超时 */
  readonly requestTimeoutMs: number
}

/** 注册全部工具。 */
export function registerRagTools(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'fuseki_sparql_query',
    description:
      'Run a read-only SPARQL SELECT against the tenant ontology graph. '
      + 'Updates (INSERT/DELETE/LOAD/DROP/…), multiple statements, and any FROM/GRAPH pointing outside the tenant graph are rejected server-side with HTTP 400. '
      + 'The server injects `FROM <tenant graph>` and clamps LIMIT, so always write plain triple patterns instead of naming graphs yourself. '
      + 'Use it to inspect contract / payment / emission facts before drawing conclusions.',
    parameters: {
      sparql: {
        type: 'string',
        required: true,
        description: 'One SELECT statement. PREFIX declarations are allowed. No updates, no LIMIT larger than the returned cap.',
      },
      limit: {
        type: 'integer',
        description: `Rows to return (${LIMIT_MIN}-${LIMIT_MAX}, default 50). The server may clamp further.`,
      },
      timeout_ms: {
        type: 'integer',
        description: `Execution budget in ms (${TIMEOUT_MIN_MS}-${TIMEOUT_MAX_MS}, default 8000). Can only shorten the server default.`,
      },
    },
    // 只读且无共享状态：允许与同轮其它只读调用并行
    isConcurrencySafe: () => true,
    timeoutMs: 30_000,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const started = Date.now()
      const limit = clamp(args.limit, LIMIT_MIN, LIMIT_MAX, 50)
      const timeoutMs = clamp(args.timeout_ms, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, 8_000)

      try {
        const result = await deps.client.post<SparqlToolResult>(
          '/v1/tools/sparql',
          { sparql: args.sparql, limit, timeout_ms: timeoutMs },
          exec.signal,
        )
        await deps.audit.record({
          at: new Date().toISOString(),
          tenantId: deps.tenantId,
          tool: 'fuseki_sparql_query',
          ok: true,
          latencyMs: Date.now() - started,
          detail: `rows=${result.count}`,
        })
        return renderRows(result)
      } catch (error) {
        await deps.audit.record({
          at: new Date().toISOString(),
          tenantId: deps.tenantId,
          tool: 'fuseki_sparql_query',
          ok: false,
          latencyMs: Date.now() - started,
          detail: describeError(error),
        })
        // 400 是"查询写法越界"，原样上抛，让模型改写法而不是改结论
        throw new Error(`SPARQL 查询被拒绝或失败：${describeError(error)}`)
      }
    },
    presentCall: args => ({ card: 'generic', title: '查询本体图', kind: 'read', rawInput: args.sparql }),
  }))

  ctx.tools.register(defineTool({
    name: 'shacl_validate',
    description:
      'Validate candidate business conclusions against the domain SHACL shapes before reporting them. '
      + 'Send the triples you intend to assert (subject IRI, predicate like `con:paymentVerdict`, object value). '
      + 'A VIOLATION-severity result blocks this turn outright — you must then tell the user which rule conflicted and which triples conflict, '
      + 'instead of rewording the claim. WARNING results are advisory and do not block.',
    parameters: {
      triples: {
        type: 'array',
        required: true,
        description: 'Candidate triples to validate (1-200). Subject must be an instance IRI that already exists in the tenant graph.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            subject: { type: 'string', required: true, description: 'Instance IRI, e.g. http://ontorag.local/tenant/demo/contract#PAY-1001' },
            predicate: { type: 'string', required: true, description: 'Ontology property, e.g. con:paymentVerdict or doc:basedOnChunk' },
            object: { type: 'json', required: true, description: 'Literal value (string / number / boolean) or object IRI' },
            datatype: { type: 'string', description: 'Optional xsd local name: decimal / integer / date / string / boolean' },
          },
        },
      },
      include_tenant_facts: {
        type: 'boolean',
        description: 'Merge tenant facts so arithmetic constraints (remaining payable, emission factor) can be evaluated. Default true — turning it off will fail most business shapes.',
      },
      engine: {
        type: 'string',
        enum: ['auto', 'fuseki', 'local'],
        description: 'Validation engine. `auto` uses the server default; `fuseki` runs the shapes as SPARQL in the graph store.',
      },
      fail_on_warning: {
        type: 'boolean',
        description: 'Strict tenant policy: treat WARNING results as blocking too. Default false.',
      },
    },
    timeoutMs: 30_000,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const started = Date.now()
      const triples = toClaims(args.triples)

      const body: Record<string, unknown> = { triples }
      if (args.include_tenant_facts !== undefined) body.include_tenant_facts = args.include_tenant_facts
      if (args.engine !== undefined) body.engine = args.engine
      if (args.fail_on_warning !== undefined) body.fail_on_warning = args.fail_on_warning

      try {
        const report = await deps.client.post<GuardReport>('/v1/tools/shacl', body, exec.signal)
        // 通过（可能带 Warning）：登记后交给 post-execute 做最终放行判定
        stash(exec.token, {
          kind: 'shacl',
          guard: report,
          question: '',
          traceId: '',
          tokens: 0,
        })
        await deps.audit.record({
          at: new Date().toISOString(),
          tenantId: deps.tenantId,
          tool: 'shacl_validate',
          ok: true,
          latencyMs: Date.now() - started,
          detail: `conforms=${report.conforms} engine=${report.engine ?? '-'}`,
        })
        return renderGuard(report)
      } catch (error) {
        if (error instanceof RagApiError && error.status === 422) {
          // 后端已判定阻断：这里把明细原样带回，post-execute 会把它变成 block
          const report = guardFromError(error)
          if (report !== undefined) {
            stash(exec.token, { kind: 'shacl', guard: report, question: '', traceId: '', tokens: 0 })
            await deps.audit.record({
              at: new Date().toISOString(),
              tenantId: deps.tenantId,
              tool: 'shacl_validate',
              ok: false,
              latencyMs: Date.now() - started,
              detail: `blocked by ${report.violations.map(item => item.rule).join(',')}`,
            })
            return renderGuard(report)
          }
        }
        await deps.audit.record({
          at: new Date().toISOString(),
          tenantId: deps.tenantId,
          tool: 'shacl_validate',
          ok: false,
          latencyMs: Date.now() - started,
          detail: describeError(error),
        })
        throw new Error(`SHACL 校验调用失败：${describeError(error)}`)
      }
    },
    presentCall: args => ({ card: 'generic', title: 'SHACL 校验', kind: 'other', rawInput: `${args.triples.length} 条候选三元组` }),
  }))

  ctx.tools.register(defineTool({
    name: 'ontology_entity_link',
    description:
      'Align Chinese business wording, aliases and abbreviations to ontology IRIs. '
      + 'DeepSeek Flash extracts candidate business terms, then the deterministic ontology lexicon maps them to IRIs — '
      + 'the model never picks the IRI itself, so it cannot invent one. '
      + 'Call it before writing SPARQL when the user says things like 请款单, 乙方, 碳源.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'Raw user text or phrase to normalize (1-1000 chars).',
      },
      domain: {
        type: 'string',
        enum: ['contract', 'carbon'],
        description: 'Optional domain hint to narrow alignment.',
      },
      use_llm: {
        type: 'boolean',
        description: 'Let Flash propose candidate terms. Default true; false falls back to lexicon-only matching.',
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 25_000,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const started = Date.now()
      const text = args.text.trim()
      if (text.length === 0) throw new Error('text 不能为空')
      if (text.length > 1000) throw new Error('text 超过 1000 字，请截取关键片段')

      const body: Record<string, unknown> = { text }
      if (args.domain !== undefined) body.domain = args.domain
      if (args.use_llm !== undefined) body.use_llm = args.use_llm

      try {
        const result = await deps.client.post<EntityLinkResult>('/v1/tools/entity-link', body, exec.signal)
        await deps.audit.record({
          at: new Date().toISOString(),
          tenantId: deps.tenantId,
          tool: 'ontology_entity_link',
          ok: true,
          latencyMs: Date.now() - started,
          detail: `mentions=${result.mentions.length} extractor=${result.extractor}`,
        })
        return renderMentions(result)
      } catch (error) {
        await deps.audit.record({
          at: new Date().toISOString(),
          tenantId: deps.tenantId,
          tool: 'ontology_entity_link',
          ok: false,
          latencyMs: Date.now() - started,
          detail: describeError(error),
        })
        throw new Error(`术语对齐失败：${describeError(error)}`)
      }
    },
    presentCall: args => ({ card: 'generic', title: '术语对齐', kind: 'search', rawInput: args.text }),
  }))

  ctx.tools.register(defineTool({
    name: 'ontology_rag_answer',
    description:
      'Answer a contract-payment or carbon-accounting question through the full ontology-guided RAG pipeline: '
      + 'intent parsing, weighted hybrid retrieval (graph 60% > exact text 25% > vector 15%), ontology-compatibility filtering, '
      + 'source-priority ranking, generation, and a mandatory SHACL gate. Always prefer this over answering from memory. '
      + 'A 422 response means the gate blocked the answer: report the conflict instead of retrying with different wording.',
    parameters: {
      question: {
        type: 'string',
        required: true,
        description: 'The business question, including contract / payment / facility numbers when known.',
      },
      domain: {
        type: 'string',
        enum: ['contract', 'carbon'],
        description: 'Optional domain hint.',
      },
      top_k: {
        type: 'integer',
        description: 'Evidence count (1-20, default 8).',
      },
    },
    timeoutMs: 90_000,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const started = Date.now()
      const topK = clamp(args.top_k, 1, 20, 8)
      const body: Record<string, unknown> = { question: args.question, top_k: topK }
      if (args.domain !== undefined) body.domain = args.domain

      try {
        const payload = await deps.client.post<AnswerPayload>('/v1/query', body, exec.signal)
        const view: AnswerView = {
          trace_id: payload.trace_id,
          answer: payload.answer,
          citations: payload.citations,
          claims: payload.claims,
          sparql_rows: payload.sparql.row_count,
          guard: payload.guard,
          question: args.question,
          tokens: payload.usage.total_tokens,
        }
        // 交给 post_generation 钩子复检；未复检前不算数
        stash(exec.token, {
          kind: 'answer',
          guard: payload.guard,
          question: args.question,
          traceId: payload.trace_id,
          tokens: payload.usage.total_tokens,
          answer: payload.answer,
          claims: payload.claims,
          citations: payload.citations.map(citation => citation.chunk_id),
        })
        await deps.audit.record({
          at: new Date().toISOString(),
          tenantId: deps.tenantId,
          tool: 'ontology_rag_answer',
          ok: true,
          latencyMs: Date.now() - started,
          traceId: payload.trace_id,
          tokens: payload.usage.total_tokens,
        })
        return JSON.stringify(view, null, 2)
      } catch (error) {
        await deps.audit.record({
          at: new Date().toISOString(),
          tenantId: deps.tenantId,
          tool: 'ontology_rag_answer',
          ok: false,
          latencyMs: Date.now() - started,
          detail: describeError(error),
        })
        if (error instanceof RagApiError && error.status === 422) {
          // 后端已把答案拦下，没有可渲染的内容：直接把冲突规则写进错误消息，
          // 让模型知道"该原样上报什么"，而不是只知道"调用失败了"。
          const report = guardFromError(error)
          const rules = (report?.violations ?? [])
            .filter(item => (item.severity ?? 'Violation') === 'Violation')
            .map(item => `- [${item.rule}] ${item.message}`)
            .join('\n')
          throw new Error(
            `答案未通过 SHACL 闸门，已被阻断：\n${rules || describeError(error)}\n请把冲突规则与证据告知用户，不要换措辞重试。`,
          )
        }
        throw new Error(`本体问答失败：${describeError(error)}`)
      }
    },
    presentCall: args => ({ card: 'generic', title: '本体问答', kind: 'execute', rawInput: args.question }),
  }))
}

/** 供渲染测试与冒烟脚本复用。 */
export const __internals = { renderRows, renderMentions, renderGuard, toClaims, localName }
