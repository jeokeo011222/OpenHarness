/**
 * One-line identity for a domain in a picker row.
 *
 * Both pickers (the composer's chat seat and the ontology center's scope seat)
 * show the same second line, and it has to say what a pick will mean rather
 * than duplicate the label: the id is what an `@` token carries and the version
 * plus node count are what tell two same-named domains apart.
 *
 * @module
 */

import type { OntologyDomainSummary } from '../types.ts'
import type { Translate } from './Inspector.tsx'

/**
 * Describe one domain for a menu row.
 *
 * @param domain - domain behind the row.
 * @param t - copy bound to the workbench namespace.
 * @returns id, active version, and graph size in one line.
 */
export function domainRowDescription(domain: OntologyDomainSummary, t: Translate): string {
  const version = domain.version === null ? '' : ` · ${t('versionPrefix')}${domain.version}`
  return `${domain.id}${version} · ${domain.nodeCount} ${t('nodeCount')}`
}
