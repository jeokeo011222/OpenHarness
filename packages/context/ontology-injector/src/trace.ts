/**
 * The traced question pipeline: parse → retrieve → gate → answer → evidence chain.
 *
 * `trace` and the product's answer path share this one function. A demo panel
 * that re-simulates the pipeline proves nothing: the SPARQL, the scores, and the
 * gate verdict shown on screen have to be the ones that produced the answer, or
 * the panel is decoration.
 *
 * The answer is always traceable: offline mode returns the evidence verbatim
 * instead of inventing prose, and a gate violation blocks the answer rather than
 * appending a footnote to it.
 */

import { instanceGraphIri, listInstanceBatches } from './store.ts'
import { judgeBaseline } from './retrieval/compat.ts'
import { readChunks } from './retrieval/chunks.ts'
import { buildIndex } from './retrieval/index.ts'
import {
  findIdentifiers,
  loadLexicon,
  matchTerms,
  type Lexicon,
} from './retrieval/lexicon.ts'
import { retrieve } from './retrieval/service.ts'
import { loadShapes } from './shacl/shapes.ts'
import { runGate } from './shacl/engine.ts'
import type {
  AnswerClaim,
  BaselineSide,
  ChainStep,
  RetrievalOutcome,
  StageTiming,
  StructuredQuery,
  TraceExample,
  TraceResult,
} from './retrieval/types.ts'
import type { GenerationSettings } from './generate.ts'

/** Inputs for one traced question. */
export interface TraceInput {
  readonly root: string
  readonly domain: string
  readonly question: string
  readonly topK: number
  /** Model connection; `null` keeps the pipeline offline and deterministic. */
  readonly model: GenerationSettings | null
}

/**
 * Demonstration questions shipped with the panel.
 *
 * Each one exercises a different failure mode of plain vector RAG, so the
 * comparison in the panel is about a mechanism rather than a lucky query.
 */
export const DEMO_EXAMPLES: readonly TraceExample[] = [
  {
    question: 'C-2024-001 这笔付款申请是否超付',
    note: '图谱通道主导：编号定位到事实链，超付结论有算式可复核',
  },
  {
    question: '付款申请需要核对合同金额吗',
    note: '关键词通道主导：问题里没有编号，靠条款原话命中制度',
  },
  {
    question: '核算边界要覆盖哪些排放源',
    note: '跨域对照：同库里既有合同也有碳核算，纯向量会把合同条款一并召回',
  },
  {
    question: '历史版本 旧版 付款审批流程是什么',
    note: '时效与废止：归档资料可进证据，已废止版本永不进入',
  },
]

/**
 * Run one question end to end and return every intermediate stage.
 *
 * @param input - question, domain, and model settings.
 * @returns the full trace; failures are captured in `error` with partial stages.
 */
