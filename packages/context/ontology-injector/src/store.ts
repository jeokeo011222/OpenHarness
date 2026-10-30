/**
 * Ontology store backed by the embedded RDF graph database.
 *
 * The domain registry, per-domain metadata, live graphs, and immutable version
 * snapshots all live in named graphs of `<root>/graph.db.nq`
 * (see `graph-db.ts`). Uploaded source documents remain plain files under
 * `<root>/<domain>/sources/` because they are binary inputs, not graph data.
 *
 * Vocabulary (`urn:dsh:ontology:`):
 *   registry graph          registry, domain records, version records
 *   graph:<domain>          the live graph of one domain
 *   graph:<domain>:<ver>    the immutable snapshot of one version
 */

import { existsSync } from 'node:fs'
import { readFile, readdir, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { literal, namedNode, quad, type NamedNode, type Quad, type Store } from 'oxigraph'
import { REGISTRY_GRAPH, databaseAt, dropGraph, OntologyDatabase } from './graph-db.ts'
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditEntry,
  type DomainStats,
  type InstanceBatch,
  type OntologyVersionStatus,
  type SparqlResult,
} from './types.ts'

export type { AuditAction, AuditEntry, DomainStats, SparqlResult } from './types.ts'

/** Per-domain metadata kept in the registry graph. */
export interface DomainMeta {
  readonly id: string
  readonly label: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly activeVersion: string | null
  /** A disabled domain is listed and readable but never injected. */
  readonly disabled: boolean
}

/** One immutable version snapshot. */
export interface VersionRecord {
  readonly version: string
  readonly createdAt: string
  readonly approver: string
  readonly note: string
  readonly sourceName: string
  /** Review state; only published versions are injected into a turn. */
  readonly status: OntologyVersionStatus
}

/** Cached model-facing summary of one domain's live graph. */
export interface SummaryCache {
  /** Domain `updatedAt` the summary was rendered from. */
  readonly stamp: string
  readonly text: string
}

/** Why a store operation was refused. */
export type OntologyStoreErrorKind = 'version-active' | 'version-not-found' | 'query-rejected'

/** Typed refusal raised by store operations that must not proceed. */
export class OntologyStoreError extends Error {
  /**
   * @param kind - the refused operation's cause.
   * @param message - user-facing explanation of the refusal.
   */
  constructor(readonly kind: OntologyStoreErrorKind, message: string) {
    super(message)
    this.name = 'OntologyStoreError'
  }
}

const DSH = 'urn:dsh:ontology:'
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean'
const DOMAIN_CLASS = `${DSH}Domain`
const VERSION_CLASS = `${DSH}Version`
const PREDICATE_LABEL = `${DSH}label`
const PREDICATE_CREATED_AT = `${DSH}createdAt`
const PREDICATE_UPDATED_AT = `${DSH}updatedAt`
const PREDICATE_ACTIVE_VERSION = `${DSH}activeVersion`
const PREDICATE_DISABLED = `${DSH}disabled`
const PREDICATE_VERSION = `${DSH}version`
const PREDICATE_APPROVER = `${DSH}approver`
const PREDICATE_NOTE = `${DSH}note`
const PREDICATE_SOURCE_NAME = `${DSH}sourceName`
const PREDICATE_STATUS = `${DSH}status`
const PREDICATE_BELONGS_TO = `${DSH}belongsTo`
const PREDICATE_SUMMARY = `${DSH}summary`
const PREDICATE_SUMMARY_STAMP = `${DSH}summaryStamp`
const PREDICATE_ACTION = `${DSH}action`
const PREDICATE_DOMAIN = `${DSH}domain`
const PREDICATE_AT = `${DSH}at`
const PREDICATE_DETAIL = `${DSH}detail`

/** Named graph holding the audit trail. */
const AUDIT_GRAPH = `${DSH}audit`

const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class'
const RDFS_CLASS = 'http://www.w3.org/2000/01/rdf-schema#Class'
const OWL_OBJECT_PROPERTY = 'http://www.w3.org/2002/07/owl#ObjectProperty'
const OWL_DATATYPE_PROPERTY = 'http://www.w3.org/2002/07/owl#DatatypeProperty'

/** Query forms accepted as the first keyword of a read-only query. */
const ALLOWED_QUERY_KEYWORDS: ReadonlySet<string> = new Set([
  'SELECT',
  'ASK',
  'PREFIX',
  'BASE',
  'FROM',
  'WHERE',
  'CONSTRUCT',
  'DESCRIBE',
])

/** Update forms refused outright, even behind a prologue. */
const REFUSED_QUERY_KEYWORDS: readonly string[] = [
  'INSERT',
  'DELETE',
  'LOAD',
  'CLEAR',
  'DROP',
  'CREATE',
  'COPY',
  'MOVE',
  'ADD',
]

/** Audit entries returned when the caller does not cap the list. */
const DEFAULT_AUDIT_LIMIT = 50

const DOMAIN_ID = /^[a-z][a-z0-9-]{1,31}$/

const registryTerm = (): NamedNode => namedNode(REGISTRY_GRAPH)

