/**
 * Turtle ⇄ workbench model conversion, graph projection, micro-edits, and
 * version comparison.
 *
 * The model is the single source of truth for one domain: classes with their
 * parents, and properties with their domain and range. Turtle is read into the
 * model and written back from it, so the file kept on disk is always produced by
 * the same emitter the workbench edits feed.
 */

import { Store, parse as parseRdf } from 'rdflib'
import type {
  OntologyEdit,
  OntologyGraph,
  OntologyGraphEdge,
  OntologyGraphNode,
  OntologyNodeKind,
  OntologyPatch,
  OntologyVersionDiff,
} from './types.ts'

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#'
const OWL = 'http://www.w3.org/2002/07/owl#'
const XSD = 'http://www.w3.org/2001/XMLSchema#'
/** Annotation vocabulary for the source clause and clause text. */
const META = 'http://example.org/ontology/meta#'

const RDF_TYPE = `${RDF}type`
const RDFS_LABEL = `${RDFS}label`
const RDFS_COMMENT = `${RDFS}comment`
const RDFS_SUBCLASS = `${RDFS}subClassOf`
const RDFS_DOMAIN = `${RDFS}domain`
const RDFS_RANGE = `${RDFS}range`
const OWL_CLASS = `${OWL}Class`
const OWL_OBJECT_PROPERTY = `${OWL}ObjectProperty`
const OWL_DATATYPE_PROPERTY = `${OWL}DatatypeProperty`
const RDFS_CLASS = `${RDFS}Class`
const META_SOURCE = `${META}sourceClause`
const META_SOURCE_TEXT = `${META}sourceText`

const KNOWN_PREFIXES: readonly (readonly [string, string])[] = [
  [RDF, 'rdf'],
  [RDFS, 'rdfs'],
  [OWL, 'owl'],
  [XSD, 'xsd'],
  [META, 'meta'],
]

/** One class in the working model. */
export interface ModelClass {
  id: string
  label: string
  comment: string
  parents: string[]
  /** Clause the class was extracted from. */
  source: string
  /** Clause text the class was extracted from. */
  sourceText: string
}

/** One property in the working model. */
export interface ModelProperty {
  id: string
  kind: 'object' | 'datatype'
  label: string
  comment: string
  domain: string
  range: string
  /** Clause the property was extracted from. */
  source: string
  /** Clause text the property was extracted from. */
  sourceText: string
}

/** One domain's working model. */
export interface OntologyModel {
  namespace: string
  classes: ModelClass[]
  properties: ModelProperty[]
}

/** A rejected edit, reported to the caller instead of mutating the model. */
export class OntologyModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OntologyModelError'
  }
}

/**
 * Build an empty model for a domain namespace.
 * @param domain - the domain id used in the generated namespace IRI.
 * @returns a model with no classes or properties.
 */
export function emptyModel(domain: string): OntologyModel {
  return { namespace: `http://example.org/ontology/${domain}#`, classes: [], properties: [] }
}

/** Triple fields the parser exposes; narrowed here so the model layer stays typed. */
interface Triple {
  readonly subject: { readonly value: string }
  readonly predicate: { readonly value: string }
  readonly object: { readonly value: string }
}

/** Return every triple in a Turtle document. */
function triplesOf(turtle: string, domain: string): Triple[] {
  const store = new Store()
  parseRdf(turtle, store, `http://example.org/ontology/${domain}#`, 'text/turtle')
  return store.statementsMatching(null, null, null)
}

/** Choose the namespace shared by most subjects, so local ids stay meaningful. */
function detectNamespace(subjects: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const iri of subjects) {
    const cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'))
    if (cut <= 0) continue
    const prefix = iri.slice(0, cut + 1)
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
  }
  let best = ''
  let bestCount = 0
  for (const [prefix, count] of counts) {
    if (count > bestCount) {
      best = prefix
      bestCount = count
    }
  }
  return best
}

/**
 * Compact an IRI to a known prefix, or to its local name inside the namespace.
 * @param iri - the absolute IRI.
 * @param namespace - the model namespace whose prefix is dropped.
 * @returns the compact id, or the IRI itself when no prefix applies.
 */
