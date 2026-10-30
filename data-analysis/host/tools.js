/** Tool definitions: file, database, and REST imports; the query DSL; computed fields; and charts. */
import path from 'node:path'
import { readCsvRows, readFileHead, sniffDelimiter } from './csv.js'
import { addDerivedColumn, listDatasets, materializeDataset, readDatasetMeta } from './dataset.js'
import { buildChartSpec, listCharts, saveChart, summarizeChart } from './charts.js'
import { describeTable, findConnection, listObjects, readTable, runReadOnlyQuery, testConnection } from './database.js'
import { compileExpression } from './expr.js'
import { assertWithinLimits, normalizeHeaders } from './infer.js'
import { buildProfile, normalizeQuery, runQuery } from './query.js'
import { discoverShape, fetchRecords, findSource } from './rest.js'
import { readXlsx } from './xlsx.js'
import { AnalysisError, clampInt } from './util.js'
import { ensureAnalysisDirs, fileFacts, resolveInsideWorkspace, sessionCwd } from './workspace.js'

/**
 * Build a host tool definition without importing the tool SDK.
 * @param definition - Name, description, parameters, and execute.
 * @returns A raw ToolDefinition accepted by `ctx.tools.register`.
 */
function tool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: {
      schema: { type: 'object' },
      /**
       * @param _args - Tool arguments, unused by the generic renderer.
       * @param value - Canonical tool value.
       * @returns One text content block.
       */
      render: definition.render ?? ((_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]),
    },
    /**
     * @param args - Validated arguments.
     * @param exec - Execution context providing the session workspace.
     * @returns The tool value.
     */
    execute: definition.execute,
    /**
     * @param args - Raw arguments.
     * @returns A generic call card.
     */
    presentCall: args => ({
      card: 'generic',
      title: definition.title ?? definition.name,
      kind: definition.kind ?? 'other',
      rawInput: args,
    }),
  }
}

/**
 * Describe a dataset for tool output.
 * @param meta - Dataset metadata.
 * @param warnings - Import warnings.
 * @param preview - Preview rows.
 * @returns The summary the model reads.
 */
