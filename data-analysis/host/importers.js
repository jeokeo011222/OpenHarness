/**
 * Import orchestration shared by the agent tools and the browser workbench.
 *
 * The agent reaches these through `host/tools.js` (argument validation and
 * rendering stay there); the workbench reaches them through `host/api.js`.
 * Both paths therefore materialize datasets with the same limits, the same
 * content addressing, and the same warnings.
 */
import path from 'node:path'
import { readCsvRows, readFileHead, sniffDelimiter } from './csv.js'
import { materializeDataset } from './dataset.js'
import { readTable } from './database.js'
import { assertWithinLimits, normalizeHeaders } from './infer.js'
import { fetchRecords } from './rest.js'
import { readXlsx } from './xlsx.js'
import { AnalysisError, clampInt } from './util.js'
import { ensureAnalysisDirs, fileFacts, resolveInsideWorkspace } from './workspace.js'

/** Formats the file importer accepts, keyed by extension. */
const FILE_FORMATS = new Map([
  ['.csv', 'csv'],
  ['.tsv', 'tsv'],
  ['.txt', 'csv'],
  ['.xlsx', 'xlsx'],
  ['.xlsm', 'xlsx'],
])

/**
 * Summarize a materialized dataset for a caller that renders JSON.
 * @param meta - Dataset metadata.
 * @param warnings - Import warnings.
 * @param preview - Preview rows.
 * @returns The summary both the model and the workbench read.
 */
export function describeDataset(meta, warnings, preview) {
  return {
    datasetId: meta.id,
    name: meta.name,
    version: meta.version,
    rowCount: meta.rowCount,
    columnCount: meta.columnCount,
    source: meta.source,
    columns: meta.schema.map(entry => ({
      name: entry.name,
      type: entry.type,
      role: entry.role,
      nullRate: meta.stats?.nullRateByColumn?.[entry.name] ?? 0,
      distinct: meta.stats?.distinctByColumn?.[entry.name] ?? null,
      min: meta.stats?.columns?.[entry.name]?.min ?? null,
      max: meta.stats?.columns?.[entry.name]?.max ?? null,
      mean: meta.stats?.columns?.[entry.name]?.mean ?? null,
      p50: meta.stats?.columns?.[entry.name]?.p50 ?? null,
      p95: meta.stats?.columns?.[entry.name]?.p95 ?? null,
    })),
    warnings,
    preview,
  }
}

/**
 * Read a delimited file's header and prepare a reproducible row factory.
 * @param filePath - Absolute file.
 * @param options - `delimiter`, `headerRow`, `limitRows`.
 * @returns `{ columns, rowsFactory, warnings, format, delimiter }`.
 */
async function prepareCsvSource(filePath, options) {
  const head = await readFileHead(filePath)
  const extension = path.extname(filePath).toLowerCase()
  const delimiter = typeof options.delimiter === 'string' && options.delimiter.length > 0
    ? options.delimiter
    : extension === '.tsv'
      ? '\t'
      : sniffDelimiter(head)
  const headerRow = clampInt(options.headerRow, 1, 1000, 1)
  const warnings = []
  let header = null
  let index = 0
  for await (const row of readCsvRows(filePath, delimiter)) {
    index += 1
    if (index === headerRow) {
      header = row
      break
    }
    if (index >= headerRow) break
  }
  if (header === null) throw new AnalysisError(`The file has no header row at line ${headerRow}.`, 'missing_header')
  const columns = normalizeHeaders(header, warnings)
  const limitRows = Number.isFinite(options.limitRows) && options.limitRows > 0 ? Math.trunc(options.limitRows) : Infinity
  let widthWarned = false
  const rowsFactory = async function* rows() {
    let line = 0
    let emitted = 0
    for await (const row of readCsvRows(filePath, delimiter)) {
      line += 1
      if (line <= headerRow) continue
      if (row.every(cell => String(cell ?? '').trim() === '')) continue
      if (row.length !== columns.length) {
        if (!widthWarned) {
          warnings.push(`Line ${line} has ${row.length} fields but the header has ${columns.length}; values are padded or dropped.`)
          widthWarned = true
        }
        if (row.length < columns.length) while (row.length < columns.length) row.push('')
        else row.length = columns.length
      }
      emitted += 1
      if (emitted > limitRows) return
      yield row
    }
  }
  return { columns, rowsFactory, warnings, format: delimiter === '\t' ? 'tsv' : 'csv', delimiter }
}

