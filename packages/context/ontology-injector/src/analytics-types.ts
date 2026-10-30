/**
 * Wire types of the ontology analytics engine.
 *
 * This module holds declarations only, so the browser face can import the same
 * metric result types as the Host without pulling the graph database.
 * @module @deepseek-ai/dsh-ontology-injector/src/analytics-types
 */

/** How a metric's rows are shaped for the panel. */
export type MetricKind = 'scalar' | 'group' | 'trend' | 'rows'

/** Unit the panel uses to format values. */
export type MetricUnit = 'count' | 'currency' | 'days'

/** User-supplied metric filters, resolved against the active domain's ontology. */
export interface MetricFilters {
  /** Class local id or absolute IRI that scopes the metric. */
  readonly class?: string
  /** Property local id or absolute IRI the value metric distributes over. */
  readonly property?: string
}

/** One metric as the catalog lists it, before any query runs. */
export interface MetricSummary {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly kind: MetricKind
  readonly unit: MetricUnit
  /** Ontology terms or instance properties the metric reads. */
  readonly requires: readonly string[]
  /** Why the number can differ from a naive ledger total. */
  readonly caveat: string
}

/** One aggregated metric run. */
export interface MetricRun {
  readonly metricId: string
  readonly title: string
  readonly kind: MetricKind
  readonly unit: MetricUnit
  readonly variables: readonly string[]
  /** Result rows, every term as its lexical string. */
  readonly rows: readonly Record<string, string>[]
  /** Compiled SPARQL, so the panel can show exactly what ran. */
  readonly sparql: string
  readonly durationMs: number
  /** Non-fatal problems, such as an empty result after a property was absent. */
  readonly warnings: readonly string[]
  /** ISO timestamp of the run. */
  readonly ranAt: string
}

/** Definition plus a sample query, shown in the caveat drawer. */
export interface MetricExplanation extends MetricSummary {
  /** Query compiled with the supplied filters. */
  readonly sparql: string
  /** Result columns the query returns. */
  readonly variables: readonly string[]
}

/** Instance rows returned by a drilldown. */
export interface MetricDetail {
  readonly metricId: string
  readonly variables: readonly string[]
  readonly rows: readonly Record<string, string>[]
  readonly sparql: string
  readonly truncated: boolean
}

/** Stable refusal reasons of the analytics engine. */
export type AnalyticsErrorCode = 'invalid-filter' | 'unknown-metric'
