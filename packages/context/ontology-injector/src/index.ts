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
import { resolveInjectorConfig, fetchDomainSummary, domainIndexLine, wrapInjection, selectTurnDomains } from './injector.ts'
import { latestUserText, findLabelConflict } from './mention.ts'
import type { InjectionMode } from './injector.ts'
import type { MentionCandidate } from './mention.ts'
import { ONTOLOGY_BASELINE, ontologyDomainBindings, ontologyDomainOf } from './acl.ts'
import { registerDomainSummaryTool } from './tools.ts'
import { registerAnalyticsTools } from './analytics-tools.ts'
import { registerComplianceTool, runCompliance } from './compliance.ts'
import { objectIndexLine, registerObjectTools } from './objects/index.ts'
import { chunkStats, ingestDocument, readChunks } from './retrieval/chunks.ts'
import { loadLexicon } from './retrieval/lexicon.ts'
import type {
  ChunkLibraryStats,
  EvidenceChunk,
  IngestRequest,
  TraceExample,
  TraceResult,
} from './retrieval/types.ts'
import { DEMO_EXAMPLES, trace as traceQuestion } from './trace.ts'
import {
  AnalyticsError,
  drilldownMetric as executeDrilldown,
  explainMetric as explainCatalogMetric,
  listMetrics as catalogMetrics,
  runMetric as executeMetric,
} from './analytics.ts'
import type { MetricDetail, MetricExplanation, MetricFilters, MetricRun, MetricSummary } from './analytics.ts'
import { extractDocumentText } from './extract.ts'
import { generateOntology } from './generate.ts'
import type { GenerationSettings } from './generate.ts'
import { OntologyDatabaseError, SCHEMA_VERSION } from './graph-db.ts'
import { applyEdits as applyModelEdits, diffModels, emptyModel, emitTurtle, parseTurtle, patchToEdits, toGraph, OntologyModelError } from './model.ts'
import type { OntologyModel } from './model.ts'
import { evaluateQuality } from './quality.ts'
import {
  OntologyStoreError,
  appendAudit,
  clearInstanceGraph,
  compareVersions,
  deleteDomain as deleteStoredDomain,
  deleteVersion as deleteStoredVersion,
  domainExists,
  domainStats,
  exportDomain as exportStoredDomain,
  importOntology as importStoredOntology,
  listInstanceBatches,
  listSources,
  listVersions,
  nextVersion,
  querySparql,
  readAudit,
  readDomainMeta,
  readLiveTurtle,
  readRegistry,
  readShapesTurtle,
  readVersionTurtle,
  requireBatchId,
  requireDomainId,
  updateVersionRecord,
  writeDomainMeta,
  writeInstanceGraph,
  writeLiveTurtle,
  writeRegistry,
  writeShapes,
  writeSource,
  writeVersion,
} from './store.ts'
import type { VersionRecord } from './store.ts'
import type { InstanceBatch } from './types.ts'
import { validateOntology } from './validate.ts'
import type {
  ApplyEditsResult,
  AuditEntry,
  ComplianceReport,
  DomainUpdate,
  GenerateRequest,
  GenerateResult,
  GenerationStep,
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
    /** SPARQL query refused as non-read-only or unsupported. */
    'ontology/query-rejected': { readonly reason: string }
    /** The version is the active graph and needs explicit force to delete. */
    'ontology/version-active': { readonly domain: string; readonly version: string }
    /** Turtle import rejected before or during the write. */
    'ontology/import-failed': { readonly reason: string }
    /** The durable image is unreadable or records a newer format version. */
    'ontology/storage-corrupt': { readonly reason: string }
    /** A version is in a review state that forbids the requested transition. */
    'ontology/version-status': { readonly domain: string; readonly version: string; readonly status: string }
    /** A metric id is outside the catalog. */
    'analytics/unknown-metric': { readonly metric: string }
    /** A metric filter was rejected before reaching SPARQL. */
    'analytics/invalid-filter': { readonly reason: string }
    /** An instance batch id is outside the accepted form. */
    'instance/invalid-batch': { readonly batch: string }
    /** Imported instance Turtle is unparsable or empty. */
    'instance/invalid-turtle': { readonly reason: string }
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

/** Default character budget for clause text stored on each node. */
const DEFAULT_MAX_EVIDENCE_CHARS = 200

/** Default cap on one instance Turtle import, in bytes. */
const DEFAULT_MAX_INSTANCE_BYTES = 20 * 1024 * 1024

/** Default source kinds whose messages must not trigger ontology injection. */
const DEFAULT_SKIP_SOURCE_KINDS: readonly string[] = ['schedule']

/** Ontology center configuration. */
export interface Config {
  /** Root directory holding the graph database (`graph.db.nq`) and uploaded sources. */
  readonly storePath?: string
  /** Domains injected into each turn's first step; disabled or missing ids are skipped. */
  readonly defaultDomains?: string[]
  /** Where a turn's domains come from: the message's `@` tokens (default) or `defaultDomains`. */
  readonly injectionMode?: InjectionMode
  /** Character budget for one summary; the per-turn injection carries only a one-line index. */
  readonly maxSummaryChars?: number
  /** Extraction model name. */
  readonly model?: string
  /** OpenAI-compatible endpoint base URL. */
  readonly baseUrl?: string
  /** Clause groups processed per generation run. */
  readonly maxClauses?: number
  /** Uploaded document size ceiling, in bytes. */
  readonly maxSourceBytes?: number
  /** One instance Turtle import ceiling, in bytes. */
  readonly maxInstanceBytes?: number
  /** Clause text stored on each node, in characters. */
  readonly maxEvidenceChars?: number
  /** Extraction API key; defaults to `DEEPSEEK_API_KEY`. */
  readonly apiKey?: string
  /** Message source kinds that must never trigger ontology injection on step 1.
   *
   * System-internal triggers (schedule reminders, automation callbacks, subagent
   * reports) often reuse a user's Session with a self-contained prompt that
   * knows nothing about the configured business domain. Listing those kinds
   * here keeps the domain vocabulary out of turns that cannot use it.
   * Defaults to `['schedule']`. */
  readonly skipSourceKinds?: string[]
}

/** Host service behind the `ontologyStore` Remote namespace. */
export class OntologyStore extends TypertRemoteService {
  static inject = ['typert', 'agents']

  static Config: z<Config> = z.object({
    storePath: z.string(),
    defaultDomains: z.array(z.string()),
    injectionMode: z.union([z.const('mention'), z.const('always')]).default('mention'),
    maxSummaryChars: z.natural().min(1),
    model: z.string().default(DEFAULT_MODEL),
    baseUrl: z.string().default(DEFAULT_BASE_URL),
    maxClauses: z.natural().min(1).default(DEFAULT_MAX_CLAUSES),
    maxSourceBytes: z.natural().min(1).default(DEFAULT_MAX_SOURCE_BYTES),
    maxInstanceBytes: z.natural().min(1).default(DEFAULT_MAX_INSTANCE_BYTES),
    maxEvidenceChars: z.natural().min(1).default(DEFAULT_MAX_EVIDENCE_CHARS),
    apiKey: z.string(),
    skipSourceKinds: z.array(z.string()).default([...DEFAULT_SKIP_SOURCE_KINDS]),
  })

  private readonly storePath: string
  private readonly defaultDomains: readonly string[]
  private readonly injectionMode: InjectionMode
  private readonly maxSummaryChars: number
  private readonly skipSourceKinds: ReadonlySet<string>
  private readonly model: string
  private readonly baseUrl: string
  private readonly maxClauses: number
  private readonly maxSourceBytes: number
  private readonly maxInstanceBytes: number
  private readonly maxEvidenceChars: number
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
    this.defaultDomains = injector.defaultDomains
    this.injectionMode = injector.injectionMode
    this.maxSummaryChars = injector.maxSummaryChars
    this.skipSourceKinds = new Set(resolved.skipSourceKinds)
    this.model = resolved.model
    this.baseUrl = resolved.baseUrl
    this.maxClauses = resolved.maxClauses
    this.maxSourceBytes = resolved.maxSourceBytes
    this.maxInstanceBytes = resolved.maxInstanceBytes
    this.maxEvidenceChars = resolved.maxEvidenceChars
    this.apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY

    ctx.logger.info('[ontology-store] loaded (store=%s, mode=%s, defaultDomains=%s)',
      this.storePath, injector.injectionMode, injector.defaultDomains.join(',') || '<none>')

    // Domain-scoped access resolves every call against the domain it names, so
    // Remote-access bindings never fall back to the shared global resource.
    ctx.effect(() => ctx.typert.resources.register('ontology-domain', {
      resolve: input => ontologyDomainOf(input.args),
    }), 'ontology-injector: domain resource')

    // Grants come from the account directory when that identity surface is mounted;
    // heads-up installations without it keep the owner-only defaults.
    ctx.inject(['accountDirectory'], (scope) => {
      scope.effect(() => {
        const rule = scope.accountDirectory.acl.register({
          kind: 'ontology-domain',
          bind: ontologyDomainBindings,
        })
        const baseline = scope.accountDirectory.acl.registerBaseline(() => ONTOLOGY_BASELINE)
        // The permission form offers domain ids as a dictionary: an operator
        // should never retype a domain id from memory and silently grant a
        // resource that does not exist.
        const catalog = scope.accountDirectory.catalog.register({
          kind: 'ontology-domain',
          label: '本体域',
          list: async () => (await this.listDomains()).map(domain => ({ id: domain.id, label: domain.label })),
        })
        return () => {
          catalog()
          baseline()
          rule()
        }
      }, 'ontology-injector: account ACL')
    })

    // The per-turn injection only lists domains; the full vocabulary is read on demand.
    ctx.inject(['tools'], (scope) => {
      registerDomainSummaryTool(scope, { storePath: this.storePath, maxChars: this.maxSummaryChars })
      registerAnalyticsTools(scope, { storePath: this.storePath })
      registerObjectTools(scope, { storePath: this.storePath })
      registerComplianceTool(scope, { storePath: this.storePath })
    })

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

      // System-internal triggers (schedule reminders, automation callbacks)
      // reuse a user's Session but must not inherit per-turn business-domain
      // injection — the prompt is self-contained and knows nothing about the
      // configured domains. `skipSourceKinds` defaults to `['schedule']`;
      // deployments can extend it for other self-contained sources.
      if (decision.messages.some(m => this.skipSourceKinds.has(m.source.kind))) return decision

      const lastInjected = injectedTurnBySession.get(agent.session)
      if (lastInjected === turn) return decision

      // `mention` reads the turn's own user message, so a message without a
      // domain token is a plain chat: no vocabulary, no tool hints, no fallback.
      // The `@` test keeps the store read off the hot path for ordinary turns.
      const mentionMode = this.injectionMode === 'mention'
      const text = mentionMode ? latestUserText(decision.messages) : ''
      if (mentionMode && !text.includes('@')) return decision

      const picks = selectTurnDomains({
        mode: this.injectionMode,
        defaults: this.defaultDomains,
        text,
        domains: mentionMode ? await this.injectionCandidates() : [],
      })
      if (picks.length === 0) return decision

      const blocks: string[] = []
      const sections: { name: string; text: string }[] = []
      for (const pick of picks) {
        if (!await domainExists(this.storePath, pick.domain)) continue
        const meta = await readDomainMeta(this.storePath, pick.domain)
        if (meta.disabled) continue
        const summary = await fetchDomainSummary(this.storePath, pick.domain)
        if (summary === undefined) continue
        const objectLine = objectIndexLine(this.storePath, pick.domain)
        const index = domainIndexLine(meta.label, pick.domain, summary)
        // `always` injects the vocabulary itself; `mention` keeps the full index
        // so a freshly picked domain is usable without a second tool round-trip.
        const body = objectLine.length === 0 ? index : `${index}\n${objectLine}`
        // The file-reference prompt teaches the model that `@` introduces a
        // path. A chosen domain must say otherwise in the same breath, or the
        // model reads a file named after the domain instead of using it.
        const note = pick.token.length === 0
          ? ''
          : `用户消息中的 ${pick.token} 指这个本体域，不是文件路径。`
        blocks.push(wrapInjection(body, pick.domain, note))
        sections.push({ name: `ontology-injector/${pick.domain}`, text: body })
      }
      if (blocks.length === 0) return decision

      const injectionMessage = createUserMessage({
        content: [{ type: 'text', text: blocks.join('\n') }],
        source: { kind: 'ontology-injector', form: 'instructions', sections },
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
    await this.requireUniqueLabel(label, domain)
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
      await appendAudit(this.storePath, {
        action: 'domain-create',
        domain,
        detail: `新建业务域「${label.trim() || domain}」`,
      })
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
    // Only a real change is checked: re-saving the same label must not collide
    // with the domain's own record.
    if (label.length > 0 && label !== meta.label) await this.requireUniqueLabel(label, domain)
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
      await appendAudit(this.storePath, {
        action: 'domain-update',
        domain,
        detail: `更新业务域元数据（注入${disabled ? '已禁用' : '已启用'}）`,
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
        maxEvidenceChars: this.maxEvidenceChars,
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
        status: 'draft',
      })
      await writeLiveTurtle(this.storePath, request.domain, turtle)
      await writeDomainMeta(this.storePath, {
        id: request.domain,
        label: meta.label,
        createdAt: meta.createdAt || now,
        updatedAt: now,
        activeVersion: meta.activeVersion,
        disabled: meta.disabled,
      })
      steps.push({ stage: 'version', message: `Draft snapshot created: ${version}`, status: 'done' })
      await appendAudit(this.storePath, {
        action: 'generate',
        domain: request.domain,
        detail: `由 ${request.fileName} 生成草稿版本 ${version}`,
      })

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
   * Apply micro-edits to the working graph and snapshot the result as a draft.
   *
   * @param domain - registered domain id.
   * @param edits - operations applied in order.
   * @param signal - cancellation from the Remote call.
   * @returns the new graph, its version, and repair warnings.
   */
  @Remote
  async applyEdits(domain: string, edits: OntologyEdit[], signal: AbortSignal): Promise<ApplyEditsResult> {
    return this.runEdits(
      domain,
      () => edits,
      `Graph edit (${edits.length} operations)`,
      'edit',
      `应用 ${edits.length} 处图谱编辑`,
      signal,
    )
  }

  /**
   * Apply an incremental patch to the working graph and snapshot the result as a draft.
   *
   * A patch may add, replace, and remove classes and properties in one step.
   * @param domain - registered domain id.
   * @param patch - classes and properties to add, replace, or remove.
   * @param signal - cancellation from the Remote call.
   * @returns the new graph, its version, and repair warnings.
   */
  @Remote
  async applyPatch(domain: string, patch: OntologyPatch, signal: AbortSignal): Promise<ApplyEditsResult> {
    const changes = (patch.classes?.length ?? 0)
      + (patch.properties?.length ?? 0)
      + (patch.removeClasses?.length ?? 0)
      + (patch.removeProperties?.length ?? 0)
    if (changes === 0) {
      throw new RemoteError('ontology/invalid-request', 'The patch has no changes', { reason: 'Patch lists no classes or properties' })
    }
    return this.runEdits(
      domain,
      model => patchToEdits(model, patch),
      `Incremental patch (${changes} changes)`,
      'patch',
      `应用增量补丁（${changes} 项变更）`,
      signal,
    )
  }

  /**
   * List a domain's version snapshots, newest first.
   *
   * @param domain - registered domain id.
   * @returns version rows with node and edge counts and the active flag.
   */
  @Remote
  async listVersions(domain: string): Promise<OntologyVersionSummary[]> {
    return this.versionSummaries(domain)
  }

  /**
   * Submit a draft version for review.
   *
   * @param domain - registered domain id.
   * @param version - draft version id.
   * @returns the updated version rows, newest first.
   */
  @Remote
  async submitReview(domain: string, version: string): Promise<OntologyVersionSummary[]> {
    this.requireIdle(domain)
    this.writing.add(domain)
    try {
      const record = await this.requireVersion(domain, version)
      if (record.status !== 'draft') {
        throw new RemoteError('ontology/version-status', `Version ${version} is ${record.status}, not a draft`, {
          domain,
          version,
          status: record.status,
        })
      }
      await updateVersionRecord(this.storePath, domain, { ...record, status: 'review' })
      await appendAudit(this.storePath, { action: 'version-review', domain, detail: `提交版本 ${version} 审核` })
      return await this.versionSummaries(domain)
    } catch (error) {
      this.fail(error, domain)
    } finally {
      this.writing.delete(domain)
    }
  }

  /**
   * Publish one version, making it the graph injection reads.
   *
   * A draft must pass review first. Publishing an already published version is
   * the rollback path.
   *
   * @param domain - registered domain id.
   * @param version - version id in review or already published.
   * @returns the updated version rows, newest first.
   */
  @Remote
  async publishVersion(domain: string, version: string): Promise<OntologyVersionSummary[]> {
    this.requireIdle(domain)
    this.writing.add(domain)
    try {
      const record = await this.requireVersion(domain, version)
      if (record.status === 'draft') {
        throw new RemoteError('ontology/version-status', `Version ${version} is a draft; submit it for review first`, {
          domain,
          version,
          status: record.status,
        })
      }
      let turtle: string
      try {
        turtle = await readVersionTurtle(this.storePath, domain, version)
      } catch {
        throw new RemoteError('ontology/not-found', `Version not found: ${version}`, { domain })
      }
      const meta = await readDomainMeta(this.storePath, domain)
      const now = new Date().toISOString()
      await writeLiveTurtle(this.storePath, domain, turtle)
      await writeDomainMeta(this.storePath, {
        id: domain,
        label: meta.label,
        createdAt: meta.createdAt,
        updatedAt: now,
        activeVersion: version,
        disabled: meta.disabled,
      })
      await updateVersionRecord(this.storePath, domain, { ...record, status: 'published' })
      await appendAudit(this.storePath, { action: 'version-publish', domain, detail: `发布版本 ${version}` })
      return await this.versionSummaries(domain)
    } catch (error) {
      this.fail(error, domain)
    } finally {
      this.writing.delete(domain)
    }
  }

  /**
   * Score the working graph against an uploaded gold-standard Turtle document.
   *
   * @param domain - registered domain id.
   * @param goldTurtle - the gold-standard Turtle document.
   * @param baselineName - file name of the gold standard, recorded in the report.
   * @returns class and property precision and recall.
   */
  @Remote
  async evaluateQuality(domain: string, goldTurtle: string, baselineName: string): Promise<QualityReport> {
    if (!await domainExists(this.storePath, domain)) {
      throw new RemoteError('ontology/not-found', `Domain not found: ${domain}`, { domain })
    }
    if (goldTurtle.trim().length === 0) {
      throw new RemoteError('ontology/invalid-request', 'The gold standard is empty', { reason: 'Uploaded baseline has no Turtle' })
    }
    const records = await listVersions(this.storePath, domain)
    try {
      const report = evaluateQuality(
        domain,
        records[0]?.version ?? null,
        await readLiveTurtle(this.storePath, domain),
        goldTurtle,
        baselineName,
      )
      const percent = (value: number): string => `${Math.round(value * 100)}%`
      await appendAudit(this.storePath, {
        action: 'quality',
        domain,
        detail: `质量评估：类 P${percent(report.classes.precision)}/R${percent(report.classes.recall)}，属性 P${percent(report.properties.precision)}/R${percent(report.properties.recall)}`,
      })
      return report
    } catch (error) {
      throw new RemoteError('ontology/invalid-request', (error as Error).message, { reason: (error as Error).message })
    }
  }

  /**
   * Delete a registered domain: its live graph, every version snapshot, and its
   * registry metadata. Uploaded source documents stay on disk.
   *
   * Deleting the configured fallback domain is allowed, but the audit entry
   * records that injection now points at a missing domain.
   *
   * @param domain - registered domain id.
   * @param signal - cancellation from the Remote call.
   */
  @Remote
  async deleteDomain(domain: string, signal: AbortSignal): Promise<void> {
    this.requireIdle(domain)
    signal.throwIfAborted()
    if (!await domainExists(this.storePath, domain)) {
      throw new RemoteError('ontology/not-found', `Domain not found: ${domain}`, { domain })
    }
    this.writing.add(domain)
    try {
      await deleteStoredDomain(this.storePath, domain)
      const detail = this.defaultDomains.includes(domain)
        ? '删除业务域；注入回退域现在指向不存在的业务域'
        : '删除业务域及其全部版本'
      await appendAudit(this.storePath, { action: 'domain-delete', domain, detail })
    } catch (error) {
      this.fail(error, domain)
    } finally {
      this.writing.delete(domain)
    }
  }

  /**
   * Delete one version snapshot and its record.
   *
   * @param domain - registered domain id.
   * @param version - version id to delete.
   * @param force - delete even when the version is active, clearing `activeVersion`.
   * @param signal - cancellation from the Remote call.
   * @returns the remaining version rows.
   */
  @Remote
  async deleteVersion(
    domain: string,
    version: string,
    force: boolean,
    signal: AbortSignal,
  ): Promise<OntologyVersionSummary[]> {
    this.requireIdle(domain)
    signal.throwIfAborted()
    if (!await domainExists(this.storePath, domain)) {
      throw new RemoteError('ontology/not-found', `Domain not found: ${domain}`, { domain })
    }
    this.writing.add(domain)
    try {
      await deleteStoredVersion(this.storePath, domain, version, force)
      await appendAudit(this.storePath, {
        action: 'version-delete',
        domain,
        detail: `删除版本 ${version}${force ? '（强制清除激活状态）' : ''}`,
      })
      return await this.versionSummaries(domain)
    } catch (error) {
      if (error instanceof OntologyStoreError && error.kind === 'version-active') {
        throw new RemoteError('ontology/version-active', error.message, { domain, version })
      }
      this.fail(error, domain)
    } finally {
      this.writing.delete(domain)
    }
  }

  /**
   * Export a domain's live graph as Turtle.
   *
   * @param domain - registered domain id.
   * @param format - output media type; only `text/turtle` is supported.
   * @returns the live graph Turtle.
   */
  @Remote
  async exportDomain(domain: string, format: 'text/turtle'): Promise<string> {
    if (!await domainExists(this.storePath, domain)) {
      throw new RemoteError('ontology/not-found', `Domain not found: ${domain}`, { domain })
    }
    try {
      const turtle = await exportStoredDomain(this.storePath, domain, format)
      await appendAudit(this.storePath, { action: 'export', domain, detail: '导出业务域图谱（Turtle）' })
      return turtle
    } catch (error) {
      this.fail(error, domain)
    }
  }

  /**
   * Import a Turtle ontology as a new live version.
   *
   * @param domain - registered domain id; created when it does not exist yet.
   * @param turtle - the Turtle document to import.
   * @param note - approval note stored with the version record.
   * @param signal - cancellation from the Remote call.
   * @returns the imported graph.
   */
  @Remote
  async importOntology(domain: string, turtle: string, note: string, signal: AbortSignal): Promise<OntologyGraph> {
    this.requireIdle(domain)
    try {
      requireDomainId(domain)
    } catch (error) {
      throw new RemoteError('ontology/invalid-domain', (error as Error).message, { domain })
    }
    signal.throwIfAborted()
    this.writing.add(domain)
    try {
      await importStoredOntology(this.storePath, domain, turtle, { approver: 'workbench', note, sourceName: '' })
      const graph = await this.loadGraph(domain)
      return graph
    } catch (error) {
      if (error instanceof RemoteError) throw error
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('ontology/import-failed', reason, { reason })
    } finally {
      this.writing.delete(domain)
    }
  }

  /**
   * Validate a domain's live graph structure.
   *
   * @param domain - registered domain id.
   * @returns hard errors and advisory warnings.
   */
  @Remote
  async validateDomain(domain: string): Promise<ValidationReport> {
    if (!await domainExists(this.storePath, domain)) {
      throw new RemoteError('ontology/not-found', `Domain not found: ${domain}`, { domain })
    }
    try {
      const report = validateOntology(domain, await readLiveTurtle(this.storePath, domain))
      await appendAudit(this.storePath, {
        action: 'validate',
        domain,
        detail: `结构校验：${report.errors.length} 个错误、${report.warnings.length} 个警告`,
      })
      return report
    } catch (error) {
      this.fail(error, domain)
    }
  }

  /**
   * Run a read-only SPARQL query over the store.
   *
   * @param domain - registered domain id the query is attributed to.
   * @param sparql - a SELECT or ASK query.
   * @returns the solution table or the ASK answer.
   */
  @Remote
  async queryDomain(domain: string, sparql: string): Promise<SparqlResult> {
    if (!await domainExists(this.storePath, domain)) {
      throw new RemoteError('ontology/not-found', `Domain not found: ${domain}`, { domain })
    }
    try {
      const result = await querySparql(this.storePath, sparql)
      return result
    } catch (error) {
      this.fail(error, domain)
    }
  }

  /**
   * Run one question through the ontology-guided pipeline and return every stage.
   *
   * @param domain - registered domain id the question is scoped to.
   * @param question - natural-language question.
   * @param topK - evidence budget, `1..20`.
   * @returns the full trace, including the gate verdict and the baseline.
   */
  @Remote
  async retrievalTrace(domain: string, question: string, topK?: number): Promise<TraceResult> {
    await this.requireDomainExists(domain)
    const trimmed = question.trim()
    if (trimmed.length < 2) {
      throw new RemoteError('ontology/invalid-request', '问题太短，至少 2 个字符', { reason: 'question too short' })
    }
    return traceQuestion({
      root: this.storePath,
      domain,
      question: trimmed,
      topK: Math.min(20, Math.max(1, Math.round(topK ?? 5))),
      model: this.modelSettings(),
    })
  }

  /**
   * Clause library statistics for a domain.
   *
   * @param domain - registered domain id.
   * @returns document, chunk, and tagged-class counts.
   */
  @Remote
  async retrievalLibrary(domain: string): Promise<ChunkLibraryStats> {
    await this.requireDomainExists(domain)
    return chunkStats(this.storePath, domain)
  }

  /**
   * List the clause library, newest file order preserved.
   *
   * @param domain - registered domain id.
   * @param limit - maximum clauses to return.
   * @returns the clauses shown in the library tab.
   */
  @Remote
  async retrievalChunks(domain: string, limit?: number): Promise<readonly EvidenceChunk[]> {
    await this.requireDomainExists(domain)
    const chunks = await readChunks(this.storePath, domain)
    return chunks.slice(0, Math.max(1, Math.min(1000, Math.round(limit ?? 200))))
  }

  /**
   * Import one document as tagged evidence clauses.
   *
   * Tags come from the domain vocabulary, not from the model, so a clause can
   * only be labelled with classes the ontology already declares.
   *
   * @param request - document payload.
   * @returns the document id and how many clauses were written.
   */
  @Remote
  async retrievalIngest(request: IngestRequest): Promise<{ docId: string; added: number; total: number }> {
    const domain = request.domain
    await this.requireDomainExists(domain)
    const text = request.text.trim()
    if (text.length < 10) {
      throw new RemoteError('ontology/invalid-request', '文档内容太短，至少 10 个字符', { reason: 'text too short' })
    }
    if (request.title.trim().length === 0) {
      throw new RemoteError('ontology/invalid-request', '文档标题不能为空', { reason: 'title required' })
    }
    const lexicon = await loadLexicon(this.storePath, domain)
    const result = await ingestDocument(this.storePath, domain, { ...request, text }, lexicon)
    await appendAudit(this.storePath, {
      action: 'instance-import',
      domain,
      detail: `导入证据文档「${request.title.trim()}」：${result.added} 条条款`,
    })
    return result
  }

  /**
   * Demonstration questions.
   *
   * Static text, computed nowhere, so it needs neither a domain nor a store read.
   *
   * @returns the shipped examples.
   */
  @Remote
  async retrievalExamples(): Promise<readonly TraceExample[]> {
    return DEMO_EXAMPLES
  }

  /**
   * Model connection for answer generation, or `null` to stay offline.
   *
   * @returns generation settings when an API key is configured.
   */
  private modelSettings(): GenerationSettings | null {
    const apiKey = this.apiKey
    if (apiKey === undefined || apiKey.length === 0) return null
    return {
      apiKey,
      baseUrl: this.baseUrl,
      model: this.model,
      maxClauses: this.maxClauses,
      maxEvidenceChars: this.maxEvidenceChars,
    }
  }

  /**
   * List the metric catalog this deployment offers for a domain.
   *
   * @param domain - registered domain id the catalog is read for.
   * @returns metric summaries in presentation order.
   */
  @Remote
  async listMetrics(domain: string): Promise<MetricSummary[]> {
    await this.requireDomainExists(domain)
    return [...await catalogMetrics(this.storePath, domain)]
  }

  /**
   * Run one metric over a domain's instance graphs.
   *
   * @param domain - registered domain id.
   * @param metricId - metric id from the catalog.
   * @param filters - optional class or property filters resolved against the domain ontology.
   * @param signal - cancellation from the Remote call.
   * @returns aggregated rows, compiled SPARQL, duration, and warnings.
   */
  @Remote
  async runMetric(
    domain: string,
    metricId: string,
    filters: MetricFilters,
    signal: AbortSignal,
  ): Promise<MetricRun> {
    await this.requireDomainExists(domain)
    signal.throwIfAborted()
    try {
      const outcome = await executeMetric(this.storePath, domain, metricId, filters)
      signal.throwIfAborted()
      await appendAudit(this.storePath, {
        action: 'metric-run',
        domain,
        detail: `运行指标「${outcome.title}」（${outcome.rows.length} 行，${outcome.durationMs}ms）`,
      })
      return outcome
    } catch (error) {
      this.failAnalytics(error, metricId, domain)
    }
  }

  /**
   * Explain one metric's definition and compiled query.
   *
   * @param domain - registered domain id.
   * @param metricId - metric id from the catalog.
   * @returns definition, default query, and result columns.
   */
  @Remote
  async explainMetric(domain: string, metricId: string): Promise<MetricExplanation> {
    await this.requireDomainExists(domain)
    try {
      return await explainCatalogMetric(this.storePath, domain, metricId)
    } catch (error) {
      this.failAnalytics(error, metricId, domain)
    }
  }

  /**
   * List the instances behind one metric.
   *
   * @param domain - registered domain id.
   * @param metricId - metric id from the catalog.
   * @param filters - filters shared with the aggregated query.
   * @param limit - maximum rows, 1–500.
   * @param signal - cancellation from the Remote call.
   * @returns deduplicated instance rows.
   */
  @Remote
  async drilldownMetric(
    domain: string,
    metricId: string,
    filters: MetricFilters,
    limit: number,
    signal: AbortSignal,
  ): Promise<MetricDetail> {
    await this.requireDomainExists(domain)
    signal.throwIfAborted()
    try {
      const detail = await executeDrilldown(this.storePath, domain, metricId, filters, limit)
      signal.throwIfAborted()
      return detail
    } catch (error) {
      this.failAnalytics(error, metricId, domain)
    }
  }

  /**
   * List the instance batches a domain's analytics can read.
   *
   * @param domain - registered domain id.
   * @returns batches with graph IRI and quad count.
   */
  @Remote
  async listMetricBatches(domain: string): Promise<InstanceBatch[]> {
    await this.requireDomainExists(domain)
    return listInstanceBatches(this.storePath, domain)
  }

  /**
   * Import one Turtle instance batch for a domain.
   *
   * The batch owns a dedicated named graph, so reusing an id replaces that
   * graph and never touches the ontology, its versions, or other batches.
   * @param domain - registered domain id.
   * @param turtle - instance Turtle document.
   * @param batch - batch id of 1–32 lowercase letters, digits, or dashes.
   * @param signal - cancellation from the Remote call.
   * @returns the written batch with its graph IRI and quad count.
   * @throws {RemoteError} `instance/invalid-batch`, `instance/invalid-turtle`,
   * or `ontology/invalid-request` when the document exceeds `maxInstanceBytes`.
   */
  @Remote
  async importInstances(domain: string, turtle: string, batch: string, signal: AbortSignal): Promise<InstanceBatch> {
    await this.requireDomainExists(domain)
    this.requireIdle(domain)
    signal.throwIfAborted()
    try {
      requireBatchId(batch)
    } catch (error) {
      throw new RemoteError('instance/invalid-batch', (error as Error).message, { batch })
    }
    const bytes = Buffer.byteLength(turtle, 'utf8')
    if (bytes > this.maxInstanceBytes) {
      throw new RemoteError('ontology/invalid-request', 'The instance document is too large', {
        reason: `Document is ${bytes} bytes; the limit is ${this.maxInstanceBytes}`,
      })
    }
    this.writing.add(domain)
    let triples: number
    try {
      triples = await writeInstanceGraph(this.storePath, domain, batch, turtle)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('instance/invalid-turtle', reason, { reason })
    } finally {
      this.writing.delete(domain)
    }
    if (triples === 0) {
      await clearInstanceGraph(this.storePath, domain, batch)
      throw new RemoteError('instance/invalid-turtle', 'The instance batch is empty', { reason: 'The document declares no triples' })
    }
    signal.throwIfAborted()
    await appendAudit(this.storePath, {
      action: 'instance-import',
      domain,
      detail: `导入实例批次 ${batch}（${triples} 条三元组）`,
    })
    const stored = (await listInstanceBatches(this.storePath, domain)).find(item => item.batch === batch)
    if (stored === undefined) {
      throw new RemoteError('instance/invalid-turtle', 'The instance batch was not persisted', { reason: `Batch ${batch} is missing after import` })
    }
    return stored
  }

  /**
   * Remove one instance batch and return the remaining batches.
   *
   * @param domain - registered domain id.
   * @param batch - batch id to remove.
   * @param signal - cancellation from the Remote call.
   * @returns batches left in the domain, ordered by id.
   * @throws {RemoteError} `instance/invalid-batch` or `ontology/not-found`
   * when the batch does not exist.
   */
  @Remote
  async deleteInstanceBatch(domain: string, batch: string, signal: AbortSignal): Promise<InstanceBatch[]> {
    await this.requireDomainExists(domain)
    this.requireIdle(domain)
    signal.throwIfAborted()
    try {
      requireBatchId(batch)
    } catch (error) {
      throw new RemoteError('instance/invalid-batch', (error as Error).message, { batch })
    }
    const batches = await listInstanceBatches(this.storePath, domain)
    if (!batches.some(item => item.batch === batch)) {
      throw new RemoteError('ontology/not-found', `Instance batch not found: ${batch}`, { domain })
    }
    this.writing.add(domain)
    let removed: number
    try {
      removed = await clearInstanceGraph(this.storePath, domain, batch)
    } finally {
      this.writing.delete(domain)
    }
    signal.throwIfAborted()
    await appendAudit(this.storePath, {
      action: 'instance-clear',
      domain,
      detail: `清除实例批次 ${batch}（${removed} 条三元组）`,
    })
    return listInstanceBatches(this.storePath, domain)
  }

  /**
   * Replace a domain's SHACL shapes document.
   *
   * Shapes live in a dedicated named graph, not the live ontology graph: a
   * workbench edit rewrites the live graph through the model, which cannot
   * represent SHACL blank-node structures.
   *
   * @param domain - registered domain id.
   * @param turtle - the shapes Turtle document.
   * @param signal - cancellation from the Remote call.
   * @returns the number of shape triples written.
   * @throws {RemoteError} `ontology/not-found`, `ontology/busy`, or
   * `ontology/import-failed` when the Turtle cannot be parsed.
   */
  @Remote
  async importShapes(domain: string, turtle: string, signal: AbortSignal): Promise<number> {
    await this.requireDomainExists(domain)
    this.requireIdle(domain)
    signal.throwIfAborted()
    if (turtle.trim().length === 0) {
      throw new RemoteError('ontology/import-failed', 'The shapes document is empty', { reason: 'Uploaded shapes have no Turtle' })
    }
    this.writing.add(domain)
    let triples: number
    try {
      triples = await writeShapes(this.storePath, domain, turtle)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new RemoteError('ontology/import-failed', reason, { reason })
    } finally {
      this.writing.delete(domain)
    }
    signal.throwIfAborted()
    await appendAudit(this.storePath, {
      action: 'shapes-import',
      domain,
      detail: `导入 SHACL 形状（${triples} 条三元组）`,
    })
    return triples
  }

  /**
   * Read a domain's SHACL shapes as Turtle.
   *
   * @param domain - registered domain id.
   * @returns the shapes Turtle, or an empty string when the domain has no shapes.
   * @throws {RemoteError} `ontology/not-found` when the domain does not exist.
   */
  @Remote
  async exportShapes(domain: string): Promise<string> {
    await this.requireDomainExists(domain)
    return readShapesTurtle(this.storePath, domain)
  }

  /**
   * Run the compliance report: every SHACL shape over every instance batch,
   * tallied per rule.
   *
   * @param domain - registered domain id.
   * @returns the per-rule violation counts and the shapes that could not run.
   * @throws {RemoteError} `ontology/not-found` when the domain does not exist.
   */
  @Remote
  async complianceReport(domain: string): Promise<ComplianceReport> {
    await this.requireDomainExists(domain)
    let report: ComplianceReport
    try {
      report = await runCompliance(this.storePath, domain)
    } catch (error) {
      this.fail(error, domain)
    }
    await appendAudit(this.storePath, {
      action: 'compliance-run',
      domain,
      detail: report.conforms
        ? `合规检查通过（${report.shapes} 个形状，${report.batches.length} 个批次）`
        : `合规检查未通过：${report.rules.reduce((sum, rule) => sum + rule.violations, 0)} 条违规`,
    })
    return report
  }

  /**
   * Read the audit trail, newest first.
   *
   * @param limit - maximum entries to return; defaults to 50.
   * @returns the audit entries, newest first.
   */
  @Remote
  async auditLog(limit?: number): Promise<AuditEntry[]> {
    return readAudit(this.storePath, limit)
  }

  /**
   * Report store health for the workbench.
   *
   * @returns the store path, durable format version, and per-domain counters.
   */
  @Remote
  async health(): Promise<OntologyHealth> {
    const ids = await readRegistry(this.storePath)
    const domains = await Promise.all(ids.map(id => domainStats(this.storePath, id)))
    return { storePath: this.storePath, formatVersion: SCHEMA_VERSION, domains }
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

  /**
   * Every registered domain as the mention resolver sees it.
   *
   * Read on demand rather than cached: a rename or a disable in the ontology
   * center must take effect on the next turn, and the store read is one small
   * query set compared with the model call it precedes.
   *
   * @returns id, label, and enabled state per registered domain.
   */
  private async injectionCandidates(): Promise<MentionCandidate[]> {
    const ids = await readRegistry(this.storePath)
    const metas = await Promise.all(ids.map(id => readDomainMeta(this.storePath, id)))
    return metas.map(meta => ({ id: meta.id, label: meta.label, disabled: meta.disabled }))
  }

  /**
   * Refuse a label another domain already answers to.
   *
   * The `@label` token is how a turn selects a domain, so a duplicate label is
   * not a cosmetic problem: the resolver would have to pick one arbitrarily.
   *
   * @param label - proposed display label; blank labels fall back to the id and are not checked.
   * @param exceptId - domain being renamed.
   */
  private async requireUniqueLabel(label: string, exceptId?: string): Promise<void> {
    const trimmed = label.trim()
    if (trimmed.length === 0) return
    const conflict = findLabelConflict(trimmed, await this.injectionCandidates(), exceptId)
    if (conflict !== null) {
      throw new RemoteError(
        'ontology/invalid-request',
        `Domain label already in use: ${trimmed} (conflicts with "${conflict}")`,
        { reason: `Domain label already in use: ${trimmed}` },
      )
    }
  }

  /** Read one stored version record. */
  private async requireVersion(domain: string, version: string): Promise<VersionRecord> {
    const record = (await listVersions(this.storePath, domain)).find(item => item.version === version)
    if (record === undefined) {
      throw new RemoteError('ontology/not-found', `Version not found: ${version}`, { domain })
    }
    return record
  }

  /**
   * Apply edits to a domain's working graph and snapshot the result as a draft.
   *
   * The working graph changes immediately; the model keeps reading the last
   * published version until the draft is published.
   * @param domain - registered domain id.
   * @param buildEdits - derives the micro-edits from the parsed working model.
   * @param note - version note shown in the timeline.
   * @param action - audit action recorded for the change.
   * @param detail - audit detail recorded for the change.
   * @param signal - cancellation from the Remote call.
   * @returns the new graph, its draft version, and repair warnings.
   */
  private async runEdits(
    domain: string,
    buildEdits: (model: OntologyModel) => OntologyEdit[],
    note: string,
    action: 'edit' | 'patch',
    detail: string,
    signal: AbortSignal,
  ): Promise<ApplyEditsResult> {
    this.requireIdle(domain)
    this.writing.add(domain)
    try {
      signal.throwIfAborted()
      if (!await domainExists(this.storePath, domain)) {
        throw new RemoteError('ontology/not-found', `Domain not found: ${domain}`, { domain })
      }
      const meta = await readDomainMeta(this.storePath, domain)
      const turtle = await readLiveTurtle(this.storePath, domain)
      if (turtle.trim().length === 0) {
        throw new RemoteError('ontology/not-found', `Domain has no ontology: ${domain}`, { domain })
      }

      const model = parseTurtle(turtle, domain)
      const { model: edited, warnings } = applyModelEdits(model, buildEdits(model))
      const versions = await listVersions(this.storePath, domain)
      const version = nextVersion(versions.map(record => record.version))
      const nextTurtle = emitTurtle(edited)
      const now = new Date().toISOString()
      await writeVersion(this.storePath, domain, nextTurtle, {
        version,
        createdAt: now,
        approver: 'workbench',
        note,
        sourceName: '',
        status: 'draft',
      })
      await writeLiveTurtle(this.storePath, domain, nextTurtle)
      await writeDomainMeta(this.storePath, {
        id: domain,
        label: meta.label,
        createdAt: meta.createdAt || now,
        updatedAt: now,
        activeVersion: meta.activeVersion,
        disabled: meta.disabled,
      })
      await appendAudit(this.storePath, { action, domain, detail: `${detail}，生成草稿版本 ${version}` })
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

  /** Build version rows for one domain, newest first. */
  private async versionSummaries(domain: string): Promise<OntologyVersionSummary[]> {
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
        status: record.status,
      })
    }
    return rows.sort((left, right) => compareVersions(right.version, left.version))
  }

  /** Translate a store or storage refusal into a Remote error the workbench can localize. */
  private fail(error: unknown, domain: string): never {
    if (error instanceof RemoteError) throw error
    if (error instanceof OntologyDatabaseError) {
      if (error.kind === 'locked') throw new RemoteError('ontology/busy', error.message, { domain })
      throw new RemoteError('ontology/storage-corrupt', error.message, { reason: error.message })
    }
    if (error instanceof OntologyStoreError) {
      if (error.kind === 'version-not-found') {
        throw new RemoteError('ontology/not-found', error.message, { domain })
      }
      if (error.kind === 'query-rejected') {
        throw new RemoteError('ontology/query-rejected', error.message, { reason: error.message })
      }
    }
    const reason = error instanceof Error ? error.message : String(error)
    throw new RemoteError('ontology/invalid-request', reason, { reason })
  }

  /** Refuse a request whose domain is not registered. */
  private async requireDomainExists(domain: string): Promise<void> {
    if (!await domainExists(this.storePath, domain)) {
      throw new RemoteError('ontology/not-found', `Domain not found: ${domain}`, { domain })
    }
  }

  /** Translate an analytics refusal into the Remote error the panel localizes. */
  private failAnalytics(error: unknown, metricId: string, domain: string): never {
    if (error instanceof RemoteError) throw error
    if (error instanceof AnalyticsError) {
      if (error.code === 'unknown-metric') {
        throw new RemoteError('analytics/unknown-metric', error.message, { metric: metricId })
      }
      throw new RemoteError('analytics/invalid-filter', error.message, { reason: error.message })
    }
    this.fail(error, domain)
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