/**
 * Reject a domain id that cannot be a graph name suffix or directory name.
 * @param domain - the domain id to validate.
 * @throws {Error} when the id is outside `2-32` lowercase letters, digits, or dashes.
 */
export function requireDomainId(domain: string): void {
  if (!DOMAIN_ID.test(domain)) {
    throw new Error(`Domain id must be 2-32 lowercase letters, digits, or dashes: ${domain}`)
  }
}

/**
 * Absolute directory holding a domain's uploaded source documents.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @returns the absolute path of the domain directory.
 */
export function domainDirOf(root: string, domain: string): string {
  return join(root, domain)
}

/** Subject IRI of one domain record. */
function domainNode(domain: string): NamedNode {
  return namedNode(`${DSH}domain:${domain}`)
}

/** Named graph IRI of one domain's live graph. */
function liveGraphName(domain: string): string {
  return `${DSH}graph:${domain}`
}

/** Named graph IRI of one version snapshot. */
function versionGraphName(domain: string, version: string): string {
  return `${DSH}graph:${domain}:${version}`
}

/** Subject IRI of one version record. */
function versionNode(domain: string, version: string): NamedNode {
  return namedNode(`${DSH}domain:${domain}:version:${version}`)
}

/**
 * Resolve the database for a root, running the legacy file import on first use.
 * @param root - the ontology store root.
 * @returns the ready database handle.
 */
async function database(root: string): Promise<OntologyDatabase> {
  const db = databaseAt(root)
  await db.prepare(() => importLegacyLayout(root, db))
  return db
}

/** Replace a domain record with the given metadata. */
function applyDomainMeta(store: Store, meta: DomainMeta): void {
  const subject = domainNode(meta.id)
  const graph = registryTerm()
  dropSubject(store, subject)
  store.add(quad(subject, namedNode(RDF_TYPE), namedNode(DOMAIN_CLASS), graph))
  store.add(quad(subject, namedNode(PREDICATE_LABEL), literal(meta.label), graph))
  store.add(quad(subject, namedNode(PREDICATE_CREATED_AT), literal(meta.createdAt), graph))
  store.add(quad(subject, namedNode(PREDICATE_UPDATED_AT), literal(meta.updatedAt), graph))
  if (meta.activeVersion !== null) {
    store.add(quad(subject, namedNode(PREDICATE_ACTIVE_VERSION), literal(meta.activeVersion), graph))
  }
  store.add(quad(subject, namedNode(PREDICATE_DISABLED), literal(String(meta.disabled), namedNode(XSD_BOOLEAN)), graph))
}

/** Replace a version record with the given metadata. */
function applyVersionRecord(store: Store, domain: string, record: VersionRecord): void {
  const subject = versionNode(domain, record.version)
  const graph = registryTerm()
  dropSubject(store, subject)
  store.add(quad(subject, namedNode(RDF_TYPE), namedNode(VERSION_CLASS), graph))
  store.add(quad(subject, namedNode(PREDICATE_BELONGS_TO), domainNode(domain), graph))
  store.add(quad(subject, namedNode(PREDICATE_VERSION), literal(record.version), graph))
  store.add(quad(subject, namedNode(PREDICATE_CREATED_AT), literal(record.createdAt), graph))
  store.add(quad(subject, namedNode(PREDICATE_APPROVER), literal(record.approver), graph))
  store.add(quad(subject, namedNode(PREDICATE_NOTE), literal(record.note), graph))
  store.add(quad(subject, namedNode(PREDICATE_SOURCE_NAME), literal(record.sourceName), graph))
  store.add(quad(subject, namedNode(PREDICATE_STATUS), literal(record.status), graph))
}

/** Remove every registry triple of one subject. */
function dropSubject(store: Store, subject: NamedNode): void {
  for (const entry of store.match(subject, null, null, registryTerm())) store.delete(entry)
}

/** Read the first literal object of `subject predicate` in the registry graph. */
function firstObject(store: Store, subject: NamedNode, predicate: string): string | undefined {
  const entry = store.match(subject, namedNode(predicate), null, registryTerm()).at(0)
  if (entry === undefined) return undefined
  return entry.object.termType === 'Literal' ? entry.object.value : undefined
}

/**
 * Read a stored review status.
 * @param store - registry store.
 * @param subject - version record subject.
 * @returns the stored status; records written before the review workflow read as published.
 */
function statusOf(store: Store, subject: NamedNode): OntologyVersionStatus {
  const raw = firstObject(store, subject, PREDICATE_STATUS)
  return raw === 'draft' || raw === 'review' ? raw : 'published'
}

/**
 * Read the domain list, ordered by creation time then id.
 * @param root - the ontology store root.
 * @returns the registered domain ids, empty when no domain exists.
 */
export async function readRegistry(root: string): Promise<string[]> {
  const db = await database(root)
  return db.run((store) => {
    const entries = store.match(null, namedNode(RDF_TYPE), namedNode(DOMAIN_CLASS), registryTerm())
      .flatMap((entry) => {
        if (entry.subject.termType !== 'NamedNode') return []
        const subject = entry.subject
        return [{ id: subject.value.slice(`${DSH}domain:`.length), createdAt: firstObject(store, subject, PREDICATE_CREATED_AT) ?? '' }]
      })
    return entries
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(entry => entry.id)
  })
}