export function compactIri(iri: string, namespace: string): string {
  if (iri.startsWith(namespace)) return iri.slice(namespace.length)
  for (const [base, prefix] of KNOWN_PREFIXES) {
    if (iri === base.slice(0, -1)) return prefix
    if (iri.startsWith(base)) return `${prefix}:${iri.slice(base.length)}`
  }
  return iri
}

/**
 * Expand a compact id back to an IRI for the model namespace.
 * @param id - the compact id or absolute IRI.
 * @param namespace - the model namespace prefixed to local ids.
 * @returns the absolute IRI.
 */
export function expandId(id: string, namespace: string): string {
  if (id.startsWith('http://') || id.startsWith('https://')) return id
  for (const [base, prefix] of KNOWN_PREFIXES) {
    if (id === prefix) return base.slice(0, -1)
    if (id.startsWith(`${prefix}:`)) return `${base}${id.slice(prefix.length + 1)}`
  }
  return `${namespace}${id}`
}

/**
 * Read a Turtle document into the working model.
 * @param turtle - the Turtle text.
 * @param domain - the domain id used for the fallback namespace.
 * @returns the parsed model.
 */
export function parseTurtle(turtle: string, domain: string): OntologyModel {
  const fallback = `http://example.org/ontology/${domain}#`
  const triples = triplesOf(turtle, domain)
  const types = new Map<string, Set<string>>()
  const literals = new Map<string, Map<string, string>>()
  const references = new Map<string, Map<string, string[]>>()
  for (const triple of triples) {
    const subject = triple.subject.value
    if (triple.predicate.value === RDF_TYPE) {
      const set = types.get(subject) ?? new Set<string>()
      set.add(triple.object.value)
      types.set(subject, set)
      continue
    }
    if (triple.predicate.value === RDFS_LABEL
      || triple.predicate.value === RDFS_COMMENT
      || triple.predicate.value === META_SOURCE
      || triple.predicate.value === META_SOURCE_TEXT) {
      const map = literals.get(subject) ?? new Map<string, string>()
      map.set(triple.predicate.value, triple.object.value)
      literals.set(subject, map)
      continue
    }
    if (triple.predicate.value === RDFS_SUBCLASS
      || triple.predicate.value === RDFS_DOMAIN
      || triple.predicate.value === RDFS_RANGE) {
      const map = references.get(subject) ?? new Map<string, string[]>()
      const list = map.get(triple.predicate.value) ?? []
      list.push(triple.object.value)
      map.set(triple.predicate.value, list)
      references.set(subject, map)
    }
  }

  const classIris = [...types.keys()].filter((iri) => {
    const set = types.get(iri)
    return set !== undefined && (set.has(OWL_CLASS) || set.has(RDFS_CLASS))
  })
  const propertyIris = [...types.keys()].filter((iri) => {
    const set = types.get(iri)
    return set !== undefined && (set.has(OWL_OBJECT_PROPERTY) || set.has(OWL_DATATYPE_PROPERTY))
  })
  const namespace = detectNamespace([...classIris, ...propertyIris]) || fallback

  const model = emptyModel(domain)
  model.namespace = namespace

  for (const iri of classIris) {
    const id = compactIri(iri, namespace)
    const props = literals.get(iri)
    const refs = references.get(iri)
    model.classes.push({
      id,
      label: props?.get(RDFS_LABEL) ?? '',
      comment: props?.get(RDFS_COMMENT) ?? '',
      parents: (refs?.get(RDFS_SUBCLASS) ?? []).map(parent => compactIri(parent, namespace)),
      source: props?.get(META_SOURCE) ?? '',
      sourceText: props?.get(META_SOURCE_TEXT) ?? '',
    })
  }

  for (const iri of propertyIris) {
    const id = compactIri(iri, namespace)
    if (model.classes.some(item => item.id === id)) continue
    const props = literals.get(iri)
    const refs = references.get(iri)
    const typeSet = types.get(iri)
    const isObject = typeSet?.has(OWL_OBJECT_PROPERTY) ?? false
    model.properties.push({
      id,
      kind: isObject ? 'object' : 'datatype',
      label: props?.get(RDFS_LABEL) ?? '',
      comment: props?.get(RDFS_COMMENT) ?? '',
      domain: refs?.get(RDFS_DOMAIN)?.map(value => compactIri(value, namespace))[0] ?? '',
      range: refs?.get(RDFS_RANGE)?.map(value => compactIri(value, namespace))[0] ?? '',
      source: props?.get(META_SOURCE) ?? '',
      sourceText: props?.get(META_SOURCE_TEXT) ?? '',
    })
  }

  return model
}