/** A header cell that carries no usable name: blank or a bare number. */
const PLACEHOLDER_LABEL = /^[+-]?\d+(?:[.,]\d+)*$/

/** Trimmed text of one worksheet cell. */
function cellText(cell) {
  return String(cell ?? '').replace(/^\uFEFF/, '').trim()
}

/** Whether a header cell names its column rather than merely marking it. */
function isPlaceholderLabel(text) {
  return text.length === 0 || PLACEHOLDER_LABEL.test(text)
}

/**
 * Fold a second, stacked header row into the column names.
 *
 * Excel reports often stack two header rows: a group row (`2023年一期`) over the
 * field row (`欠费金额`/`结算金额`/`回款时间`). Reading only the first row names
 * the fields `column_9` or `54`, repeats a group label, and leaves the field row
 * in the data as a phantom first record made entirely of labels.
 *
 * Three conditions together separate a header continuation from a record: it
 * names at least two columns the header row leaves unnamed (blank or a bare
 * number), it fills at least half of those unnamed columns, and it is text
 * rather than values — a record of a numeric report is at least 40% numbers.
 * @param header - Header row cells.
 * @param next - Row directly below the header, when the sheet has one.
 * @param headerRow - 1-based position of `header`, for the warning text.
 * @returns The merged header, its warning, and nothing when the row is data.
 */
function stackedHeader(header, next, headerRow) {
  if (next === undefined) return undefined
  const width = Math.max(header.length, next.length)
  const cells = []
  let placeholders = 0
  let candidates = 0
  let folded = 0
  let filled = 0
  let numbers = 0
  let group = ''
  for (let index = 0; index < width; index += 1) {
    const parent = cellText(header[index])
    const child = cellText(next[index])
    const childNames = !isPlaceholderLabel(child)
    if (parent.length > 0) group = parent
    if (child.length > 0) {
      filled += 1
      if (PLACEHOLDER_LABEL.test(child)) numbers += 1
    }
    if (isPlaceholderLabel(parent)) {
      placeholders += 1
      if (childNames) candidates += 1
    }
    if (!childNames) {
      cells.push(parent)
      continue
    }
    folded += 1
    // A merged group header names its first column and leaves the rest blank,
    // so a blank parent inherits the group label it sits under.
    const owner = parent.length === 0 ? group : parent
    cells.push(owner.length === 0 || owner === child ? child : `${owner} · ${child}`)
  }
  if (candidates < 2 || candidates * 2 < placeholders || numbers * 5 > filled * 2) return undefined
  return {
    cells,
    warning: `Row ${headerRow + 1} continues the header of row ${headerRow}; its ${folded} labels were folded into the column names as "group · field" and the row is not read as data.`,
  }
}

/**
 * Prepare one worksheet of an already-read workbook as a dataset source.
 *
 * The workbook is read once per import, so importing five sheets does not
 * unzip and re-parse the same file five times.
 * @param sheet - Worksheet with a name and a row table.
 * @param options - `headerRow`, `limitRows`.
 * @returns `{ columns, rowsFactory, warnings, format, sheet }`.
 */
function xlsxSourceOf(sheet, options) {
  const warnings = []
  const headerRow = clampInt(options.headerRow, 1, 1000, 1)
  const header = sheet.rows[headerRow - 1]
  if (header === undefined) throw new AnalysisError(`Worksheet "${sheet.name}" has no header row at line ${headerRow}.`, 'missing_header')
  // An explicit headerRow is the caller's decision; only the automatic pick
  // spends a second row on the header.
  const stacked = options.headerRow === undefined || options.headerRow === null
    ? stackedHeader(header, sheet.rows[headerRow], headerRow)
    : undefined
  if (stacked !== undefined) warnings.push(stacked.warning)
  const columns = normalizeHeaders(stacked?.cells ?? header, warnings)
  const dataRows = sheet.rows.slice(headerRow - 1 + (stacked === undefined ? 1 : 2)).filter(row => row.some(cell => String(cell ?? '').trim() !== ''))
  const limitRows = Number.isFinite(options.limitRows) && options.limitRows > 0 ? Math.trunc(options.limitRows) : Infinity
  for (const row of dataRows) {
    if (row.length < columns.length) while (row.length < columns.length) row.push('')
    else row.length = columns.length
  }
  return {
    columns,
    sheet: sheet.name,
    format: 'xlsx',
    warnings,
    rowsFactory: async function* rows() {
      let emitted = 0
      for (const row of dataRows) {
        emitted += 1
        if (emitted > limitRows) return
        yield row
      }
    },
  }
}

