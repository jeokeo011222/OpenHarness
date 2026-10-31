/**
 * In-process keyword and vector indexes over the clause library.
 *
 * No external search engine, no embedding service, no Python: a demo machine
 * with Node and a store directory is enough. Both indexes are rebuilt from the
 * chunk library on demand, which keeps them consistent with the file and costs
 * a few milliseconds for the few hundred clauses a domain actually has.
 *
 * Tokenisation is deliberately dependency-free. Chinese has no spaces, so CJK
 * runs are cut into character bigrams (single characters for length-1 runs);
 * Latin words and numbers are lowercased. Bigrams are the standard cheap
 * substitute for a segmenter and behave predictably for domain vocabulary.
 */

import type { EvidenceChunk } from './types.ts'

/** One keyword hit. */
export interface KeywordHit {
  readonly chunk: EvidenceChunk
  /** Zero-based rank by BM25. */
  readonly rank: number
  /** Raw BM25 score, kept for the panel; not normalised. */
  readonly score: number
  /** Share of query terms present in the chunk. */
  readonly coverage: number
}

/** One vector hit. */
export interface VectorHit {
  readonly chunk: EvidenceChunk
  /** Cosine similarity in `[-1, 1]`. */
  readonly similarity: number
}

/** Read-only search surface used by the retrieval service. */
export interface ChunkIndex {
  readonly size: number
  /** Chunks in library order. */
  readonly chunks: readonly EvidenceChunk[]
  /**
   * BM25 keyword search.
   * @param query - question text.
   * @param limit - maximum hits.
   * @returns hits ordered by BM25.
   */
  keyword(query: string, limit: number): KeywordHit[]
  /**
   * Cosine search over the hashed embedding.
   * @param query - question text.
   * @param limit - maximum hits.
   * @returns hits ordered by similarity.
   */
  vector(query: string, limit: number): VectorHit[]
}

/** BM25 term-frequency saturation. */
const K1 = 1.2
/** BM25 length normalisation. */
const B = 0.75
/** Hashing embedding dimension. */
export const EMBEDDING_DIM = 256

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
const WORD = /[a-z0-9]+/gu

/**
 * Tokenise text into index terms.
 *
 * @param text - any text.
 * @returns tokens; empty for blank input.
 */
export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase()
  const tokens: string[] = []
  const runs = lowered.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu) ?? []
  for (const run of runs) {
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.push(run.slice(index, index + 2))
    }
  }
  for (const match of lowered.match(WORD) ?? []) {
    if (match.length >= 1) tokens.push(match)
  }
  return tokens
}

/**
 * Deterministic hashing embedding.
 *
 * Determinism matters more than semantic quality here: the same clause must
 * score the same on every run, or the demo cannot be compared across sessions.
 *
 * @param text - any text.
 * @returns a unit-length vector of `EMBEDDING_DIM`.
 */
export function embed(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIM).fill(0)
  for (const token of tokenize(text)) {
    const bucket = hash32(token) % EMBEDDING_DIM
    const sign = (hash32(`${token}#sign`) & 1) === 0 ? 1 : -1
    vector[bucket] = (vector[bucket] ?? 0) + sign
  }
  return normalize(vector)
}

/**
 * FNV-1a over UTF-16 code units.
 *
 * @param text - input.
 * @returns an unsigned 32-bit hash.
 */
function hash32(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * L2-normalise a vector in place.
 *
 * @param vector - raw counts.
 * @returns the normalised vector (the same array).
 */
function normalize(vector: number[]): number[] {
  let norm = 0
  for (const value of vector) norm += value * value
  const length = Math.sqrt(norm)
  if (length === 0) return vector
  for (let index = 0; index < vector.length; index += 1) vector[index] = (vector[index] ?? 0) / length
  return vector
}

/**
 * Dot product of two unit vectors, i.e. cosine similarity.
 *
 * @param left - unit vector.
 * @param right - unit vector.
 * @returns similarity in `[-1, 1]`.
 */
function cosine(left: readonly number[], right: readonly number[]): number {
  let sum = 0
  const size = Math.min(left.length, right.length)
  for (let index = 0; index < size; index += 1) sum += (left[index] ?? 0) * (right[index] ?? 0)
  return sum
}

/** One posting: chunk position plus term frequency. */
interface Posting {
  readonly position: number
  readonly frequency: number
}

/**
 * Build both indexes over a chunk library.
 *
 * @param chunks - clause library.
 * @returns the search surface.
 */
export function buildIndex(chunks: readonly EvidenceChunk[]): ChunkIndex {
  const postings = new Map<string, Posting[]>()
  const lengths: number[] = []
  const vectors: number[][] = []

  chunks.forEach((chunk, position) => {
    const tokens = tokenize(chunk.text)
    lengths.push(tokens.length)
    const counts = new Map<string, number>()
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    for (const [token, frequency] of counts) {
      const list = postings.get(token)
      if (list === undefined) postings.set(token, [{ position, frequency }])
      else list.push({ position, frequency })
    }
    vectors.push(embed(`${chunk.docTitle} ${chunk.clauseNo} ${chunk.text}`))
  })

  const averageLength = lengths.length === 0
    ? 0
    : lengths.reduce((sum, value) => sum + value, 0) / lengths.length
  const total = chunks.length

  return {
    size: total,
    chunks,

    keyword(query: string, limit: number): KeywordHit[] {
      const terms = [...new Set(tokenize(query))]
      if (terms.length === 0 || total === 0) return []
      const scores = new Float64Array(total)
      const matched = new Uint8Array(total)

      for (const term of terms) {
        const list = postings.get(term)
        if (list === undefined) continue
        const df = list.length
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
        for (const posting of list) {
          const length = lengths[posting.position] ?? 0
          const denominator = posting.frequency + K1 * (1 - B + B * (averageLength === 0 ? 0 : length / averageLength))
          scores[posting.position] = (scores[posting.position] ?? 0)
            + idf * ((posting.frequency * (K1 + 1)) / (denominator === 0 ? 1 : denominator))
          matched[posting.position] = 1
        }
      }

      const hits: { position: number; score: number; coverage: number }[] = []
      for (let position = 0; position < total; position += 1) {
        const score = scores[position] ?? 0
        if (score <= 0 || matched[position] === 0) continue
        const chunk = chunks[position]!
        const present = terms.filter(term => chunk.text.toLowerCase().includes(term)).length
        hits.push({ position, score, coverage: present / terms.length })
      }
      hits.sort((left, right) => right.score - left.score)
      return hits.slice(0, Math.max(1, limit)).map((hit, rank) => ({
        chunk: chunks[hit.position]!,
        rank,
        score: hit.score,
        coverage: hit.coverage,
      }))
    },

    vector(query: string, limit: number): VectorHit[] {
      if (total === 0) return []
      const queryVector = embed(query)
      const hits: { position: number; similarity: number }[] = []
      for (let position = 0; position < total; position += 1) {
        hits.push({ position, similarity: cosine(queryVector, vectors[position] ?? []) })
      }
      hits.sort((left, right) => right.similarity - left.similarity)
      return hits.slice(0, Math.max(1, limit)).map(hit => ({
        chunk: chunks[hit.position]!,
        similarity: hit.similarity,
      }))
    },
  }
}

/**
 * Whether a string contains CJK characters; exported for tests and diagnostics.
 *
 * @param text - input.
 * @returns true when at least one CJK character is present.
 */
export function hasCjk(text: string): boolean {
  return CJK.test(text)
}
