/**
 * Three-tier retrieval over one domain's ontology and clause library.
 *
 * The tiers are tried in cost order and each one's outcome is reported even
 * when it does not run: a panel that only shows what was found cannot explain
 * why the vector tier stayed silent for a graph-dominated question.
 *
 * The graph tier is not "search the graph for the question text". It plans a
 * bounded SPARQL query from the structured question, reads facts, and then maps
 * those facts onto clauses by business identifier. That indirection is the whole
 * point: the answer rests on a fact chain that can be re-run, not on textual
 * proximity that merely looks right.
 */

import { instanceGraphIri, listInstanceBatches, ontologyGraphIri, querySparql } from '../store.ts'
import { judge } from './compat.ts'
import { readChunks } from './chunks.ts'
import { buildIndex } from './index.ts'
import { localName, loadLexicon, type Lexicon } from './lexicon.ts'
import { plan } from './planner.ts'
import {
  DEFAULT_WEIGHTS,
  finalize,
  fuse,
  graphScore,
  keywordScore,
  vectorScore,
  type TierWeights,
} from './scoring.ts'
import type {
  DroppedChunk,
  EvidenceChunk,
  GraphFact,
  RankedChunk,
  RecallTier,
  RetrievalOutcome,
  SparqlTrace,
  StructuredQuery,
  TierReport,
} from './types.ts'

/** Candidate window multiplier applied on top of `topK`. */
const WINDOW_FACTOR = 3
/** Graph-hit strength: identifier match versus class-only overlap. */
const PATH_STRENGTH_EXACT = 1
const PATH_STRENGTH_WEAK = 0.55
/** When stage one already looks this good, skip the vector tier. */
const SUFFICIENCY = 0.45
/** Facts kept for the evidence chain. */
const MAX_FACTS = 60

/** Inputs for one retrieval run. */
export interface RetrieveInput {
  readonly root: string
  readonly domain: string
  readonly query: StructuredQuery
  readonly topK: number
  /** Reference date for validity windows, `YYYY-MM-DD`. */
  readonly today: string
  readonly weights?: TierWeights
}

/** Accumulator for one chunk across tiers. */
interface Candidate {
  readonly chunk: EvidenceChunk
  readonly tierScores: Map<RecallTier, number>
  readonly reasons: string[]
}

/**
 * Run the three tiers for one question.
 *
 * @param input - retrieval inputs.
 * @returns the ranked evidence plus every intermediate state the panel shows.
 */