/**
 * Read one Excel worksheet and prepare a row factory.
 * @param filePath - Absolute file.
 * @param options - `sheet`, `headerRow`, `limitRows`.
 * @returns `{ columns, rowsFactory, warnings, format, sheet }`.
 */
async function prepareXlsxSource(filePath, options) {
  const sheets = await readXlsx(filePath)
  const leading = []
  let sheet = sheets[0]
  if (typeof options.sheet === 'string' && options.sheet.length > 0) {
    const match = sheets.find(candidate => candidate.name === options.sheet)
    if (match === undefined) {
      throw new AnalysisError(`Worksheet "${options.sheet}" was not found. Available sheets: ${sheets.map(candidate => candidate.name).join(', ')}.`, 'missing_sheet')
    }
    sheet = match
  } else {
    sheet = sheets.find(candidate => candidate.rows.length > 1) ?? sheets[0]
    if (sheets.length > 1) leading.push(`Read the first non-empty worksheet "${sheet.name}" of ${sheets.length}.`)
  }
  const source = xlsxSourceOf(sheet, options)
  return leading.length === 0 ? source : { ...source, warnings: [...leading, ...source.warnings] }
}

/**
 * List the worksheets of an Excel workbook without importing it.
 *
 * The dialog renders one row per worksheet, so each entry carries just enough
 * to let a reader pick: how many data rows it holds, how many header columns it
 * declares, and the header text itself for the first few columns.
 * @param cwd - Workspace root.
 * @param filePath - Workspace-relative or absolute path inside the workspace.
 * @returns Sheet names in workbook order and the one an import would pick.
 */
export async function listSheets(cwd, filePath) {
  const absolute = resolveInsideWorkspace(cwd, filePath)
  if (!['.xlsx', '.xlsm'].includes(path.extname(absolute).toLowerCase())) return { sheets: [] }
  const sheets = await readXlsx(absolute)
  return {
    path: path.relative(cwd, absolute).split(path.sep).join('/'),
    sheets: sheets.map(sheet => {
      const stacked = stackedHeader(sheet.rows[0] ?? [], sheet.rows[1], 1)
      const header = stacked?.cells ?? sheet.rows[0] ?? []
      const headerText = header.map(cell => cellText(cell)).filter(text => text.length > 0)
      const dataRows = Math.max(0, sheet.rows.length - (stacked === undefined ? 1 : 2))
      return {
        name: sheet.name,
        rows: dataRows,
        // The width the import will use, blank header cells included: they
        // become `column_N` fields rather than disappearing.
        columns: header.length,
        header: headerText.slice(0, 12),
        stacked: stacked !== undefined,
        empty: dataRows === 0,
      }
    }),
    preferred: (sheets.find(candidate => candidate.rows.length > 1) ?? sheets[0])?.name,
  }
}

/**
 * Import several worksheets of one workbook, each as its own dataset.
 *
 * One failing worksheet does not abort the rest: the caller gets the datasets
 * that were built plus a per-sheet failure list, so a stray empty or malformed
 * tab cannot cost the reader the other four.
 * @param cwd - Absolute workspace root.
 * @param options - `path`, `sheets` (or `sheet`), `name`, `headerRow`, `limitRows`, `force`.
 * @returns `{ datasets, failures, skipped }`, each dataset keyed to its worksheet.
 */
