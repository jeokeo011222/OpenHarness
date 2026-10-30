/**
 * Narrow Client face of the `ontologyStore` Remote namespace.
 *
 * The panel receives these methods through slot props, so the UI never reaches
 * into `ctx.remote` at render time and stays testable with a plain stub.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { MetricDetail, MetricExplanation, MetricFilters, MetricRun, MetricSummary } from '../analytics-types.ts'
import type { InstanceBatch } from '../types.ts'
import type {
  ApplyEditsResult,
  AuditEntry,
  DomainUpdate,
  GenerateRequest,
  GenerateResult,
  OntologyDomainSummary,
  OntologyEdit,
  OntologyGraph,
  OntologyHealth,
  OntologyPatch,
  OntologyVersionDiff,
  OntologyVersionSummary,
  QualityReport,
  SparqlResult,
  ValidationReport,
} from '../types.ts'

/** Store methods the workbench calls. */
export interface OntologyStoreFace {
  listDomains(): Promise<RemoteResult<OntologyDomainSummary[]>>
  createDomain(domain: string, label: string): Promise<RemoteResult<OntologyDomainSummary>>
  updateDomain(domain: string, patch: DomainUpdate): Promise<RemoteResult<OntologyDomainSummary>>
  generate(request: GenerateRequest): Promise<RemoteResult<GenerateResult>>
  graph(domain: string): Promise<RemoteResult<OntologyGraph>>
  applyEdits(domain: string, edits: OntologyEdit[]): Promise<RemoteResult<ApplyEditsResult>>
  applyPatch(domain: string, patch: OntologyPatch): Promise<RemoteResult<ApplyEditsResult>>
  listVersions(domain: string): Promise<RemoteResult<OntologyVersionSummary[]>>
  submitReview(domain: string, version: string): Promise<RemoteResult<OntologyVersionSummary[]>>
  publishVersion(domain: string, version: string): Promise<RemoteResult<OntologyVersionSummary[]>>
  evaluateQuality(domain: string, goldTurtle: string, baselineName: string): Promise<RemoteResult<QualityReport>>
  diffVersions(domain: string, from: string, to: string): Promise<RemoteResult<OntologyVersionDiff>>
  deleteDomain(domain: string): Promise<RemoteResult<void>>
  deleteVersion(domain: string, version: string, force: boolean): Promise<RemoteResult<OntologyVersionSummary[]>>
  exportDomain(domain: string, format: 'text/turtle'): Promise<RemoteResult<string>>
  importOntology(domain: string, turtle: string, note: string): Promise<RemoteResult<OntologyGraph>>
  validateDomain(domain: string): Promise<RemoteResult<ValidationReport>>
  queryDomain(domain: string, sparql: string): Promise<RemoteResult<SparqlResult>>
  listMetrics(domain: string): Promise<RemoteResult<MetricSummary[]>>
  runMetric(domain: string, metricId: string, filters: MetricFilters): Promise<RemoteResult<MetricRun>>
  explainMetric(domain: string, metricId: string): Promise<RemoteResult<MetricExplanation>>
  drilldownMetric(
    domain: string,
    metricId: string,
    filters: MetricFilters,
    limit: number,
  ): Promise<RemoteResult<MetricDetail>>
  listMetricBatches(domain: string): Promise<RemoteResult<InstanceBatch[]>>
  importInstances(domain: string, turtle: string, batch: string): Promise<RemoteResult<InstanceBatch>>
  deleteInstanceBatch(domain: string, batch: string): Promise<RemoteResult<InstanceBatch[]>>
  auditLog(limit?: number): Promise<RemoteResult<AuditEntry[]>>
  health(): Promise<RemoteResult<OntologyHealth>>
}

/** Rejection carrying the Remote error code, so the panel can render one line. */
export class StoreCallError extends Error {
  /** Remote error code, e.g. `ontology/not-found`. */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'StoreCallError'
    this.code = code
  }
}

/**
 * Read a display message from any thrown value.
 * @param failure - the caught value.
 * @returns the error message, or the string form of a non-error value.
 */
export function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/**
 * Unwrap a Remote result or throw its failure.
 *
 * @param result - envelope returned by a Store method.
 * @returns the business value.
 */
export function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new StoreCallError(result.error.code, result.error.message)
  return result.value
}
