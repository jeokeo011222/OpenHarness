/**
 * Sync of one object type from its bound data source.
 *
 * A sync is one transaction: rows and the run record land together, so a
 * failure never leaves an object type partly refreshed without a run saying so.
 * Incremental mode needs a declared `updatedAtField`; without one, every run is
 * a full refresh and says so.
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { objectDatabaseAt } from './db.ts'
import { parseCsv } from './csv.ts'
import type { ObjectTypeBinding, SyncOutcome, SyncRunRecord } from './types.ts'

/** Default ceiling on rows read from one source. */
const DEFAULT_ROW_LIMIT = 200_000

/** Options for one sync run. */
export interface SyncOptions {
  /** Ontology store root holding `objects.db`. */
  readonly storePath: string
  readonly domain: string
  readonly objectType: string
  /** Requested mode; downgraded to `full` when the type declares no watermark. */
  readonly mode?: 'full' | 'incremental'
  /** Row ceiling, protecting against a runaway source. */
  readonly limit?: number
}

/** One source record before field mapping. */
type SourceRow = Readonly<Record<string, string>>

/**
 * Render one JSON value as the text stored in a bound field.
 * @param value - any value a JSON source may hold.
 * @returns a string, never `[object Object]`.
 */
function scalarText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString()
  }
  return JSON.stringify(value)
}

/**
 * Resolve a CSV path against the store root.
 * @param storePath - ontology root.
 * @param path - absolute, or relative to the root.
 * @returns the absolute file path.
 */
function resolveSourcePath(storePath: string, path: string): string {
  return isAbsolute(path) ? path : resolve(storePath, path)
}

/**
 * Read every row of a bound source.
 * @param binding - the object type being synced.
 * @param storePath - ontology root, used to resolve a relative CSV path.
 * @returns the raw records, before field mapping.
 */
async function readSource(binding: ObjectTypeBinding, storePath: string): Promise<SourceRow[]> {
  if (binding.datasource.kind === 'csv') {
    const text = await readFile(resolveSourcePath(storePath, binding.datasource.path), 'utf8')
    return [...parseCsv(text).rows]
  }
  const response = await fetch(binding.datasource.url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`Source ${binding.datasource.url} answered ${response.status}`)
  const payload: unknown = await response.json()
  const items = binding.datasource.itemsPath === undefined
    ? payload
    : binding.datasource.itemsPath.split('.').reduce<unknown>((node, key) => {
      if (typeof node !== 'object' || node === null) return undefined
      return (node as Record<string, unknown>)[key]
    }, payload)
  if (!Array.isArray(items)) throw new Error('Source JSON did not contain an array of records')
  return items.map((item) => {
    const row: Record<string, string> = {}
    if (typeof item === 'object' && item !== null) {
      for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
        row[key] = scalarText(value)
      }
    }
    return row
  })
}

/**
 * Map one raw record onto the declared fields.
 * @param binding - the object type being synced.
 * @param row - raw source record.
 * @returns the primary key and the stored field map.
 */
function mapRow(
  binding: ObjectTypeBinding,
  row: SourceRow,
): { primaryKey: string; data: Record<string, string> } {
  const data: Record<string, string> = {}
  for (const field of binding.fields) {
    data[field.name] = row[field.column] ?? ''
  }
  const keyField = binding.fields.find(field => field.name === binding.primaryKey)
  const primaryKey = (keyField === undefined ? row[binding.primaryKey] : data[keyField.name]) ?? ''
  return { primaryKey: primaryKey.trim(), data }
}

/**
 * Refresh one object type from its source.
 * @param options - store root, target type, and the requested mode.
 * @returns the completed run, including counts and the new watermark.
 */
export async function syncObjectType(options: SyncOptions): Promise<SyncOutcome> {
  const db = objectDatabaseAt(options.storePath)
  const binding = db.readObjectType(options.domain, options.objectType)
  if (binding === undefined) {
    throw new Error(`Object type is not bound: ${options.domain}/${options.objectType}`)
  }

  const startedAt = new Date().toISOString()
  const runId = `${options.domain}.${options.objectType}.${startedAt.replace(/[:.]/g, '-')}`
  const limit = options.limit ?? DEFAULT_ROW_LIMIT
  const watermarkField = binding.updatedAtField
  const mode = options.mode === 'incremental' && watermarkField !== undefined ? 'incremental' : 'full'
  const previousWatermark = mode === 'incremental' && watermarkField !== undefined
    ? db.maxField(options.domain, options.objectType, watermarkField)
    : null

  try {
    const source = await readSource(binding, options.storePath)
    if (source.length > limit) {
      throw new Error(`Source returned ${source.length} rows, above the ${limit}-row ceiling`)
    }

    let watermark: string | null = previousWatermark
    const rows: { primaryKey: string; data: Record<string, string> }[] = []
    let skipped = 0
    for (const raw of source) {
      const mapped = mapRow(binding, raw)
      if (mapped.primaryKey.length === 0) {
        skipped += 1
        continue
      }
      if (mode === 'incremental' && previousWatermark !== null && watermarkField !== undefined) {
        const stamp = mapped.data[watermarkField] ?? ''
        if (stamp.length > 0 && stamp <= previousWatermark) continue
      }
      if (watermarkField !== undefined) {
        const stamp = mapped.data[watermarkField] ?? ''
        if (stamp.length > 0 && (watermark === null || stamp > watermark)) watermark = stamp
      }
      rows.push(mapped)
    }

    const syncedAt = new Date().toISOString()
    const counts = db.transaction(() => db.writeRows(options.domain, options.objectType, rows, runId, syncedAt))
    const finishedAt = new Date().toISOString()
    db.recordSyncRun({
      runId,
      domain: options.domain,
      objectType: options.objectType,
      mode,
      read: source.length,
      inserted: counts.inserted,
      updated: counts.updated,
      skipped,
      watermark,
      failedReason: null,
      startedAt,
      finishedAt,
    })
    return {
      runId,
      domain: options.domain,
      objectType: options.objectType,
      mode,
      read: source.length,
      inserted: counts.inserted,
      updated: counts.updated,
      skipped,
      watermark,
      startedAt,
      finishedAt,
    }
  } catch (error: unknown) {
    const record: SyncRunRecord = {
      runId,
      domain: options.domain,
      objectType: options.objectType,
      mode,
      read: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      watermark: previousWatermark,
      failedReason: error instanceof Error ? error.message : String(error),
      startedAt,
      finishedAt: new Date().toISOString(),
    }
    db.recordSyncRun(record)
    throw error
  }
}
