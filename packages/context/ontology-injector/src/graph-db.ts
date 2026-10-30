/**
 * Embedded RDF graph database shared by the ontology center.
 *
 * Every ontology root owns one Oxigraph store holding a dataset of named
 * graphs: the registry/metadata graph plus one live graph and one snapshot
 * graph per domain version. The durable image is `<root>/graph.db.nq`, loaded
 * on first use and rewritten atomically after each mutation.
 *
 * Several processes may share one root, so every mutation first takes the
 * `<root>/graph.db.lock` single-writer lock and re-reads the image under it;
 * reads and writes both reload the image when its `mtime`/size moved. The
 * registry graph records the durable schema version, and a damaged image fails
 * loud instead of leaving a partially loaded dataset in memory.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Store, literal, namedNode, quad, type Quad } from 'oxigraph'

/** Graph holding registry, domain metadata, and version metadata. */
export const REGISTRY_GRAPH = 'urn:dsh:ontology:registry'

/** Current durable schema version recorded in the registry graph. */
export const SCHEMA_VERSION = 1

/** Predicate recording the durable schema version. */
const FORMAT_VERSION_PREDICATE = 'urn:dsh:ontology:formatVersion'

/** Database image name inside the ontology root. */
const IMAGE = 'graph.db.nq'

/** Cross-process single-writer lock name inside the ontology root. */
const LOCK = 'graph.db.lock'

/** Directory holding `backup()` images. */
const BACKUP_DIR = 'backups'

/** Age after which a lock left by a live-looking pid is taken over anyway. */
const LOCK_STALE_MS = 60_000

/** Age after which an unparsable lock record counts as stale. */
const UNREADABLE_LOCK_STALE_MS = 10_000

/** Lock acquisition attempts before reporting the root busy. */
const LOCK_ATTEMPTS = 3

/** Observable image state; a change between two observations means someone wrote. */
interface ImageStamp {
  readonly mtimeMs: number
  readonly size: number
}

/** One parsed lock record. */
interface LockRecord {
  readonly pid: number
  readonly startedAt: number
}

/** Why a database operation was refused. */
export type OntologyDatabaseErrorKind = 'locked' | 'corrupt-image' | 'schema-mismatch'

/** Typed storage failure raised instead of continuing with an untrusted image. */
export class OntologyDatabaseError extends Error {
  /**
   * @param kind - the refused operation's cause.
   * @param message - actionable, user-facing explanation naming the affected path.
   */
  constructor(readonly kind: OntologyDatabaseErrorKind, message: string) {
    super(message)
    this.name = 'OntologyDatabaseError'
  }
}

/** Open databases, keyed by resolved ontology root. */
const openDatabases = new Map<string, OntologyDatabase>()

/**
 * Get the shared database handle for an ontology root.
 * @param root - ontology store root, relative or absolute.
 * @returns the database for that root, opened on first use.
 */
export function databaseAt(root: string): OntologyDatabase {
  const key = resolve(root)
  const existing = openDatabases.get(key)
  if (existing !== undefined) return existing
  const created = new OntologyDatabase(key)
  openDatabases.set(key, created)
  return created
}

/**
 * Drop the cached handle for an ontology root.
 *
 * Call after {@link OntologyDatabase.restore} so the next use opens the restored
 * image instead of the dataset the cached handle already holds in memory.
 * @param root - ontology store root, relative or absolute.
 */
export function forgetDatabase(root: string): void {
  openDatabases.delete(resolve(root))
}

/** Oxigraph store with a serialized write queue, a writer lock, and an atomic image writer. */
export class OntologyDatabase {
  private readonly store = new Store()
  private readonly imagePath: string
  private readonly lockPath: string
  private readonly loading: Promise<void>
  private pending: Promise<void> = Promise.resolve()
  private schema: Promise<void> | null = null
  private migration: Promise<void> | null = null
  /** Image state the in-memory dataset was loaded from; `null` when absent. */
  private stamp: ImageStamp | null = null

  /** Whether the image file already existed when this database opened. */
  readonly hadImage: boolean

  /**
   * @param root - absolute ontology store root.
   */
  constructor(readonly root: string) {
    this.imagePath = join(root, IMAGE)
    this.lockPath = join(root, LOCK)
    this.hadImage = existsSync(this.imagePath)
    this.loading = this.loadImage()
  }

