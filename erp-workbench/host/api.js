/**
 * HTTP face of the ERP workbench.
 *
 * The browser half has no build step and cannot reach Host services directly,
 * so everything it needs — connection CRUD, mapping validation, and one call —
 * is JSON over these routes, behind the same browser admission the static index
 * uses.
 */
import { readFile } from 'node:fs/promises'
import {
  mappingSummary,
  normalizeConnection,
  publicConnection,
  readStore,
  storePath,
  withConnection,
  withoutConnection,
  writeStore,
} from './config-store.js'
import { connectorStatus, invoke, probe, validateMapping } from './runtime.js'
import { ErpError, text } from './util.js'

/** Path prefix this plugin owns. */
export const API_PREFIX = '/plugins/erp-workbench/api'

/** Largest JSON body accepted. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * Read and parse a JSON request body.
 * @param req - Incoming request.
 * @returns Parsed object, or an empty object.
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new ErpError('body_too_large', 'The request body is too large.', 413)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new ErpError('bad_json', 'The request body is not valid JSON.')
  }
}

/**
 * Write one JSON response.
 * @param res - Response.
 * @param status - HTTP status.
 * @param payload - Body.
 * @returns Nothing.
 */
function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/**
 * Answer one request.
 * @param req - Incoming request.
 * @param res - Response.
 * @returns Nothing.
 */
async function dispatch(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = url.pathname.slice(API_PREFIX.length) || '/'
  const query = Object.fromEntries(url.searchParams.entries())
  const method = req.method ?? 'GET'
  const body = method === 'GET' || method === 'DELETE' ? query : { ...query, ...(await readBody(req)) }

  if (method === 'GET' && route === '/health') {
    return send(res, 200, { ok: true, value: { status: 'ok', prefix: API_PREFIX } })
  }

  const store = await readStore()

  switch (`${method} ${route}`) {
    case 'GET /state':
      return send(res, 200, {
        ok: true,
        value: {
          connector: await connectorStatus(),
          connections: store.connections.map(publicConnection),
          mapping: mappingSummary(store.mapping),
          store: storePath(),
        },
      })

    case 'POST /connections': {
      const submitted = body.connection ?? body
      const existing = store.connections.find(entry => entry.id === text(submitted?.id))
      const connection = normalizeConnection(submitted, existing)
      await writeStore(withConnection(store, connection))
      const next = await readStore()
      return send(res, 200, { ok: true, value: { connection: publicConnection(connection), connections: next.connections.map(publicConnection) } })
    }

    case 'DELETE /connections': {
      const id = text(body.id)
      if (id === '') throw new ErpError('bad_connection', 'A connection id is required.')
      await writeStore(withoutConnection(store, id))
      return send(res, 200, { ok: true, value: { connections: (await readStore()).connections.map(publicConnection) } })
    }

    case 'POST /connections/test': {
      const id = text(body.connectionId)
      const connection = store.connections.find(entry => entry.id === id)
      if (connection === undefined) throw new ErpError('connection_not_found', `No connection "${id}".`, 404)
      return send(res, 200, { ok: true, value: { ...(await probe(connection)), baseUrl: connection.baseUrl } })
    }

    case 'POST /mappings': {
      const mapping = parseMapping(body)
      await validateMapping(mapping)
      await writeStore({ ...store, mapping })
      return send(res, 200, { ok: true, value: { mapping: mappingSummary(mapping) } })
    }

    case 'POST /mappings/example': {
      // The sample file is the one the connector's own tests and examples use,
      // so what the page loads is the shape the library documents.
      const exampleUrl = new URL('../../erp-connector/examples/sample-config.json', import.meta.url)
      const mapping = JSON.parse(await readFile(exampleUrl, 'utf8'))
      await validateMapping(mapping)
      await writeStore({ ...store, mapping })
      return send(res, 200, { ok: true, value: { mapping: mappingSummary(mapping) } })
    }

    case 'POST /invoke': {
      const id = text(body.connectionId)
      const connection = store.connections.find(entry => entry.id === id)
      if (connection === undefined) throw new ErpError('connection_not_found', `No connection "${id}".`, 404)
      const params = body.params !== null && typeof body.params === 'object' ? body.params : {}
      const result = await invoke(connection, store.mapping, {
        domain: text(body.domain),
        action: text(body.action),
        params,
      })
      return send(res, 200, { ok: true, value: result })
    }

    default:
      return send(res, 404, { ok: false, error: { code: 'not_found', message: `No route for ${method} ${route}.` } })
  }
}

/**
 * Read the mapping document one request carries, as an object or as text.
 * @param body - Request body.
 * @returns Parsed mapping document.
 */
function parseMapping(body) {
  if (body.mapping !== undefined) return body.mapping
  if (typeof body.text === 'string') {
    if (body.text.trim() === '') throw new ErpError('mapping_invalid', 'The mapping text is empty.')
    try {
      return JSON.parse(body.text)
    } catch (error) {
      throw new ErpError('mapping_invalid', `The mapping text is not valid JSON: ${String(error?.message ?? error)}`)
    }
  }
  throw new ErpError('mapping_invalid', 'Send the mapping as `mapping` or as JSON `text`.')
}

/**
 * Admit one request the way the static index is admitted.
 * @param ctx - Plugin context.
 * @param req - Incoming request.
 * @returns The admitted peer, or undefined when the caller must sign in.
 */
function admit(ctx, req) {
  const connection = ctx.get('connection')
  if (connection === undefined) return undefined
  const identity = ctx.get('connectionIdentity')
  if (identity !== undefined) return connection.identityPeer?.(req)
  return connection.browserPeer
}

/**
 * Register the workbench API on the Host web server.
 * @param ctx - Host plugin context.
 * @returns A disposer, or a no-op when nothing serves HTTP.
 */
export function registerApi(ctx) {
  const server = ctx.get('webServer')
  if (server === undefined || typeof server.register !== 'function') return () => {}
  return server.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler(req, res) {
      void (async () => {
        try {
          if (admit(ctx, req) === undefined) {
            send(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Sign in to use the ERP workbench.' } })
            return
          }
          await dispatch(req, res)
        } catch (error) {
          if (error instanceof ErpError) {
            send(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
            return
          }
          send(res, 500, {
            ok: false,
            error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
          })
        }
      })()
    },
  })
}
