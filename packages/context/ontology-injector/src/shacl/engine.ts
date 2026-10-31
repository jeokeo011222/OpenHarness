/**
 * Constraint gate: run the domain's SHACL shapes over the instance graphs.
 *
 * Two things this engine refuses to do:
 *
 * - **Skip a shape silently.** A rule that could not run is reported in
 *   `errors` and makes the report non-conforming. A gate that quietly drops a
 *   rule produces a green result that means nothing, which is worse than a red
 *   one that means something.
 * - **Trust the declared prefixes.** Shape files in the wild use their own
 *   prefixes (`pay:`), and the store does not keep Turtle prefix bindings. Every
 *   prefixed term is therefore resolved through the vocabulary by local name,
 *   with the standard prefixes kept as an explicit first choice.
 */

import { ontologyGraphIri, querySparql } from '../store.ts'
import { localName, PREFIXES, type Lexicon } from '../retrieval/lexicon.ts'
import type { GateReport, GateViolation } from '../retrieval/types.ts'
import type { NodeShape, PropertyConstraint, SparqlConstraint } from './shapes.ts'

/** Cap on violations reported per shape; a broken dataset would otherwise flood the panel. */
const MAX_PER_SHAPE = 25

/** Prefixes resolved without a lookup. */
const BUILTIN_PREFIXES: Record<string, string> = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  sh: 'http://www.w3.org/ns/shacl#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
}

/** Inputs for one gate run. */
export interface GateInput {
  readonly root: string
  readonly domain: string
  /** Instance graphs to check. */
  readonly graphs: readonly string[]
  readonly shapes: readonly NodeShape[]
  readonly lexicon: Lexicon
}

/**
 * Run every shape and collect violations.
 *
 * @param input - gate inputs.
 * @returns the verdict, the violations, and the shapes that could not run.
 */
export async function runGate(input: GateInput): Promise<GateReport> {
  const violations: GateViolation[] = []
  const errors: string[] = []
  let checked = 0

  for (const shape of input.shapes) {
    const scoped = input.graphs.length > 0
    if (!scoped) {
      errors.push(`${shape.label}：没有实例图可检查`)
      continue
    }
    for (const constraint of shape.sparql) {
      checked += 1
      const outcome = await runSparqlConstraint(input, shape, constraint)
      if (outcome.error.length > 0) errors.push(`${shape.label}：${outcome.error}`)
      violations.push(...outcome.violations)
    }
    for (const constraint of shape.properties) {
      checked += 1
      const outcome = await runPropertyConstraint(input, shape, constraint)
      if (outcome.error.length > 0) errors.push(`${shape.label}：${outcome.error}`)
      violations.push(...outcome.violations)
    }
  }

  return {
    conforms: violations.every(item => item.severity !== 'Violation') && errors.length === 0,
    checked,
    violations,
    errors,
  }
}

/** Result of one constraint execution. */
interface ConstraintOutcome {
  readonly violations: readonly GateViolation[]
  readonly error: string
}

/**
 * Execute one `sh:sparql` constraint: any returned row is a violation.
 *
 * @param input - gate inputs.
 * @param shape - owning shape.
 * @param constraint - the SPARQL constraint.
 * @returns violations for this constraint.
 */
async function runSparqlConstraint(
  input: GateInput,
  shape: NodeShape,
  constraint: SparqlConstraint,
): Promise<ConstraintOutcome> {
  const scoped = scopeWhere(constraint.select, input.graphs, input.lexicon)
  if (scoped.error.length > 0) return { violations: [], error: scoped.error }

  let rows: readonly Record<string, string>[]
  try {
    const result = await querySparql(input.root, scoped.query)
    rows = result.rows
  } catch (failure) {
    return { violations: [], error: `SPARQL 约束执行失败：${messageOf(failure)}` }
  }

  const violations: GateViolation[] = []
  for (const row of rows.slice(0, MAX_PER_SHAPE)) {
    const focus = row.this || row.this1 || ''
    violations.push({
      shape: shape.label,
      severity: constraint.severity,
      message: renderMessage(constraint.message, row) || shape.label,
      focusNode: focus,
      detail: Object.entries(row)
        .filter(([name]) => name !== 'this')
        .map(([name, value]) => `${name}=${value}`)
        .join(' '),
    })
  }
  return { violations, error: '' }
}

