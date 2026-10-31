/**
 * The workbench's HTTP face.
 *
 * The browser half is a hand-written module bundle with no build step and no
 * generated Remote descriptors, so it cannot call Host services directly the
 * way a Typert package does. This route gives it the same capabilities the
 * agent tools have — import, query, chart, connect — over JSON, behind the
 * same browser authentication the static index uses.
 *
 * Every response is `{ ok: true, value }` or `{ ok: false, error }`, so the
 * client has one shape to handle and one place to read the message it shows.
 */
import path from 'node:path'
import { buildChartSpec, listCharts, saveChart, summarizeChart } from './charts.js'
import { describeTable, findConnection, listObjects, testConnection } from './database.js'
import { listDatasets, readDatasetMeta, readDatasetRows, readPreview } from './dataset.js'
import { importApiDataset, importFileDataset, importTableDataset, importWorkbookSheets, listSheets, stageUpload } from './importers.js'
import { buildProfile, normalizeQuery, runQuery } from './query.js'
import { discoverShape, fetchRecords, findSource } from './rest.js'
import { AnalysisError } from './util.js'
import { analysisRoot, ensureAnalysisDirs, sessionStoreRoot } from './workspace.js'
import {
  mergeConfig, normalizeConnection, readConfig, redactConnection, removeConnection, removeSource, upsertConnection,
  upsertSource,
} from './config-store.js'

/** Path prefix this plugin owns. */
export const API_PREFIX = '/plugins/data-analysis/api'

/** Largest JSON body accepted, before base64 inflation of an upload. */
const MAX_BODY_BYTES = 96 * 1024 * 1024

/**
 * Read and parse a JSON request body.
 * @param req - Incoming request.
 * @returns Parsed body, or an empty object when the body is absent.
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new AnalysisError('The request body is too large to accept.', 'body_too_large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new AnalysisError('The request body is not valid JSON.', 'bad_json')
  }
}

/**
 * Write a JSON response.
 * @param res - Response.
 * @param status - HTTP status.
 * @param payload - Body to serialize.
 * @returns Nothing.
 */
