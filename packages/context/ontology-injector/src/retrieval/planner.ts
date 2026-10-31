/**
 * SPARQL planning: structured question in, one executable query out.
 *
 * The planner is the boundary between "what was asked" and "what runs". It is
 * deliberately the only place that writes SPARQL: when the query is built in
 * several places, the statement shown in the evidence-chain panel stops being the
 * statement that produced the answer, and every later debugging session is
 * spent reconciling the two.
 *
 * Scope is bounded on purpose — a subject class, up to one explicit property,
 * and identifier narrowing. That covers the payment-risk questions this system
 * exists for, and a bounded planner is one whose failures are explainable.
 */

import { PREFIXES, type Lexicon } from './lexicon.ts'
import type { StructuredQuery } from './types.ts'

/** Inputs for one plan. */
export interface PlanInput {
  readonly query: StructuredQuery
  readonly lexicon: Lexicon
  /** Graph IRIs to search: the domain ontology plus every instance batch. */
  readonly graphs: readonly string[]
  /** Hard row ceiling. */
  readonly maxRows: number
}

/** One planned query plus the reasoning behind its shape. */
export interface Plan {
  readonly sparql: string
  readonly note: string
  /** Class locals actually constrained, for the panel. */
  readonly classes: readonly string[]
  /** Property locals used as a filter. */
  readonly properties: readonly string[]
  /** Whether a business identifier narrowed the subject set. */
  readonly narrowed: boolean
}

/**
 * Choose the subject class for a question.
 *
 * Preference order: a class the question named, then the domain of a property
 * the question named. Anything else would be guessing.
 *
 * @param query - structured question.
 * @param lexicon - domain vocabulary.
 * @returns the class local name, or `null` when nothing usable was found.
 */
export function subjectClass(query: StructuredQuery, lexicon: Lexicon): string | null {
  for (const name of query.classes) {
    if (lexicon.classes.has(name)) return name
  }
  for (const name of query.properties) {
    const property = lexicon.properties.get(name)
    const domain = property?.domain[0]
    if (domain !== undefined && lexicon.classes.has(domain)) return domain
  }
  return null
}

/**
 * Escape a string for a SPARQL double-quoted literal.
 *
 * @param value - raw value.
 * @returns the escaped body (without quotes).
 */
export function escapeLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
}

/**
 * Render the `VALUES ?g { … }` block scoping a query to specific graphs.
 *
 * @param graphs - graph IRIs.
 * @returns the block, or an empty string when there are no graphs.
 */
function graphBlock(graphs: readonly string[]): string {
  if (graphs.length === 0) return ''
  return `  VALUES ?g { ${graphs.map(graph => `<${graph}>`).join(' ')} }\n`
}

/**
 * Build the query for one structured question.
 *
 * @param input - plan inputs.
 * @returns the plan; `sparql` is empty when nothing could be planned.
 */
export function plan(input: PlanInput): Plan {
  const { query, lexicon, graphs, maxRows } = input
  const graph = graphBlock(graphs)
  const identifiers = query.identifiers.filter(value => /^[A-Za-z0-9_-]+$/.test(value))
  const narrowed = identifiers.length > 0

  const target = subjectClass(query, lexicon)
  const propertyNames = query.properties.filter(name => lexicon.properties.has(name))

  // Case 1: an identifier was named. Find the subject by literal value, then
  // read its facts. Class typing is not required here: imported instance data
  // does not always declare `rdf:type`, and demanding it would return nothing
  // for exactly the questions the demo is built around.
  if (narrowed) {
    const values = identifiers.map(value => `"${escapeLiteral(value)}"`).join(' ')
    // Two ways an identifier can appear in the data: as a literal property
    // (`top:identifier "C-2024-001"`) or as the subject IRI itself
    // (`…/payment#C-2024-001`). Imported instance graphs do both, and supporting
    // only the first makes the graph tier return nothing for exactly the
    // questions the demo is built around.
    const iriPattern = identifiers.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    const typeFilter = target === null ? '' : `    ?s a <${lexicon.classes.get(target)!.iri}> .\n`
    const propertyFilter = propertyNames.length === 0
      ? ''
      : `    FILTER(?p IN (${propertyNames.map(name => `<${lexicon.properties.get(name)!.iri}>`).join(' ')}))\n`
    const sparql = [
      PREFIXES,
      'SELECT DISTINCT ?s ?p ?o WHERE {',
      graph + '    GRAPH ?g {',
      '      {',
      '        SELECT DISTINCT ?s WHERE {',
      graph + '          GRAPH ?g { ?s ?ip ?iv }',
      `          FILTER((isLiteral(?iv) && STR(?iv) IN (${values})) || (isIRI(?s) && REGEX(STR(?s), "(#|/)(${iriPattern})$")))`,
      '        }',
      '      }',
      typeFilter + '      ?s ?p ?o .',
      propertyFilter + '    }',
      '}',
      `LIMIT ${Math.max(1, maxRows)}`,
      '',
    ].join('\n')
    return {
      sparql,
      note: `按业务编号 ${identifiers.join('、')} 定位主体${target === null ? '' : `，类 ${target}`}`,
      classes: target === null ? [] : [target],
      properties: propertyNames,
      narrowed: true,
    }
  }

  // Case 2: no identifier. Constrain by class, optionally by one property.
  if (target === null) {
    return { sparql: '', note: '问句没有解析出可用的类或属性，图谱通道不执行', classes: [], properties: [], narrowed: false }
  }
  const classIri = lexicon.classes.get(target)!.iri
  const propertyFilter = propertyNames.length === 0
    ? ''
    : `      FILTER(?p IN (${propertyNames.map(name => `<${lexicon.properties.get(name)!.iri}>`).join(' ')}))\n`
  const sparql = [
    PREFIXES,
    'SELECT DISTINCT ?s ?p ?o WHERE {',
    graph + '    GRAPH ?g {',
    `      ?s a <${classIri}> .`,
    '      ?s ?p ?o .',
    propertyFilter + '    }',
    '}',
    `LIMIT ${Math.max(1, maxRows)}`,
    '',
  ].join('\n')

  return {
    sparql,
    note: `主体类 ${target}${propertyNames.length === 0 ? '，不限属性' : `，属性 ${propertyNames.join('、')}`}`,
    classes: [target],
    properties: propertyNames,
    narrowed: false,
  }
}