/**
 * Execute one `sh:property` constraint.
 *
 * @param input - gate inputs.
 * @param shape - owning shape.
 * @param constraint - the property constraint.
 * @returns violations for this constraint.
 */
async function runPropertyConstraint(
  input: GateInput,
  shape: NodeShape,
  constraint: PropertyConstraint,
): Promise<ConstraintOutcome> {
  const values = input.graphs.map(graph => `<${graph}>`).join(' ')
  const className = shape.targetClass.startsWith('http')
    ? shape.targetClass
    : resolveIri(input.lexicon, shape.targetClass)
  if (className === null) return { violations: [], error: `目标类 ${shape.targetClass} 不在本体中` }
  const pathIri = constraint.path.startsWith('http')
    ? constraint.path
    : resolveIri(input.lexicon, constraint.path)
  if (pathIri === null) return { violations: [], error: `路径 ${constraint.path} 不在本体中` }

  const violations: GateViolation[] = []
  const run = async (query: string, render: (row: Record<string, string>) => GateViolation): Promise<string> => {
    try {
      const result = await querySparql(input.root, `${PREFIXES}${query}`)
      for (const row of result.rows.slice(0, MAX_PER_SHAPE)) violations.push(render(row))
      return ''
    } catch (failure) {
      return `属性约束执行失败：${messageOf(failure)}`
    }
  }

  if (constraint.minCount !== null) {
    const error = await run(
      `SELECT ?s (COUNT(?v) AS ?n) WHERE { VALUES ?g { ${values} } GRAPH ?g { ?s a <${className}> . OPTIONAL { ?s <${pathIri}> ?v } } } GROUP BY ?s HAVING (COUNT(?v) < ${constraint.minCount})`,
      row => ({
        shape: shape.label,
        severity: constraint.severity,
        message: renderMessage(constraint.message, row) || `缺少 ${localName(pathIri)}（至少 ${constraint.minCount} 个）`,
        focusNode: row.s ?? '',
        detail: `实际 ${row.n ?? '0'} 个`,
      }),
    )
    if (error.length > 0) return { violations, error }
  }

  if (constraint.maxCount !== null) {
    const error = await run(
      `SELECT ?s (COUNT(?v) AS ?n) WHERE { VALUES ?g { ${values} } GRAPH ?g { ?s a <${className}> . OPTIONAL { ?s <${pathIri}> ?v } } } GROUP BY ?s HAVING (COUNT(?v) > ${constraint.maxCount})`,
      row => ({
        shape: shape.label,
        severity: constraint.severity,
        message: renderMessage(constraint.message, row) || `${localName(pathIri)} 超过 ${constraint.maxCount} 个`,
        focusNode: row.s ?? '',
        detail: `实际 ${row.n ?? '0'} 个`,
      }),
    )
    if (error.length > 0) return { violations, error }
  }

  if (constraint.className !== null) {
    const expected = constraint.className.startsWith('http')
      ? constraint.className
      : resolveIri(input.lexicon, constraint.className)
    if (expected === null) return { violations, error: `约束类 ${constraint.className} 不在本体中` }
    const error = await run(
      `SELECT DISTINCT ?s ?v WHERE { VALUES ?g { ${values} } GRAPH ?g { ?s a <${className}> ; <${pathIri}> ?v . FILTER NOT EXISTS { ?v a <${expected}> } } }`,
      row => ({
        shape: shape.label,
        severity: constraint.severity,
        message: renderMessage(constraint.message, row) || `${localName(pathIri)} 指向的对象不是 ${localName(expected)}`,
        focusNode: row.s ?? '',
        detail: `对象=${row.v ?? ''}`,
      }),
    )
    if (error.length > 0) return { violations, error }
  }

  return { violations, error: '' }
}