export async function retrieve(input: RetrieveInput): Promise<RetrievalOutcome> {
  const started = Date.now()
  const weights = input.weights ?? DEFAULT_WEIGHTS
  const window = Math.max(input.topK * WINDOW_FACTOR, input.topK)
  const lexicon = await loadLexicon(input.root, input.domain)
  const chunks = await readChunks(input.root, input.domain)
  const index = buildIndex(chunks)

  const candidates = new Map<string, Candidate>()
  const tiers: TierReport[] = []
  const dropped: DroppedChunk[] = []
  const merge = (chunk: EvidenceChunk, tier: RecallTier, score: number, reason: string): void => {
    const existing = candidates.get(chunk.chunkId)
    if (existing === undefined) {
      const tierScores = new Map<RecallTier, number>()
      tierScores.set(tier, score)
      candidates.set(chunk.chunkId, { chunk, tierScores, reasons: [reason] })
      return
    }
    const previous = existing.tierScores.get(tier) ?? 0
    if (score > previous) existing.tierScores.set(tier, score)
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason)
  }

  // ---- Tier 1: graph -------------------------------------------------------
  const graphOutcome = await runGraphTier(input, lexicon)
  tiers.push(graphOutcome.report)
  for (const hit of graphOutcome.hits) merge(hit.chunk, 'graph', hit.score, hit.reason)

  // ---- Tier 2: keyword -----------------------------------------------------
  const keywordHits = index.keyword(input.query.text, window)
  tiers.push({
    tier: 'keyword',
    ran: true,
    reason: keywordHits.length === 0
      ? '没有条款命中问句词项'
      : `命中 ${keywordHits.length} 条（BM25 + 词项覆盖率）`,
    candidates: keywordHits.length,
  })
  for (const hit of keywordHits) {
    merge(
      hit.chunk,
      'keyword',
      keywordScore(hit.rank, hit.coverage),
      `关键词第 ${hit.rank + 1} 位，词项覆盖 ${(hit.coverage * 100).toFixed(0)}%`,
    )
  }

  // ---- Tier 3: vector ------------------------------------------------------
  const bestStageOne = Math.max(0, ...[...candidates.values()].flatMap(item => [...item.tierScores.values()]))
  const needsVector = candidates.size === 0 || bestStageOne < SUFFICIENCY
  if (needsVector && index.size > 0) {
    const vectorHits = index.vector(input.query.text, window)
    tiers.push({
      tier: 'vector',
      ran: true,
      reason: candidates.size === 0 ? '前两级没有候选，向量兜底' : `前两级最高分 ${bestStageOne.toFixed(2)} 不足，向量兜底`,
      candidates: vectorHits.length,
    })
    for (const hit of vectorHits) {
      merge(hit.chunk, 'vector', vectorScore(hit.similarity), `向量相似度 ${hit.similarity.toFixed(3)}`)
    }
  } else {
    tiers.push({
      tier: 'vector',
      ran: false,
      reason: index.size === 0 ? 'skipped:条款库为空' : 'skipped:前两级已足够',
      candidates: 0,
    })
  }

  // ---- Filter, fuse, rank --------------------------------------------------
  const ranked: RankedChunk[] = []
  for (const candidate of candidates.values()) {
    const expired = isExpired(candidate.chunk, input.today)
    if (expired !== null) {
      dropped.push({ chunkId: candidate.chunk.chunkId, reason: expired })
      continue
    }
    const graphHit = candidate.tierScores.has('graph')
    const verdict = judge(candidate.chunk, input.query.classes, graphHit)
    if (!verdict.compatible) {
      dropped.push({ chunkId: candidate.chunk.chunkId, reason: verdict.reason })
      continue
    }
    const contributions = [...candidate.tierScores.entries()].map(([tier, score]) => ({ tier, score }))
    const fused = fuse(contributions, weights)
    ranked.push({
      chunk: candidate.chunk,
      finalScore: finalize(fused, candidate.chunk.priority),
      tiers: [...candidate.tierScores.keys()],
      reasons: [...candidate.reasons, verdict.reason],
    })
  }

  ranked.sort((left, right) => {
    if (right.finalScore !== left.finalScore) return right.finalScore - left.finalScore
    return left.chunk.chunkId.localeCompare(right.chunk.chunkId)
  })

  return {
    items: ranked.slice(0, input.topK),
    tiers,
    facts: graphOutcome.facts,
    sparql: graphOutcome.trace,
    seeds: graphOutcome.seeds,
    dropped,
    weights,
    elapsedMs: Date.now() - started,
  }
}

/** Graph-tier result bundle. */
interface GraphTierOutcome {
  readonly report: TierReport
  readonly hits: readonly { chunk: EvidenceChunk; score: number; reason: string }[]
  readonly facts: readonly GraphFact[]
  readonly trace: SparqlTrace
  readonly seeds: readonly string[]
}

/**
 * Run the graph tier: plan, execute, then map facts back onto clauses.
 *
 * @param input - retrieval inputs.
 * @param lexicon - domain vocabulary.
 * @returns hits, facts, and the executed query.
 */
