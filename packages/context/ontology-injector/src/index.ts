/**
 * Ontology center: the prompt-injection listener from the original injector,
 * plus the Host service behind the generated `ctx.remote.ontologyStore`
 * namespace — domain listing, one-shot generation from an uploaded document,
 * graph reads, micro-edits, and version activation.
 *
 * Injection happens only at step 1 of each turn, when a configured fallback
 * domain is available. The pre-step listener is a waterfall and always calls
 * `next()`.
 *
 * @module @deepseek-ai/dsh-ontology-injector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { resolveInjectorConfig, fetchDomainSummary, wrapInjection } from './injector.ts'
import { extractDocumentText } from './extract.ts'
import { generateOntology } from './generate.ts'
import { applyEdits as applyModelEdits, diffModels, emptyModel, emitTurtle, parseTurtle, toGraph, OntologyModelError } from './model.ts'
import {
  compareVersions,
  domainExists,
  listSources,
  listVersions,
  nextVersion,
  readDomainMeta,
  readLiveTurtle,
  readRegistry,
  readVersionTurtle,
  requireDomainId,
  writeDomainMeta,
  writeLiveTurtle,
  writeRegistry,
  writeSource,
  writeVersion,
} from './store.ts'
import type {
  ApplyEditsResult,
  DomainUpdate,
  GenerateRequest,
  GenerateResult,
  GenerationStep,
  OntologyDomainSummary,
  OntologyEdit,
  OntologyGraph,
  OntologyVersionDiff,
  OntologyVersionSummary,
} from './types.ts'

export type * from './types.ts'

/** Register our plugin name as a valid user-message source kind. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'ontology-injector': { kind: 'ontology-injector' } & ContextFormed
  }
}

/** Error details the ontology workbench can report to the browser. */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No such domain under the store root. */
    'ontology/not-found': { readonly domain: string }
    /** Domain id rejected before any directory was touched. */
    'ontology/invalid-domain': { readonly domain: string }
    /** Request rejected before any model call. */
    'ontology/invalid-request': { readonly reason: string }
    /** A write for this domain is already in flight. */
    'ontology/busy': { readonly domain: string }
    /** Extraction produced nothing usable. */
    'ontology/generate-failed': { readonly reason: string }
    /** Micro-edits rejected by model validation. */
    'ontology/edit-rejected': { readonly reason: string }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Ontology center Host service. */
    ontologyStore: OntologyStore
  }
}

/** Default extraction model. */
const DEFAULT_MODEL = 'deepseek-chat'

/** Default OpenAI-compatible endpoint. */
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'

/** Default cap on clause groups processed per run. */
const DEFAULT_MAX_CLAUSES = 12

/** Default cap on uploaded document size, in bytes. */
const DEFAULT_MAX_SOURCE_BYTES = 20 * 1024 * 1024

/** Ontology center configuration. */
export interface Config {
  /** Root directory containing registry.json and per-domain subdirs. */
  readonly storePath?: string
  /** Fallback domain injected into each turn's first step. */
  readonly defaultDomain?: string
  /** Extraction model name. */
  readonly model?: string
  /** OpenAI-compatible endpoint base URL. */
  readonly baseUrl?: string
  /** Clause groups processed per generation run. */
  readonly maxClauses?: number
  /** Uploaded document size ceiling, in bytes. */
  readonly maxSourceBytes?: number
  /** Extraction API key; defaults to `DEEPSEEK_API_KEY`. */
  readonly apiKey?: string
}

/** Host service behind the `ontologyStore` Remote namespace. */
export class OntologyStore extends TypertRemoteService {
  static inject = ['typert', 'agents']

  static Config: z<Config> = z.object({
    storePath: z.string(),
    defaultDomain: z.string(),
    model: z.string().default(DEFAULT_MODEL),
    baseUrl: z.string().default(DEFAULT_BASE_URL),
    maxClauses: z.natural().min(1).default(DEFAULT_MAX_CLAUSES),
    maxSourceBytes: z.natural().min(1).default(DEFAULT_MAX_SOURCE_BYTES),
    apiKey: z.string(),
  })