export async function trace(input: TraceInput): Promise<TraceResult> {
  const started = Date.now()
  const stages: StageTiming[] = []
  const mark = (stage: string, ms: number, note: string): void => {
    stages.push({ stage, ms, note })
  }

  let lexicon: Lexicon
  const parseStarted = Date.now()
  try {
    lexicon = await loadLexicon(input.root, input.domain)
  } catch (failure) {
    const message = messageOf(failure)
    mark('解析', Date.now() - parseStarted, `本体无法读取：${message}`)
    return emptyTrace(input, stages, `本体无法读取：${message}`, Date.now() - started)
  }

  const matched = matchTerms(lexicon, input.question)
  const query: StructuredQuery = {
    text: input.question,
    domain: input.domain,
    classes: matched.classes,
    properties: matched.properties,
    entities: [],
    identifiers: findIdentifiers(input.question),
    constraints: [],
    timeRange: { from: null, to: null },
  }
  mark('解析', Date.now() - parseStarted, `类 ${query.classes.length} 个、属性 ${query.properties.length} 个、编号 ${query.identifiers.length} 个`)

  const retrievalStarted = Date.now()
  let retrieval: RetrievalOutcome | null = null
  try {
    retrieval = await retrieve({
      root: input.root,
      domain: input.domain,
      query,
      topK: input.topK,
      today: todayIso(),
    })
    mark('检索', Date.now() - retrievalStarted, `最终证据 ${retrieval.items.length} 条，丢弃 ${retrieval.dropped.length} 条`)
  } catch (failure) {
    mark('检索', Date.now() - retrievalStarted, `检索失败：${messageOf(failure)}`)
  }

  const gateStarted = Date.now()
  let gate = null
  try {
    const shapes = await loadShapes(input.root, input.domain)
    const batches = await listInstanceBatches(input.root, input.domain)
    const graphs = batches.map(batch => instanceGraphIri(input.domain, batch.batch))
    gate = await runGate({ root: input.root, domain: input.domain, graphs, shapes, lexicon })
    mark('闸门', Date.now() - gateStarted, `形状 ${shapes.length} 个，检查 ${gate.checked} 项，违规 ${gate.violations.length} 条`)
  } catch (failure) {
    mark('闸门', Date.now() - gateStarted, `闸门失败：${messageOf(failure)}`)
  }

  const answerStarted = Date.now()
  const evidence = retrieval?.items ?? []
  let answer = ''
  let provider = 'offline'
  let model = ''
  let error = ''
  if (evidence.length === 0) {
    answer = '没有检索到可支撑结论的证据条款。请补充问题中的业务编号，或先导入相关制度文档。'
  } else if (input.model === null) {
    answer = offlineAnswer(evidence)
  } else {
    try {
      const generated = await generateAnswer(input.model, input.question, evidence)
      answer = generated.answer
      provider = 'deepseek'
      model = input.model.model
    } catch (failure) {
      error = `模型生成失败，已退回离线证据列表：${messageOf(failure)}`
      answer = offlineAnswer(evidence)
    }
  }
  mark('答案', Date.now() - answerStarted, provider === 'offline' ? '离线证据模式' : `模型 ${model}`)

  const claims: AnswerClaim[] = evidence.slice(0, 5).map(item => ({
    text: `${item.chunk.docTitle} ${item.chunk.clauseNo}`,
    evidence: [item.chunk.chunkId],
    verdict: 'supported' as const,
  }))

  const blocked = gate !== null && !gate.conforms
  const violation = gate === null
    ? null
    : (gate.violations.find(item => item.severity === 'Violation')?.message ?? gate.errors[0] ?? null)
  const blockReason = blocked ? (violation ?? '闸门未通过') : ''

  return {
    question: input.question,
    domain: input.domain,
    parsed: query,
    retrieval,
    gate,
    answer: blocked ? `【已阻断】${blockReason}\n\n${answer}` : answer,
    claims,
    chain: chainOf(query, retrieval, gate),
    baseline: await baselineOf(input, query),
    stages,
    blocked,
    blockReason,
    error,
    provider,
    model,
    totalMs: Date.now() - started,
  }
}

/**
 * Offline answer: return the evidence verbatim, never prose.
 *
 * A deterministic template that pretends to reason would be indistinguishable
 * from a model answer in a screenshot, which is exactly the confusion this mode
 * exists to avoid.
 *
 * @param evidence - ranked clauses.
 * @returns a quoted evidence list.
 */
export function offlineAnswer(evidence: readonly { chunk: { docTitle: string; clauseNo: string; text: string } }[]): string {
  const lines = ['离线模式：按证据条款原样返回，不做推理。', '']
  evidence.slice(0, 5).forEach((item, index) => {
    lines.push(`【E${index + 1}】${item.chunk.docTitle} ${item.chunk.clauseNo}`)
    lines.push(item.chunk.text.replace(/\s+/g, ' ').slice(0, 220))
    lines.push('')
  })
  return lines.join('\n').trim()
}

/**
 * Ask the model for an answer grounded in numbered evidence.
 *
 * @param settings - model connection.
 * @param question - user question.
 * @param evidence - ranked clauses.
 * @returns the answer text.
 */
async function generateAnswer(
  settings: GenerationSettings,
  question: string,
  evidence: RetrievalOutcome['items'],
): Promise<{ answer: string }> {
  const numbered = evidence
    .slice(0, 6)
    .map((item, index) => `【E${index + 1}】${item.chunk.docTitle} ${item.chunk.clauseNo}\n${item.chunk.text.slice(0, 800)}`)
    .join('\n\n')
  const response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: [
            '你是合同付款风控助手。只能依据给定的证据条款回答，不得引入证据之外的事实。',
            '每个结论后面必须标注依据的编号，例如「（E1）」。',
            '证据不足时直接说明不足，不要推测。',
          ].join('\n'),
        },
        { role: 'user', content: `## 问题\n${question}\n\n## 证据\n${numbered}` },
      ],
    }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`模型返回 ${response.status}：${body.slice(0, 200)}`)
  }
  const payload: unknown = await response.json()
  const choices = typeof payload === 'object' && payload !== null ? (payload as { choices?: unknown }).choices : undefined
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined
  const message = first !== null && typeof first === 'object' ? (first as { message?: unknown }).message : undefined
  const content = message !== null && typeof message === 'object' && typeof (message as { content?: unknown }).content === 'string'
    ? (message as { content: string }).content
    : ''
  return { answer: content.trim() }
}

