/**
 * SHACL shapes read from the domain graph.
 *
 * Only the subset this product actually ships is supported, and each unsupported
 * construct is reported instead of ignored: a gate that silently skips a rule is
 * worse than one that refuses to run it, because the first produces a green
 * result that means nothing.
 *
 * Supported: `sh:targetClass`, `sh:sparql` (SELECT constraint), and
 * `sh:property` with `sh:path`, `sh:minCount`, `sh:maxCount`, `sh:class`.
 */

import { ontologyGraphIri, querySparql, shapesGraphIri } from '../store.ts'
import { localName } from '../retrieval/lexicon.ts'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label'
const SH = 'http://www.w3.org/ns/shacl#'

/** One `sh:sparql` constraint. */
export interface SparqlConstraint {
  readonly select: string
  readonly message: string
  readonly severity: GateSeverity
}

/** One `sh:property` constraint. */
export interface PropertyConstraint {
  readonly path: string
  readonly minCount: number | null
  readonly maxCount: number | null
  readonly className: string | null
  readonly message: string
  readonly severity: GateSeverity
}

/** Severity reported by the gate. */
export type GateSeverity = 'Violation' | 'Warning' | 'Info'

/** One node shape. */
export interface NodeShape {
  readonly iri: string
  readonly label: string
  readonly targetClass: string
  readonly severity: GateSeverity
  readonly sparql: readonly SparqlConstraint[]
  readonly properties: readonly PropertyConstraint[]
}

/**
 * Read every node shape in a domain.
 *
 * Shapes are read from the domain's shapes graph and the live ontology graph
 * together: `writeShapes` puts authored shapes in the dedicated shapes graph,
 * while a domain imported from the legacy layout may still carry its shapes
 * inside the live graph, and both must keep working.
 *
 * The whole graph is pulled once and indexed locally: SHACL structures are blank
 * nodes linked by several predicates, and reconstructing them from several
 * targeted queries is both slower and easier to get wrong.
 *
 * @param root - ontology store root.
 * @param domain - domain id.
 * @returns shapes in IRI order.
 */
export async function loadShapes(root: string, domain: string): Promise<NodeShape[]> {
  const graph = ontologyGraphIri(domain)
  const shapesGraph = shapesGraphIri(domain)
  const result = await querySparql(
    root,
    `SELECT ?s ?p ?o WHERE { { GRAPH <${shapesGraph}> { ?s ?p ?o } } UNION { GRAPH <${graph}> { ?s ?p ?o } } }`,
  )

  const types = new Map<string, Set<string>>()
  const edges = new Map<string, { predicate: string; object: string }[]>()
  for (const row of result.rows) {
    const subject = row.s ?? ''
    const predicate = row.p ?? ''
    const object = row.o ?? ''
    if (subject.length === 0 || predicate.length === 0) continue
    if (predicate === RDF_TYPE) {
      const set = types.get(subject) ?? new Set<string>()
      set.add(object)
      types.set(subject, set)
      continue
    }
    const list = edges.get(subject)
    if (list === undefined) edges.set(subject, [{ predicate, object }])
    else list.push({ predicate, object })
  }

  const value = (subject: string, predicate: string): string =>
    edges.get(subject)?.find(edge => edge.predicate === predicate)?.object ?? ''
  const values = (subject: string, predicate: string): string[] =>
    (edges.get(subject) ?? []).filter(edge => edge.predicate === predicate).map(edge => edge.object)

  const shapes: NodeShape[] = []
  for (const [subject, kinds] of types) {
    if (!kinds.has(`${SH}NodeShape`)) continue
    const target = value(subject, `${SH}targetClass`)
    if (target.length === 0) continue

    const sparql: SparqlConstraint[] = []
    for (const node of values(subject, `${SH}sparql`)) {
      const select = value(node, `${SH}select`)
      if (select.length === 0) continue
      sparql.push({
        select,
        message: value(node, `${SH}message`),
        severity: severityOf(value(node, `${SH}severity`) || value(subject, `${SH}severity`)),
      })
    }

    const properties: PropertyConstraint[] = []
    for (const node of values(subject, `${SH}property`)) {
      const path = value(node, `${SH}path`)
      if (path.length === 0) continue
      properties.push({
        path,
        minCount: numberOrNull(value(node, `${SH}minCount`)),
        maxCount: numberOrNull(value(node, `${SH}maxCount`)),
        className: value(node, `${SH}class`) || null,
        message: value(node, `${SH}message`),
        severity: severityOf(value(node, `${SH}severity`) || value(subject, `${SH}severity`)),
      })
    }

    shapes.push({
      iri: subject,
      label: value(subject, `${RDFS_LABEL}`) || localName(subject),
      targetClass: target,
      severity: severityOf(value(subject, `${SH}severity`)),
      sparql,
      properties,
    })
  }
  return shapes.sort((left, right) => left.iri.localeCompare(right.iri))
}

/**
 * Map a severity IRI to its local name, defaulting to `Violation`.
 *
 * @param iri - `sh:Violation` and friends.
 * @returns the severity.
 */
function severityOf(iri: string): GateSeverity {
  const local = iri.length === 0 ? '' : localName(iri)
  return local === 'Warning' || local === 'Info' ? local : 'Violation'
}

/**
 * Parse a literal count.
 *
 * @param text - lexical value.
 * @returns the number, or `null` when absent or not numeric.
 */
function numberOrNull(text: string): number | null {
  if (text.length === 0) return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}