  private readonly storePath: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly maxClauses: number
  private readonly maxSourceBytes: number
  private readonly apiKey: string | undefined
  /** Domains with a write in flight, so two browser requests cannot interleave. */
  private readonly writing = new Set<string>()

  /**
   * Wire the Remote namespace and the per-turn injection listener.
   *
   * @param ctx - plugin context; listeners are disposed with it.
   * @param config - store path, model endpoint, and injection fallback.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'ontologyStore', { namespace: 'ontologyStore' })
    const resolved = config as Required<Config>
    const injector = resolveInjectorConfig(config)
    this.storePath = injector.storePath
    this.model = resolved.model
    this.baseUrl = resolved.baseUrl
    this.maxClauses = resolved.maxClauses
    this.maxSourceBytes = resolved.maxSourceBytes
    this.apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY

    ctx.logger.info('[ontology-store] loaded (store=%s, defaultDomain=%s)',
      this.storePath, injector.defaultDomain ?? '<none>')

    /** Track last injected turn per session so we never double-inject. */
    const injectedTurnBySession = new WeakMap<Session, number>()

    ctx.on('agent/pre-step', async (
      { agent, turn, step, signal },
      next,
    ): Promise<PreStepDecision> => {
      // MUST call next() — waterfall semantics; omitting it stalls the loop.
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      if (step !== 1) return decision

      const lastInjected = injectedTurnBySession.get(agent.session)
      if (lastInjected === turn) return decision

      const domain = injector.defaultDomain
      if (domain === undefined) return decision

      const meta = await readDomainMeta(this.storePath, domain)
      if (meta.disabled) return decision

      const summary = await fetchDomainSummary(this.storePath, domain)
      if (summary === undefined) return decision

      const wrapped = wrapInjection(summary, domain)
      const injectionMessage = createUserMessage({
        content: [{ type: 'text', text: wrapped }],
        source: { kind: 'ontology-injector', form: 'instructions', sections: [{ name: 'ontology-injector', text: summary }] },
      })

      injectedTurnBySession.set(agent.session, turn)
      return { ...decision, messages: [...decision.messages, injectionMessage] }
    })
  }

  /**
   * List every registered domain with its active version and graph size.
   *
   * @returns one summary per domain, ordered by id.
   */
  @Remote
  async listDomains(): Promise<OntologyDomainSummary[]> {
    const ids = await readRegistry(this.storePath)
    const summaries = await Promise.all(ids.map(id => this.summarize(id)))
    return summaries.sort((left, right) => left.id.localeCompare(right.id))
  }

  /**
   * Create an empty domain and register it.
   *
   * @param domain - directory-safe domain id.
   * @param label - display name for the domain.
   * @returns the new domain's summary.
   */
  @Remote
  async createDomain(domain: string, label: string): Promise<OntologyDomainSummary> {
    this.requireIdle(domain)
    try {
      requireDomainId(domain)
    } catch (error) {
      throw new RemoteError('ontology/invalid-domain', (error as Error).message, { domain })
    }
    const ids = await readRegistry(this.storePath)
    if (ids.includes(domain) || await domainExists(this.storePath, domain)) {
      throw new RemoteError('ontology/invalid-request', `Domain already exists: ${domain}`, { reason: `Domain already exists: ${domain}` })
    }
    const now = new Date().toISOString()
    this.writing.add(domain)
    try {
      await writeRegistry(this.storePath, [...ids, domain])
      await writeDomainMeta(this.storePath, {
        id: domain,
        label: label.trim() || domain,
        createdAt: now,
        updatedAt: now,
        activeVersion: null,
        disabled: false,
      })
      await writeLiveTurtle(this.storePath, domain, emitTurtle(emptyModel(domain)))
    } finally {
      this.writing.delete(domain)
    }
    return this.summarize(domain)
  }

  /**
   * Rename a domain or toggle whether it takes part in per-turn injection.
   *
   * @param domain - registered domain id.
   * @param patch - fields to change; omitted fields keep their current value.
   * @returns the updated domain summary.
   */
  @Remote
  async updateDomain(domain: string, patch: DomainUpdate): Promise<OntologyDomainSummary> {
    this.requireIdle(domain)
    if (!await domainExists(this.storePath, domain)) {
      throw new RemoteError('ontology/not-found', `Domain not found: ${domain}`, { domain })
    }
    const meta = await readDomainMeta(this.storePath, domain)
    const label = typeof patch.label === 'string' ? patch.label.trim() : ''
    const disabled = typeof patch.disabled === 'boolean' ? patch.disabled : meta.disabled
    this.writing.add(domain)
    try {
      await writeDomainMeta(this.storePath, {
        id: domain,
        label: label.length > 0 ? label : meta.label,
        createdAt: meta.createdAt,
        updatedAt: new Date().toISOString(),
        activeVersion: meta.activeVersion,
        disabled,
      })
    } finally {
      this.writing.delete(domain)
    }
    return this.summarize(domain)
  }

  /**
   * Generate an ontology from an uploaded document and snapshot it as a version.
   *
   * @param request - target domain, display label, file name, and base64 bytes.
   * @param signal - cancellation from the Remote call.
   * @returns the new graph, its version, the stage log, and warnings.
   */
  @Remote
  async generate(request: GenerateRequest, signal: AbortSignal): Promise<GenerateResult> {
    this.requireIdle(request.domain)
    try {
      requireDomainId(request.domain)
    } catch (error) {
      throw new RemoteError('ontology/invalid-domain', (error as Error).message, { domain: request.domain })
    }
    if (this.apiKey === undefined) {
      throw new RemoteError('ontology/invalid-request', 'Extraction API key is not configured', { reason: 'Set DEEPSEEK_API_KEY or the plugin apiKey config field' })
    }

    const bytes = Buffer.from(request.contentBase64, 'base64')
    if (bytes.byteLength === 0) {
      throw new RemoteError('ontology/invalid-request', 'The uploaded document is empty', { reason: 'Decoded document is empty' })
    }
    if (bytes.byteLength > this.maxSourceBytes) {
      throw new RemoteError('ontology/invalid-request', 'The uploaded document is too large', {
        reason: `Document is ${bytes.byteLength} bytes; the limit is ${this.maxSourceBytes}`,
      })
    }

    this.writing.add(request.domain)
    try {
      const exists = await this.prepareDomain(request.domain, request.label)
      const steps: GenerationStep[] = []
      const warnings: string[] = []
      if (!exists) {
        warnings.push(`Created a new domain: ${request.domain}`)
      }

      const extracted = await extractDocumentText(request.fileName, bytes)
      const sourceName = await writeSource(this.storePath, request.domain, request.fileName, bytes)
      steps.push({
        stage: 'read',
        message: `${extracted.format.toUpperCase()} text extracted (${extracted.text.length} characters)`,
        status: 'done',
      })

      const liveTurtle = await readLiveTurtle(this.storePath, request.domain)
      const baseModel = liveTurtle.trim().length > 0 ? parseTurtle(liveTurtle, request.domain) : emptyModel(request.domain)

      const outcome = await generateOntology(extracted.text, baseModel, {
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        model: this.model,
        maxClauses: this.maxClauses,
      }, signal)

      warnings.push(...outcome.warnings)
      steps.push(...outcome.steps.slice(1))
      signal.throwIfAborted()

      const meta = await readDomainMeta(this.storePath, request.domain)
      const versions = await listVersions(this.storePath, request.domain)
      const version = nextVersion(versions.map(record => record.version))
      const turtle = emitTurtle(outcome.model)
      const now = new Date().toISOString()
      await writeVersion(this.storePath, request.domain, turtle, {
        version,
        createdAt: now,
        approver: this.model,
        note: `Generated from ${request.fileName}`,
        sourceName,
      })
      await writeLiveTurtle(this.storePath, request.domain, turtle)
      await writeDomainMeta(this.storePath, {
        id: request.domain,
        label: meta.label,
        createdAt: meta.createdAt || now,
        updatedAt: now,
        activeVersion: version,
        disabled: meta.disabled,
      })
      steps.push({ stage: 'version', message: `Snapshot created: ${version}`, status: 'done' })

      const graph = toGraph(outcome.model, request.domain, meta.label, version)
      return { graph, version, steps, warnings, sourceName }
    } catch (error) {
      if (signal.aborted) throw new RemoteError('ontology/generate-failed', 'Generation cancelled', { reason: 'Generation cancelled' })
      if (error instanceof RemoteError) throw error
      throw new RemoteError('ontology/generate-failed', (error as Error).message, { reason: (error as Error).message })
    } finally {
      this.writing.delete(request.domain)
    }
  }

  /**
   * Read one domain's active graph.
   *
   * @param domain - registered domain id.
   * @returns nodes, edges, Turtle, and the active version.
   */
  @Remote('graph')
  async getGraph(domain: string): Promise<OntologyGraph> {
    return this.loadGraph(domain)
  }

  /**
   * Apply micro-edits to the live graph and snapshot the result.
   *
   * @param domain - registered domain id.
   * @param edits - operations applied in order.
   * @param signal - cancellation from the Remote call.
   * @returns the new graph, its version, and repair warnings.
   */
  @Remote
  async applyEdits(domain: string, edits: OntologyEdit[], signal: AbortSignal): Promise<ApplyEditsResult> {
    this.requireIdle(domain)
    this.writing.add(domain)
    try {
      signal.throwIfAborted()
      const meta = await readDomainMeta(this.storePath, domain)
      const turtle = await readLiveTurtle(this.storePath, domain)
      if (turtle.trim().length === 0) throw new RemoteError('ontology/not-found', `Domain has no ontology: ${domain}`, { domain })

      const model = parseTurtle(turtle, domain)
      const { model: edited, warnings } = applyModelEdits(model, edits)
      const versions = await listVersions(this.storePath, domain)
      const version = nextVersion(versions.map(record => record.version))
      const nextTurtle = emitTurtle(edited)
      const now = new Date().toISOString()
      await writeVersion(this.storePath, domain, nextTurtle, {
        version,
        createdAt: now,
        approver: 'workbench',
        note: `Graph edit (${edits.length} operations)`,
        sourceName: '',
      })
      await writeLiveTurtle(this.storePath, domain, nextTurtle)
      await writeDomainMeta(this.storePath, {
        id: domain,
        label: meta.label,
        createdAt: meta.createdAt || now,
        updatedAt: now,
        activeVersion: version,
        disabled: meta.disabled,
      })
      return { graph: toGraph(edited, domain, meta.label, version), version, warnings }
    } catch (error) {
      if (signal.aborted) throw new RemoteError('ontology/edit-rejected', 'Edit cancelled', { reason: 'Edit cancelled' })
      if (error instanceof RemoteError) throw error
      if (error instanceof OntologyModelError) {
        throw new RemoteError('ontology/edit-rejected', error.message, { reason: error.message })
      }
      throw new RemoteError('ontology/edit-rejected', (error as Error).message, { reason: (error as Error).message })
    } finally {
      this.writing.delete(domain)
    }
  }

  /**
   * List a domain's version snapshots, newest first.
   *
   * @param domain - registered domain id.
   * @returns version rows with node and edge counts and the active flag.
   */
  @Remote
  async listVersions(domain: string): Promise<OntologyVersionSummary[]> {
    const meta = await readDomainMeta(this.storePath, domain)
    const records = await listVersions(this.storePath, domain)
    const rows: OntologyVersionSummary[] = []
    for (const record of records) {
      let nodeCount = 0
      let edgeCount = 0
      try {
        const model = parseTurtle(await readVersionTurtle(this.storePath, domain, record.version), domain)
        const graph = toGraph(model, domain, meta.label, record.version)
        nodeCount = graph.nodes.length
        edgeCount = graph.edges.length
      } catch {
        // A damaged snapshot still lists; its counts stay zero.
      }
      rows.push({
        version: record.version,
        createdAt: record.createdAt,
        approver: record.approver,
        note: record.note,
        nodeCount,
        edgeCount,
        active: meta.activeVersion === null
          ? record.version === records[0]?.version
          : record.version === meta.activeVersion,
      })
    }
    return rows.sort((left, right) => compareVersions(right.version, left.version))
  }

  /**
   * Make one stored version the active graph.
   *
   * @param domain - registered domain id.
   * @param version - snapshot to activate.
   * @returns the activated graph.
   */
  @Remote
  async activateVersion(domain: string, version: string): Promise<OntologyGraph> {
    this.requireIdle(domain)
    this.writing.add(domain)
    try {
      const meta = await readDomainMeta(this.storePath, domain)
      let turtle: string
      try {
        turtle = await readVersionTurtle(this.storePath, domain, version)
      } catch {
        throw new RemoteError('ontology/not-found', `Version not found: ${version}`, { domain })
      }
      await writeLiveTurtle(this.storePath, domain, turtle)
      await writeDomainMeta(this.storePath, {
        id: domain,
        label: meta.label,
        createdAt: meta.createdAt,
        updatedAt: new Date().toISOString(),
        activeVersion: version,
        disabled: meta.disabled,
      })
      return toGraph(parseTurtle(turtle, domain), domain, meta.label, version)
    } finally {
      this.writing.delete(domain)
    }
  }

  /**
   * Compare two stored versions.
   *
   * @param domain - registered domain id.
   * @param from - earlier version id.
   * @param to - later version id.
   * @returns node and edge deltas.
   */
  @Remote
  async diffVersions(domain: string, from: string, to: string): Promise<OntologyVersionDiff> {
    let fromTurtle: string
    let toTurtle: string
    try {
      fromTurtle = await readVersionTurtle(this.storePath, domain, from)
      toTurtle = await readVersionTurtle(this.storePath, domain, to)
    } catch (error) {
      throw new RemoteError('ontology/not-found', (error as Error).message, { domain })
    }
    return diffModels(
      parseTurtle(fromTurtle, domain),
      parseTurtle(toTurtle, domain),
      { from, to },
    )
  }

  /** Reject a second write for one domain. */
  private requireIdle(domain: string): void {
    if (this.writing.has(domain)) {
      throw new RemoteError('ontology/busy', `A write is already in flight for ${domain}`, { domain })
    }
  }

  /** Create the domain directory when the request names an unregistered domain. */
  private async prepareDomain(domain: string, label: string): Promise<boolean> {
    const ids = await readRegistry(this.storePath)
    if (ids.includes(domain)) return true
    const now = new Date().toISOString()
    await writeRegistry(this.storePath, [...ids, domain])
    await writeDomainMeta(this.storePath, {
      id: domain,
      label: label.trim() || domain,
      createdAt: now,
      updatedAt: now,
      activeVersion: null,
      disabled: false,
    })
    return false
  }

  /** Read the live graph of a domain. */
  private async loadGraph(domain: string): Promise<OntologyGraph> {
    if (!await domainExists(this.storePath, domain)) {
      throw new RemoteError('ontology/not-found', `Domain not found: ${domain}`, { domain })
    }
    const meta = await readDomainMeta(this.storePath, domain)
    const turtle = await readLiveTurtle(this.storePath, domain)
    const model = turtle.trim().length > 0 ? parseTurtle(turtle, domain) : emptyModel(domain)
    return toGraph(model, domain, meta.label, meta.activeVersion)
  }

  /** Build one domain's rail summary. */
  private async summarize(domain: string): Promise<OntologyDomainSummary> {
    const meta = await readDomainMeta(this.storePath, domain)
    const records = await listVersions(this.storePath, domain)
    const sources = await listSources(this.storePath, domain)
    let nodeCount = 0
    let edgeCount = 0
    try {
      const graph = await this.loadGraph(domain)
      nodeCount = graph.nodes.length
      edgeCount = graph.edges.length
    } catch {
      // A domain without a readable ontology still lists with zero counts.
    }
    return {
      id: domain,
      label: meta.label,
      version: meta.activeVersion ?? records[0]?.version ?? null,
      versionCount: records.length,
      nodeCount,
      edgeCount,
      updatedAt: meta.updatedAt.length > 0 ? meta.updatedAt : null,
      sourceCount: sources.length,
      disabled: meta.disabled,
    }
  }
}

export default OntologyStore
