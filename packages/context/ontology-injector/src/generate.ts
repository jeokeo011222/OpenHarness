/**
 * One-shot ontology generation: clause slicing, DeepSeek extraction, and merge
 * into an existing model.
 *
 * The model is asked for structured classes and properties rather than Turtle,
 * so a malformed answer can never corrupt the stored graph: every added node is
 * built by the Host emitter from validated JSON fields.
 */

import { mergeExtraction, type Extraction, type OntologyModel } from './model.ts'
import type { GenerationStep } from './types.ts'

/** Connection settings for the extraction model. */
export interface GenerationSettings {
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
  readonly maxClauses: number
}

/** Result of one clause extraction attempt. */
export interface ClauseOutcome {
  readonly clause: string
  readonly added: number
  readonly error: string
}

/** Outcome of a full generation run. */
export interface GenerationOutcome {
  readonly model: OntologyModel
  readonly outcomes: readonly ClauseOutcome[]
  readonly warnings: readonly string[]
  readonly steps: readonly GenerationStep[]
}

/** One clause group of the source document. */
export interface TextSlice {
  readonly clause: string
  readonly text: string
}

const CLAUSE_MARKER = /(第[一二三四五六七八九十百千万零\d]+[章节条款部分卷编篇])|(§\s*\d+)/g
const NUMBERED_MARKER = /(^|\n)\s*\d+\.\s+/g

/**
 * Slice a document into clause groups, falling back to numbered paragraphs.
 * @param text - the extracted document text.
 * @returns clause-labelled slices, or one whole-document slice when no marker exists.
 */
export function sliceByClauses(text: string): TextSlice[] {
  const markers: Array<{ clause: string; index: number }> = []
  for (const match of text.matchAll(CLAUSE_MARKER)) {
    markers.push({ clause: match[0], index: match.index })
  }
  if (markers.length === 0) {
    for (const match of text.matchAll(NUMBERED_MARKER)) {
      markers.push({ clause: `Paragraph ${markers.length + 1}`, index: match.index })
    }
  }
  if (markers.length === 0) return text.trim().length > 0 ? [{ clause: 'Whole document', text: text.trim() }] : []

  const slices: TextSlice[] = []
  for (const [index, marker] of markers.entries()) {
    const end = markers[index + 1]?.index ?? text.length
    const body = text.slice(marker.index, end).trim()
    if (body.length > 10) slices.push({ clause: marker.clause, text: body })
  }
  return slices.length > 0 ? slices : [{ clause: '全文', text: text.trim() }]
}

const SYSTEM_PROMPT = `你是企业本体工程师。从制度文本片段中抽取业务本体，只输出 JSON。

输出结构：
{
  "classes": [{"name":"Contract","label":"合同","comment":"合同的业务含义"}],
  "properties": [
    {"name":"hasParty","kind":"object","label":"签约方","domain":"Contract","range":"Party","comment":"说明"},
    {"name":"contractNo","kind":"datatype","label":"合同编号","domain":"Contract","range":"xsd:string","comment":"说明"}
  ],
  "confidence": 0.9
}

约束：
1. name 必须是英文驼峰标识（首字母大写表示类，首字母小写表示属性），只含字母和数字
2. label 与 comment 使用文档语言（中文），不超过 40 字
3. 复用“已有本体”中列出的类与属性标识，不要重复定义
4. kind 只能是 object 或 datatype；datatype 的 range 使用 xsd:string / xsd:date / xsd:decimal
5. 只抽取片段中明确出现的概念与关系，没有可抽取内容时返回空数组`

/** Validate an unknown JSON payload into a typed extraction. */
function parseExtraction(raw: unknown): Extraction {
  if (raw === null || typeof raw !== 'object') throw new Error('Model answer is not a JSON object')
  const record = raw as Record<string, unknown>
  const classes: Extraction['classes'][number][] = []
  const properties: Extraction['properties'][number][] = []
  const readString = (entry: Record<string, unknown>, key: string): string => {
    const value = entry[key]
    return typeof value === 'string' ? value.trim() : ''
  }

  if (Array.isArray(record.classes)) {
    for (const entry of record.classes) {
      if (entry === null || typeof entry !== 'object') continue
      const fields = entry as Record<string, unknown>
      const name = readString(fields, 'name') || readString(fields, 'label')
      if (!name) continue
      classes.push({ name, label: readString(fields, 'label'), comment: readString(fields, 'comment') })
    }
  }

  if (Array.isArray(record.properties)) {
    for (const entry of record.properties) {
      if (entry === null || typeof entry !== 'object') continue
      const fields = entry as Record<string, unknown>
      const name = readString(fields, 'name') || readString(fields, 'label')
      if (!name) continue
      const rawKind = readString(fields, 'kind')
      const range = readString(fields, 'range')
      const kind = rawKind === 'object' || rawKind === 'datatype'
        ? rawKind
        : range.startsWith('xsd:') || range === '' ? 'datatype' : 'object'
      properties.push({
        name,
        kind,
        label: readString(fields, 'label'),
        comment: readString(fields, 'comment'),
        domain: readString(fields, 'domain'),
        range,
      })
    }
  }

  const confidence = typeof record.confidence === 'number' ? record.confidence : 0.5
  return { classes, properties, confidence }
}