/** Escape a Turtle double-quoted literal body. */
function escapeLiteral(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')
}

/** Render one model id as a Turtle term. */
function term(id: string, namespace: string): string {
  if (id.startsWith('http://') || id.startsWith('https://')) return `<${id}>`
  for (const [, prefix] of KNOWN_PREFIXES) {
    if (id.startsWith(`${prefix}:`)) return id
  }
  if (!namespace) return `<${id}>`
  return `store:${id}`
}

/** Render one predicate-and-object block with a trailing separator. */
function block(predicate: string, value: string): string {
  return `  ${predicate} ${value} ;\n`
}

/** Join a subject's statements, dropping the leading indent and closing the list. */
function terminate(statements: readonly string[]): string {
  return statements.join('').slice(2).replace(/ ;\n$/, ' .\n')
}

/**
 * Write the working model back to Turtle.
 * @param model - the model to render.
 * @returns a full Turtle document with the model's fixed prefixes.
 */
export function emitTurtle(model: OntologyModel): string {
  const lines: string[] = [
    `@prefix rdf: <${RDF}> .`,
    `@prefix rdfs: <${RDFS}> .`,
    `@prefix owl: <${OWL}> .`,
    `@prefix xsd: <${XSD}> .`,
    `@prefix meta: <${META}> .`,
    `@prefix store: <${model.namespace}> .`,
    '',
    '# Generated by the DeepSeek Harness ontology workbench.',
    '',
  ]
  const namespace = model.namespace

  for (const item of model.classes) {
    const statements: string[] = []
    statements.push(block('a', 'owl:Class'))
    if (item.label) statements.push(block('rdfs:label', `"${escapeLiteral(item.label)}"`))
    if (item.comment) statements.push(block('rdfs:comment', `"${escapeLiteral(item.comment)}"`))
    if (item.source) statements.push(block('meta:sourceClause', `"${escapeLiteral(item.source)}"`))
    if (item.sourceText) statements.push(block('meta:sourceText', `"${escapeLiteral(item.sourceText)}"`))
    for (const parent of item.parents) statements.push(block('rdfs:subClassOf', term(parent, namespace)))
    lines.push(`${term(item.id, namespace)} ${terminate(statements)}`)
    lines.push('')
  }

  for (const item of model.properties) {
    const statements: string[] = []
    statements.push(block('a', item.kind === 'object' ? 'owl:ObjectProperty' : 'owl:DatatypeProperty'))
    if (item.label) statements.push(block('rdfs:label', `"${escapeLiteral(item.label)}"`))
    if (item.comment) statements.push(block('rdfs:comment', `"${escapeLiteral(item.comment)}"`))
    if (item.source) statements.push(block('meta:sourceClause', `"${escapeLiteral(item.source)}"`))
    if (item.sourceText) statements.push(block('meta:sourceText', `"${escapeLiteral(item.sourceText)}"`))
    if (item.domain) statements.push(block('rdfs:domain', term(item.domain, namespace)))
    if (item.range) statements.push(block('rdfs:range', term(item.range, namespace)))
    lines.push(`${term(item.id, namespace)} ${terminate(statements)}`)
    lines.push('')
  }

  return lines.join('\n').trimEnd() + '\n'
}

/**
 * Project the model into the node-and-edge graph the workbench renders.
 * @param model - the model to project.
 * @param domain - the domain id echoed into the graph.
 * @param label - the domain label echoed into the graph.
 * @param version - the active version echoed into the graph, or `null` when unsaved.
 * @returns nodes, edges, and the model's Turtle.
 */
