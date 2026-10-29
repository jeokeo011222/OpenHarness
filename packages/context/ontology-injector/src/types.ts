/**
 * Wire vocabulary of the ontology workbench Remote namespace.
 *
 * Every type here crosses the Typert Remote boundary as plain JSON: strings,
 * numbers, booleans, arrays, and records only.
 */

/** Node categories the workbench graph renders and the inspector edits. */
export type OntologyNodeKind = 'class' | 'object-property' | 'datatype-property'

/** Edge categories: a property's domain and range, plus class subsumption. */
export type OntologyEdgeKind = 'domain' | 'range' | 'subclass'

/**
 * One graph node.
 *
 * Property nodes carry `domain` and `range`; class nodes leave both empty.
 */
export interface OntologyGraphNode {
  readonly id: string
  readonly kind: OntologyNodeKind
  readonly label: string
  readonly comment: string
  /** Clause the node was extracted from; empty when unknown. */
  readonly source: string
  /** Property domain id, empty for classes. */
  readonly domain: string
  /** Property range id or external datatype IRI, empty for classes. */
  readonly range: string
  /** Class parents, empty for properties. */
  readonly parents: readonly string[]
}

/** One rendered relation between two graph nodes. */
export interface OntologyGraphEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly kind: OntologyEdgeKind
  readonly label: string
}

/** One domain's ontology at one version, plus the Turtle that produced it. */
export interface OntologyGraph {
  readonly domain: string
  readonly label: string
  readonly namespace: string
  readonly version: string | null
  readonly nodes: readonly OntologyGraphNode[]
  readonly edges: readonly OntologyGraphEdge[]
  readonly turtle: string
}

/** One domain row in the ontology list. */
export interface OntologyDomainSummary {
  readonly id: string
  readonly label: string
  readonly version: string | null
  readonly versionCount: number
  readonly nodeCount: number
  readonly edgeCount: number
  readonly updatedAt: string | null
  readonly sourceCount: number
  /** A disabled domain stays readable but is never injected into a turn. */
  readonly disabled: boolean
}

/** Fields a domain update may change; omitted fields keep their current value. */
export interface DomainUpdate {
  /** New display name; blank leaves the current label. */
  readonly label?: string
  /** Whether the domain takes part in per-turn injection. */
  readonly disabled?: boolean
}

/** One version snapshot in the version timeline. */
export interface OntologyVersionSummary {
  readonly version: string
  readonly createdAt: string
  readonly approver: string
  readonly note: string
  readonly nodeCount: number
  readonly edgeCount: number
  readonly active: boolean
}

/** One stage of a one-shot generation run. */
export interface GenerationStep {
  readonly stage: 'read' | 'extract' | 'generate' | 'merge' | 'version'
  readonly message: string
  readonly status: 'done' | 'skipped' | 'failed'
}

/**
 * One-shot generation request.
 *
 * `contentBase64` carries the uploaded document; the Host decodes it and
 * extracts plain text before any model call.
 */
export interface GenerateRequest {
  readonly domain: string
  readonly label: string
  readonly fileName: string
  readonly contentBase64: string
}

/** Outcome of a one-shot generation run. */
export interface GenerateResult {
  readonly graph: OntologyGraph
  readonly version: string
  readonly steps: readonly GenerationStep[]
  readonly warnings: readonly string[]
  readonly sourceName: string
}

/**
 * One micro-edit applied to the live model.
 *
 * Ids are Turtle local names inside the domain namespace; labels are free text.
 */
export type OntologyEdit =
  | { readonly op: 'add-class'; readonly id: string; readonly label: string; readonly comment: string }
  | { readonly op: 'update-class'; readonly id: string; readonly label: string; readonly comment: string; readonly parents: readonly string[] }
  | { readonly op: 'delete-class'; readonly id: string }
  | { readonly op: 'add-property'; readonly id: string; readonly kind: 'object' | 'datatype'; readonly label: string; readonly comment: string; readonly domain: string; readonly range: string }
  | { readonly op: 'update-property'; readonly id: string; readonly label: string; readonly comment: string; readonly domain: string; readonly range: string }
  | { readonly op: 'delete-property'; readonly id: string }

/** Result of applying edits: the new graph plus non-fatal repair notes. */
export interface ApplyEditsResult {
  readonly graph: OntologyGraph
  readonly version: string
  readonly warnings: readonly string[]
}

/** Node and edge deltas between two versions. */
export interface OntologyVersionDiff {
  readonly from: string
  readonly to: string
  readonly addedNodes: readonly string[]
  readonly removedNodes: readonly string[]
  readonly addedEdges: readonly string[]
  readonly removedEdges: readonly string[]
}