/**
 * Build the evidence chain shown under the answer.
 *
 * @param query - parsed question.
 * @param retrieval - retrieval outcome.
 * @param gate - gate report.
 * @returns ordered steps from question to verdict.
 */
function chainOf(
  query: StructuredQuery,
  retrieval: RetrievalOutcome | null,
  gate: { conforms: boolean; violations: readonly { message: string }[] } | null,
): ChainStep[] {
  const steps: ChainStep[] = [
    { kind: 'question', title: '问题', detail: query.text },
    {
      kind: 'intent',
      title: '本体解析',
      detail: [
        query.classes.length > 0 ? `类：${query.classes.join('、')}` : '类：未识别',
        query.properties.length > 0 ? `属性：${query.properties.join('、')}` : '',
        query.identifiers.length > 0 ? `编号：${query.identifiers.join('、')}` : '',
      ].filter(part => part.length > 0).join('；'),
    },
  ]
  if (retrieval !== null && retrieval.facts.length > 0) {
    steps.push({ kind: 'graph', title: '图谱事实', detail: retrieval.facts.slice(0, 4).map(fact => fact.label).join('；') })
  }
  if (retrieval !== null) {
    steps.push({
      kind: 'evidence',
      title: '证据条款',
      detail: retrieval.items.map(item => `${item.chunk.docTitle} ${item.chunk.clauseNo}（${item.finalScore.toFixed(2)}）`).join('；'),
    })
  }
  steps.push({
    kind: 'gate',
    title: '闸门',
    detail: gate === null ? '未执行' : gate.conforms ? '通过' : `未通过：${gate.violations[0]?.message ?? ''}`,
  })
  return steps
}

/**
 * Run the plain-vector baseline for contrast, using the same compatibility rule.
 *
 * @param input - trace inputs.
 * @param query - parsed question.
 * @returns the baseline side.
 */
async function baselineOf(input: TraceInput, query: StructuredQuery): Promise<BaselineSide> {
  try {
    const chunks = await readChunks(input.root, input.domain)
    const index = buildIndex(chunks)
    const hits = index.vector(input.question, Math.max(1, input.topK))
    const incompatible: string[] = []
    const kept: string[] = []
    for (const hit of hits) {
      const verdict = judgeBaseline(hit.chunk, query.classes)
      if (verdict.compatible) kept.push(hit.chunk.chunkId)
      else incompatible.push(`${hit.chunk.docTitle} ${hit.chunk.clauseNo}`)
    }
    return {
      ran: true,
      topK: kept,
      incompatible,
      note: `纯向量 top${hits.length}，用同一个兼容性规则判脏：${incompatible.length} 条不兼容`,
    }
  } catch (failure) {
    return { ran: false, topK: [], incompatible: [], note: `基线未执行：${messageOf(failure)}` }
  }
}

/**
 * Empty trace used when the ontology itself cannot be read.
 *
 * @param input - trace inputs.
 * @param stages - stages collected so far.
 * @param error - failure message.
 * @param totalMs - elapsed time.
 * @returns a trace carrying only the error.
 */
function emptyTrace(input: TraceInput, stages: readonly StageTiming[], error: string, totalMs: number): TraceResult {
  return {
    question: input.question,
    domain: input.domain,
    parsed: null,
    retrieval: null,
    gate: null,
    answer: '',
    claims: [],
    chain: [],
    baseline: { ran: false, topK: [], incompatible: [], note: '' },
    stages,
    blocked: false,
    blockReason: '',
    error,
    provider: 'offline',
    model: '',
    totalMs,
  }
}

/**
 * Today's date in `YYYY-MM-DD`.
 *
 * @returns the local date.
 */
function todayIso(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * Read a message from an unknown thrown value.
 *
 * @param failure - caught value.
 * @returns the message.
 */
function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}