/**
 * Persist the domain list: missing domains are registered and dropped domains
 * lose their metadata, live graph, and snapshots.
 * @param root - the ontology store root; created when missing.
 * @param domains - the domain ids to keep.
 */
export async function writeRegistry(root: string, domains: readonly string[]): Promise<void> {
  const db = await database(root)
  const registered = await readRegistry(root)
  const keep = new Set(domains)
  const now = new Date().toISOString()
  await db.mutate((store) => {
    for (const domain of registered) {
      if (keep.has(domain)) continue
      dropSubject(store, domainNode(domain))
      dropGraph(store, liveGraphName(domain))
      for (const entry of store.match(null, namedNode(PREDICATE_BELONGS_TO), domainNode(domain), registryTerm())) {
        if (entry.subject.termType !== 'NamedNode') continue
        const version = firstObject(store, entry.subject, PREDICATE_VERSION)
        dropSubject(store, entry.subject)
        if (version !== undefined) dropGraph(store, versionGraphName(domain, version))
      }
    }
    for (const domain of domains) {
      if (registered.includes(domain)) continue
      store.add(quad(domainNode(domain), namedNode(RDF_TYPE), namedNode(DOMAIN_CLASS), registryTerm()))
      store.add(quad(domainNode(domain), namedNode(PREDICATE_LABEL), literal(domain), registryTerm()))
      store.add(quad(domainNode(domain), namedNode(PREDICATE_CREATED_AT), literal(now), registryTerm()))
      store.add(quad(domainNode(domain), namedNode(PREDICATE_UPDATED_AT), literal(now), registryTerm()))
      store.add(quad(domainNode(domain), namedNode(PREDICATE_DISABLED), literal('false', namedNode(XSD_BOOLEAN)), registryTerm()))
    }
  })
}

/**
 * Read domain metadata, synthesizing it for domains without a record.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @returns the stored metadata, or defaults named after the domain id.
 */
export async function readDomainMeta(root: string, domain: string): Promise<DomainMeta> {
  const db = await database(root)
  return db.run((store) => {
    const subject = domainNode(domain)
    if (store.match(subject, namedNode(RDF_TYPE), namedNode(DOMAIN_CLASS), registryTerm()).length === 0) {
      return { id: domain, label: domain, createdAt: '', updatedAt: '', activeVersion: null, disabled: false }
    }
    const label = firstObject(store, subject, PREDICATE_LABEL)
    return {
      id: domain,
      label: label !== undefined && label.length > 0 ? label : domain,
      createdAt: firstObject(store, subject, PREDICATE_CREATED_AT) ?? '',
      updatedAt: firstObject(store, subject, PREDICATE_UPDATED_AT) ?? '',
      activeVersion: firstObject(store, subject, PREDICATE_ACTIVE_VERSION) ?? null,
      disabled: firstObject(store, subject, PREDICATE_DISABLED) === 'true',
    }
  })
}

/**
 * Write domain metadata.
 * @param root - the ontology store root.
 * @param meta - the metadata to persist.
 */
export async function writeDomainMeta(root: string, meta: DomainMeta): Promise<void> {
  const db = await database(root)
  await db.mutate((store) => { applyDomainMeta(store, meta) })
}

/**
 * Read the live Turtle for a domain.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @returns the live Turtle text, or an empty string when the domain has no graph yet.
 */
export async function readLiveTurtle(root: string, domain: string): Promise<string> {
  const db = await database(root)
  return db.graphTurtle(liveGraphName(domain))
}

/**
 * Replace the live Turtle for a domain.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @param turtle - the full Turtle document to store.
 */
export async function writeLiveTurtle(root: string, domain: string, turtle: string): Promise<void> {
  const db = await database(root)
  await db.replaceGraph(liveGraphName(domain), turtle)
}

/**
 * Compare two semantic versions.
 * @param left - the first version id.
 * @param right - the second version id.
 * @returns a negative number when `left` is older, positive when newer, `0` when equal; non-numeric segments count as `0`.
 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => value.split('.').map(part => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Next patch version after the highest existing one.
 * @param existing - the version ids already stored for the domain.
 * @returns the next patch version, or `1.0.0` when no version exists.
 */
export function nextVersion(existing: readonly string[]): string {
  const sorted = [...existing].sort(compareVersions)
  const latest = sorted.at(-1)
  if (latest === undefined) return '1.0.0'
  const parts = latest.split('.')
  const major = Number.parseInt(parts[0] ?? '0', 10) || 0
  const minor = Number.parseInt(parts[1] ?? '0', 10) || 0
  const patch = Number.parseInt(parts[2] ?? '0', 10) || 0
  return `${major}.${minor}.${patch + 1}`
}

/**
 * List stored version snapshots.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @returns the version records, newest first.
 */
