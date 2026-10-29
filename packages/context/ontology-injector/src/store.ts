/**
 * Ontology store layout: domain registry, per-domain metadata, live Turtle,
 * immutable version snapshots, and stored source documents.
 *
 * Layout:
 *   registry.json                       `{ "domains": ["contract", ...] }`
 *   <domain>/domain.json                label, timestamps, active version
 *   <domain>/ontology.ttl               the live graph
 *   <domain>/versions/<version>/        ontology.ttl + meta.json
 *   <domain>/sources/<timestamp>-<name> uploaded documents kept for traceability
 */

import { readFile, writeFile, rename, mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

/** Per-domain metadata kept beside the live ontology. */
export interface DomainMeta {
  readonly id: string
  readonly label: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly activeVersion: string | null
}

/** One immutable version snapshot. */
export interface VersionRecord {
  readonly version: string
  readonly createdAt: string
  readonly approver: string
  readonly note: string
  readonly sourceName: string
}

const DOMAIN_ID = /^[a-z][a-z0-9-]{1,31}$/

/**
 * Reject a domain id that cannot be a directory name.
 * @param domain - the domain id to validate.
 * @throws {Error} when the id is outside `2-32` lowercase letters, digits, or dashes.
 */
export function requireDomainId(domain: string): void {
  if (!DOMAIN_ID.test(domain)) {
    throw new Error(`Domain id must be 2-32 lowercase letters, digits, or dashes: ${domain}`)
  }
}

/**
 * Absolute directory of one domain.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @returns the absolute path of the domain directory.
 */
export function domainDirOf(root: string, domain: string): string {
  return join(root, domain)
}

/**
 * Read the domain list, accepting the legacy bare-string registry format.
 * @param root - the ontology store root.
 * @returns the registered domain ids, or an empty list when no registry exists.
 */
export async function readRegistry(root: string): Promise<string[]> {
  const path = join(root, 'registry.json')
  if (!existsSync(path)) return []
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (typeof raw !== 'object' || raw === null) return []
  const domains: unknown = (raw as { domains?: unknown }).domains
  if (!Array.isArray(domains)) return []
  const ids: string[] = []
  for (const entry of domains) {
    if (typeof entry === 'string') {
      ids.push(entry)
      continue
    }
    if (typeof entry === 'object' && entry !== null) {
      const id: unknown = (entry as { id?: unknown }).id
      if (typeof id === 'string') ids.push(id)
    }
  }
  return ids
}

/**
 * Persist the domain list in the canonical string-array form.
 * @param root - the ontology store root; created when missing.
 * @param domains - the domain ids to record.
 */
export async function writeRegistry(root: string, domains: readonly string[]): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeAtomic(join(root, 'registry.json'), `${JSON.stringify({ domains }, null, 2)}\n`)
}

/**
 * Read domain metadata, synthesizing it for domains without a domain.json.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @returns the stored metadata, or defaults named after the domain id.
 */
export async function readDomainMeta(root: string, domain: string): Promise<DomainMeta> {
  const path = join(domainDirOf(root, domain), 'domain.json')
  if (!existsSync(path)) {
    return { id: domain, label: domain, createdAt: '', updatedAt: '', activeVersion: null }
  }
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
  const record = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const active = typeof record.activeVersion === 'string' ? record.activeVersion : null
  return {
    id: domain,
    label: typeof record.label === 'string' && record.label.length > 0 ? record.label : domain,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    activeVersion: active,
  }
}

/**
 * Write domain metadata.
 * @param root - the ontology store root; the domain directory is created when missing.
 * @param meta - the metadata to persist.
 */
export async function writeDomainMeta(root: string, meta: DomainMeta): Promise<void> {
  await mkdir(domainDirOf(root, meta.id), { recursive: true })
  await writeAtomic(join(domainDirOf(root, meta.id), 'domain.json'), `${JSON.stringify(meta, null, 2)}\n`)
}

/**
 * Read the live Turtle for a domain.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @returns the live Turtle text, or an empty string when the domain has none yet.
 */
export async function readLiveTurtle(root: string, domain: string): Promise<string> {
  const path = join(domainDirOf(root, domain), 'ontology.ttl')
  if (!existsSync(path)) return ''
  return readFile(path, 'utf8')
}

/**
 * Replace the live Turtle for a domain.
 * @param root - the ontology store root.
 * @param domain - the domain id; its directory is created when missing.
 * @param turtle - the full Turtle document to write.
 */
export async function writeLiveTurtle(root: string, domain: string, turtle: string): Promise<void> {
  await mkdir(domainDirOf(root, domain), { recursive: true })
  await writeAtomic(join(domainDirOf(root, domain), 'ontology.ttl'), turtle)
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
  const dir = join(domainDirOf(root, domain), 'versions')
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const records: VersionRecord[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const metaPath = join(dir, entry.name, 'meta.json')
    let record: VersionRecord = {
      version: entry.name,
      createdAt: '',
      approver: '',
      note: '',
      sourceName: '',
    }
    if (existsSync(metaPath)) {
      const raw: unknown = JSON.parse(await readFile(metaPath, 'utf8'))
      const value = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      record = {
        version: entry.name,
        createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
        approver: typeof value.approver === 'string' ? value.approver : '',
        note: typeof value.note === 'string' ? value.note : '',
        sourceName: typeof value.sourceName === 'string' ? value.sourceName : '',
      }
    }
    records.push(record)
  }
  return records.sort((left, right) => compareVersions(right.version, left.version))
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
  const path = join(domainDirOf(root, domain), 'versions', version, 'ontology.ttl')
  if (!existsSync(path)) throw new Error(`Version not found: ${version}`)
  return readFile(path, 'utf8')
}

/**
 * Write an immutable version snapshot.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @param turtle - the snapshot Turtle.
 * @param record - the snapshot metadata; `record.version` is the directory name.
 */
export async function writeVersion(
  root: string,
  domain: string,
  turtle: string,
  record: VersionRecord,
): Promise<void> {
  const dir = join(domainDirOf(root, domain), 'versions', record.version)
  await mkdir(dir, { recursive: true })
  await writeAtomic(join(dir, 'ontology.ttl'), turtle)
  await writeAtomic(join(dir, 'meta.json'), `${JSON.stringify(record, null, 2)}\n`)
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

/** Write a file through a sibling temporary file so readers never see a partial write. */
async function writeAtomic(path: string, content: string | Uint8Array): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(temporary, content)
  await rename(temporary, path)
}

/**
 * Report whether a domain directory exists.
 * @param root - the ontology store root.
 * @param domain - the domain id.
 * @returns `true` when the domain directory is readable.
 */
export async function domainExists(root: string, domain: string): Promise<boolean> {
  try {
    await stat(domainDirOf(root, domain))
    return true
  } catch {
    // stat only fails with ENOENT here; any other failure is treated the same,
    // so an unreadable directory reads as absent rather than failing the call.
    return false
  }
}