export async function importWorkbookSheets(cwd, options) {
  if (typeof options.encoding === 'string' && options.encoding.toLowerCase() !== 'utf-8' && options.encoding.toLowerCase() !== 'utf8') {
    throw new AnalysisError(`Encoding "${options.encoding}" is not supported. Re-save the file as UTF-8.`, 'not_utf8')
  }
  const filePath = resolveInsideWorkspace(cwd, options.path)
  const extension = path.extname(filePath).toLowerCase()
  if (!['.xlsx', '.xlsm'].includes(extension)) {
    throw new AnalysisError(
      `Cannot pick worksheets of "${path.basename(filePath)}": only .xlsx and .xlsm workbooks have them. Import the file on its own instead.`,
      'unsupported_format',
    )
  }
  const facts = await fileFacts(filePath)
  assertWithinLimits(0, facts.sizeBytes, { force: options.force === true })
  const root = await ensureAnalysisDirs(cwd)
  const sheets = await readXlsx(filePath)
  const requested = Array.isArray(options.sheets)
    ? options.sheets.map(name => String(name ?? '').trim()).filter(name => name.length > 0)
    : typeof options.sheet === 'string' && options.sheet.trim().length > 0
      ? [options.sheet.trim()]
      : []
  let selected
  if (requested.length > 0) {
    const known = new Set(sheets.map(sheet => sheet.name))
    const missing = requested.filter(name => !known.has(name))
    if (missing.length > 0) {
      throw new AnalysisError(
        `Worksheet ${missing.map(name => `"${name}"`).join(', ')} was not found. Available sheets: ${sheets.map(sheet => sheet.name).join(', ')}.`,
        'missing_sheet',
      )
    }
    selected = requested.map(name => sheets.find(sheet => sheet.name === name))
  } else {
    const withData = sheets.filter(sheet => sheet.rows.length > 1)
    selected = withData.length > 0 ? withData : [sheets[0]]
  }
  const baseName = options.name ?? path.basename(filePath, extension)
  const relative = path.relative(cwd, filePath).split(path.sep).join('/')
  const datasets = []
  const failures = []
  const skipped = []
  for (const sheet of selected) {
    try {
      const source = xlsxSourceOf(sheet, options)
      const result = await materializeDataset(root, {
        // With a single worksheet the workbook name is the whole story; with
        // several, the sheet name is what tells the datasets apart in the rail.
        name: selected.length === 1 ? baseName : `${baseName} · ${sheet.name}`,
        source: {
          kind: 'file',
          detail: {
            path: relative,
            format: 'xlsx',
            sheet: sheet.name,
            sizeBytes: facts.sizeBytes,
            mtime: facts.mtime,
          },
        },
        columns: source.columns,
        rowsFactory: source.rowsFactory,
        warnings: source.warnings,
        contentAddress: true,
        force: options.force === true,
      })
      datasets.push({
        sheet: sheet.name,
        reused: result.reused === true,
        ...describeDataset(result.dataset, result.warnings, result.preview ?? []),
      })
    } catch (error) {
      const code = error instanceof AnalysisError ? error.code : 'internal'
      const message = error instanceof Error ? error.message : String(error)
      // A worksheet with a header but no rows is a normal shape in a workbook
      // that keeps a template tab around; report it, do not call it a failure.
      if (code === 'empty_source') skipped.push({ sheet: sheet.name, reason: message })
      else failures.push({ sheet: sheet.name, code, message })
    }
  }
  if (datasets.length === 0 && failures.length === 0) {
    throw new AnalysisError(
      `No worksheet in "${path.basename(filePath)}" has data rows below the header.`,
      'empty_source',
    )
  }
  if (datasets.length === 0) {
    throw new AnalysisError(
      `No worksheet could be imported: ${failures.map(entry => `${entry.sheet} — ${entry.message}`).join('; ')}`,
      failures[0].code,
    )
  }
  return { datasets, failures, skipped }
}

/**
 * Import a CSV/TSV/Excel file from the workspace into a dataset.
 * @param cwd - Absolute workspace root.
 * @param options - `path`, plus `name`, `sheet`, `delimiter`, `headerRow`, `limitRows`, `force`.
 * @returns Dataset summary, preview, and warnings.
 */
export async function importFileDataset(cwd, options) {
  if (typeof options.encoding === 'string' && options.encoding.toLowerCase() !== 'utf-8' && options.encoding.toLowerCase() !== 'utf8') {
    throw new AnalysisError(`Encoding "${options.encoding}" is not supported. Re-save the file as UTF-8.`, 'not_utf8')
  }
  const filePath = resolveInsideWorkspace(cwd, options.path)
  const extension = path.extname(filePath).toLowerCase()
  if (!FILE_FORMATS.has(extension)) {
    throw new AnalysisError(
      `Cannot import "${path.basename(filePath)}": expected .csv, .tsv, .txt, .xlsx, or .xlsm. Legacy .xls must be re-saved as .xlsx or CSV.`,
      'unsupported_format',
    )
  }
  const facts = await fileFacts(filePath)
  assertWithinLimits(0, facts.sizeBytes, { force: options.force === true })
  const root = await ensureAnalysisDirs(cwd)
  const source = FILE_FORMATS.get(extension) === 'xlsx'
    ? await prepareXlsxSource(filePath, options)
    : await prepareCsvSource(filePath, options)
  const displayName = options.name ?? path.basename(filePath, path.extname(filePath))
  const result = await materializeDataset(root, {
    name: displayName,
    source: {
      kind: 'file',
      detail: {
        path: path.relative(cwd, filePath).split(path.sep).join('/'),
        format: source.format,
        ...(source.sheet === undefined ? {} : { sheet: source.sheet }),
        ...(source.delimiter === undefined ? {} : { delimiter: source.delimiter }),
        sizeBytes: facts.sizeBytes,
        mtime: facts.mtime,
      },
    },
    columns: source.columns,
    rowsFactory: source.rowsFactory,
    warnings: source.warnings,
    contentAddress: true,
    force: options.force === true,
  })
  return {
    reused: result.reused === true,
    ...describeDataset(result.dataset, result.warnings, result.preview ?? []),
  }
}