/**
 * Scope a SHACL-SPARQL `sh:select` body to a set of graphs.
 *
 * The body is wrapped rather than rewritten: `$this` stays a variable, and the
 * existing WHERE body keeps its shape, so a constraint that works standalone
 * works here too.
 *
 * @param select - the declared select text.
 * @param graphs - graph IRIs to search.
 * @param lexicon - vocabulary used to expand prefixed terms.
 * @returns the executable query, or an error explaining why it could not be built.
 */
export function scopeWhere(
  select: string,
  graphs: readonly string[],
  lexicon: Lexicon,
): { query: string; error: string } {
  const expanded = expandPrefixed(select, lexicon)
  if (expanded.error.length > 0) return { query: '', error: expanded.error }
  const text = expanded.text
  const whereIndex = text.search(/\bWHERE\b/i)
  if (whereIndex < 0) return { query: '', error: '约束缺少 WHERE 子句' }
  const openIndex = text.indexOf('{', whereIndex)
  const closeIndex = text.lastIndexOf('}')
  if (openIndex < 0 || closeIndex <= openIndex) return { query: '', error: '约束的 WHERE 子句不完整' }

  const prologue = text.slice(0, whereIndex)
  const body = text.slice(openIndex + 1, closeIndex)
  const tail = text.slice(closeIndex + 1)
  const values = graphs.map(graph => `<${graph}>`).join(' ')
  const query = `${PREFIXES}${prologue}WHERE { VALUES ?g { ${values} } GRAPH ?g {${body}} } ${tail}`.trim()
  return { query, error: '' }
}

/**
 * Replace `prefix:local` terms with absolute IRIs.
 *
 * Standard prefixes are **left untouched**: the prologue already declares them,
 * and rewriting `xsd:decimal(?v)` into `<…#decimal>(?v)` turns a casting call
 * into an unknown function — the FILTER then evaluates to false for every row
 * and the constraint silently stops firing. That failure mode looks exactly
 * like "no violations", which is the worst possible way for a gate to be wrong.
 *
 * Only foreign prefixes (a shape file's own `pay:`) are expanded, and they are
 * resolved by local name through the vocabulary. An unresolvable prefix is an
 * error, not a silent pass-through.
 *
 * @param text - SPARQL text.
 * @param lexicon - domain vocabulary.
 * @returns the expanded text, or an error naming the unknown prefix.
 */
export function expandPrefixed(text: string, lexicon: Lexicon): { text: string; error: string } {
  const pattern = /\b([A-Za-z][A-Za-z0-9_-]*):([A-Za-z_][A-Za-z0-9_-]*)\b/g
  const unknown = new Set<string>()
  const replaced = text.replace(pattern, (match, prefix: string, local: string) => {
    if (/^(https?|urn)$/i.test(prefix)) return match
    if (BUILTIN_PREFIXES[prefix] !== undefined) return match
    const iri = resolveIri(lexicon, local)
    if (iri !== null) return `<${iri}>`
    unknown.add(prefix)
    return match
  })
  if (unknown.size > 0) {
    return { text, error: `无法解析前缀 ${[...unknown].join('、')}（本体中找不到对应的本地名）` }
  }
  return { text: replaced, error: '' }
}

/**
 * Resolve a local name to an IRI through the vocabulary.
 *
 * @param lexicon - domain vocabulary.
 * @param localOrIri - local name or absolute IRI.
 * @returns the IRI, or `null`.
 */
function resolveIri(lexicon: Lexicon, localOrIri: string): string | null {
  if (localOrIri.startsWith('http')) return localOrIri
  const local = localName(localOrIri)
  return lexicon.classes.get(local)?.iri ?? lexicon.properties.get(local)?.iri ?? null
}

/**
 * Render a SHACL message template against one result row.
 *
 * @param template - message with `{?name}` placeholders.
 * @param row - bound values.
 * @returns the rendered message.
 */
function renderMessage(template: string, row: Record<string, string>): string {
  if (template.length === 0) return ''
  return template.replace(/\{\?([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => row[name] ?? match)
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

/**
 * Graph IRIs a gate run should read; exposed so the panel shows the same list.
 *
 * @param domain - domain id.
 * @returns the ontology graph IRI (instance graphs are added by the caller).
 */
export function gateOntologyGraph(domain: string): string {
  return ontologyGraphIri(domain)
}