export function toGraph(
  model: OntologyModel,
  domain: string,
  label: string,
  version: string | null,
): OntologyGraph {
  const nodes: OntologyGraphNode[] = []
  for (const item of model.classes) {
    nodes.push({
      id: item.id,
      kind: 'class',
      label: item.label || item.id,
      comment: item.comment,
      source: item.source,
      sourceText: item.sourceText,
      domain: '',
      range: '',
      parents: [...item.parents],
    })
  }
  for (const item of model.properties) {
    nodes.push({
      id: item.id,
      kind: item.kind === 'object' ? 'object-property' : 'datatype-property',
      label: item.label || item.id,
      comment: item.comment,
      source: item.source,
      sourceText: item.sourceText,
      domain: item.domain,
      range: item.range,
      parents: [],
    })
  }

  const known = new Set(nodes.map(node => node.id))
  const edges: OntologyGraphEdge[] = []
  for (const item of model.classes) {
    for (const parent of item.parents) {
      if (!known.has(parent)) continue
      edges.push({
        id: `${item.id}->${parent}:subclass`,
        source: item.id,
        target: parent,
        kind: 'subclass',
        label: 'rdfs:subClassOf',
      })
    }
  }
  for (const item of model.properties) {
    if (item.domain && known.has(item.domain)) {
      edges.push({
        id: `${item.domain}->${item.id}:domain`,
        source: item.domain,
        target: item.id,
        kind: 'domain',
        label: 'rdfs:domain',
      })
    }
    if (item.kind === 'object' && item.range && known.has(item.range)) {
      edges.push({
        id: `${item.id}->${item.range}:range`,
        source: item.id,
        target: item.range,
        kind: 'range',
        label: 'rdfs:range',
      })
    }
  }

  return {
    domain,
    label,
    namespace: model.namespace,
    version,
    nodes,
    edges,
    turtle: emitTurtle(model),
  }
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/

/** Reject an id the Turtle emitter cannot render as a local name. */
function requireIdentifier(id: string, what: string): void {
  if (!IDENTIFIER.test(id)) {
    throw new OntologyModelError(`${what} id must start with a letter and contain only letters, digits, and underscores: ${id}`)
  }
}

/** Return a deep copy so a rejected edit never leaves a half-modified model. */
function cloneModel(model: OntologyModel): OntologyModel {
  return structuredClone(model)
}

/**
 * Apply micro-edits to a copy of the model.
 *
 * Deleting a class clears every property reference to it and reports which
 * properties lost their reference; deleting a property removes only itself.
 *
 * @param source - model to copy and edit.
 * @param edits - operations applied in order.
 * @returns the edited model and repair warnings.
 */
export function applyEdits(source: OntologyModel, edits: readonly OntologyEdit[]): { model: OntologyModel; warnings: string[] } {
  const model = cloneModel(source)
  const warnings: string[] = []

  const findClass = (id: string): ModelClass | undefined => model.classes.find(item => item.id === id)
  const findProperty = (id: string): ModelProperty | undefined => model.properties.find(item => item.id === id)

  for (const edit of edits) {
    switch (edit.op) {
      case 'add-class': {
        requireIdentifier(edit.id, 'Class')
        if (findClass(edit.id)) throw new OntologyModelError(`Class already exists: ${edit.id}`)
        model.classes.push({ id: edit.id, label: edit.label, comment: edit.comment, parents: [], source: '', sourceText: '' })
        break
      }
      case 'update-class': {
        const target = findClass(edit.id)
        if (!target) throw new OntologyModelError(`Class not found: ${edit.id}`)
        target.label = edit.label
        target.comment = edit.comment
        target.parents = []
        for (const parent of edit.parents) {
          if (parent === edit.id) continue
          if (!findClass(parent)) {
            model.classes.push({ id: parent, label: parent, comment: '', parents: [], source: '', sourceText: '' })
            warnings.push(`Created missing parent class: ${parent}`)
          }
          target.parents.push(parent)
        }
        break
      }
      case 'delete-class': {
        const target = findClass(edit.id)
        if (!target) throw new OntologyModelError(`Class not found: ${edit.id}`)
        model.classes = model.classes.filter(item => item.id !== edit.id)
        for (const item of model.classes) {
          if (item.parents.includes(edit.id)) {
            item.parents = item.parents.filter(parent => parent !== edit.id)
            warnings.push(`Removed subClassOf reference from: ${item.id}`)
          }
        }
        for (const item of model.properties) {
          if (item.domain === edit.id) {
            item.domain = ''
            warnings.push(`Cleared domain of: ${item.id}`)
          }
          if (item.kind === 'object' && item.range === edit.id) {
            item.range = ''
            warnings.push(`Cleared range of: ${item.id}`)
          }
        }
        break
      }
      case 'add-property': {
        requireIdentifier(edit.id, 'Property')
        if (findProperty(edit.id)) throw new OntologyModelError(`Property already exists: ${edit.id}`)
        if (findClass(edit.id)) throw new OntologyModelError(`Id is already a class: ${edit.id}`)
        model.properties.push({
          id: edit.id,
          kind: edit.kind,
          label: edit.label,
          comment: edit.comment,
          domain: edit.domain,
          range: edit.range,
          source: '',
          sourceText: '',
        })
        break
      }
      case 'update-property': {
        const target = findProperty(edit.id)
        if (!target) throw new OntologyModelError(`Property not found: ${edit.id}`)
        target.label = edit.label
        target.comment = edit.comment
        target.domain = edit.domain
        target.range = edit.range
        break
      }
      case 'delete-property': {
        const target = findProperty(edit.id)
        if (!target) throw new OntologyModelError(`Property not found: ${edit.id}`)
        model.properties = model.properties.filter(item => item.id !== edit.id)
        break
      }
    }
  }

  return { model, warnings }
}

/** Key one node for cross-version comparison. */
function nodeKey(kind: OntologyNodeKind, id: string): string {
  return `${kind}:${id}`
}

/**
 * Compare two models and list added and removed nodes and edges.
 *
 * @param from - earlier model.
 * @param to - later model.
 * @param labels - `from` and `to` version identifiers, echoed into the result.
 * @returns the node and edge differences keyed by version.
 */
export function diffModels(from: OntologyModel, to: OntologyModel, labels: { from: string; to: string }): OntologyVersionDiff {
  const fromGraph = toGraph(from, '', '', labels.from)
  const toGraphModel = toGraph(to, '', '', labels.to)
  const fromNodes = new Set(fromGraph.nodes.map(node => nodeKey(node.kind, node.id)))
  const toNodes = new Set(toGraphModel.nodes.map(node => nodeKey(node.kind, node.id)))
  const fromEdges = new Set(fromGraph.edges.map(edge => edge.id))
  const toEdges = new Set(toGraphModel.edges.map(edge => edge.id))
  return {
    from: labels.from,
    to: labels.to,
    addedNodes: [...toNodes].filter(key => !fromNodes.has(key)),
    removedNodes: [...fromNodes].filter(key => !toNodes.has(key)),
    addedEdges: [...toEdges].filter(key => !fromEdges.has(key)),
    removedEdges: [...fromEdges].filter(key => !toEdges.has(key)),
  }
}

/** One class or property an extraction produced from a clause. */
export interface ExtractedClass {
  readonly name: string
  readonly label: string
  readonly comment: string
}

/** One property an extraction produced from a clause. */
export interface ExtractedProperty {
  readonly name: string
  readonly kind: 'object' | 'datatype'
  readonly label: string
  readonly comment: string
  readonly domain: string
  readonly range: string
}

/** Model additions one clause produced. */
export interface Extraction {
  readonly classes: readonly ExtractedClass[]
  readonly properties: readonly ExtractedProperty[]
  readonly confidence: number
}

/** Split a raw name on separators and camelCase word boundaries. */
function splitNameWords(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(word => word.length > 0)
}

/** Turn an arbitrary model-supplied name into a Turtle local name. */
function sanitizeName(raw: string, kind: 'class' | 'property'): string {
  const words = splitNameWords(raw)
  if (words.length === 0) return kind === 'class' ? 'UnnamedClass' : 'unnamedProperty'
  const joined = words.map((word, index) => {
    const lower = word.toLowerCase()
    if (kind === 'class') return lower.charAt(0).toUpperCase() + lower.slice(1)
    return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1)
  }).join('')
  const cleaned = joined.replace(/^[0-9]+/, '')
  if (cleaned.length === 0) return kind === 'class' ? 'UnnamedClass' : 'unnamedProperty'
  return kind === 'class'
    ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
    : cleaned.charAt(0).toLowerCase() + cleaned.slice(1)
}