/**
 * Import a table (or view) from a configured database connection.
 * @param cwd - Absolute workspace root.
 * @param connection - Connection descriptor.
 * @param options - `table`, `name`, `limit`, `force`.
 * @returns Dataset summary.
 */
export async function importTableDataset(cwd, connection, options) {
  const limit = clampInt(options.limit, 1, 10_000, 10_000)
  const table = await readTable(connection, cwd, options.table, limit)
  if (table.rows.length === 0) throw new AnalysisError(`Table "${options.table}" is empty.`, 'empty_source')
  const root = await ensureAnalysisDirs(cwd)
  const columns = table.columns.map(column => column.name)
  const result = await materializeDataset(root, {
    name: options.name ?? options.table,
    source: { kind: 'database', detail: { connectionId: connection.id, table: options.table, kind: connection.kind } },
    columns,
    rowsFactory: async function* rows() {
      for (const row of table.rows) yield row.map(value => (value === null || value === undefined ? '' : String(value)))
    },
    warnings: table.truncated ? [`The table was truncated to ${limit} rows.`] : [],
    contentAddress: false,
    force: options.force === true,
  })
  const summary = describeDataset(result.dataset, result.warnings, result.preview ?? [])
  return table.truncated
    ? { ...summary, warnings: [...summary.warnings, `Table read was capped at ${limit} rows.`] }
    : summary
}

/**
 * Fetch one or more REST pages and import the records as a dataset.
 * @param cwd - Absolute workspace root.
 * @param source - Configured API source.
 * @param options - `path`, `query`, `recordsPath`, `pagination`, `name`, `force`.
 * @returns Dataset summary.
 */
export async function importApiDataset(cwd, source, options) {
  const fetched = await fetchRecords(source, options)
  if (fetched.records.length === 0) throw new AnalysisError('The API returned no records at the requested path.', 'empty_source')
  const columns = []
  const seen = new Set()
  for (const record of fetched.records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key)
        columns.push(key)
      }
    }
  }
  const root = await ensureAnalysisDirs(cwd)
  const result = await materializeDataset(root, {
    name: options.name ?? `${source.name ?? source.id} records`,
    source: {
      kind: 'api',
      detail: {
        sourceId: source.id,
        path: options.path ?? '',
        recordsPath: options.recordsPath,
        pages: fetched.pages,
        requests: fetched.requests,
        waterMark: new Date().toISOString(),
      },
    },
    columns,
    rowsFactory: async function* rows() {
      for (const record of fetched.records) {
        yield columns.map(key => (record[key] === null || record[key] === undefined ? '' : String(record[key])))
      }
    },
    warnings: [],
    contentAddress: false,
    force: options.force === true,
  })
  return describeDataset(result.dataset, result.warnings, result.preview ?? [])
}

/**
 * Write uploaded bytes into the analysis scratch directory.
 * @param cwd - Absolute workspace root.
 * @param filename - Client-supplied name, reduced to its base name.
 * @param bytes - File content.
 * @returns Workspace-relative path ready for {@link importFileDataset}.
 */
export async function stageUpload(cwd, filename, bytes) {
  const safe = path.basename(String(filename)).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
  if (safe.length === 0) throw new AnalysisError('The uploaded file needs a name with an extension.', 'bad_path')
  const extension = path.extname(safe).toLowerCase()
  if (!FILE_FORMATS.has(extension)) {
    throw new AnalysisError(`Cannot upload "${safe}": expected .csv, .tsv, .txt, .xlsx, or .xlsm.`, 'unsupported_format')
  }
  const root = await ensureAnalysisDirs(cwd)
  const target = path.join(root, 'tmp', `${Date.now()}-${safe}`)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(target, bytes)
  return path.relative(cwd, target).split(path.sep).join('/')
}