export async function listVersions(root: string, domain: string): Promise<VersionRecord[]> {
  const db = await database(root)
  return db.run((store) => {
    const records: VersionRecord[] = []
    for (const entry of store.match(null, namedNode(PREDICATE_BELONGS_TO), domainNode(domain), registryTerm())) {
      if (entry.subject.termType !== 'NamedNode') continue
      const subject = entry.subject
      const version = firstObject(store, subject, PREDICATE_VERSION)
      if (version === undefined) continue
      records.push({
        version,
        createdAt: firstObject(store, subject, PREDICATE_CREATED_AT) ?? '',
        approver: firstObject(store, subject, PREDICATE_APPROVER) ?? '',
        note: firstObject(store, subject, PREDICATE_NOTE) ?? '',
        sourceName: firstObject(store, subject, PREDICATE_SOURCE_NAME) ?? '',
        status: statusOf(store, subject),
      })
    }
    return records.sort((left, right) => compareVersions(right.version, left.version))
  })
}

/**
 * Read the Turtle snapshot of one version.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @param version - the version id.
 * @returns the snapshot Turtle.
 * @throws {Error} when the version has no stored snapshot.
 */
export async function readVersionTurtle(root: string, domain: string, version: string): Promise<string> {
  const db = await database(root)
  const turtle = await db.graphTurtle(versionGraphName(domain, version))
  if (turtle.trim().length === 0) throw new Error(`Version not found: ${version}`)
  return turtle
}

/**
 * Write an immutable version snapshot.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @param turtle - the snapshot Turtle.
 * @param record - the snapshot metadata; `record.version` names the graph.
 */
export async function writeVersion(
  root: string,
  domain: string,
  turtle: string,
  record: VersionRecord,
): Promise<void> {
  const db = await database(root)
  const quads = OntologyDatabase.parseGraph(versionGraphName(domain, record.version), turtle)
  await db.mutate((store) => {
    dropGraph(store, versionGraphName(domain, record.version))
    for (const entry of quads) store.add(entry)
    applyVersionRecord(store, domain, record)
  })
}

/**
 * Replace one version record without touching its snapshot graph.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @param record - the new metadata; `record.version` names the record.
 */
export async function updateVersionRecord(root: string, domain: string, record: VersionRecord): Promise<void> {
  const db = await database(root)
  await db.mutate((store) => { applyVersionRecord(store, domain, record) })
}

/**
 * Keep the uploaded source document beside the domain.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @param fileName - the uploaded file name, sanitized into the stored name.
 * @param bytes - the document content.
 * @returns the stored file name.
 */