/**
 * Merge one clause extraction into the model.
 *
 * Referenced classes that the extraction did not define are created as stub
 * nodes so every property keeps a resolvable domain and range.
 *
 * @param model - model mutated in place.
 * @param extraction - classes and properties extracted from one clause.
 * @param clause - clause label stored on every new node.
 * @param sourceText - clause text stored on every new node.
 * @returns the ids added by this extraction.
 */
export function mergeExtraction(model: OntologyModel, extraction: Extraction, clause: string, sourceText: string): string[] {
  const added: string[] = []
  const known = new Map(model.classes.map(item => [item.id, item]))

  for (const item of extraction.classes) {
    const id = sanitizeName(item.name, 'class')
    const existing = known.get(id)
    if (existing) {
      if (!existing.label) existing.label = item.label
      if (!existing.comment) existing.comment = item.comment
      if (!existing.source) existing.source = clause
      if (!existing.sourceText) existing.sourceText = sourceText
      continue
    }
    const created: ModelClass = {
      id,
      label: item.label || id,
      comment: item.comment,
      parents: [],
      source: clause,
      sourceText,
    }
    model.classes.push(created)
    known.set(id, created)
    added.push(`class:${id}`)
  }

  const ensureClass = (raw: string): string => {
    const id = sanitizeName(raw, 'class')
    if (known.has(id)) return id
    const created: ModelClass = { id, label: raw, comment: '', parents: [], source: clause, sourceText }
    model.classes.push(created)
    known.set(id, created)
    added.push(`class:${id}`)
    return id
  }

  for (const item of extraction.properties) {
    const id = sanitizeName(item.name, 'property')
    if (model.properties.some(property => property.id === id) || known.has(id)) continue
    const domain = item.domain ? ensureClass(item.domain) : ''
    const range = item.kind === 'object' && item.range ? ensureClass(item.range) : item.range
    model.properties.push({
      id,
      kind: item.kind,
      label: item.label || id,
      comment: item.comment,
      domain,
      range,
      source: clause,
      sourceText,
    })
    added.push(`property:${id}`)
  }

  return added
}