function datasetSummary(meta, warnings, preview) {
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
 * Read the header of a delimited file and prepare a reproducible row factory.
 * @param filePath - Absolute file.
 * @param args - Tool arguments.
 * @returns `{ columns, rowsFactory, warnings, format }`.
 */
async function prepareCsvSource(filePath, args) {
  const head = await readFileHead(filePath)
  const extension = path.extname(filePath).toLowerCase()
  const delimiter = typeof args.delimiter === 'string' && args.delimiter.length > 0
    ? args.delimiter
    : extension === '.tsv'
      ? '\t'
      : sniffDelimiter(head)
  const headerRow = clampInt(args.headerRow, 1, 1000, 1)
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
  const limitRows = Number.isFinite(args.limitRows) && args.limitRows > 0 ? Math.trunc(args.limitRows) : Infinity
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

/**
 * Read an Excel worksheet and prepare a row factory.
 * @param filePath - Absolute file.
 * @param args - Tool arguments.
 * @returns `{ columns, rowsFactory, warnings, format, sheet }`.
 */
async function prepareXlsxSource(filePath, args) {
  const sheets = await readXlsx(filePath)
  const warnings = []
  let sheet = sheets[0]
  if (typeof args.sheet === 'string' && args.sheet.length > 0) {
    const match = sheets.find(candidate => candidate.name === args.sheet)
    if (match === undefined) {
      throw new AnalysisError(`Worksheet "${args.sheet}" was not found. Available sheets: ${sheets.map(candidate => candidate.name).join(', ')}.`, 'missing_sheet')
    }
    sheet = match
  } else {
    sheet = sheets.find(candidate => candidate.rows.length > 1) ?? sheets[0]
    if (sheets.length > 1) warnings.push(`Read the first non-empty worksheet "${sheet.name}" of ${sheets.length}.`)
  }
  const headerRow = clampInt(args.headerRow, 1, 1000, 1)
  const header = sheet.rows[headerRow - 1]
  if (header === undefined) throw new AnalysisError(`Worksheet "${sheet.name}" has no header row at line ${headerRow}.`, 'missing_header')
  const columns = normalizeHeaders(header, warnings)
  const dataRows = sheet.rows.slice(headerRow).filter(row => row.some(cell => String(cell ?? '').trim() !== ''))
  const limitRows = Number.isFinite(args.limitRows) && args.limitRows > 0 ? Math.trunc(args.limitRows) : Infinity
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
 * Register every analysis tool on the host context.
 * @param ctx - Host cordis context.
 * @param runtime - Shared plugin state: config, caches.
 * @returns A disposer removing every registration.
 */
export function registerTools(ctx, runtime) {
  const disposers = []
  const register = definition => {
    disposers.push(ctx.tools.register(tool(definition)))
  }
  const connections = () => runtime.config.connections ?? []
  const sources = () => runtime.config.sources ?? []

  register({
    name: 'analysis_ping',
    title: 'Analysis ping',
    kind: 'read',
    description: 'Check that the data analysis workbench is installed and report where datasets are stored.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    /**
     * @param _args - No arguments.
     * @param exec - Execution context.
     * @returns Plugin status and the analysis root.
     */
    async execute(_args, exec) {
      const cwd = sessionCwd(exec)
      const root = await ensureAnalysisDirs(cwd)
      return {
        ok: true,
        plugin: 'dsh-data-analysis',
        version: '0.1.0',
        dataRoot: root,
        datasets: (await listDatasets(root)).length,
        connections: (connections() ?? []).map(connection => connection.id),
        sources: (sources() ?? []).map(source => source.id),
      }
    },
  })

  register({
    name: 'dataset_list',
    title: 'List datasets',
    kind: 'read',
    description: 'List imported datasets with row and column counts. Call this before querying to learn dataset ids.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    /**
     * @param _args - No arguments.
     * @param exec - Execution context.
     * @returns Dataset summaries.
     */
    async execute(_args, exec) {
      const root = await ensureAnalysisDirs(sessionCwd(exec))
      return { dataRoot: root, datasets: await listDatasets(root) }
    },
  })

  register({
    name: 'dataset_import_file',
    title: 'Import CSV or Excel',
    kind: 'other',
    description: [
      'Import a CSV, TSV, or XLSX file from the workspace into a dataset.',
      'The file must sit inside the session workspace; `..` paths and absolute paths outside it are rejected.',
      'The import streams the file twice (schema scan, then write), so 100k+ rows stay in flat memory.',
      'Identical content yields the same dataset id instead of a duplicate.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path of the file.' },
        name: { type: 'string', description: 'Display name; defaults to the file name without extension.' },
        sheet: { type: 'string', description: 'XLSX worksheet name; defaults to the first non-empty sheet.' },
        delimiter: { type: 'string', description: 'CSV delimiter; sniffed from , ; tab | when omitted.' },
        headerRow: { type: 'integer', description: '1-based header row; defaults to 1.' },
        encoding: { type: 'string', description: 'Only utf-8 is accepted in this version.' },
        limitRows: { type: 'integer', description: 'Debug aid: import at most this many data rows.' },
        force: { type: 'boolean', description: 'Bypass the 1,000,000-row and 200 MB import limits.' },
      },
      required: ['path'],
    },
    /**
     * @param args - Import arguments.
     * @param exec - Execution context.
     * @returns Dataset summary with preview rows.
     */
    async execute(args, exec) {
      const cwd = sessionCwd(exec)
      if (typeof args.encoding === 'string' && args.encoding.toLowerCase() !== 'utf-8' && args.encoding.toLowerCase() !== 'utf8') {
        throw new AnalysisError(`Encoding "${args.encoding}" is not supported. Re-save the file as UTF-8.`, 'not_utf8')
      }
      const filePath = resolveInsideWorkspace(cwd, args.path)
      const facts = await fileFacts(filePath)
      assertWithinLimits(0, facts.sizeBytes, { force: args.force === true })
      const root = await ensureAnalysisDirs(cwd)
      const extension = path.extname(filePath).toLowerCase()
      const isExcel = extension === '.xlsx' || extension === '.xlsm'
      if (extension === '.xls') throw new AnalysisError('Legacy .xls is not supported; re-save it as .xlsx or CSV.', 'unsupported_format')
      const source = isExcel ? await prepareXlsxSource(filePath, args) : await prepareCsvSource(filePath, args)
      const displayName = args.name ?? path.basename(filePath, path.extname(filePath))
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
        force: args.force === true,
      })
      const summary = datasetSummary(result.dataset, result.warnings, result.preview ?? [])
      return result.reused ? { reused: true, ...summary } : summary
    },
  })

  register({
    name: 'dataset_profile',
    title: 'Profile dataset',
    kind: 'read',
    description: [
      'Return a compact profile (under 2 KB) of a dataset: types, null rates, distinct counts, numeric ranges, top values,',
      'and three suggested questions that the query tool can actually answer.',
      'Use this instead of reading raw rows; it keeps the context small and prevents invented numbers.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: { datasetId: { type: 'string' } },
      required: ['datasetId'],
    },
    /**
     * @param args - Dataset id.
     * @param exec - Execution context.
     * @returns The profile plus lineage.
     */
    async execute(args, exec) {
      const root = await ensureAnalysisDirs(sessionCwd(exec))
      const meta = await readDatasetMeta(root, args.datasetId)
      return { ...buildProfile(meta), source: meta.source, derived: meta.derived }
    },
  })

  register({
    name: 'dataset_query',
    title: 'Query dataset',
    kind: 'read',
    description: [
      'Aggregate a dataset with the DSL: dimensions (with optional timeGrain), measures (count, countDistinct, sum, avg, min, max, p50, p95),',
      'filters, orderBy, limit, and offset. Null semantics: sum/avg skip null, count counts rows, countDistinct skips null;',
      'division by zero and empty aggregates return null. limit defaults to 1000, is capped at 10000, and exceeding it sets truncated.',
      'Results are cached per dataset version.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        datasetId: { type: 'string' },
        dimensions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              timeGrain: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'] },
              alias: { type: 'string' },
            },
            required: ['field'],
          },
        },
        measures: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              agg: { type: 'string', enum: ['count', 'countDistinct', 'sum', 'avg', 'min', 'max', 'p50', 'p95'] },
              alias: { type: 'string' },
            },
            required: ['field'],
          },
        },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              op: {
                type: 'string',
                enum: ['=', '!=', '>', '>=', '<', '<=', 'in', 'notIn', 'contains', 'startsWith', 'isNull', 'notNull', 'between'],
              },
              value: {},
            },
            required: ['field', 'op'],
          },
        },
        orderBy: {
          type: 'array',
          items: {
            type: 'object',
            properties: { field: { type: 'string' }, direction: { type: 'string', enum: ['asc', 'desc'] } },
            required: ['field'],
          },
        },
        limit: { type: 'integer' },
        offset: { type: 'integer' },
      },
      required: ['datasetId'],
    },
    /**
     * @param args - DSL query.
     * @param exec - Execution context.
     * @returns Result columns, rows, and timing.
     */
    async execute(args, exec) {
      const root = await ensureAnalysisDirs(sessionCwd(exec))
      const meta = await readDatasetMeta(root, args.datasetId)
      const result = await runQuery(root, meta, args, runtime.queryCache)
      return { datasetId: meta.id, datasetVersion: meta.version, ...result }
    },
    /**
     * @param _args - Query arguments.
     * @param value - Query result.
     * @returns A short lead-in plus at most 50 rows as JSON.
     */
    render(_args, value) {
      const head = `${value.rowCount} row(s) in ${value.elapsedMs} ms${value.truncated ? ' (truncated)' : ''}${value.cached ? ' (cached)' : ''}; timezone ${value.timezone}`
      const shown = { ...value, rows: value.rows.slice(0, 50) }
      return [{ type: 'text', text: `${head}\n${JSON.stringify(shown, null, 2)}` }]
    },
  })

  register({
    name: 'dataset_add_field',
    title: 'Add computed field',
    kind: 'other',
    description: [
      'Add a computed column from a whitelisted expression and bump the dataset version.',
      'Allowed: + - * / %, comparisons, AND/OR/NOT, IF, ROUND, ABS, COALESCE, YEAR, MONTH, DAY, DATE_TRUNC, CONCAT, LOWER, UPPER, LENGTH.',
      'Expressions are parsed into an AST; eval and unknown functions are rejected with the character position.',
      'Division by zero yields null.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        datasetId: { type: 'string' },
        name: { type: 'string', description: 'New column name; must not collide with an existing column.' },
        expression: { type: 'string', description: 'Expression such as ROUND(金额 / 数量, 2) or [省份] + "-" + [城市].' },
      },
      required: ['datasetId', 'name', 'expression'],
    },
    /**
     * @param args - Field request.
     * @param exec - Execution context.
     * @returns The updated schema.
     */
    async execute(args, exec) {
      const root = await ensureAnalysisDirs(sessionCwd(exec))
      const meta = await readDatasetMeta(root, args.datasetId)
      if (typeof args.name !== 'string' || !/^[\p{L}\p{N}_ .-]{1,64}$/u.test(args.name)) {
        throw new AnalysisError('name must be 1-64 characters of letters, digits, spaces, dots, hyphens, or underscores.', 'bad_field_name')
      }
      const compiled = compileExpression(args.expression, meta.schema.map(entry => entry.name))
      const next = await addDerivedColumn(root, meta, {
        name: args.name,
        expression: args.expression,
        dependsOn: compiled.dependsOn,
        evaluate: compiled.evaluate,
      })
      return {
        datasetId: next.id,
        version: next.version,
        added: args.name,
        dependsOn: compiled.dependsOn,
        schema: next.schema,
      }
    },
  })

  register({
    name: 'db_test_connection',
    title: 'Test connection',
    kind: 'read',
    description: 'Open a configured database read-only and run SELECT 1. Secrets come from the environment variable named by urlEnv.',
    parameters: { type: 'object', properties: { connectionId: { type: 'string' } }, required: ['connectionId'] },
    /**
     * @param args - Connection id.
     * @param exec - Execution context.
     * @returns Latency report.
     */
    async execute(args, exec) {
      return testConnection(findConnection(connections(), args.connectionId), sessionCwd(exec))
    },
  })

  register({
    name: 'db_list_objects',
    title: 'List tables',
    kind: 'read',
    description: 'List tables and views visible to a read-only database connection.',
    parameters: { type: 'object', properties: { connectionId: { type: 'string' } }, required: ['connectionId'] },
    /**
     * @param args - Connection id.
     * @param exec - Execution context.
     * @returns Tables and views.
     */
    async execute(args, exec) {
      return listObjects(findConnection(connections(), args.connectionId), sessionCwd(exec))
    },
  })

  register({
    name: 'db_describe_table',
    title: 'Describe table',
    kind: 'read',
    description: 'Describe a table: column names, types, nullability, and primary keys.',
    parameters: {
      type: 'object',
      properties: { connectionId: { type: 'string' }, table: { type: 'string' } },
      required: ['connectionId', 'table'],
    },
    /**
     * @param args - Connection and table.
     * @param exec - Execution context.
     * @returns Column descriptors.
     */
    async execute(args, exec) {
      return describeTable(findConnection(connections(), args.connectionId), sessionCwd(exec), args.table)
    },
  })

  register({
    name: 'db_query',
    title: 'Query database',
    kind: 'read',
    description: [
      'Run one read-only SELECT on a configured connection. Writes, DDL, stacked statements, and comment tricks are rejected.',
      'Rows are capped at 10000 and the response sets truncated when the statement returned more.',
      'SQLite is accessed through node:sqlite in read-only mode; Postgres and MySQL need their optional drivers installed in the profile.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        sql: { type: 'string' },
        maxRows: { type: 'integer' },
      },
      required: ['connectionId', 'sql'],
    },
    /**
     * @param args - Connection and SQL.
     * @param exec - Execution context.
     * @returns Columns, rows, and timing.
     */
    async execute(args, exec) {
      const connection = findConnection(connections(), args.connectionId)
      return runReadOnlyQuery(connection, sessionCwd(exec), args.sql, args.maxRows ?? 1000)
    },
  })

  register({
    name: 'db_import_table',
    title: 'Import table',
    kind: 'other',
    description: 'Read a table (SELECT * with a row cap) into a dataset so it can be queried with the same DSL as files and APIs.',
    parameters: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        table: { type: 'string' },
        name: { type: 'string' },
        limit: { type: 'integer', description: 'Row cap; defaults to 10000, hard cap 10000.' },
        force: { type: 'boolean' },
      },
      required: ['connectionId', 'table'],
    },
    /**
     * @param args - Table import request.
     * @param exec - Execution context.
     * @returns Dataset summary.
     */
    async execute(args, exec) {
      const cwd = sessionCwd(exec)
      const connection = findConnection(connections(), args.connectionId)
      const limit = clampInt(args.limit, 1, 10_000, 10_000)
      const table = await readTable(connection, cwd, args.table, limit)
      if (table.rows.length === 0) throw new AnalysisError(`Table "${args.table}" is empty.`, 'empty_source')
      const root = await ensureAnalysisDirs(cwd)
      const columns = table.columns.map(column => column.name)
      const result = await materializeDataset(root, {
        name: args.name ?? args.table,
        source: { kind: 'database', detail: { connectionId: connection.id, table: args.table, kind: connection.kind } },
        columns,
        rowsFactory: async function* rows() {
          for (const row of table.rows) yield row.map(value => (value === null || value === undefined ? '' : String(value)))
        },
        warnings: table.truncated ? [`The table was truncated to ${limit} rows.`] : [],
        contentAddress: false,
        force: args.force === true,
      })
      const summary = datasetSummary(result.dataset, result.warnings, result.preview ?? [])
      return table.truncated ? { ...summary, warnings: [...summary.warnings, `Table read was capped at ${limit} rows.`] } : summary
    },
  })

  register({
    name: 'api_request',
    title: 'Call REST API',
    kind: 'read',
    description: [
      'Call a configured REST source. Only hosts in that source\'s allowedHosts are reachable, redirects are re-checked,',
      'GET retries twice on 429/5xx with backoff, responses are capped by maxBytes, and query results are flattened with dotted keys.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        sourceId: { type: 'string' },
        path: { type: 'string', description: 'Path relative to baseUrl, or an absolute URL on an allowed host.' },
        method: { type: 'string', enum: ['GET', 'POST'] },
        query: { type: 'object' },
        headers: { type: 'object' },
        body: {},
        recordsPath: { type: 'string', description: 'Dotted path of the record array, e.g. data.items.' },
        pagination: {
          type: 'object',
          properties: {
            style: { type: 'string', enum: ['none', 'page', 'offset', 'cursor'] },
            param: { type: 'string' },
            sizeParam: { type: 'string' },
            pageSize: { type: 'integer' },
            startPage: { type: 'integer' },
            maxPages: { type: 'integer' },
            nextPath: { type: 'string' },
            hasMorePath: { type: 'string' },
          },
        },
        maxBytes: { type: 'integer' },
        timeoutMs: { type: 'integer' },
      },
      required: ['sourceId'],
    },
    /**
     * @param args - Request description.
     * @param exec - Execution context.
     * @returns Fetch statics and normalized records.
     */
    async execute(args, exec) {
      const source = findSource(sources(), args.sourceId)
      const records = await fetchRecords(source, args)
      return {
        sourceId: source.id,
        status: records.status,
        records: records.records.length,
        pages: records.pages,
        requests: records.requests,
        sampleRecords: records.records.slice(0, 3),
        detectedColumns: records.records.length > 0 ? Object.keys(records.records[0]) : [],
      }
    },
  })

  register({
    name: 'api_discover',
    title: 'Discover API shape',
    kind: 'read',
    description: 'Fetch one page and report where the record array lives, the detected columns, and a sample record.',
    parameters: {
      type: 'object',
      properties: { sourceId: { type: 'string' }, path: { type: 'string' }, query: { type: 'object' } },
      required: ['sourceId'],
    },
    /**
     * @param args - Discovery request.
     * @param _exec - Unused; sources are configuration-scoped.
     * @returns Shape report.
     */
    async execute(args, _exec) {
      return discoverShape(findSource(sources(), args.sourceId), args)
    },
  })

  register({
    name: 'api_import',
    title: 'Import REST API',
    kind: 'other',
    description: 'Fetch one or more pages from a REST source and materialize them into a dataset for the shared query DSL.',
    parameters: {
      type: 'object',
      properties: {
        sourceId: { type: 'string' },
        path: { type: 'string' },
        query: { type: 'object' },
        recordsPath: { type: 'string' },
        name: { type: 'string' },
        pagination: {
          type: 'object',
          properties: {
            style: { type: 'string', enum: ['none', 'page', 'offset', 'cursor'] },
            param: { type: 'string' },
            sizeParam: { type: 'string' },
            pageSize: { type: 'integer' },
            startPage: { type: 'integer' },
            maxPages: { type: 'integer' },
            nextPath: { type: 'string' },
            hasMorePath: { type: 'string' },
          },
        },
        force: { type: 'boolean' },
      },
      required: ['sourceId'],
    },
    /**
     * @param args - Import request.
     * @param exec - Execution context.
     * @returns Dataset summary.
     */
    async execute(args, exec) {
      const cwd = sessionCwd(exec)
      const source = findSource(sources(), args.sourceId)
      const fetched = await fetchRecords(source, args)
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
        name: args.name ?? `${source.name ?? source.id} records`,
        source: {
          kind: 'api',
          detail: {
            sourceId: source.id,
            path: args.path ?? '',
            recordsPath: args.recordsPath,
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
        force: args.force === true,
      })
      return datasetSummary(result.dataset, result.warnings, result.preview ?? [])
    },
  })

  register({
    name: 'chart_create',
    title: 'Create chart',
    kind: 'other',
    description: [
      'Create and save a ChartSpec from a dataset query. Omit type to auto-pick from the result shape:',
      'time dimension to line, 1 category (<=12) to bar, >12 categories to horizontal bar, ratio-like category field (<=6) to pie,',
      '0 dimensions to kpi, >2 dimensions or no measure to table.',
      'The response returns the chart id and a numeric summary; raw rows stay out of the model context.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        datasetId: { type: 'string' },
        name: { type: 'string' },
        type: { type: 'string', enum: ['auto', 'bar', 'line', 'area', 'pie', 'scatter', 'table', 'kpi'] },
        x: { type: 'object', properties: { field: { type: 'string' }, timeGrain: { type: 'string' } } },
        y: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              agg: { type: 'string' },
              alias: { type: 'string' },
            },
          },
        },
        filters: { type: 'array', items: { type: 'object' } },
        options: { type: 'object' },
      },
      required: ['datasetId'],
    },
    /**
     * @param args - Chart request.
     * @param exec - Execution context.
     * @returns Stored chart id, spec, and summary.
     */
    async execute(args, exec) {
      const root = await ensureAnalysisDirs(sessionCwd(exec))
      const meta = await readDatasetMeta(root, args.datasetId)
      const timeField = meta.schema.find(entry => entry.type === 'date' || entry.type === 'datetime')
      const dimensionField = args.x?.field
        ?? timeField?.name
        ?? meta.schema.find(entry => entry.type === 'string')?.name
      const measureEntry = meta.schema.find(entry => entry.role === 'measure')
      const query = normalizeQuery(meta, {
        dimensions: dimensionField === undefined ? [] : [{ field: dimensionField, timeGrain: args.x?.timeGrain ?? (timeField?.name === dimensionField ? 'month' : undefined) }],
        measures: (args.y ?? (measureEntry === undefined ? [] : [{ field: measureEntry.name, agg: 'sum' }]))
          .map(measure => ({ field: measure.field, agg: measure.agg ?? 'sum', alias: measure.alias })),
        filters: args.filters ?? [],
        limit: 1000,
      })
      const result = await runQuery(root, meta, query, runtime.queryCache)
      const spec = buildChartSpec(meta, { ...args, name: args.name }, query, result)
      await saveChart(root, spec)
      return {
        chartId: spec.id,
        spec,
        summary: summarizeChart(spec, result),
        rowCount: result.rowCount,
        panelHint: 'Open the Data analysis tab in the right sidebar to see this chart; the panel reads the same ChartSpec.',
      }
    },
  })

  register({
    name: 'chart_list',
    title: 'List charts',
    kind: 'read',
    description: 'List saved ChartSpecs with their type, dataset, and query hash so a chart can be re-rendered from its spec.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    /**
     * @param _args - No arguments.
     * @param exec - Execution context.
     * @returns Saved charts.
     */
    async execute(_args, exec) {
      const root = await ensureAnalysisDirs(sessionCwd(exec))
      const charts = await listCharts(root)
      return {
        charts: charts.map(chart => ({
          id: chart.id,
          name: chart.name,
          type: chart.type,
          datasetId: chart.datasetId,
          createdAt: chart.createdAt,
          encoding: chart.encoding,
        })),
      }
    },
  })

  return () => {
    for (const dispose of disposers) dispose()
  }
}
