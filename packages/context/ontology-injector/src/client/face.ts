/**
 * Narrow Client face of the `ontologyStore` Remote namespace.
 *
 * The panel receives these methods through slot props, so the UI never reaches
 * into `ctx.remote` at render time and stays testable with a plain stub.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ApplyEditsResult,
  DomainUpdate,
  GenerateRequest,
  GenerateResult,
  OntologyDomainSummary,
  OntologyEdit,
  OntologyGraph,
  OntologyVersionDiff,
  OntologyVersionSummary,
} from '../types.ts'

/** Store methods the workbench calls. */
export interface OntologyStoreFace {
  listDomains(): Promise<RemoteResult<OntologyDomainSummary[]>>
  createDomain(domain: string, label: string): Promise<RemoteResult<OntologyDomainSummary>>
  updateDomain(domain: string, patch: DomainUpdate): Promise<RemoteResult<OntologyDomainSummary>>
  generate(request: GenerateRequest): Promise<RemoteResult<GenerateResult>>
  graph(domain: string): Promise<RemoteResult<OntologyGraph>>
  applyEdits(domain: string, edits: OntologyEdit[]): Promise<RemoteResult<ApplyEditsResult>>
  listVersions(domain: string): Promise<RemoteResult<OntologyVersionSummary[]>>
  activateVersion(domain: string, version: string): Promise<RemoteResult<OntologyGraph>>
  diffVersions(domain: string, from: string, to: string): Promise<RemoteResult<OntologyVersionDiff>>
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
