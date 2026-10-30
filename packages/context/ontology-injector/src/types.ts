/**
 * Wire vocabulary of the ontology workbench Remote namespace.
 *
 * Every type here crosses the Typert Remote boundary as plain JSON: strings,
 * numbers, booleans, arrays, and records only.
 */

/** Node categories the workbench graph renders and the inspector edits. */
export type OntologyNodeKind = 'class' | 'object-property' | 'datatype-property'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertResourceMap {
    /** Ontology domain identity carried by `domain` arguments and request fields. */
    'ontology-domain': import('@deepseek-ai/dsh-typert-protocol').TypertResource<string>
  }
}

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
  /** Clause text the node was extracted from; empty when unknown. */
  readonly sourceText: string
  /** Property domain id, empty for classes. */
  readonly domain: string
  /** Property range id or external datatype IRI, empty for classes. */
  readonly range: string
  /** Class parents, empty for properties. */
  readonly parents: readonly string[]
}

/** Review state of one version snapshot. */
export type OntologyVersionStatus = 'draft' | 'review' | 'published'

/** One rendered relation between two graph nodes. */
export interface OntologyGraphEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly kind: OntologyEdgeKind
  readonly label: string
}

export type {
  AnalyticsErrorCode,
  MetricDetail,
  MetricExplanation,
  MetricFilters,
  MetricKind,
  MetricRun,
  MetricSummary,
  MetricUnit,
} from './analytics-types.ts'

/** One instance batch a domain's analytics can read. */
export interface InstanceBatch {
  /** Batch id, unique within the domain. */
  readonly batch: string
  /** Absolute IRI of the named graph holding the batch. */
  readonly graph: string
  /** Quad count in the batch. */
  readonly triples: number
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
  /** Review state; only published versions reach the model. */
  readonly status: OntologyVersionStatus
}

/**
 * One incremental update against a domain's working graph.
 *
 * An entry in `classes` or `properties` whose id already exists replaces the
 * stored fields; a new id adds the entity. Removals run first, so one patch can
 * replace an entity by naming it in both lists.
 */
export interface OntologyPatch {
  readonly classes?: readonly {
    readonly id: string
    readonly label: string
    readonly comment: string
    readonly parents: readonly string[]
  }[]
  readonly properties?: readonly {
    readonly id: string
    readonly kind: 'object' | 'datatype'
    readonly label: string
    readonly comment: string
    readonly domain: string
    readonly range: string
  }[]
  readonly removeClasses?: readonly string[]
  readonly removeProperties?: readonly string[]
}

/** Precision and recall of one entity family against a gold standard. */
export interface QualityMetric {
  /** Entities the gold standard declares. */
  readonly expected: number
  /** Entities the evaluated graph declares. */
  readonly actual: number
  readonly matched: number
  /** `matched / actual`; `1` when the graph declares nothing. */
  readonly precision: number
  /** `matched / expected`; `1` when the gold standard declares nothing. */
  readonly recall: number
  /** Gold-standard ids the graph does not declare. */
  readonly missing: readonly string[]
  /** Graph ids the gold standard does not declare. */
  readonly unexpected: readonly string[]
}

/** Quality of one graph against an uploaded gold-standard Turtle document. */
export interface QualityReport {
  readonly domain: string
  /** Version the graph was read from, or `null` for an unsaved working graph. */
  readonly version: string | null
  /** File name of the uploaded gold standard. */
  readonly baselineName: string
  readonly classes: QualityMetric
  readonly properties: QualityMetric
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

/** Every action the ontology audit log records. */
export const AUDIT_ACTIONS = [
  'domain-create',
  'domain-update',
  'domain-delete',
  'generate',
  'edit',
  'patch',
  'version-create',
  'version-review',
  'version-activate',
  'version-publish',
  'version-delete',
  'import',
  'export',
  'validate',
  'quality',
  'metric-run',
  'instance-import',
  'instance-clear',
] as const

/** Kinds of change recorded in the ontology audit log. */
export type AuditAction = typeof AUDIT_ACTIONS[number]

/** One audit-log entry, newest first when read back. */
export interface AuditEntry {
  /** ISO timestamp of the change. */
  readonly at: string
  readonly action: AuditAction
  readonly domain: string
  /** Human-readable description shown in the audit list. */
  readonly detail: string
}

/** One structural problem found by ontology validation. */
export interface ValidationIssue {
  /** Stable machine code, e.g. `missing-label`. */
  readonly code: string
  readonly message: string
  /** Compact entity id or IRI the issue is about, when it names one. */
  readonly subject?: string
}

/** Structural validation result: hard errors and advisory warnings. */
export interface ValidationReport {
  readonly errors: readonly ValidationIssue[]
  readonly warnings: readonly ValidationIssue[]
}

/** Health counters for one domain. */
export interface DomainStats {
  /** Quad count of the domain's live graph. */
  readonly tripleCount: number
  /** Distinct classes declared in the live graph. */
  readonly classCount: number
  /** Distinct object and datatype properties declared in the live graph. */
  readonly propertyCount: number
  readonly versionCount: number
  readonly activeVersion: string | null
  readonly updatedAt: string
  readonly disabled: boolean
}

/** Read-only SPARQL result. */
export interface SparqlResult {
  /** Result column names, in query order; `boolean` for an ASK answer. */
  readonly variables: readonly string[]
  /** One record per solution, every bound term stringified to its lexical value. */
  readonly rows: readonly Record<string, string>[]
  /**
   * Query form: `select` for a solution table, `ask` for a yes/no answer,
   * `boolean` reserved for engines that report a bare boolean.
   */
  readonly kind: 'select' | 'ask' | 'boolean'
}

/** Store-level health snapshot returned by the workbench. */
export interface OntologyHealth {
  readonly storePath: string
  readonly formatVersion: number
  readonly domains: readonly DomainStats[]
}
