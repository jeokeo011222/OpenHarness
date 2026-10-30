/**
 * Ontology loader over the embedded graph database.
 *
 * The live graph and the domain registry live in `<store>/graph.db.nq`; see
 * `store.ts`. This module only adapts them into the shape the injection path
 * consumes, so the pre-step listener stays free of storage details.
 */

import { readDomainMeta, readLiveTurtle, readRegistry } from './store.ts'

/** Thrown when a requested domain has no graph in the database. */
export interface LoadError extends Error {
  kind: 'domain-missing'
  domain: string
}

/**
 * Read the registered domain ids.
 * @param storePath - root ontology store directory.
 * @returns the registered domain ids, empty when none exists.
 */
export async function listDomains(storePath: string): Promise<string[]> {
  return await readRegistry(storePath)
}

/** Ontology content returned by {@link loadOntology}. */
export interface OntologySources {
  /** Raw Turtle content of the domain's OWL ontology. */
  turtle: string
  /** Domain revision stamp the content was read at, used to key the summary cache. */
  revision: string
}

/**
 * Read the live graph of one business domain.
 * @param storePath - root ontology store directory.
 * @param domain - business domain name, e.g. "contract".
 * @returns the domain's live Turtle plus its revision stamp.
 * @throws {LoadError} when the domain has no live graph.
 */
export async function loadOntology(storePath: string, domain: string): Promise<OntologySources> {
  const turtle = await readLiveTurtle(storePath, domain)
  if (turtle.trim().length === 0) {
    const error = new Error(`ontology-injector: no live graph for domain ${domain}`) as LoadError
    error.kind = 'domain-missing'
    error.domain = domain
    throw error
  }
  const meta = await readDomainMeta(storePath, domain)
  return { turtle, revision: meta.updatedAt }
}
