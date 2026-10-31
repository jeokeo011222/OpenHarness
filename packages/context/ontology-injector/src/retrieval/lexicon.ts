/**
 * Vocabulary view of one domain's ontology, built from the stored live graph.
 *
 * The store keeps every domain, every version, and every instance batch in a
 * single oxigraph dataset. Every query here is therefore scoped with
 * `GRAPH <iri>`; an unscoped query would happily mix contract and carbon facts
 * and produce a demo that "works" for the wrong reason.
 *
 * The whole graph is read once per call instead of issuing three targeted
 * queries. An ontology is a few hundred to a few thousand triples, so one round
 * trip plus local indexing beats several round trips and is far easier to reason
 * about than a UNION with optional joins.
 */

import { ontologyGraphIri, querySparql } from '../store.ts'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label'
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf'
const RDFS_DOMAIN = 'http://www.w3.org/2000/01/rdf-schema#domain'
const RDFS_RANGE = 'http://www.w3.org/2000/01/rdf-schema#range'
const SKOS_ALT = 'http://www.w3.org/2004/02/skos/core#altLabel'
const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class'
const OWL_OBJECT_PROPERTY = 'http://www.w3.org/2002/07/owl#ObjectProperty'
const OWL_DATATYPE_PROPERTY = 'http://www.w3.org/2002/07/owl#DatatypeProperty'

/** SPARQL prologue shared by every planner query. */
export const PREFIXES = [
  'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>',
  'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>',
  'PREFIX owl: <http://www.w3.org/2002/07/owl#>',
  'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>',
  'PREFIX skos: <http://www.w3.org/2004/02/skos/core#>',
  'PREFIX sh: <http://www.w3.org/ns/shacl#>',
  '',
].join('\n')

/** One class as the retrieval stack sees it. */
export interface LexiconClass {
  readonly iri: string
  readonly local: string
  readonly labels: readonly string[]
  readonly parents: readonly string[]
}

/** One property as the retrieval stack sees it. */
export interface LexiconProperty {
  readonly iri: string
  readonly local: string
  readonly kind: 'object' | 'datatype'
  readonly labels: readonly string[]
  readonly domain: readonly string[]
  readonly range: readonly string[]
}

/** Alias hit: which IRI a surface form maps to. */
export interface AliasHit {
  readonly iri: string
  readonly kind: 'class' | 'property'
}

/** Read-only vocabulary of one domain. */
export interface Lexicon {
  readonly domain: string
  readonly graph: string
  readonly namespace: string
  readonly namespaces: readonly string[]
  readonly classes: ReadonlyMap<string, LexiconClass>
  readonly properties: ReadonlyMap<string, LexiconProperty>
  /** Normalised label/altLabel → target, longest surface form wins. */
  readonly aliases: ReadonlyMap<string, AliasHit>
}

const NORMALIZE_PATTERN = /[-\s\u3000()（）【】\[\]「」『』，,。.;；:：、—_/\\]+/gu

/**
 * Normalise a surface form the same way for indexing and for lookup.
 *
 * @param text - raw text.
 * @returns folded text without separators.
 */
export function normalizeTerm(text: string): string {
  return text.replace(NORMALIZE_PATTERN, '').toLowerCase()
}

/**
 * Local name of an IRI: everything after the last `#` or `/`.
 *
 * @param iri - absolute IRI.
 * @returns the local part, or the input when it has no separator.
 */
export function localName(iri: string): string {
  const hash = iri.lastIndexOf('#')
  if (hash >= 0) return iri.slice(hash + 1)
  const slash = iri.lastIndexOf('/')
  if (slash >= 0) return iri.slice(slash + 1)
  const colon = iri.lastIndexOf(':')
  return colon >= 0 ? iri.slice(colon + 1) : iri
}

/**
 * Namespace part of an IRI, including the trailing separator.
 *
 * @param iri - absolute IRI.
 * @returns the namespace, or an empty string.
 */
export function namespaceOf(iri: string): string {
  const hash = iri.lastIndexOf('#')
  if (hash >= 0) return iri.slice(0, hash + 1)
  const slash = iri.lastIndexOf('/')
  if (slash >= 0) return iri.slice(0, slash + 1)
  return ''
}

/**
 * Read one domain's vocabulary.
 *
 * @param root - ontology store root.
 * @param domain - domain id.
 * @returns the lexicon; empty when the domain has no ontology yet.
 */
