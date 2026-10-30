/**
 * Gold-standard evaluation: precision and recall of the classes and properties
 * a domain declares against a reference Turtle document.
 *
 * Matching is by compact identifier, so a gold standard written against the
 * same namespace compares entity-to-entity without resolving full IRIs.
 */

import { parseTurtle, type OntologyModel } from './model.ts'
import type { QualityMetric, QualityReport } from './types.ts'

/**
 * Compare two identifier sets.
 *
 * @param expected - identifiers the gold standard declares.
 * @param actual - identifiers the evaluated graph declares.
 * @returns counts, precision, recall, and the differing identifiers, sorted.
 */
function compare(expected: ReadonlySet<string>, actual: ReadonlySet<string>): QualityMetric {
  const matched: string[] = []
  for (const id of actual) {
    if (expected.has(id)) matched.push(id)
  }
  const missing = [...expected].filter(id => !actual.has(id)).sort((left, right) => left.localeCompare(right))
  const unexpected = [...actual].filter(id => !expected.has(id)).sort((left, right) => left.localeCompare(right))
  return {
    expected: expected.size,
    actual: actual.size,
    matched: matched.length,
    precision: actual.size === 0 ? 1 : matched.length / actual.size,
    recall: expected.size === 0 ? 1 : matched.length / expected.size,
    missing,
    unexpected,
  }
}

/**
 * Build the identifier sets an ontology model declares.
 * @param model - parsed ontology.
 * @returns class ids and property ids.
 */
function identifiersOf(model: OntologyModel): { classes: Set<string>; properties: Set<string> } {
  return {
    classes: new Set(model.classes.map(item => item.id)),
    properties: new Set(model.properties.map(item => item.id)),
  }
}

/**
 * Score one graph against a gold-standard Turtle document.
 *
 * @param domain - domain id the graph belongs to.
 * @param version - version the graph was read from, `null` for a working graph.
 * @param currentTurtle - Turtle of the evaluated graph.
 * @param goldTurtle - Turtle of the gold standard.
 * @param baselineName - file name of the uploaded gold standard.
 * @returns per-family precision and recall.
 * @throws {Error} when either document is not valid Turtle.
 */
export function evaluateQuality(
  domain: string,
  version: string | null,
  currentTurtle: string,
  goldTurtle: string,
  baselineName: string,
): QualityReport {
  const current = identifiersOf(parseTurtle(currentTurtle, domain))
  const gold = identifiersOf(parseTurtle(goldTurtle, domain))
  return {
    domain,
    version,
    baselineName,
    classes: compare(gold.classes, current.classes),
    properties: compare(gold.properties, current.properties),
  }
}