async function runGraphTier(input: RetrieveInput, lexicon: Lexicon): Promise<GraphTierOutcome> {
  const batches = await listInstanceBatches(input.root, input.domain)
  const graphs = [ontologyGraphIri(input.domain), ...batches.map(batch => instanceGraphIri(input.domain, batch.batch))]
  const planned = plan({
    query: input.query,
    lexicon,
    graphs,
    maxRows: MAX_FACTS * 4,
  })
  if (planned.sparql.length === 0) {
    return {
      report: { tier: 'graph', ran: false, reason: planned.note, candidates: 0 },
      hits: [],
      facts: [],
      trace: { query: '', rows: 0, error: '' },
      seeds: [],
    }
  }

  let rows: readonly Record<string, string>[] = []
  let error = ''
  try {
    const result = await querySparql(input.root, planned.sparql)
    rows = result.rows
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure)
  }

  const facts: GraphFact[] = []
  const seen = new Set<string>()
  const ontologyNamespace = lexicon.namespace
  for (const row of rows) {
    const subject = row.s ?? ''
    const predicate = row.p ?? ''
    const object = row.o ?? ''
    if (subject.length === 0 || predicate.length === 0) continue
    // Structural triples are not facts about the business; they only describe
    // the vocabulary and would drown the panel in type declarations.
    if (predicate.startsWith('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')) continue
    if (predicate.startsWith(ontologyNamespace) && subject.startsWith(ontologyNamespace)) continue
    if (predicate.startsWith('http://www.w3.org/2000/01/rdf-schema#')) continue
    if (predicate.startsWith('http://www.w3.org/2002/07/owl#')) continue
    const key = `${subject}|${predicate}|${object}`
    if (seen.has(key)) continue
    seen.add(key)
    facts.push({
      subject,
      predicate,
      object,
      label: `${localName(subject)} · ${localName(predicate)} · ${object.startsWith('http') ? localName(object) : object}`,
    })
    if (facts.length >= MAX_FACTS) break
  }

  const chunkPool = await readChunks(input.root, input.domain)
  const seeds = [...new Set(facts.map(fact => localName(fact.subject)))]
  const identifierPool = new Set<string>()
  for (const fact of facts) {
    identifierPool.add(localName(fact.subject))
    if (!fact.object.startsWith('http')) identifierPool.add(fact.object)
  }
  const askedIdentifiers = input.query.identifiers

  const hits: { chunk: EvidenceChunk; score: number; reason: string }[] = []
  for (const chunk of chunkPool) {
    const shared = chunk.identifiers.filter(value => identifierPool.has(value))
    if (shared.length > 0) {
      const coverage = askedIdentifiers.length === 0
        ? 1
        : shared.length / askedIdentifiers.length
      hits.push({
        chunk,
        score: graphScore(PATH_STRENGTH_EXACT, coverage),
        reason: `事实链命中业务编号 ${shared.join('、')}`,
      })
      continue
    }
    const asked = new Set(input.query.properties)
    const sharedProperties = chunk.properties.filter(name => asked.has(name))
    if (sharedProperties.length > 0 && askedIdentifiers.length === 0) {
      hits.push({
        chunk,
        score: graphScore(PATH_STRENGTH_WEAK, sharedProperties.length / Math.max(1, asked.size)),
        reason: `条款约束了问句中的属性 ${sharedProperties.join('、')}`,
      })
    }
  }

  return {
    report: {
      tier: 'graph',
      ran: true,
      reason: error.length > 0
        ? `SPARQL 失败：${error}`
        : `事实 ${facts.length} 条，映射到 ${hits.length} 条条款`,
      candidates: hits.length,
    },
    hits,
    facts,
    trace: { query: planned.sparql, rows: rows.length, error },
    seeds,
  }
}

/**
 * Check a clause's validity window.
 *
 * @param chunk - candidate clause.
 * @param today - reference date.
 * @returns a drop reason, or `null` when the clause is usable.
 */
function isExpired(chunk: EvidenceChunk, today: string): string | null {
  if (chunk.deprecated) return '已废止版本，不进入证据'
  if (chunk.effectiveFrom !== null && chunk.effectiveFrom > today) return `尚未生效（${chunk.effectiveFrom} 起）`
  if (chunk.effectiveTo !== null && chunk.effectiveTo < today) return `已失效（截至 ${chunk.effectiveTo}）`
  return null
}
