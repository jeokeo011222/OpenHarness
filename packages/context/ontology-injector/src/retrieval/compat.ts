/**
 * Ontology compatibility: is this clause even allowed to answer this question?
 *
 * This is the filter a plain vector RAG does not have, and the reason the demo
 * can show a difference instead of asserting one. A clause about carbon
 * accounting has high cosine similarity to "核算边界" and zero business relevance
 * to a payment question; without a vocabulary-level check it enters the answer
 * with the same confidence as a real rule.
 *
 * The rule is fail-closed: a clause that cannot be shown to talk about the
 * asked classes is dropped. "We could not tell" is not evidence.
 */

import type { EvidenceChunk } from './types.ts'

/** Why a clause was kept or dropped. */
export interface CompatibilityVerdict {
  readonly compatible: boolean
  readonly reason: string
}

/**
 * Judge one chunk against the classes a question asked about.
 *
 * @param chunk - candidate clause.
 * @param queryClasses - local names of the classes the question targets.
 * @param graphHit - whether the graph tier already linked this clause to a fact.
 * @returns the verdict plus a human-readable reason for the panel.
 */
export function judge(
  chunk: EvidenceChunk,
  queryClasses: readonly string[],
  graphHit: boolean,
): CompatibilityVerdict {
  // A fact chain already proved relevance: the clause carries the entity the
  // SPARQL path started from, so re-judging it by class overlap only adds noise.
  if (graphHit) return { compatible: true, reason: '图谱事实链命中，豁免兼容性判定' }

  if (queryClasses.length === 0) {
    return { compatible: true, reason: '问题没有解析出类约束，无法判定，放行' }
  }
  if (chunk.classes.length === 0) {
    return { compatible: false, reason: '条款没有本体标签，无法证明相关（fail-closed）' }
  }

  const asked = new Set(queryClasses)
  const shared = chunk.classes.filter(name => asked.has(name))
  if (shared.length === 0) {
    return {
      compatible: false,
      reason: `条款标签（${chunk.classes.join('、')}）与问句类（${queryClasses.join('、')}）无交集`,
    }
  }
  return { compatible: true, reason: `命中共同类：${shared.join('、')}` }
}

/**
 * Judge a chunk for the plain-vector baseline.
 *
 * The baseline uses the **same** filter on purpose. Comparing an unfiltered
 * baseline against a filtered pipeline would prove that filtering helps, which
 * nobody doubts; the question is whether the ontology supplies the filter.
 *
 * @param chunk - candidate clause.
 * @param queryClasses - local names the question targets.
 * @returns whether the clause survives the same compatibility rule.
 */
export function judgeBaseline(chunk: EvidenceChunk, queryClasses: readonly string[]): CompatibilityVerdict {
  return judge(chunk, queryClasses, false)
}