/** Call the extraction model for one clause. */
async function requestExtraction(
  settings: GenerationSettings,
  model: OntologyModel,
  slice: TextSlice,
  signal: AbortSignal | undefined,
): Promise<Extraction> {
  const existingClasses = model.classes.map(item => `${item.id}${item.label ? `(${item.label})` : ''}`)
  const existingProperties = model.properties.map(item => `${item.id}${item.label ? `(${item.label})` : ''}`)
  const prompt = [
    '## 已有本体（必须复用）',
    `类：${existingClasses.length > 0 ? existingClasses.join('、') : '（空）'}`,
    `属性：${existingProperties.length > 0 ? existingProperties.join('、') : '（空）'}`,
    '',
    `## 制度片段（${slice.clause}）`,
    slice.text.slice(0, 6000),
    '',
    '## 输出',
    '按系统提示的结构返回 JSON。',
  ].join('\n')

  const response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Extraction model answered ${response.status}: ${body.slice(0, 200)}`)
  }
  const payload: unknown = await response.json()
  const content = typeof payload === 'object' && payload !== null
    ? (payload as { choices?: unknown }).choices
    : undefined
  const first: unknown = Array.isArray(content) ? content[0] : undefined
  const message = first !== null && typeof first === 'object'
    ? (first as { message?: unknown }).message
    : undefined
  const text = message !== null && typeof message === 'object' && typeof (message as { content?: unknown }).content === 'string'
    ? (message as { content: string }).content
    : ''
  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim()
  try {
    return parseExtraction(JSON.parse(cleaned))
  } catch (error) {
    throw new Error(`Model answer is not valid extraction JSON: ${(error as Error).message}`)
  }
}

/**
 * Generate classes and properties from document text and merge them into a model.
 *
 * A clause that fails is recorded and skipped; the run only fails when every
 * clause fails, so one flaky answer does not discard the rest of the document.
 *
 * @param text - extracted document text.
 * @param model - base model; the returned model is the merged copy.
 * @param settings - extraction model connection settings.
 * @param signal - cancellation from the Remote call.
 * @returns merged model, per-clause outcomes, warnings, and stage log.
 */
export async function generateOntology(
  text: string,
  model: OntologyModel,
  settings: GenerationSettings,
  signal: AbortSignal | undefined,
): Promise<GenerationOutcome> {
  const steps: GenerationStep[] = []
  const warnings: string[] = []
  const outcomes: ClauseOutcome[] = []
  const slices = sliceByClauses(text)

  if (slices.length === 0) {
    throw new Error('The document has no extractable text')
  }
  steps.push({ stage: 'read', message: `Sliced the document into ${slices.length} clause groups`, status: 'done' })

  const selected = slices.slice(0, settings.maxClauses)
  if (slices.length > selected.length) {
    warnings.push(`The document has ${slices.length} clause groups; this run processed the first ${selected.length}`)
  }

  const merged = structuredClone(model)
  let succeeded = 0
  for (const slice of selected) {
    signal?.throwIfAborted()
    try {
      const extraction = await requestExtraction(settings, merged, slice, signal)
      const added = mergeExtraction(merged, extraction, slice.clause)
      outcomes.push({ clause: slice.clause, added: added.length, error: '' })
      succeeded += 1
      steps.push({
        stage: 'extract',
        message: `${slice.clause}: added ${added.length} concepts (confidence ${extraction.confidence.toFixed(2)})`,
        status: added.length > 0 ? 'done' : 'skipped',
      })
    } catch (error) {
      if (signal?.aborted) throw new Error('Generation cancelled')
      const message = (error as Error).message
      outcomes.push({ clause: slice.clause, added: 0, error: message })
      steps.push({ stage: 'extract', message: `${slice.clause}: failed ${message.slice(0, 120)}`, status: 'failed' })
    }
  }

  if (succeeded === 0) {
    throw new Error(`Every clause failed to extract. ${outcomes.find(item => item.error)?.error ?? ''}`.trim())
  }

  steps.push({
    stage: 'merge',
    message: `Merged model: ${merged.classes.length} classes, ${merged.properties.length} properties`,
    status: 'done',
  })
  return { model: merged, outcomes, warnings, steps }
}