export async function writeSource(root: string, domain: string, fileName: string, bytes: Uint8Array): Promise<string> {
  const dir = join(domainDirOf(root, domain), 'sources')
  await mkdir(dir, { recursive: true })
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80)
  const stored = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeName}`
  await writeAtomic(join(dir, stored), bytes)
  return stored
}

/**
 * List stored source documents.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @returns the stored file names, newest first.
 */
export async function listSources(root: string, domain: string): Promise<string[]> {
  const dir = join(domainDirOf(root, domain), 'sources')
  if (!existsSync(dir)) return []
  const names = await readdir(dir)
  return names.sort().reverse()
}

/**
 * Read the cached model-facing summary of one domain.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @returns the cache entry, or `null` when none was rendered yet.
 */
export async function readSummaryCache(root: string, domain: string): Promise<SummaryCache | null> {
  const db = await database(root)
  return db.run((store) => {
    const subject = domainNode(domain)
    const stamp = firstObject(store, subject, PREDICATE_SUMMARY_STAMP)
    if (stamp === undefined) return null
    return { stamp, text: firstObject(store, subject, PREDICATE_SUMMARY) ?? '' }
  })
}

/**
 * Cache the rendered summary against the domain revision it was built from.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @param cache - the summary text and its source revision stamp.
 */
export async function writeSummaryCache(root: string, domain: string, cache: SummaryCache): Promise<void> {
  const db = await database(root)
  await db.mutate((store) => {
    const subject = domainNode(domain)
    for (const predicate of [PREDICATE_SUMMARY, PREDICATE_SUMMARY_STAMP]) {
      for (const entry of store.match(subject, namedNode(predicate), null, registryTerm())) store.delete(entry)
    }
    store.add(quad(subject, namedNode(PREDICATE_SUMMARY), literal(cache.text), registryTerm()))
    store.add(quad(subject, namedNode(PREDICATE_SUMMARY_STAMP), literal(cache.stamp), registryTerm()))
  })
}

/**
 * Report whether a domain is registered.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @returns `true` when the registry holds a record for the domain.
 */
export async function domainExists(root: string, domain: string): Promise<boolean> {
  const db = await database(root)
  return db.run(store => store.match(domainNode(domain), namedNode(RDF_TYPE), namedNode(DOMAIN_CLASS), registryTerm()).length > 0)
}

/** Version record subjects belonging to one domain. */
function versionSubjectsOf(store: Store, domain: string): NamedNode[] {
  return store.match(null, namedNode(PREDICATE_BELONGS_TO), domainNode(domain), registryTerm())
    .flatMap(entry => entry.subject.termType === 'NamedNode' ? [entry.subject] : [])
}

/** Version ids recorded for one domain, read from a live dataset snapshot. */
function versionIdsOf(store: Store, domain: string): string[] {
  return versionSubjectsOf(store, domain).flatMap((subject) => {
    const recorded = firstObject(store, subject, PREDICATE_VERSION)
    return recorded === undefined ? [] : [recorded]
  })
}

/** Write one audit entry, deriving a collision-free subject from its timestamp. */
function addAuditEntry(store: Store, entry: AuditEntry): void {
  const graph = namedNode(AUDIT_GRAPH)
  const at = namedNode(PREDICATE_AT)
  const counter = store.match(null, at, literal(entry.at), graph).length + 1
  const subject = namedNode(`${DSH}audit:${entry.at}-${String(counter).padStart(4, '0')}`)
  store.add(quad(subject, at, literal(entry.at), graph))
  store.add(quad(subject, namedNode(PREDICATE_ACTION), literal(entry.action), graph))
  store.add(quad(subject, namedNode(PREDICATE_DOMAIN), literal(entry.domain), graph))
  store.add(quad(subject, namedNode(PREDICATE_DETAIL), literal(entry.detail), graph))
}

/** Whether an arbitrary audit `dsh:action` literal names a known action. */
function isAuditAction(value: string): value is AuditAction {
  return AUDIT_ACTIONS.some(action => action === value)
}

/** Remove `#` comments; used only to screen query keywords, never to execute. */
function stripSparqlComments(sparql: string): string {
  return sparql.replace(/#[^\n]*/g, ' ')
}

/** First keyword of a query after comments are stripped. */
function firstQueryKeyword(sparql: string): string {
  const word = /^[A-Za-z]+/.exec(stripSparqlComments(sparql).trim())?.at(0)
  return word === undefined ? '' : word.toUpperCase()
}

/** Whether a keyword appears as a standalone word, case-insensitively. */
function containsKeyword(text: string, keyword: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${keyword}([^A-Za-z0-9_]|$)`, 'i').test(text)
}

/**
 * Parse a SPARQL JSON result document.
 * @param raw - the engine's `application/sparql-results+json` payload.
 * @returns the solution table or ASK answer.
 * @throws {OntologyStoreError} `query-rejected` when the payload is not SPARQL JSON.
 */
function parseSparqlJson(raw: string): SparqlResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (_invalid) {
    throw new OntologyStoreError('query-rejected', '查询结果不是有效的 SPARQL JSON。')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new OntologyStoreError('query-rejected', '查询结果不是有效的 SPARQL JSON。')
  }
  const booleanValue: unknown = (parsed as { boolean?: unknown }).boolean
  if (typeof booleanValue === 'boolean') {
    return { variables: ['boolean'], rows: [{ boolean: String(booleanValue) }], kind: 'ask' }
  }
  const head: unknown = (parsed as { head?: unknown }).head
  const results: unknown = (parsed as { results?: unknown }).results
  const vars: unknown = typeof head === 'object' && head !== null ? (head as { vars?: unknown }).vars : undefined
  const bindings: unknown = typeof results === 'object' && results !== null
    ? (results as { bindings?: unknown }).bindings
    : undefined
  if (!Array.isArray(bindings)) {
    throw new OntologyStoreError('query-rejected', '查询未返回 SELECT 或 ASK 结果，请改用只读查询形式。')
  }
  const variables = Array.isArray(vars) ? vars.flatMap(value => typeof value === 'string' ? [value] : []) : []
  const rows: Record<string, string>[] = []
  for (const binding of bindings) {
    if (typeof binding !== 'object' || binding === null) continue
    const row: Record<string, string> = {}
    for (const [name, term] of Object.entries(binding as Record<string, unknown>)) {
      const value: unknown = typeof term === 'object' && term !== null ? (term as { value?: unknown }).value : undefined
      row[name] = typeof value === 'string' ? value : ''
    }
    rows.push(row)
  }
  const columns = variables.length > 0 ? variables : [...new Set(rows.flatMap(row => Object.keys(row)))]
  return { variables: columns, rows, kind: 'select' }
}

/**
 * Append one audit entry to the audit graph.
 * @param root - the ontology store root.
 * @param entry - the action, domain, and detail; the timestamp is stamped here.
 */
export async function appendAudit(root: string, entry: Omit<AuditEntry, 'at'>): Promise<void> {
  const db = await database(root)
  await db.mutate((store) => {
    addAuditEntry(store, { ...entry, at: new Date().toISOString() })
  })
}

/**
 * Read the audit trail, newest first.
 * @param root - the ontology store root.
 * @param limit - maximum entries to return; defaults to 50.
 * @returns the audit entries, newest first.
 */
export async function readAudit(root: string, limit = DEFAULT_AUDIT_LIMIT): Promise<AuditEntry[]> {
  const db = await database(root)
  return db.run((store) => {
    const graph = namedNode(AUDIT_GRAPH)
    const rows = new Map<string, { at: string; action: string; domain: string; detail: string }>()
    for (const entry of store.match(null, null, null, graph)) {
      if (entry.subject.termType !== 'NamedNode' || entry.object.termType !== 'Literal') continue
      const key = entry.subject.value
      const row = rows.get(key) ?? { at: '', action: '', domain: '', detail: '' }
      switch (entry.predicate.value) {
        case PREDICATE_AT:
          row.at = entry.object.value
          break
        case PREDICATE_ACTION:
          row.action = entry.object.value
          break
        case PREDICATE_DOMAIN:
          row.domain = entry.object.value
          break
        case PREDICATE_DETAIL:
          row.detail = entry.object.value
          break
        default:
          continue
      }
      rows.set(key, row)
    }
    const entries: { key: string; entry: AuditEntry }[] = []
    for (const [key, row] of rows) {
      if (row.at.length === 0 || !isAuditAction(row.action)) continue
      entries.push({ key, entry: { at: row.at, action: row.action, domain: row.domain, detail: row.detail } })
    }
    entries.sort((left, right) => right.entry.at.localeCompare(left.entry.at) || right.key.localeCompare(left.key))
    return entries.slice(0, Math.max(0, Math.floor(limit))).map(item => item.entry)
  })
}

/**
 * Delete a registered domain: its live graph, every version snapshot, and all
 * registry metadata, which also removes it from the domain list.
 *
 * Uploaded source documents under `<root>/<domain>/sources/` are user files and
 * are deliberately left on disk.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 */
export async function deleteDomain(root: string, domain: string): Promise<void> {
  const db = await database(root)
  await db.mutate((store) => {
    dropGraph(store, liveGraphName(domain))
    for (const subject of versionSubjectsOf(store, domain)) {
      const recorded = firstObject(store, subject, PREDICATE_VERSION)
      const version = recorded ?? subject.value.slice(`${DSH}domain:${domain}:version:`.length)
      dropSubject(store, subject)
      dropGraph(store, versionGraphName(domain, version))
    }
    dropSubject(store, domainNode(domain))
  })
}

/**
 * Delete one version snapshot and its record.
 *
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @param version - the version id to delete.
 * @param force - delete even when `version` is the active version, clearing `activeVersion`.
 * @throws {OntologyStoreError} `version-not-found` when no record exists, `version-active`
 * when the version is active and `force` is false.
 */
export async function deleteVersion(root: string, domain: string, version: string, force = false): Promise<void> {
  const db = await database(root)
  await db.mutate((store) => {
    const subject = versionNode(domain, version)
    if (firstObject(store, subject, PREDICATE_VERSION) === undefined) {
      throw new OntologyStoreError('version-not-found', `Version not found: ${version}`)
    }
    const active = firstObject(store, domainNode(domain), PREDICATE_ACTIVE_VERSION)
    if (active === version) {
      if (!force) {
        throw new OntologyStoreError('version-active', `版本 ${version} 是当前激活版本，需要强制删除才会清除 activeVersion。`)
      }
      for (const entry of store.match(domainNode(domain), namedNode(PREDICATE_ACTIVE_VERSION), null, registryTerm())) {
        store.delete(entry)
      }
    }
    dropSubject(store, subject)
    dropGraph(store, versionGraphName(domain, version))
  })
}

/**
 * Import a Turtle ontology as a new draft version and working graph.
 *
 * The Turtle is parsed before any write, so an invalid document leaves the
 * store untouched. The imported graph stays a draft: the model keeps reading
 * the previously published version until the draft is published.
 * @param root - the ontology store root.
 * @param domain - the domain id; registered when it does not exist yet.
 * @param turtle - the Turtle document to import.
 * @param record - optional approval metadata stored with the version record.
 * @returns the created version id.
 * @throws {OntologyStoreError} `query-rejected` when `turtle` does not parse.
 */
export async function importOntology(
  root: string,
  domain: string,
  turtle: string,
  record: { approver?: string; note?: string; sourceName?: string },
): Promise<string> {
  let liveQuads: Quad[]
  try {
    liveQuads = OntologyDatabase.parseGraph(liveGraphName(domain), turtle)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new OntologyStoreError('query-rejected', `导入的 Turtle 无法解析：${reason}`)
  }
  const db = await database(root)
  const now = new Date().toISOString()
  let created = ''
  await db.mutate((store) => {
    const version = nextVersion(versionIdsOf(store, domain))
    created = version
    const snapshot = versionGraphName(domain, version)
    dropGraph(store, snapshot)
    for (const entry of liveQuads) {
      store.add(quad(entry.subject, entry.predicate, entry.object, namedNode(snapshot)))
    }
    dropGraph(store, liveGraphName(domain))
    for (const entry of liveQuads) store.add(entry)
    applyVersionRecord(store, domain, {
      version,
      createdAt: now,
      approver: record.approver ?? '',
      note: record.note ?? '',
      sourceName: record.sourceName ?? '',
      status: 'draft',
    })
    const subject = domainNode(domain)
    const storedLabel = firstObject(store, subject, PREDICATE_LABEL)
    applyDomainMeta(store, {
      id: domain,
      label: storedLabel !== undefined && storedLabel.length > 0 ? storedLabel : domain,
      createdAt: firstObject(store, subject, PREDICATE_CREATED_AT) ?? now,
      updatedAt: now,
      activeVersion: firstObject(store, subject, PREDICATE_ACTIVE_VERSION) ?? null,
      disabled: firstObject(store, subject, PREDICATE_DISABLED) === 'true',
    })
    addAuditEntry(store, { at: now, action: 'import', domain, detail: `导入本体为草稿版本 ${version}` })
  })
  return created
}

/** Prefix of the named graphs that hold imported instance batches. */
const INSTANCE_GRAPH_PREFIX = `${DSH}graph:inst:`

const BATCH_ID = /^[a-z0-9][a-z0-9-]{0,31}$/u

/**
 * Reject a batch id that cannot be a graph-name suffix.
 * @param batch - the batch id to validate.
 * @throws {Error} when the id is outside 1–32 lowercase letters, digits, or dashes.
 */
export function requireBatchId(batch: string): void {
  if (!BATCH_ID.test(batch)) {
    throw new Error(`Batch id must be 1-32 lowercase letters, digits, or dashes: ${batch}`)
  }
}

/** Absolute graph IRI of one instance batch. */
function instanceGraphName(domain: string, batch: string): string {
  return `${INSTANCE_GRAPH_PREFIX}${domain}:${batch}`
}

/**
 * Replace one instance batch with the given Turtle.
 *
 * The batch owns a dedicated named graph, so a re-import replaces only that
 * graph and never touches the ontology, versions, or other batches.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @param batch - batch id; reusing it replaces the batch.
 * @param turtle - instance Turtle document.
 * @returns the number of quads written.
 * @throws {OntologyStoreError} `query-rejected` when the Turtle cannot be parsed.
 */
export async function writeInstanceGraph(
  root: string,
  domain: string,
  batch: string,
  turtle: string,
): Promise<number> {
  requireBatchId(batch)
  const graph = instanceGraphName(domain, batch)
  let quads: Quad[]
  try {
    quads = OntologyDatabase.parseGraph(graph, turtle)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new OntologyStoreError('query-rejected', `实例 Turtle 无法解析：${reason}`)
  }
  const db = await database(root)
  await db.mutate((store) => {
    dropGraph(store, graph)
    for (const entry of quads) store.add(entry)
  })
  return quads.length
}

/**
 * List a domain's instance batches.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @returns batches with their graph IRI and quad count, ordered by id.
 */
export async function listInstanceBatches(root: string, domain: string): Promise<InstanceBatch[]> {
  const db = await database(root)
  return db.run((store) => {
    const prefix = instanceGraphName(domain, '')
    const counts = new Map<string, number>()
    for (const entry of store.match(null, null, null)) {
      if (entry.graph.termType !== 'NamedNode' || !entry.graph.value.startsWith(prefix)) continue
      counts.set(entry.graph.value, (counts.get(entry.graph.value) ?? 0) + 1)
    }
    return Array.from(counts, ([graph, triples]) => ({
      batch: graph.slice(prefix.length),
      graph,
      triples,
    })).sort((left, right) => left.batch.localeCompare(right.batch))
  })
}

/**
 * Remove one instance batch.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @param batch - batch id to remove.
 * @returns the number of quads removed.
 */
export async function clearInstanceGraph(root: string, domain: string, batch: string): Promise<number> {
  requireBatchId(batch)
  const graph = instanceGraphName(domain, batch)
  const db = await database(root)
  const count = await db.run(store => store.match(null, null, null, namedNode(graph)).length)
  await db.mutate((store) => { dropGraph(store, graph) })
  return count
}

/**
 * Dump a domain's live graph as Turtle.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @param format - output media type; only `text/turtle` is supported.
 * @returns the live graph Turtle.
 */
export async function exportDomain(
  root: string,
  domain: string,
  format: 'text/turtle' = 'text/turtle',
): Promise<string> {
  const db = await database(root)
  return db.run(store => store.dump({ format, from_graph_name: namedNode(liveGraphName(domain)) }))
}

/**
 * Run a read-only SPARQL query over the whole dataset.
 *
 * Update forms are refused both by keyword screening and by using the engine's
 * query path, which never modifies the dataset.
 * @param root - the ontology store root.
 * @param sparql - the query text.
 * @returns the solution table, or the ASK answer in a single `boolean` row.
 * @throws {OntologyStoreError} `query-rejected` for update forms, unsupported forms,
 * or a payload that is not SPARQL JSON.
 */
export async function querySparql(root: string, sparql: string): Promise<SparqlResult> {
  const screened = stripSparqlComments(sparql)
  const keyword = firstQueryKeyword(sparql)
  if (!ALLOWED_QUERY_KEYWORDS.has(keyword)) {
    throw new OntologyStoreError(
      'query-rejected',
      `仅允许只读 SPARQL 查询（SELECT/ASK），收到 ${keyword.length > 0 ? keyword : '空查询'}。`,
    )
  }
  for (const refused of REFUSED_QUERY_KEYWORDS) {
    if (containsKeyword(screened, refused)) {
      throw new OntologyStoreError('query-rejected', `拒绝执行包含 ${refused} 的更新语句：查询必须只读。`)
    }
  }
  const db = await database(root)
  // Ontologies live in named graphs; treating the default graph as their union
  // keeps plain `SELECT * WHERE { ?s ?p ?o }` usable from the workbench console.
  const raw = await db.run(store => store.query(sparql, {
    results_format: 'application/sparql-results+json',
    use_default_graph_as_union: true,
  }))
  if (typeof raw !== 'string') {
    throw new OntologyStoreError('query-rejected', '查询未返回 SPARQL JSON 结果，请改用 SELECT 或 ASK。')
  }
  return parseSparqlJson(raw)
}

/**
 * Collect health counters for one domain.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @returns live-graph counts plus registry state.
 */
export async function domainStats(root: string, domain: string): Promise<DomainStats> {
  const db = await database(root)
  return db.run((store) => {
    const graph = namedNode(liveGraphName(domain))
    const triples = store.match(null, null, null, graph)
    const classes = new Set<string>()
    const properties = new Set<string>()
    for (const entry of triples) {
      if (entry.subject.termType !== 'NamedNode' || entry.object.termType !== 'NamedNode') continue
      if (entry.predicate.value !== RDF_TYPE) continue
      if (entry.object.value === OWL_CLASS || entry.object.value === RDFS_CLASS) classes.add(entry.subject.value)
      if (entry.object.value === OWL_OBJECT_PROPERTY || entry.object.value === OWL_DATATYPE_PROPERTY) {
        properties.add(entry.subject.value)
      }
    }
    const subject = domainNode(domain)
    return {
      tripleCount: triples.length,
      classCount: classes.size,
      propertyCount: properties.size,
      versionCount: versionSubjectsOf(store, domain).length,
      activeVersion: firstObject(store, subject, PREDICATE_ACTIVE_VERSION) ?? null,
      updatedAt: firstObject(store, subject, PREDICATE_UPDATED_AT) ?? '',
      disabled: firstObject(store, subject, PREDICATE_DISABLED) === 'true',
    }
  })
}

/** Write a file through a sibling temporary file so readers never see a partial write. */
async function writeAtomic(path: string, content: string | Uint8Array): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(temporary, content)
  await rename(temporary, path)
}

/**
 * Import the pre-database file layout exactly once: registry.json, per-domain
 * domain.json/ontology.ttl, and versions/<version>/{ontology.ttl,meta.json}.
 * Legacy files are left in place as an untouched backup.
 * @param root - the ontology store root.
 * @param db - the database that received no image on this open.
 */
async function importLegacyLayout(root: string, db: OntologyDatabase): Promise<void> {
  const registryPath = join(root, 'registry.json')
  if (!existsSync(registryPath)) return
  const ids = parseLegacyRegistry(await readFile(registryPath, 'utf8'))
  for (const domain of ids) {
    const domainDir = domainDirOf(root, domain)
    const meta = await readLegacyDomainMeta(domainDir, domain)
    const livePath = join(domainDir, 'ontology.ttl')
    if (existsSync(livePath)) await db.replaceGraph(liveGraphName(domain), await readFile(livePath, 'utf8'))
    for (const version of await readLegacyVersions(domainDir)) {
      const record = await readLegacyVersionRecord(domainDir, version)
      const turtle = await readFile(join(domainDir, 'versions', version, 'ontology.ttl'), 'utf8')
      await db.replaceGraph(versionGraphName(domain, version), turtle)
      await db.mutate((store) => { applyVersionRecord(store, domain, record) })
    }
    await db.mutate((store) => { applyDomainMeta(store, meta) })
  }
}

/** Parse registry.json, accepting the legacy bare-string entry form. */
function parseLegacyRegistry(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) return []
  const domains: unknown = (parsed as { domains?: unknown }).domains
  if (!Array.isArray(domains)) return []
  return domains.flatMap((entry) => {
    if (typeof entry === 'string') return [entry]
    if (typeof entry === 'object' && entry !== null) {
      const id: unknown = (entry as { id?: unknown }).id
      if (typeof id === 'string') return [id]
    }
    return []
  })
}

/** Read a legacy domain.json, defaulting to the domain id. */
async function readLegacyDomainMeta(domainDir: string, domain: string): Promise<DomainMeta> {
  const path = join(domainDir, 'domain.json')
  if (!existsSync(path)) {
    return { id: domain, label: domain, createdAt: '', updatedAt: '', activeVersion: null, disabled: false }
  }
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
  const record = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    id: domain,
    label: typeof record.label === 'string' && record.label.length > 0 ? record.label : domain,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    activeVersion: typeof record.activeVersion === 'string' ? record.activeVersion : null,
    disabled: typeof record.disabled === 'boolean' ? record.disabled : false,
  }
}

/** List legacy version directories holding a snapshot. */
async function readLegacyVersions(domainDir: string): Promise<string[]> {
  const dir = join(domainDir, 'versions')
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
}

/** Read one legacy version meta.json, defaulting every field. */
async function readLegacyVersionRecord(domainDir: string, version: string): Promise<VersionRecord> {
  const metaPath = join(domainDir, 'versions', version, 'meta.json')
  if (!existsSync(metaPath)) {
    return { version, createdAt: '', approver: '', note: '', sourceName: '', status: 'published' }
  }
  const raw: unknown = JSON.parse(await readFile(metaPath, 'utf8'))
  const value = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    version,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    approver: typeof value.approver === 'string' ? value.approver : '',
    note: typeof value.note === 'string' ? value.note : '',
    sourceName: typeof value.sourceName === 'string' ? value.sourceName : '',
    status: 'published',
  }
}