/**
 * Translate a patch into micro-edits against the current model.
 *
 * An id present in the model becomes an update, an absent id an addition, so one
 * patch can both introduce and revise entities. Removals are emitted first.
 *
 * @param model - model the patch applies to.
 * @param patch - classes and properties to add, replace, or remove.
 * @returns the equivalent micro-edits, in application order.
 */
export function patchToEdits(model: OntologyModel, patch: OntologyPatch): OntologyEdit[] {
  const edited: OntologyEdit[] = []
  const removedClasses = new Set(patch.removeClasses ?? [])
  const removedProperties = new Set(patch.removeProperties ?? [])
  for (const id of patch.removeProperties ?? []) edited.push({ op: 'delete-property', id })
  for (const id of patch.removeClasses ?? []) edited.push({ op: 'delete-class', id })
  for (const item of patch.classes ?? []) {
    const exists = model.classes.some(entry => entry.id === item.id) && !removedClasses.has(item.id)
    edited.push(exists
      ? { op: 'update-class', id: item.id, label: item.label, comment: item.comment, parents: [...item.parents] }
      : { op: 'add-class', id: item.id, label: item.label, comment: item.comment })
  }
  for (const item of patch.properties ?? []) {
    const exists = model.properties.some(entry => entry.id === item.id) && !removedProperties.has(item.id)
    edited.push(exists
      ? { op: 'update-property', id: item.id, label: item.label, comment: item.comment, domain: item.domain, range: item.range }
      : {
        op: 'add-property',
        id: item.id,
        kind: item.kind,
        label: item.label,
        comment: item.comment,
        domain: item.domain,
        range: item.range,
      })
  }
  return edited
}
