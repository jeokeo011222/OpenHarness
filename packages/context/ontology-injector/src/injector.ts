/**
 * Pre-step injection logic.
 *
 * Reads the configured business domain, resolves the summary of its published
 * version from the graph database (cached against that version), injects a
 * one-line index for it, and serves the full summary through the
 * `domain_summary` tool.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planMentions } from './mention.ts'
import type { MentionCandidate, MentionPick } from './mention.ts'
import { readDomainMeta, readSummaryCache, readVersionTurtle, writeSummaryCache } from './store.ts'
import { generateSummary } from './summary.ts'

const __dirname = resolve(fileURLToPath(import.meta.url), '..', '..')

/** Default ontology store — repo-root ontology-store/. */
export const DEFAULT_STORE_PATH = resolve(__dirname, '..', '..', '..', 'ontology-store')

/** Default cap on injected summary characters across all configured domains. */
export const DEFAULT_MAX_SUMMARY_CHARS = 4000

/**
 * How a turn's ontology context is chosen.
 *
 * `mention` (the default) reads the `@` tokens of the turn's own user message,
 * so a plain chat carries no ontology at all. `always` keeps the pre-existing
 * behaviour of injecting `defaultDomains` into every turn; deployments that
 * pinned a domain globally before this option existed keep working.
 */
export type InjectionMode = 'mention' | 'always'

/** Mode used when the deployment says nothing. */
export const DEFAULT_INJECTION_MODE: InjectionMode = 'mention'

/** Configurable options for the injector. */
export interface InjectorConfig {
  /** Root directory holding the graph database and per-domain source documents. */
  storePath?: string
  /** Domains injected into each turn's first step; disabled or missing domains are skipped. */
  defaultDomains?: readonly string[]
  /** Character budget for one summary; the per-turn injection carries only a one-line index. */
  maxSummaryChars?: number
  /** Per-turn selection source: `@` mentions in the user message, or a fixed global list. */
  injectionMode?: InjectionMode
}

/** Resolved injector state. */
interface ResolvedInjector {
  storePath: string
  defaultDomains: readonly string[]
  maxSummaryChars: number
  injectionMode: InjectionMode
}

/**
 * Resolve defaults into a concrete config.
 * @param cfg - the plugin config with optional store path, domains, and budget.
 * @returns the absolute store path, deduplicated domain ids, and the summary budget.
 */
export function resolveInjectorConfig(cfg: InjectorConfig): ResolvedInjector {
  const domains = (cfg.defaultDomains ?? [])
    .map(domain => domain.trim())
    .filter(domain => domain.length > 0)
  return {
    storePath: cfg.storePath ? resolve(cfg.storePath) : DEFAULT_STORE_PATH,
    defaultDomains: [...new Set(domains)],
    maxSummaryChars: cfg.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS,
    // An unknown value falls back to `mention`: the narrower behaviour, never
    // surprising a plain chat with ontology vocabulary it did not ask for.
    injectionMode: cfg.injectionMode === 'always' ? 'always' : DEFAULT_INJECTION_MODE,
  }
}

/** Inputs for one turn's domain selection. */
export interface SelectionInput {
  /** Selection source: the message's tokens, or the configured list. */
  readonly mode: InjectionMode
  /** Domains configured for `always`; ignored otherwise. */
  readonly defaults: readonly string[]
  /** The turn's newest user message text. */
  readonly text: string
  /** Every registered domain, read only in `mention` mode. */
  readonly domains: readonly MentionCandidate[]
}

/**
 * Decide which domains this turn carries.
 *
 * `mention` returns nothing when no message token names a domain — deliberately
 * without falling back to the configured list, because a fallback would make
 * "the user did not select an ontology" indistinguishable from "the deployment
 * pinned one", and the plain-chat promise would quietly break.
 *
 * @param input - mode, configured defaults, message text, and registered domains.
 * @returns the picks to inject, in message order.
 */
export function selectTurnDomains(input: SelectionInput): MentionPick[] {
  if (input.mode === 'always') return input.defaults.map(domain => ({ domain, token: '' }))
  return planMentions(input.text, input.domains)
}

