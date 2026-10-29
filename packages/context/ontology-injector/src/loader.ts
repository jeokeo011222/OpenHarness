/**
 * File-based ontology loader.
 *
 * Reads Turtle (.ttl) ontology and SHACL shape files from a configured
 * store directory. This module is pure Node.js — no Harness dependency —
 * so it can be tested independently.
 *
 * Expected layout:
 *   {store}/
 *   ├── registry.json                    {"domains": ["contract", ...]}
 *   └── {domain}/
 *       ├── ontology.ttl
 *       └── shapes.ttl
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Thrown when a required ontology file is missing or unreadable. */
export interface LoadError extends Error {
  kind: 'registry-missing' | 'domain-missing' | 'file-missing'
  path: string
}

function makeLoadError(kind: LoadError['kind'], path: string, message: string): LoadError {
  const error = new Error(message) as LoadError
  error.kind = kind
  error.path = path
  return error
}

/** Read registry.json and return the declared domain list. */
export async function listDomains(storePath: string): Promise<string[]> {
  const registryPath = join(resolve(storePath), 'registry.json')
  let raw: string
  try {
    raw = await readFile(registryPath, 'utf8')
  } catch (cause) {
    throw makeLoadError('registry-missing', registryPath,
      `ontology-injector: cannot read registry.json at ${registryPath}: ${(cause as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw makeLoadError('registry-missing', registryPath,
      `ontology-injector: registry.json at ${registryPath} is not valid JSON: ${(cause as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || !('domains' in parsed)) {
    throw makeLoadError('registry-missing', registryPath,
      `ontology-injector: registry.json at ${registryPath} missing "domains" field`)
  }
  const domains = (parsed as { domains: unknown }).domains
  if (!Array.isArray(domains) || !domains.every(d => typeof d === 'string')) {
    throw makeLoadError('registry-missing', registryPath,
      `ontology-injector: registry.json "domains" must be a string array`)
  }
  return domains
}

/** Ontology source pair returned by {@link loadOntology}. */
export interface OntologySources {
  /** Raw Turtle content of the domain's OWL ontology. */
  turtle: string
  /** Raw Turtle content of the domain's SHACL shapes. May be empty if absent. */
  shapes: string
  /** Resolved absolute path to the ontology.ttl file. Used for cache mtime comparison. */
  ontologyPath: string
}

/**
 * Read the .ttl files for one business domain.
 * @param storePath - root ontology store directory (containing registry.json).
 * @param domain - business domain name, e.g. "contract".
 * @throws {LoadError} when the directory or ontology.ttl is missing.
 */
export async function loadOntology(storePath: string, domain: string): Promise<OntologySources> {
  const absStore = resolve(storePath)
  const domainDir = join(absStore, domain)
  const ontologyPath = join(domainDir, 'ontology.ttl')
  const shapesPath = join(domainDir, 'shapes.ttl')

  let turtle: string
  try {
    turtle = await readFile(ontologyPath, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw makeLoadError('file-missing', ontologyPath,
        `ontology-injector: ontology.ttl not found at ${ontologyPath}`)
    }
    throw makeLoadError('file-missing', ontologyPath,
      `ontology-injector: cannot read ${ontologyPath}: ${(cause as Error).message}`)
  }

  let shapes = ''
  try {
    shapes = await readFile(shapesPath, 'utf8')
  } catch (cause) {
    // shapes.ttl is optional; absence is fine for the loader layer.
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw makeLoadError('file-missing', shapesPath,
        `ontology-injector: cannot read ${shapesPath}: ${(cause as Error).message}`)
    }
  }

  return { turtle, shapes, ontologyPath }
}