  /**
   * Load the durable image, record the schema version, then run the one-time
   * import of a legacy file layout when no image existed.
   *
   * @param importer - imports legacy data into this database; skipped when the
   * image already existed or the import already ran.
   */
  async prepare(importer: () => Promise<void>): Promise<void> {
    await this.loading
    this.schema ??= this.hadImage ? this.ensureSchema() : Promise.resolve()
    await this.schema
    this.migration ??= this.hadImage ? Promise.resolve() : importer()
    await this.migration
    await this.pending
  }

  /**
   * Run a read-only operation against the dataset, after pending writes settle.
   *
   * The image is reloaded first when another process wrote since the last
   * observation, so a read never serves a stale dataset.
   * @param operation - synchronous work over the store.
   * @returns the operation result.
   */
  async run<T>(operation: (store: Store) => T): Promise<T> {
    await this.loading
    return this.serialized(async () => {
      await this.refresh()
      return operation(this.store)
    })
  }

  /**
   * Run a mutation and persist the resulting dataset image.
   *
   * The writer lock is taken before the image is re-read, so a concurrent writer
   * in another process cannot have its quad dropped by this operation.
   * @param operation - synchronous work over the store.
   */
  async mutate(operation: (store: Store) => void): Promise<void> {
    await this.loading
    await this.serialized(async () => {
      const release = await this.acquireLock()
      try {
        await this.refresh()
        ensureSchemaTriple(this.store)
        try {
          operation(this.store)
          await this.persist()
        } catch (error) {
          // The image still holds the last durable state; make the next access reload it
          // instead of serving a half-applied operation.
          this.stamp = null
          throw error
        }
      } finally {
        await release()
      }
    })
  }

  /**
   * Read one named graph as Turtle.
   * @param graphName - absolute IRI of the named graph.
   * @returns Turtle text, empty when the graph holds no triples.
   */
  async graphTurtle(graphName: string): Promise<string> {
    return this.run(store => store.dump({ format: 'text/turtle', from_graph_name: namedNode(graphName) }))
  }

  /**
   * Replace the whole content of one named graph.
   * @param graphName - absolute IRI of the named graph.
   * @param turtle - Turtle document; an empty string clears the graph.
   */
  async replaceGraph(graphName: string, turtle: string): Promise<void> {
    const quads = OntologyDatabase.parseGraph(graphName, turtle)
    await this.mutate((store) => {
      dropGraph(store, graphName)
      for (const entry of quads) store.add(entry)
    })
  }

  /**
   * Copy the durable image into a verified backup file.
   *
   * The lock is held while the image is read, and the copy is parsed in a
   * scratch store before the backup is reported as written.
   * @param destFile - absolute target path; defaults to `<root>/backups/graph-<timestamp>.nq`.
   * @returns the written backup path.
   * @throws {OntologyDatabaseError} `locked` when another process writes, `corrupt-image`
   * when the image or its copy cannot be parsed.
   */
  async backup(destFile?: string): Promise<string> {
    await this.loading
    return this.serialized(async () => {
      const release = await this.acquireLock()
      try {
        await this.refresh()
        const current = await this.imageStamp()
        const content = current === null
          ? this.store.dump({ format: 'application/n-quads' })
          : await readFile(this.imagePath, 'utf8')
        const target = destFile
          ?? join(this.root, BACKUP_DIR, `graph-${new Date().toISOString().replace(/[:.]/g, '-')}.nq`)
        verifyImage(target, content)
        await mkdir(dirname(target), { recursive: true })
        const temporary = `${target}.tmp-${process.pid}`
        await writeFile(temporary, content)
        await rename(temporary, target)
        return target
      } finally {
        await release()
      }
    })
  }

  /**
   * Install a verified backup file as a root's durable image.
   *
   * The installed file is parsed first, so a damaged backup never replaces a
   * readable image. Cached handles keep their in-memory dataset until reopened.
   * @param root - ontology store root, relative or absolute.
   * @param sourceFile - backup file to install.
   * @throws {OntologyDatabaseError} `corrupt-image` when `sourceFile` does not parse.
   */
  static async restore(root: string, sourceFile: string): Promise<void> {
    const targetRoot = resolve(root)
    const content = await readFile(sourceFile, 'utf8')
    verifyImage(sourceFile, content)
    await mkdir(targetRoot, { recursive: true })
    const target = join(targetRoot, IMAGE)
    const temporary = `${target}.tmp-${process.pid}`
    await writeFile(temporary, content)
    await rename(temporary, target)
  }

