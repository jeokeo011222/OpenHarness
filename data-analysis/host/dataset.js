/** Dataset storage: content-addressed datasets under `.analysis/datasets`, streaming I/O, and metadata. */
import { createReadStream, createWriteStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { ColumnStats, coerceValue } from './infer.js'
import { AnalysisError, createContentHasher } from './util.js'

const DATASET_ID_PATTERN = /^ds_[0-9a-f]{8,32}$/
const MAX_ROWS = 1_000_000

/**
 * Reject a dataset id that could escape the datasets directory.
 * @param id - Dataset id supplied by a caller.
 * @returns The same id when it matches the expected form.
 */
function assertDatasetId(id) {
  if (typeof id !== 'string' || !DATASET_ID_PATTERN.test(id)) {
    throw new AnalysisError(`"${id}" is not a dataset id. Call dataset_list to see valid ids.`, 'bad_dataset_id')
  }
  return id
}

/**
 * Directory of one dataset.
 * @param root - Analysis root.
 * @param id - Dataset id.
 * @returns Absolute directory path.
 */
export function datasetDirectory(root, id) {
  return path.join(root, 'datasets', assertDatasetId(id))
}

/**
 * Read a dataset's `meta.json`.
 * @param root - Analysis root.
 * @param id - Dataset id.
 * @returns Parsed metadata.
 */
export async function readDatasetMeta(root, id) {
  try {
    return JSON.parse(await readFile(path.join(datasetDirectory(root, id), 'meta.json'), 'utf8'))
  } catch {
    throw new AnalysisError(`Dataset "${id}" does not exist or its metadata is corrupt. Call dataset_list.`, 'unknown_dataset')
  }
}

/**
 * List datasets by scanning their metadata, newest first.
 * @param root - Analysis root.
 * @returns Lightweight dataset summaries.
 */
export async function listDatasets(root) {
  let names
  try {
    names = await readdir(path.join(root, 'datasets'))
  } catch {
    return []
  }
  const summaries = []
  for (const name of names) {
    if (!DATASET_ID_PATTERN.test(name)) continue
    try {
      const meta = JSON.parse(await readFile(path.join(root, 'datasets', name, 'meta.json'), 'utf8'))
      summaries.push({
        id: meta.id,
        name: meta.name,
        rowCount: meta.rowCount,
        columnCount: meta.columnCount,
        createdAt: meta.createdAt,
        version: meta.version,
        sourceKind: meta.source?.kind ?? 'unknown',
      })
    } catch {
      continue
    }
  }
  return summaries.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

/**
 * Rewrite the panel-facing dataset index.
 * @param root - Analysis root.
 * @returns The index that was written.
 */
export async function refreshIndex(root) {
  const index = { updatedAt: new Date().toISOString(), datasets: await listDatasets(root) }
  await writeFile(path.join(root, 'datasets', '_index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  return index
}

/**
 * Stream dataset records as objects.
 * @param root - Analysis root.
 * @param id - Dataset id.
 * @returns An async iterable of records.
 */
export async function* readDatasetRows(root, id) {
  const input = createReadStream(path.join(datasetDirectory(root, id), 'data.ndjson'))
  const lines = readline.createInterface({ input, crlfDelay: Infinity })
  let lineNumber = 0
  for await (const line of lines) {
    if (line.length === 0) continue
    lineNumber += 1
    try {
      yield JSON.parse(line)
    } catch {
      throw new AnalysisError(`Dataset row ${lineNumber} is corrupt JSON. Re-import the source.`, 'corrupt_dataset')
    }
  }
}

/**
 * Read the first rows of a dataset for previews and tool output.
 * @param root - Analysis root.
 * @param id - Dataset id.
 * @param limit - Maximum rows.
 * @returns Preview rows in column order.
 */
export async function readPreview(root, id, limit = 5) {
  const rows = []
  for await (const row of readDatasetRows(root, id)) {
    rows.push(row)
    if (rows.length >= limit) break
  }
  return rows
}

/**
 * Infer dataset statistics from per-column accumulators.
 * @param columns - Finished column descriptors.
 * @param rowCount - Total rows.
 * @returns Metadata `stats`.
 */
function buildStats(columns, rowCount) {
  const nullRateByColumn = {}
  const distinctByColumn = {}
  const statsColumns = {}
  let timeRange
  for (const column of columns) {
    nullRateByColumn[column.name] = column.nullRate
    distinctByColumn[column.name] = column.distinct
    statsColumns[column.name] = {
      min: column.min,
      max: column.max,
      mean: column.mean,
      p50: column.p50,
      p95: column.p95,
      topValues: column.topValues,
      literalNullMarkers: column.literalNullMarkers === true,
    }
    if (column.type === 'date' || column.type === 'datetime') {
      const min = column.sampleMin
      const max = column.sampleMax
      if (min !== undefined && max !== undefined) {
        const candidate = { field: column.name, min, max }
        if (timeRange === undefined || candidate.min < timeRange.min) timeRange = candidate
        if (max > timeRange.max) timeRange.max = max
      }
    }
  }
  return { rowCount, nullRateByColumn, distinctByColumn, columns: statsColumns, timeRange }
}

/**
 * Materialize a table into a new dataset.
 * Two streaming passes keep memory flat: one to infer columns, one to write rows.
 * @param root - Analysis root.
 * @param spec - Import description.
 * @returns The dataset summary, its preview, and import warnings.
 */
export async function materializeDataset(root, spec) {
  const warnings = [...(spec.warnings ?? [])]
  const accumulators = spec.columns.map(name => new ColumnStats(name))
  let rowCount = 0
  for await (const row of spec.rowsFactory()) {
    rowCount += 1
    for (let index = 0; index < accumulators.length; index += 1) accumulators[index].add(row[index])
    if (rowCount > MAX_ROWS && spec.force !== true) {
      throw new AnalysisError(
        `This source has more than ${MAX_ROWS.toLocaleString('en-US')} rows. Pass force: true to import it anyway.`,
        'too_many_rows',
      )
    }
  }
  if (rowCount === 0) throw new AnalysisError('The source has no data rows after the header.', 'empty_source')

  const columns = accumulators.map(accumulator => {
    const column = accumulator.finish(warnings)
    column.sampleMin = accumulator.minText
    column.sampleMax = accumulator.maxText
    return column
  })
  const literalMarkers = new Map(columns.map(column => [column.name, column.literalNullMarkers === true]))

  const tempDirectory = await mkdtemp(path.join(root, 'tmp', 'import-'))
  const dataPath = path.join(tempDirectory, 'data.ndjson')
  const output = createWriteStream(dataPath)
  const hasher = createContentHasher()
  let written = 0
  for await (const row of spec.rowsFactory()) {
    written += 1
    const record = {}
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index]
      record[column.name] = coerceValue(row[index], column.type, literalMarkers.get(column.name))
    }
    const line = JSON.stringify(record)
    hasher.update(line)
    hasher.update('\n')
    if (!output.write(`${line}\n`)) await once(output, 'drain')
  }
  await new Promise((resolve, reject) => {
    output.end()
    output.on('finish', resolve)
    output.on('error', reject)
  })
  if (written !== rowCount) {
    warnings.push(`The source changed during import: ${rowCount} rows scanned, ${written} written.`)
  }

  const contentHash = hasher.digest()
  const id = spec.contentAddress ? `ds_${contentHash.slice(0, 12)}` : `ds_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const destination = path.join(root, 'datasets', id)
  let existing
  try {
    existing = JSON.parse(await readFile(path.join(destination, 'meta.json'), 'utf8'))
  } catch {
    existing = undefined
  }
  if (existing !== undefined) {
    await rm(tempDirectory, { recursive: true, force: true })
    return {
      reused: true,
      dataset: existing,
      warnings: [...warnings, `Identical content is already stored as dataset "${existing.id}"; it was not imported twice.`],
    }
  }

  const now = new Date().toISOString()
  const stats = buildStats(columns, rowCount)
  const meta = {
    id,
    name: spec.name,
    version: 1,
    createdAt: now,
    updatedAt: now,
    source: spec.source,
    schema: columns.map(column => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      role: column.role,
    })),
    rowCount,
    columnCount: columns.length,
    stats,
    derived: [],
  }
  await writeFile(path.join(tempDirectory, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  await rename(tempDirectory, destination)
  await refreshIndex(root)
  return {
    reused: false,
    dataset: meta,
    warnings,
    preview: await readPreview(root, id, 5),
  }
}

/**
 * Append a computed column and bump the dataset version.
 * @param root - Analysis root.
 * @param meta - Current metadata.
 * @param column - `{ name, expression, evaluate }`.
 * @returns Updated metadata.
 */
export async function addDerivedColumn(root, meta, column) {
  if (meta.schema.some(entry => entry.name === column.name)) {
    throw new AnalysisError(`Column "${column.name}" already exists.`, 'duplicate_column')
  }
  const directory = datasetDirectory(root, meta.id)
  const sourcePath = path.join(directory, 'data.ndjson')
  const tempPath = path.join(directory, `data.ndjson.${randomUUID()}.tmp`)
  const output = createWriteStream(tempPath)
  let sawNumber = false
  let sawText = false
  let nulls = 0
  let rows = 0
  for await (const row of readDatasetRows(root, meta.id)) {
    let value
    try {
      value = column.evaluate(row)
    } catch (error) {
      throw new AnalysisError(`Computed field "${column.name}" failed on row ${rows + 1}: ${error.message}`, 'derived_field_failed')
    }
    rows += 1
    if (value === null || value === undefined) nulls += 1
    else if (typeof value === 'number') sawNumber = true
    else sawText = true
    const next = { ...row, [column.name]: value ?? null }
    if (!output.write(`${JSON.stringify(next)}\n`)) await once(output, 'drain')
  }
  await new Promise((resolve, reject) => {
    output.end()
    output.on('finish', resolve)
    output.on('error', reject)
  })
  await rename(tempPath, sourcePath)

  const type = sawText ? 'string' : 'number'
  const nextMeta = {
    ...meta,
    version: meta.version + 1,
    updatedAt: new Date().toISOString(),
    schema: [...meta.schema, { name: column.name, type, nullable: nulls > 0, role: type === 'number' ? 'measure' : 'dimension' }],
    derived: [...(meta.derived ?? []), { name: column.name, expression: column.expression, type, dependsOn: column.dependsOn }],
    columnCount: meta.schema.length + 1,
  }
  nextMeta.stats = {
    ...meta.stats,
    nullRateByColumn: { ...meta.stats.nullRateByColumn, [column.name]: rows === 0 ? 0 : Math.round((nulls / rows) * 1000) / 1000 },
    distinctByColumn: { ...meta.stats.distinctByColumn, [column.name]: null },
  }
  await writeFile(path.join(directory, 'meta.json'), `${JSON.stringify(nextMeta, null, 2)}\n`, 'utf8')
  await refreshIndex(root)
  return nextMeta
}

/**
 * Whether a dataset exists.
 * @param root - Analysis root.
 * @param id - Dataset id.
 * @returns True when `meta.json` is readable.
 */
export async function datasetExists(root, id) {
  try {
    await stat(path.join(datasetDirectory(root, id), 'meta.json'))
    return true
  } catch {
    return false
  }
}