function send(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Answer with a failure in the shared envelope.
 * @param res - Response.
 * @param error - Thrown value.
 * @returns Nothing.
 */
function fail(res, error) {
  if (error instanceof AnalysisError) {
    send(res, 400, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  send(res, 500, { ok: false, error: { code: 'internal', message } })
}

/**
 * Resolve the workspace a request works in.
 *
 * A session id is authoritative because the Host already owns that session's
 * cwd; a bare cwd is accepted for the shell-less case (a closed session whose
 * page is still open) as long as it is absolute. A conversation that has no
 * folder at all — a preset shell, a project entry, a Session whose cwd was never
 * bound — gets a private store under the harness home instead of a refusal, so
 * the workbench still opens there.
 * @param ctx - Plugin context.
 * @param input - Request body or query.
 * @returns `{ path, detached }`, where `detached` marks the folder-less store.
 */
function workspaceOf(ctx, input) {
  if (typeof input.sessionId === 'string' && input.sessionId.length > 0) {
    const sessions = ctx.get('sessions')
    const session = sessions?.get?.(input.sessionId)
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return { path: path.resolve(cwd), detached: false }
    // A blank Session, or one whose Agent has not been activated on this Host
    // yet, carries no `cwd` in its header — but the Workspace registry still
    // knows which directory owns it. Without this fallback every workbench
    // request on such a Session answered `missing_workspace`.
    const registry = ctx.get('workspaceRegistry')
    const owned = (registry?.list?.() || []).find(item => Array.isArray(item?.sessionIds)
      && item.sessionIds.includes(input.sessionId))
    if (typeof owned?.path === 'string' && owned.path.length > 0) return { path: path.resolve(owned.path), detached: false }
  }
  if (typeof input.cwd === 'string' && path.isAbsolute(input.cwd)) return { path: path.resolve(input.cwd), detached: false }
  if (typeof input.sessionId === 'string' && input.sessionId.length > 0) {
    return { path: sessionStoreRoot(input.sessionId), detached: true }
  }
  throw new AnalysisError('This request needs a sessionId with a workspace, or an absolute cwd.', 'missing_workspace')
}

/**
 * Effective connections: deployment seeds merged with the workspace registry.
 * @param runtime - Plugin runtime state.
 * @param cwd - Absolute workspace root.
 * @returns Connection list.
 */
async function effectiveConfig(runtime, cwd) {
  return mergeConfig(runtime.config, await readConfig(cwd))
}

/**
 * Find a connection in the effective list.
 * @param runtime - Plugin runtime state.
 * @param cwd - Absolute workspace root.
 * @param id - Connection id.
 * @returns The connection descriptor.
 */
async function requireConnection(runtime, cwd, id) {
  const config = await effectiveConfig(runtime, cwd)
  return findConnection(config.connections, id)
}

/**
 * Find a REST source in the effective list.
 * @param runtime - Plugin runtime state.
 * @param cwd - Absolute workspace root.
 * @param id - Source id.
 * @returns The source descriptor.
 */
async function requireSource(runtime, cwd, id) {
  const config = await effectiveConfig(runtime, cwd)
  return findSource(config.sources, id)
}

/**
 * Build the state the workbench renders from.
 * @param runtime - Plugin runtime state.
 * @param cwd - Absolute workspace root.
 * @param detached - Whether `cwd` is the folder-less Session store.
 * @returns Datasets, charts, the effective source lists (secrets masked), and the scope.
 */
async function stateOf(runtime, cwd, detached) {
  const root = await ensureAnalysisDirs(cwd)
  const config = await effectiveConfig(runtime, cwd)
  return {
    datasets: await listDatasets(root),
    charts: await listCharts(root),
    connections: config.connections.map(redactConnection),
    sources: config.sources,
    limits: { rows: 10_000, uploadBytes: MAX_BODY_BYTES },
    // The page says where the artifacts live: a folder-less conversation keeps
    // them under the harness home, and the reader should not look for a
    // `.analysis` directory that was never written.
    scope: { path: cwd, detached },
  }
}

/**
 * Compose and store one chart from a workbench request.
 * @param runtime - Plugin runtime state.
 * @param cwd - Absolute workspace root.
 * @param body - Chart request.
 * @returns Chart id, spec, summary, and the preview rows behind it.
 */
async function createChart(runtime, cwd, body) {
  const root = await ensureAnalysisDirs(cwd)
  const meta = await readDatasetMeta(root, String(body.datasetId ?? ''))
  const timeField = meta.schema.find(entry => entry.type === 'date' || entry.type === 'datetime')
  const dimensionField = body.x?.field
    ?? timeField?.name
    ?? meta.schema.find(entry => entry.type === 'string')?.name
  const measureEntry = meta.schema.find(entry => entry.role === 'measure')
  const query = normalizeQuery(meta, {
    dimensions: dimensionField === undefined
      ? []
      : [{ field: dimensionField, timeGrain: body.x?.timeGrain ?? (timeField?.name === dimensionField ? 'month' : undefined) }],
    measures: (body.y ?? (measureEntry === undefined ? [] : [{ field: measureEntry.name, agg: 'sum' }]))
      .map(measure => ({ field: measure.field, agg: measure.agg ?? 'sum', alias: measure.alias })),
    filters: body.filters ?? [],
    limit: 1000,
  })
  const result = await runQuery(root, meta, query, runtime.queryCache)
  const spec = buildChartSpec(meta, body, query, result)
  await saveChart(root, spec)
  return { chartId: spec.id, spec, summary: summarizeChart(spec, result), rowCount: result.rowCount, rows: result.rows?.slice(0, 500) ?? [] }
}

/**
 * Route one request to its handler.
 * @param ctx - Plugin context.
 * @param runtime - Plugin runtime state.
 * @param req - Incoming request.
 * @param res - Response.
 * @returns Nothing.
 */
async function dispatch(ctx, runtime, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = url.pathname.slice(API_PREFIX.length) || '/'
  const query = Object.fromEntries(url.searchParams.entries())
  const method = req.method ?? 'GET'
  const body = method === 'GET' || method === 'DELETE' ? query : { ...query, ...(await readBody(req)) }

  // The liveness probe answers without a workspace: it is what a caller uses
  // to find out whether this plugin is served at all.
  if (method === 'GET' && route === '/health') {
    return send(res, 200, { ok: true, value: { status: 'ok', prefix: API_PREFIX } })
  }

  const workspace = workspaceOf(ctx, body)
  const cwd = workspace.path

  switch (`${method} ${route}`) {
    case 'GET /state':
      return send(res, 200, { ok: true, value: await stateOf(runtime, cwd, workspace.detached) })

    case 'GET /dataset': {
      const root = await ensureAnalysisDirs(cwd)
      const meta = await readDatasetMeta(root, String(body.id ?? ''))
      return send(res, 200, {
        ok: true,
        value: { meta, profile: buildProfile(meta), preview: await readPreview(root, meta.id, 50) },
      })
    }

    case 'GET /rows': {
      const root = await ensureAnalysisDirs(cwd)
      const meta = await readDatasetMeta(root, String(body.id ?? ''))
      const limit = Math.min(Math.max(Number(body.limit ?? 5000) || 5000, 1), 20_000)
      const rows = []
      let lines = 0
      for await (const record of readDatasetRows(root, meta.id)) {
        lines += 1
        if (rows.length < limit) rows.push(record)
        else break
      }
      return send(res, 200, { ok: true, value: { rows, lines, eof: lines <= limit } })
    }

    case 'POST /query': {
      const root = await ensureAnalysisDirs(cwd)
      const meta = await readDatasetMeta(root, String(body.datasetId ?? ''))
      const querySpec = normalizeQuery(meta, body)
      const result = await runQuery(root, meta, querySpec, runtime.queryCache)
      return send(res, 200, { ok: true, value: { ...result, query: querySpec } })
    }

    case 'POST /import':
      return send(res, 200, { ok: true, value: await importFileDataset(cwd, body) })

    case 'POST /import/sheets':
      return send(res, 200, { ok: true, value: await importWorkbookSheets(cwd, body) })

    case 'POST /upload': {
      if (typeof body.dataBase64 !== 'string' || body.dataBase64.length === 0) {
        throw new AnalysisError('The upload carried no data.', 'bad_upload')
      }
      const bytes = Buffer.from(body.dataBase64, 'base64')
      const original = path.basename(String(body.filename ?? 'upload.csv'))
      const staged = await stageUpload(cwd, original, bytes)
      // A workbook is imported worksheet by worksheet, so the dialog stages the
      // bytes, shows the tabs it found, and only then imports the ticked ones.
      // A delimited file has no such choice and imports in one step.
      if (body.stage === true) {
        const listed = await listSheets(cwd, staged)
        return send(res, 200, { ok: true, value: { staged, sheets: listed.sheets ?? [] } })
      }
      // The staged file carries a timestamp for uniqueness; the dataset should
      // wear the name the reader picked, not that timestamp.
      const givenName = typeof body.name === 'string' ? body.name.trim() : ''
      const fallbackName = original.replace(/\.[^.]+$/, '') || original
      const summary = await importFileDataset(cwd, {
        ...body,
        name: givenName.length > 0 ? givenName : fallbackName,
        path: staged,
      })
      return send(res, 200, { ok: true, value: { ...summary, staged } })
    }

    case 'GET /sheets': {
      const value = await listSheets(cwd, String(body.path ?? ''))
      return send(res, 200, { ok: true, value })
    }

    case 'GET /charts':
      return send(res, 200, { ok: true, value: await listCharts(analysisRoot(cwd)) })

    case 'POST /chart':
      return send(res, 200, { ok: true, value: await createChart(runtime, cwd, body) })

    case 'POST /connections': {
      const saved = await upsertConnection(cwd, body.connection ?? body)
      return send(res, 200, {
        ok: true,
        value: { connections: saved.connections.map(redactConnection) },
      })
    }

    case 'DELETE /connections': {
      const remaining = await removeConnection(cwd, String(body.id ?? ''))
      return send(res, 200, { ok: true, value: { connections: remaining.map(redactConnection) } })
    }

    case 'POST /connections/test': {
      const id = String(body.connectionId ?? '').trim()
      // The dialog tests the values on screen rather than the last saved copy,
      // so a wrong password fails before it is written; a connection that was
      // never saved has no id to look up, hence the inline normalization.
      if (body.connection !== null && typeof body.connection === 'object') {
        const config = id === '' ? undefined : await effectiveConfig(runtime, cwd)
        const existing = id === '' ? undefined : config.connections.find(entry => entry.id === id)
        const connection = normalizeConnection({ ...body.connection, id: id === '' ? body.connection.id : id }, existing)
        return send(res, 200, { ok: true, value: await testConnection(connection, cwd) })
      }
      const connection = await requireConnection(runtime, cwd, id)
      return send(res, 200, { ok: true, value: await testConnection(connection, cwd) })
    }

    case 'POST /connections/tables': {
      const connection = await requireConnection(runtime, cwd, String(body.connectionId ?? ''))
      return send(res, 200, { ok: true, value: await listObjects(connection, cwd) })
    }

    case 'POST /connections/describe': {
      const connection = await requireConnection(runtime, cwd, String(body.connectionId ?? ''))
      return send(res, 200, { ok: true, value: await describeTable(connection, cwd, String(body.table ?? '')) })
    }

    case 'POST /connections/import': {
      const connection = await requireConnection(runtime, cwd, String(body.connectionId ?? ''))
      return send(res, 200, { ok: true, value: await importTableDataset(cwd, connection, body) })
    }

    case 'POST /sources': {
      const saved = await upsertSource(cwd, body.source ?? body)
      return send(res, 200, { ok: true, value: { sources: saved.sources } })
    }

    case 'DELETE /sources': {
      const remaining = await removeSource(cwd, String(body.id ?? ''))
      return send(res, 200, { ok: true, value: { sources: remaining } })
    }

    case 'POST /sources/discover': {
      const source = await requireSource(runtime, cwd, String(body.sourceId ?? ''))
      return send(res, 200, { ok: true, value: await discoverShape(source, body) })
    }

    case 'POST /sources/preview': {
      const source = await requireSource(runtime, cwd, String(body.sourceId ?? ''))
      const fetched = await fetchRecords(source, { ...body, maxPages: Math.min(Number(body.maxPages ?? 1), 3) })
      return send(res, 200, {
        ok: true,
        value: {
          status: fetched.status,
          records: fetched.records.length,
          pages: fetched.pages,
          requests: fetched.requests,
          sample: fetched.records.slice(0, 20),
        },
      })
    }

    case 'POST /sources/import': {
      const source = await requireSource(runtime, cwd, String(body.sourceId ?? ''))
      return send(res, 200, { ok: true, value: await importApiDataset(cwd, source, body) })
    }

    default:
      return send(res, 404, { ok: false, error: { code: 'not_found', message: `No route for ${method} ${route}.` } })
  }
}

/**
 * Admit one HTTP request the way the static index is admitted.
 *
 * A mounted identity provider owns the browser gate. Without one — desktop, or
 * a plain local server — Connection's shared browser Peer is the caller.
 * @param ctx - Plugin context.
 * @param req - Incoming request.
 * @returns The admitted peer, or undefined when the caller must sign in.
 */
function admit(ctx, req) {
  // `ctx.get`, not `ctx.connection`: the plugin does not declare `connection`
  // as a required inject, and strict contexts refuse property access to
  // services a plugin never injected.
  const connection = ctx.get('connection')
  if (connection === undefined) return undefined
  const identity = ctx.get('connectionIdentity')
  if (identity !== undefined) return connection.identityPeer?.(req)
  return connection.browserPeer
}

/**
 * Register the workbench API on the Host web server.
 * @param ctx - Host plugin context.
 * @param runtime - Plugin runtime state (`config`, `queryCache`).
 * @returns A disposer, or a no-op when nothing serves HTTP (headless).
 */
export function registerApi(ctx, runtime) {
  const server = ctx.get('webServer')
  // A headless profile serves no HTTP; the agent tools still work there.
  if (server === undefined || typeof server.register !== 'function') return () => {}
  return server.register({
    kind: 'prefix',
    path: API_PREFIX,
    /**
     * @param req - Incoming request.
     * @param res - Response.
     * @returns Nothing.
     */
    handler(req, res) {
      void (async () => {
        try {
          if (admit(ctx, req) === undefined) {
            send(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Sign in to use the analysis workbench.' } })
            return
          }
          await dispatch(ctx, runtime, req, res)
        } catch (error) {
          fail(res, error)
        }
      })()
    },
  })
}
