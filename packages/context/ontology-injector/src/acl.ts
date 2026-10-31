/**
 * Ontology-domain roles for the account directory: which Remote endpoints each
 * granted role allows on one domain, plus the baseline every signed-in account
 * holds. `global` endpoints list or inspect the store itself; domain endpoints
 * read and change one domain's vocabulary.
 * @module @deepseek-ai/dsh-ontology-injector/src/acl
 */

import type { RemoteAccessAction, RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access'
import type { AccountRole } from '@deepseek-ai/dsh-account-directory'

/** Endpoints that read one domain. */
const READ_ACTIONS = [
  'ontologyStore/graph',
  'ontologyStore/listVersions',
  'ontologyStore/diffVersions',
  'ontologyStore/exportDomain',
  'ontologyStore/validateDomain',
  'ontologyStore/queryDomain',
  'ontologyStore/listMetrics',
  'ontologyStore/runMetric',
  'ontologyStore/explainMetric',
  'ontologyStore/drilldownMetric',
  'ontologyStore/listMetricBatches',
  'ontologyStore/retrievalTrace',
  'ontologyStore/retrievalLibrary',
  'ontologyStore/retrievalChunks',
] as const satisfies readonly RemoteAccessAction[]

/** Endpoints that draft or change vocabulary within one domain. */
const AUTHOR_ACTIONS = [
  ...READ_ACTIONS,
  'ontologyStore/generate',
  'ontologyStore/applyEdits',
  'ontologyStore/applyPatch',
  'ontologyStore/importOntology',
  'ontologyStore/createDomain',
  'ontologyStore/evaluateQuality',
  'ontologyStore/importInstances',
  'ontologyStore/retrievalIngest',
] as const satisfies readonly RemoteAccessAction[]

/** Reviewers move a draft into review; publishers move a reviewed version live. */
const REVIEWER_ACTIONS = [...READ_ACTIONS, 'ontologyStore/submitReview'] as const satisfies readonly RemoteAccessAction[]

const PUBLISHER_ACTIONS = [...READ_ACTIONS, 'ontologyStore/publishVersion'] as const satisfies readonly RemoteAccessAction[]

/** Domain owners also manage the domain and its versions. */
const OWNER_ACTIONS = [
  ...AUTHOR_ACTIONS,
  ...REVIEWER_ACTIONS,
  ...PUBLISHER_ACTIONS,
  'ontologyStore/updateDomain',
  'ontologyStore/deleteDomain',
  'ontologyStore/deleteInstanceBatch',
  'ontologyStore/deleteVersion',
] as const satisfies readonly RemoteAccessAction[]

/** Actions each granted role contributes on one domain. */
const DOMAIN_ACTIONS: Readonly<Record<AccountRole, readonly RemoteAccessAction[]>> = {
  viewer: READ_ACTIONS,
  author: AUTHOR_ACTIONS,
  reviewer: REVIEWER_ACTIONS,
  publisher: PUBLISHER_ACTIONS,
  owner: OWNER_ACTIONS,
}

/** Endpoints every signed-in account may call: the store-wide read and audit surface. */
const BASELINE_ACTIONS = [
  'ontologyStore/listDomains',
  'ontologyStore/health',
  'ontologyStore/auditLog',
  // Static demonstration copy: no domain, no store read, nothing to protect.
  'ontologyStore/retrievalExamples',
] as const satisfies readonly RemoteAccessAction[]

/**
 * Bindings one stored grant contributes for the `ontology-domain` kind.
 * @param resourceId - domain id the grant names.
 * @param roles - roles the grant holds on that domain.
 * @returns one binding, or none when every role is unknown to this kind.
 */
export function ontologyDomainBindings(
  resourceId: string,
  roles: readonly AccountRole[],
): readonly RemoteAccessBinding[] {
  const actions = new Set<RemoteAccessAction>()
  for (const role of roles) {
    for (const action of DOMAIN_ACTIONS[role]) actions.add(action)
  }
  if (actions.size === 0) return []
  return [{
    resource: { kind: 'ontology-domain', id: resourceId },
    role: { name: 'ontology-domain', resource: 'ontology-domain', actions: Array.from(actions) },
  }]
}

/** Bindings every signed-in account holds independently of grants. */
export const ONTOLOGY_BASELINE: readonly RemoteAccessBinding[] = [{
  resource: { kind: 'global' },
  role: { name: 'ontology-store-reader', resource: 'global', actions: BASELINE_ACTIONS },
}]

/**
 * Read the `domain` argument of one Remote call, either as a top-level parameter
 * or inside its request object.
 * @param args - validated wire values of the call.
 * @returns the domain id, or `undefined` when the call names none.
 */
export function ontologyDomainOf(args: Readonly<Record<string, unknown>>): string | undefined {
  const direct = args['domain']
  if (typeof direct === 'string' && direct !== '') return direct
  for (const value of Object.values(args)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const nested = (value as Record<string, unknown>)['domain']
    if (typeof nested === 'string' && nested !== '') return nested
  }
  return undefined
}