export async function loadLexicon(root: string, domain: string): Promise<Lexicon> {
  const graph = ontologyGraphIri(domain)
  const result = await querySparql(
    root,
    `${PREFIXES}SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`,
  )

  const classTypes = new Set<string>()
  const propertyKinds = new Map<string, 'object' | 'datatype'>()
  const labels = new Map<string, string[]>()
  const parents = new Map<string, string[]>()
  const domains = new Map<string, string[]>()
  const ranges = new Map<string, string[]>()
  const push = (map: Map<string, string[]>, key: string, value: string): void => {
    if (key.length === 0 || value.length === 0) return
    const list = map.get(key)
    if (list === undefined) map.set(key, [value])
    else if (!list.includes(value)) list.push(value)
  }

  for (const row of result.rows) {
    const subject = row.s ?? ''
    const predicate = row.p ?? ''
    const object = row.o ?? ''
    if (subject.length === 0 || predicate.length === 0) continue

    if (predicate === RDF_TYPE) {
      if (object === OWL_CLASS) classTypes.add(subject)
      if (object === OWL_OBJECT_PROPERTY) propertyKinds.set(subject, 'object')
      if (object === OWL_DATATYPE_PROPERTY && !propertyKinds.has(subject)) {
        propertyKinds.set(subject, 'datatype')
      }
      continue
    }
    if (predicate === RDFS_LABEL || predicate === SKOS_ALT) {
      push(labels, subject, object)
      continue
    }
    if (predicate === RDFS_SUBCLASS) {
      push(parents, subject, object)
      continue
    }
    if (predicate === RDFS_DOMAIN) {
      push(domains, subject, object)
      continue
    }
    if (predicate === RDFS_RANGE) {
      push(ranges, subject, object)
      continue
    }
  }

  const classes = new Map<string, LexiconClass>()
  for (const iri of classTypes) {
    const local = localName(iri)
    if (local.length === 0) continue
    classes.set(local, {
      iri,
      local,
      labels: labels.get(iri) ?? [],
      parents: (parents.get(iri) ?? []).map(localName),
    })
  }

  const properties = new Map<string, LexiconProperty>()
  for (const [iri, kind] of propertyKinds) {
    const local = localName(iri)
    if (local.length === 0) continue
    properties.set(local, {
      iri,
      local,
      kind,
      labels: labels.get(iri) ?? [],
      domain: (domains.get(iri) ?? []).map(localName),
      range: (ranges.get(iri) ?? []).map(localName),
    })
  }

  // Alias table: every label and altLabel, keyed by its normalised form.
  // Longer surface forms must win ("付款申请" before "付款"), which the lookup
  // below enforces by sorting candidates by length.
  const aliases = new Map<string, AliasHit>()
  for (const info of classes.values()) {
    for (const label of [info.local, ...info.labels]) {
      const key = normalizeTerm(label)
      if (key.length >= 2) aliases.set(key, { iri: info.iri, kind: 'class' })
    }
  }
  for (const info of properties.values()) {
    for (const label of [info.local, ...info.labels]) {
      const key = normalizeTerm(label)
      if (key.length >= 2 && !aliases.has(key)) aliases.set(key, { iri: info.iri, kind: 'property' })
    }
  }

  const namespaces = countNamespaces([...classes.values(), ...properties.values()])
  return {
    domain,
    graph,
    namespace: namespaces[0] ?? '',
    namespaces,
    classes,
    properties,
    aliases,
  }
}

/**
 * Namespaces ordered by how many terms they own; the first is the domain's own.
 *
 * @param nodes - classes and properties.
 * @returns sorted namespaces.
 */
function countNamespaces(nodes: readonly { iri: string }[]): string[] {
  const counts = new Map<string, number>()
  for (const node of nodes) {
    const namespace = namespaceOf(node.iri)
    if (namespace.length === 0) continue
    counts.set(namespace, (counts.get(namespace) ?? 0) + 1)
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([ns]) => ns)
}

/**
 * Longest-alias match of a question against the vocabulary.
 *
 * @param lexicon - domain vocabulary.
 * @param text - question text.
 * @returns matched class/property locals, deduplicated, in match order.
 */
export function matchTerms(lexicon: Lexicon, text: string): { classes: string[]; properties: string[] } {
  const folded = normalizeTerm(text)
  const entries = [...lexicon.aliases.entries()].sort((left, right) => right[0].length - left[0].length)
  const consumed: { start: number; end: number }[] = []
  const classes: string[] = []
  const properties: string[] = []

  for (const [alias, hit] of entries) {
    if (alias.length < 2) continue
    let from = 0
    for (;;) {
      const start = folded.indexOf(alias, from)
      if (start < 0) break
      const end = start + alias.length
      from = end
      if (consumed.some(range => !(end <= range.start || start >= range.end))) continue
      consumed.push({ start, end })
      const local = localName(hit.iri)
      if (hit.kind === 'class') {
        if (!classes.includes(local)) classes.push(local)
      } else if (!properties.includes(local)) {
        properties.push(local)
      }
      break
    }
  }
  return { classes, properties }
}

/** Business identifiers look like `C-2024-001`, `PAY-1001`, `HT2024001`. */
const IDENTIFIER_PATTERN = /\b[A-Z]{1,5}[-_]?\d{2,}[A-Za-z0-9_-]*\b/g

/**
 * Extract business identifiers verbatim from a question.
 *
 * @param text - question text.
 * @returns identifiers in appearance order, deduplicated.
 */
export function findIdentifiers(text: string): string[] {
  const found = text.match(IDENTIFIER_PATTERN) ?? []
  const kept: string[] = []
  for (const value of found) {
    if (!kept.includes(value)) kept.push(value)
  }
  return kept
}
