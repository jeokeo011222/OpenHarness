/**
 * Pre-step injection logic.
 *
 * Reads the configured business domain, resolves the ontology
 * summary (with mtime-based cache refresh), and wraps it in a
 * `<system-reminder>` message for model consumption.
 *
 * All file I/O here is synchronous-only where trivial (mtime stat);
 * the actual summary generation is async via rdflib.
 */

import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOntology, type OntologySources } from './loader.ts'
import { generateSummary, summaryNeedsRefresh } from './summary.ts'

const __dirname = resolve(fileURLToPath(import.meta.url), '..', '..')

/** Default ontology store — repo-root ontology-store/. */
export const DEFAULT_STORE_PATH = resolve(__dirname, '..', '..', '..', 'ontology-store')

/** Configurable options for the injector. */
export interface InjectorConfig {
  /** Root directory containing registry.json and per-domain subdirs. */
  storePath?: string
  /** Fallback domain for sessions without an explicit businessDomain. */
  defaultDomain?: string
}

/** Resolved injector state. */
interface ResolvedInjector {
  storePath: string
  defaultDomain: string | undefined
}

/** Resolve defaults into a concrete config. */
export function resolveInjectorConfig(cfg: InjectorConfig): ResolvedInjector {
  return {
    storePath: cfg.storePath ? resolve(cfg.storePath) : DEFAULT_STORE_PATH,
    defaultDomain: cfg.defaultDomain,
  }
}

/**
 * Fetch or refresh the summary for one domain.
 *
 * Cache strategy:
 *   1. If summary.md exists and its mtime >= ontology.ttl mtime → read summary.md
 *   2. Otherwise re-run generateSummary (which writes summary.md + returns text)
 *   3. On load error (missing files) → undefined (skip injection, do not throw)
 */
export async function fetchDomainSummary(
  storePath: string,
  domain: string,
): Promise<string | undefined> {
  let sources: OntologySources
  try {
    sources = await loadOntology(storePath, domain)
  } catch (error: unknown) {
    // Missing domain or broken store — not an Harness error; skip injection.
    console.warn('[ontology-injector] loadOntology failed for domain=%s: %o', domain, error)
    return undefined
  }

  const domainDir = join(storePath, domain)
  const summaryPath = join(domainDir, 'summary.md')

  try {
    if (!(await summaryNeedsRefresh(summaryPath, sources.ontologyPath))) {
      return await readFile(summaryPath, 'utf8')
    }
  } catch {
    // Fall through to regeneration on any stat/read error.
  }

  // Regenerate and write.
  return await generateSummary(storePath, domain, sources.turtle)
}

/**
 * Wrap the summary in a `<system-reminder>` block identical to the format
 * described in the design document. This textual envelope is what the model
 * actually consumes — not raw RDF triples.
 */
export function wrapInjection(summary: string, domain: string): string {
  return `<system-reminder>
## 业务域本体知识：${domain}

${summary.trim()}
</system-reminder>`
}