  /**
   * Parse Turtle into quads of one named graph without touching the dataset.
   *
   * Parsing runs in a scratch store, so invalid Turtle fails before any live
   * graph is cleared.
   *
   * @param graphName - absolute IRI the quads belong to.
   * @param turtle - Turtle document.
   * @returns the parsed quads.
   */
  static parseGraph(graphName: string, turtle: string): Quad[] {
    if (turtle.trim().length === 0) return []
    const graph = namedNode(graphName)
    const scratch = new Store()
    scratch.load(turtle, { format: 'text/turtle', to_graph_name: graph })
    return scratch.match(null, null, null, graph)
  }

  /** Queue a task behind every pending read and write. */
  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.pending.then(task)
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }

  /** Replace the in-memory dataset with the current image when it changed. */
  private async refresh(): Promise<void> {
    const current = await this.imageStamp()
    if (current === null) {
      if (this.stamp === null) return
      await this.reload(null)
      return
    }
    if (this.stamp !== null && current.mtimeMs === this.stamp.mtimeMs && current.size === this.stamp.size) return
    await this.reload(current)
  }

  /** Load the image on first open. */
  private async loadImage(): Promise<void> {
    if (!this.hadImage) return
    await this.reload(await this.imageStamp())
  }

  /** Stat the image, or `null` while it does not exist. */
  private async imageStamp(): Promise<ImageStamp | null> {
    try {
      const info = await stat(this.imagePath)
      return { mtimeMs: info.mtimeMs, size: info.size }
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return null
      throw error
    }
  }

  /**
   * Replace the in-memory dataset with the image content.
   *
   * @param stamp - the image state observed before reading it; `null` when absent.
   * @throws {OntologyDatabaseError} `corrupt-image` when the image cannot be read or
   * parsed, `schema-mismatch` when it records a newer format version.
   */
  private async reload(stamp: ImageStamp | null): Promise<void> {
    if (stamp === null) {
      this.clear()
      this.stamp = null
      return
    }
    let image: string
    try {
      image = await readFile(this.imagePath, 'utf8')
    } catch (error) {
      if (codeOf(error) === 'ENOENT') {
        this.clear()
        this.stamp = null
        return
      }
      throw this.corruptImage('读取', error)
    }
    this.clear()
    try {
      if (image.length > 0) this.store.load(image, { format: 'application/n-quads' })
      this.assertSchemaVersion()
    } catch (error) {
      this.clear()
      this.stamp = null
      if (error instanceof OntologyDatabaseError) throw error
      throw this.corruptImage('解析', error)
    }
    this.stamp = stamp
  }

  /** Drop every quad, so a failed reload never leaves a partial dataset behind. */
  private clear(): void {
    for (const entry of this.store.match(null, null, null)) this.store.delete(entry)
  }

  /** Throw when the image records a newer format version than this build writes. */
  private assertSchemaVersion(): void {
    const entry = this.store.match(registryTerm(), namedNode(FORMAT_VERSION_PREDICATE), null, registryTerm()).at(0)
    if (entry === undefined || entry.object.termType !== 'Literal') return
    const stored = Number.parseInt(entry.object.value, 10)
    if (!Number.isFinite(stored) || stored <= SCHEMA_VERSION) return
    throw new OntologyDatabaseError(
      'schema-mismatch',
      `图谱镜像 ${this.imagePath} 的格式版本为 ${stored}，高于本程序支持的 ${SCHEMA_VERSION}；请升级到较新的版本或从备份恢复。`,
    )
  }

  /** Whether the loaded dataset already records the schema version. */
  private schemaPresent(): boolean {
    return this.store.match(registryTerm(), namedNode(FORMAT_VERSION_PREDICATE), null, registryTerm()).length > 0
  }

  /** Record the schema version on first open of an existing store. */
  private async ensureSchema(): Promise<void> {
    if (this.schemaPresent()) return
    await this.mutate(() => {})
  }

  /** Atomically replace the image and remember the state just written. */
  private async persist(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    const image = this.store.dump({ format: 'application/n-quads' })
    const temporary = `${this.imagePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    await writeFile(temporary, image)
    await rename(temporary, this.imagePath)
    this.stamp = await this.imageStamp()
  }

  /**
   * Create the cross-process writer lock.
   *
   * @returns the release function; callers release it in `finally`.
   * @throws {OntologyDatabaseError} `locked` when another live process holds the lock.
   */
  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(this.root, { recursive: true })
    const record = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        await writeFile(this.lockPath, record, { encoding: 'utf8', flag: 'wx' })
        return async () => {
          await rm(this.lockPath, { force: true })
        }
      } catch (error) {
        if (codeOf(error) !== 'EEXIST') throw error
      }
      if (!await this.lockIsStale()) {
        throw new OntologyDatabaseError(
          'locked',
          `另一个进程正在写入图谱数据库 ${this.root}（锁文件 ${this.lockPath}），请稍后重试。`,
        )
      }
      await rm(this.lockPath, { force: true })
    }
    throw new OntologyDatabaseError('locked', `无法获取图谱数据库写锁 ${this.lockPath}，请稍后重试。`)
  }

  /**
   * Decide whether the existing lock belongs to a dead or over-age writer.
   *
   * @returns `true` when the lock may be taken over.
   */
  private async lockIsStale(): Promise<boolean> {
    let raw: string
    let mtimeMs: number
    try {
      raw = await readFile(this.lockPath, 'utf8')
      mtimeMs = (await stat(this.lockPath)).mtimeMs
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return true
      throw error
    }
    const parsed = parseLockRecord(raw)
    if (parsed === null) return Date.now() - mtimeMs > UNREADABLE_LOCK_STALE_MS
    if (!isAlive(parsed.pid)) return true
    return Date.now() - parsed.startedAt > LOCK_STALE_MS
  }

  /** Build the typed failure for an unreadable or unparsable image. */
  private corruptImage(action: string, cause: unknown): OntologyDatabaseError {
    const reason = cause instanceof Error ? cause.message : String(cause)
    return new OntologyDatabaseError(
      'corrupt-image',
      `图谱镜像${action}失败：${this.imagePath}（${reason}）。请用 backups/ 下的备份执行 OntologyDatabase.restore 恢复，不要继续在此镜像上写入。`,
    )
  }
}

/**
 * Delete every quad of one named graph.
 * @param store - the dataset to edit.
 * @param graphName - absolute IRI of the named graph.
 */
export function dropGraph(store: Store, graphName: string): void {
  const graph = namedNode(graphName)
  for (const entry of store.match(null, null, null, graph)) store.delete(entry)
}

/** The registry graph as a term. */
function registryTerm() {
  return namedNode(REGISTRY_GRAPH)
}

/** Add the schema version triple when the registry graph records none. */
function ensureSchemaTriple(store: Store): void {
  const graph = registryTerm()
  if (store.match(graph, namedNode(FORMAT_VERSION_PREDICATE), null, graph).length > 0) return
  store.add(quad(graph, namedNode(FORMAT_VERSION_PREDICATE), literal(String(SCHEMA_VERSION)), graph))
}

/**
 * Prove a backup candidate parses before it replaces or reports as an image.
 * @param path - the backup path named in the failure message.
 * @param content - N-Quads text to parse; empty content is a valid empty dataset.
 * @throws {OntologyDatabaseError} `corrupt-image` when the text does not parse.
 */
function verifyImage(path: string, content: string): void {
  if (content.trim().length === 0) return
  try {
    const scratch = new Store()
    scratch.load(content, { format: 'application/n-quads' })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new OntologyDatabaseError('corrupt-image', `备份文件无法解析：${path}（${reason}）。`)
  }
}

/**
 * Read an `errno` code from an unknown thrown value.
 * @param error - the caught value.
 * @returns the string code, or `undefined` when it has none.
 */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code: unknown = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Parse a lock record, rejecting partial or malformed JSON.
 * @param raw - the lock file content.
 * @returns the record, or `null` when it cannot be trusted.
 */
function parseLockRecord(raw: string): LockRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (_unparsable) {
    // A writer killed mid-write leaves a truncated record; its file age decides staleness.
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const pid: unknown = (parsed as { pid?: unknown }).pid
  const startedAt: unknown = (parsed as { startedAt?: unknown }).startedAt
  if (typeof pid !== 'number' || typeof startedAt !== 'string') return null
  const started = Date.parse(startedAt)
  if (!Number.isFinite(started)) return null
  return { pid, startedAt: started }
}

/**
 * Whether a pid names a live process.
 * @param pid - the recorded writer pid.
 * @returns `true` unless the OS reports `ESRCH`; a permission failure counts as alive.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return codeOf(error) !== 'ESRCH'
  }
}
