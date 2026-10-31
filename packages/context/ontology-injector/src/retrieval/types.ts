/**
 * Wire types for the ontology-guided retrieval stack.
 *
 * Everything here stays plain JSON: these structures cross the Typert Remote
 * boundary (panel ⇄ Host) and get written to disk as JSONL, so no class
 * instances, dates, or Maps.
 */

/** One tier of the hybrid retrieval. */
export type RecallTier = 'graph' | 'keyword' | 'vector'

/** Document role, mirroring the four evidence classes the compiler emits. */
export type DocType = 'regulation' | 'contract' | 'ledger' | 'standard' | 'archive'

/** One clause-level evidence unit. */
export interface EvidenceChunk {
  readonly chunkId: string
  readonly docId: string
  readonly docTitle: string
  readonly docType: DocType
  /** Clause marker as printed in the source, e.g. `第三条`. */
  readonly clauseNo: string
  readonly text: string
  /** Local names of the ontology classes this clause talks about. */
  readonly classes: readonly string[]
  /** Local names of the properties it constrains. */
  readonly properties: readonly string[]
  /** Instance identifiers (business ids) the clause names explicitly. */
  readonly identifiers: readonly string[]
  /** 10..50; higher wins ties after the fused score. */
  readonly priority: number
  readonly effectiveFrom: string | null
  readonly effectiveTo: string | null
  readonly deprecated: boolean
}

/** What the question was understood to ask for. */
export interface StructuredQuery {
  readonly text: string
  readonly domain: string
  readonly classes: readonly string[]
  readonly properties: readonly string[]
  /** Entity IRIs resolved from the lexicon or from business identifiers. */
  readonly entities: readonly string[]
  /** Business identifiers seen verbatim in the question (`C-2024-001`). */
  readonly identifiers: readonly string[]
  readonly constraints: readonly string[]
  readonly timeRange: TimeRange
}

/** Half-open validity window; `null` means unbounded. */
export interface TimeRange {
  readonly from: string | null
  readonly to: string | null
}

/** One candidate with the score **of its own tier** plus the final blended score. */
export interface ScoredChunk {
  readonly chunk: EvidenceChunk
  readonly tier: RecallTier
  /** Tier-local score, 0..1. */
  readonly score: number
  /** Why this chunk was recalled — shown verbatim in the panel. */
  readonly reasons: readonly string[]
}

/** Final evidence with the blended score. */
export interface RankedChunk {
  readonly chunk: EvidenceChunk
  readonly finalScore: number
  readonly tiers: readonly RecallTier[]
  readonly reasons: readonly string[]
}

/** One tier's outcome, including the tiers that deliberately did not run. */
export interface TierReport {
  readonly tier: RecallTier
  readonly ran: boolean
  /** `skipped:…` when it did not run; free text otherwise. */
  readonly reason: string
  readonly candidates: number
}

/** A fact pulled from the graph tier, kept for the evidence chain. */
export interface GraphFact {
  readonly subject: string
  readonly predicate: string
  readonly object: string
  readonly label: string
}

/** Chunks removed before ranking, with the reason attached. */
export interface DroppedChunk {
  readonly chunkId: string
  readonly reason: string
}

/** One executed SPARQL query. */
export interface SparqlTrace {
  readonly query: string
  readonly rows: number
  readonly error: string
}

/** Full retrieval snapshot. */
export interface RetrievalOutcome {
  readonly items: readonly RankedChunk[]
  readonly tiers: readonly TierReport[]
  readonly facts: readonly GraphFact[]
  readonly sparql: SparqlTrace
  readonly seeds: readonly string[]
  readonly dropped: readonly DroppedChunk[]
  readonly weights: Record<RecallTier, number>
  readonly elapsedMs: number
}

/** One SHACL violation surfaced by the gate. */
export interface GateViolation {
  readonly shape: string
  readonly severity: 'Violation' | 'Warning' | 'Info'
  readonly message: string
  readonly focusNode: string
  readonly detail: string
}

/** Gate verdict over the generated answer. */
export interface GateReport {
  readonly conforms: boolean
  readonly checked: number
  readonly violations: readonly GateViolation[]
  /** Shapes that could not be executed, e.g. a SPARQL constraint error. */
  readonly errors: readonly string[]
}

/** One hop in the evidence chain from the answer back to the source clause. */
export interface ChainStep {
  readonly kind: 'question' | 'intent' | 'graph' | 'evidence' | 'claim' | 'gate'
  readonly title: string
  readonly detail: string
}

/** One stage timing, so the panel can show where the time went. */
export interface StageTiming {
  readonly stage: string
  readonly ms: number
  readonly note: string
}

/** A plain-vector baseline for contrast; the same compatibility filter is applied. */
export interface BaselineSide {
  readonly ran: boolean
  readonly topK: readonly string[]
  readonly incompatible: readonly string[]
  readonly note: string
}

/** Result of one traced question. */
export interface TraceResult {
  readonly question: string
  readonly domain: string
  readonly parsed: StructuredQuery | null
  readonly retrieval: RetrievalOutcome | null
  readonly gate: GateReport | null
  readonly answer: string
  readonly claims: readonly AnswerClaim[]
  readonly chain: readonly ChainStep[]
  readonly baseline: BaselineSide
  readonly stages: readonly StageTiming[]
  readonly blocked: boolean
  readonly blockReason: string
  readonly error: string
  readonly provider: string
  readonly model: string
  readonly totalMs: number
}

/** One asserted sentence of the answer, with the evidence it rests on. */
export interface AnswerClaim {
  readonly text: string
  readonly evidence: readonly string[]
  readonly verdict: 'supported' | 'unsupported' | 'violated'
}

/** One example question shipped with the panel. */
export interface TraceExample {
  readonly question: string
  readonly note: string
}

/** Chunk library statistics for one domain. */
export interface ChunkLibraryStats {
  readonly domain: string
  readonly documents: number
  readonly chunks: number
  readonly classes: readonly string[]
  readonly updatedAt: string
}

/** Payload for importing a document as evidence chunks. */
export interface IngestRequest {
  readonly domain: string
  readonly title: string
  readonly docType: DocType
  readonly text: string
  /** Effective window, ISO dates; empty string means unbounded. */
  readonly effectiveFrom?: string
  readonly effectiveTo?: string
  readonly priority?: number
}
