/**
 * Scoring functions for the three-tier retrieval.
 *
 * Every function here is pure and total: no lookup, no I/O, no clock. The score
 * a chunk gets must be reproducible from the numbers printed in the panel,
 * otherwise "why did this clause win" has no answer that survives scrutiny.
 *
 * Design notes that are easy to get wrong:
 *
 * - Keyword and vector scores are **not** normalised by the maximum candidate
 *   score. BM25 and cosine live on different scales; dividing by the batch max
 *   flattens an outlier onto 1.0 and drags every other candidate toward it.
 *   Each tier saturates against a fixed knee instead, so the same raw score
 *   always produces the same contribution.
 * - The vector tier starts below its own baseline (a cosine of 0.30 counts as
 *   zero relevance). Similarity in a high-dimensional space is never near zero
 *   for real text, so an unshifted cosine would make every chunk look relevant.
 * - Document priority is applied **once**, in `finalize`. Applying it inside a
 *   tier and again at fusion squares the effect and makes a single `priority: 50`
 *   outrank a graph-hit clause.
 */

import type { RecallTier } from './types.ts'

/** Tier weights; must sum to 1 or `fuse` rescales. */
export type TierWeights = Record<RecallTier, number>

/** Default weights: the graph is the reason this system exists, so it leads. */
export const DEFAULT_WEIGHTS: TierWeights = { graph: 0.5, keyword: 0.3, vector: 0.2 }

/** Cosine below this counts as no relevance at all. */
const VECTOR_BASELINE = 0.3
/** Shrinks the vector tier so it cannot outrank a graph hit on similarity alone. */
const VECTOR_DISCOUNT = 0.85
/** BM25 rank at which the keyword tier reaches half its ceiling. */
const KEYWORD_KNEE = 6
/** How much each additional tier that also recalled the chunk is worth. */
const AGREEMENT_BONUS = 0.05

/**
 * Saturating transform: monotonic, bounded, and linear near zero.
 *
 * @param value - non-negative raw value.
 * @param knee - value at which the result reaches 0.5.
 * @returns a number in `[0, 1)`.
 */
export function saturate(value: number, knee: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (!Number.isFinite(knee) || knee <= 0) return 0
  return value / (value + knee)
}

/**
 * Graph-tier score from path strength and entity coverage.
 *
 * @param pathStrength - `1` when the subject was found by a planned path, lower for fallbacks.
 * @param coverage - share of the asked entities the fact chain actually covered.
 * @returns a number in `[0, 1]`.
 */
export function graphScore(pathStrength: number, coverage: number): number {
  return 0.7 * clamp01(pathStrength) + 0.3 * clamp01(coverage)
}

/**
 * Keyword-tier score from the candidate rank and query-term coverage.
 *
 * Rank 0 is the best hit, so the saturation knee is applied in **reverse rank
 * space**: `saturate(knee, rank + 1)` decreases as the rank grows. Feeding the
 * rank straight into `saturate` inverts the ordering — the tenth hit would
 * outscore the first — which produced a demo where the worst clause won.
 *
 * @param rank - zero-based rank in the keyword result list.
 * @param coverage - share of query terms present in the clause.
 * @returns a number in `[0, 1]`.
 */
export function keywordScore(rank: number, coverage: number): number {
  return 0.65 * saturate(KEYWORD_KNEE, Math.max(0, rank) + 1) + 0.35 * clamp01(coverage)
}

/**
 * Vector-tier score: shift past the baseline, then discount.
 *
 * @param similarity - cosine similarity in `[-1, 1]`.
 * @returns a number in `[0, 0.85]`.
 */
export function vectorScore(similarity: number): number {
  if (!Number.isFinite(similarity)) return 0
  const shifted = (similarity - VECTOR_BASELINE) / (1 - VECTOR_BASELINE)
  return clamp01(shifted) * VECTOR_DISCOUNT
}

/**
 * Blend per-tier scores into one number.
 *
 * The agreement bonus is what makes "two channels found it" beat "one channel
 * found it strongly" — which is the actual evidence hierarchy behind this
 * design, not a tie-breaker.
 *
 * @param contributions - one entry per tier that recalled the chunk.
 * @param weights - tier weights.
 * @returns the fused score, `[0, 1.1]` before the priority factor.
 */
export function fuse(
  contributions: readonly { tier: RecallTier; score: number }[],
  weights: TierWeights = DEFAULT_WEIGHTS,
): number {
  const total = tierWeightSum(weights)
  if (contributions.length === 0 || total === 0) return 0
  let sum = 0
  for (const item of contributions) {
    sum += (weights[item.tier] ?? 0) * clamp01(item.score)
  }
  const extra = AGREEMENT_BONUS * (contributions.length - 1)
  return (sum / total) + extra
}

/**
 * Multiplier from document priority.
 *
 * @param priority - `10..50`; anything outside is clamped.
 * @returns a factor in `[0.9, 1.1]`.
 */
export function priorityFactor(priority: number): number {
  const bounded = Number.isFinite(priority) ? Math.min(50, Math.max(10, priority)) : 30
  return 1 + (bounded - 30) / 200
}

/**
 * Apply the priority factor. Called exactly once per chunk, at the end.
 *
 * @param fused - score from `fuse`.
 * @param priority - document priority.
 * @returns the final score.
 */
export function finalize(fused: number, priority: number): number {
  return fused * priorityFactor(priority)
}

/**
 * Clamp into `[0, 1]`, mapping NaN to 0.
 *
 * @param value - raw value.
 * @returns the clamped value.
 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * Sum of the tier weights, used to rescale when a deployment sets weights that
 * do not add up to 1.
 *
 * @param weights - tier weights.
 * @returns the sum.
 */
export function tierWeightSum(weights: TierWeights): number {
  return (weights.graph ?? 0) + (weights.keyword ?? 0) + (weights.vector ?? 0)
}

/**
 * Whether the weighted sum of the given tiers is a valid configuration.
 *
 * @param weights - tier weights.
 * @returns an error message, or `null` when the configuration is usable.
 */
export function validateWeights(weights: TierWeights): string | null {
  const values = [weights.graph, weights.keyword, weights.vector]
  if (values.some(value => !Number.isFinite(value) || value < 0)) {
    return '权重必须是非负有限数'
  }
  const sum = tierWeightSum(weights)
  if (sum <= 0) return '权重之和必须大于 0'
  return null
}