/**
 * Cut a summary down to the configured character budget.
 *
 * The cut happens on a line boundary so class and property lists stay readable,
 * and the suffix tells the model the list is partial.
 * @param text - rendered summary.
 * @param limit - maximum characters to keep.
 * @returns the text unchanged when it fits, otherwise a truncated copy.
 */
export function truncateSummary(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = text.slice(0, Math.max(0, limit))
  const cut = head.lastIndexOf('\n')
  return `${cut > 0 ? head.slice(0, cut) : head}\n…（摘要已截断，超出字符预算）`
}

/**
 * Fetch or refresh the summary for one domain.
 *
 * Only the published version is injected: drafts and versions under review stay
 * invisible to the model until they are published.
 *
 * Cache strategy:
 *   1. The rendered summary is cached against the published version id; a
 *      matching stamp returns the cached text.
 *   2. Otherwise the published snapshot is rendered again and the cache rewritten.
 *   3. On load error (missing domain or version) → undefined (skip injection, do not throw)
 * @param storePath - the ontology store root.
 * @param domain - the business domain id.
 * @returns the summary text, or `undefined` when no published version is readable.
 */
export async function fetchDomainSummary(
  storePath: string,
  domain: string,
): Promise<string | undefined> {
  let published = ''
  let turtle = ''
  try {
    const meta = await readDomainMeta(storePath, domain)
    if (meta.activeVersion === null) return undefined
    published = meta.activeVersion
    turtle = await readVersionTurtle(storePath, domain, published)
  } catch (error: unknown) {
    // Missing domain, unpublished domain, or unreadable database — not a Harness
    // error; skip injection.
    console.warn('[ontology-injector] published graph unavailable for domain=%s: %o', domain, error)
    return undefined
  }

  const cached = await readSummaryCache(storePath, domain)
  if (cached !== null && cached.stamp === published) return cached.text

  const summary = generateSummary(domain, turtle)
  await writeSummaryCache(storePath, domain, { stamp: published, text: summary })
  return summary
}

/**
 * Wrap the summary in a `<system-reminder>` block identical to the format
 * described in the design document. This textual envelope is what the model
 * actually consumes — not raw RDF triples.
 *
 * @param summary - the rendered domain summary.
 * @param domain - the business domain id shown in the heading.
 * @param note - optional sentence placed above the summary, used to tell the
 *   model that a `@` token in the user message names this domain rather than a
 *   path. Omitted for globally configured injection, which has no token.
 * @returns the reminder block appended to the step request.
 */
export function wrapInjection(summary: string, domain: string, note?: string): string {
  const trimmedNote = note?.trim() ?? ''
  return `<system-reminder>
## 业务域本体知识：${domain}
${trimmedNote.length === 0 ? '' : `\n${trimmedNote}\n`}
${summary.trim()}
</system-reminder>`
}

/** Tool the index line points at for the full vocabulary. */
export const DOMAIN_SUMMARY_TOOL = 'domain_summary'

/**
 * Derive the one-line index entry injected for a domain.
 *
 * The per-turn injection carries only this line, so the full vocabulary cannot
 * dominate every request; the model reads the complete summary through the
 * `domain_summary` tool when a task actually needs it.
 * @param label - human-readable domain label.
 * @param domain - business domain id.
 * @param summary - rendered Markdown summary of the published version.
 * @returns one line naming the domain, its counts, and the tool to call.
 */
export function domainIndexLine(label: string, domain: string, summary: string): string {
  const counts = new Map<string, number>()
  let heading = ''
  for (const raw of summary.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('### ')) {
      heading = line.slice(4)
      counts.set(heading, 0)
      continue
    }
    if (heading.length > 0 && line.startsWith('- ')) counts.set(heading, (counts.get(heading) ?? 0) + 1)
  }
  const classes = counts.get('对象类') ?? 0
  const relations = counts.get('关键关系') ?? 0
  const attributes = counts.get('数据属性') ?? 0
  return `${label}（${domain}）：${classes} 个类、${relations} 条对象关系、${attributes} 个数据属性。需要完整词汇时调用 ${DOMAIN_SUMMARY_TOOL} 工具（domain="${domain}"）。`
}
