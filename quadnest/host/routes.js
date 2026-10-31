/**
 * Authenticated browser routes for QuadNest.
 *
 * Four exact routes — readiness for the world's default model, one visitor
 * message, one unsolicited companion turn after the visitor goes quiet, and a
 * world reset that clears every companion's live memory — mount
 * on the web server itself. They sit in front of Client Connection's `/api`
 * prefix, so they call that service's own admission check first: the Host and
 * Origin fence plus a signed browser session, with local accounts admitted the
 * same way as the process owner. The routes delegate all companion work to the
 * host pool and only translate failures into responses.
 *
 * @module dsh-quadnest/host/routes
 */

import { QuadNestError } from './pool.js'
import { resolveChatTarget } from './protocol.js'

/** Route that reports model readiness. */
const STATUS_PATH = '/api/quadnest/status'
/** Route that runs one visitor message. */
const SAY_PATH = '/api/quadnest/say'
/** Route that lets a companion open a conversation after the visitor is quiet. */
const IDLE_PATH = '/api/quadnest/idle'
/** Route that disposes every companion. */
const RESET_PATH = '/api/quadnest/reset'
/** Route that reads what a companion remembers. */
const MEMORY_PATH = '/api/quadnest/memory'
/** Route that answers on-demand recall for one companion. */
const RECALL_PATH = '/api/quadnest/memory/recall'
/** Largest accepted request body, in UTF-16 code units. */
const MAX_BODY_CHARS = 24_000

/**
 * Register QuadNest's browser routes on the host web server.
 * @param ctx - Host context carrying the connection and web-server services.
 * @param pool - companion pool that owns the Agents.
 */
export function registerRoutes(ctx, pool) {
  const routes = [
    { path: STATUS_PATH, method: 'GET', handle: (_req, res) => statusRoute(pool, res) },
    {
      path: SAY_PATH,
      method: 'POST',
      handle: (req, res) => turnRoute(req, res, (payload, signal) => pool.say({
        target: payload.target,
        text: payload.text,
        world: payload.world,
        // The browser mints one id per turn so its reply can be matched back to
        // the question that caused it; the host only echoes it.
        turnId: payload.turnId,
        signal,
      })),
    },
    {
      path: IDLE_PATH,
      method: 'POST',
      handle: (req, res) => turnRoute(req, res, (payload, signal) => pool.idle({
        target: payload.target,
        world: payload.world,
        turnId: payload.turnId,
        // The browser owns the clock and the composer, so it reports both: the
        // gate decides, but it cannot know how long the visitor has been quiet
        // or whether they are mid-sentence without being told.
        quietMs: payload.quietMs,
        enabled: payload.enabled !== false,
        drafting: payload.drafting === true,
        busy: payload.busy === true,
        signal,
      })),
    },
    { path: RESET_PATH, method: 'POST', handle: (req, res) => resetRoute(pool, req, res) },
    { path: MEMORY_PATH, method: 'GET', handle: (req, res) => memoryRoute(pool, req, res) },
    {
      path: RECALL_PATH,
      method: 'POST',
      handle: (req, res) => turnRoute(req, res, (payload) => recallRoute(pool, payload)),
    },
  ]
  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: route.path,
      // Carried for introspection: the mounted table then states which method
      // each path answers, instead of leaving it implied by the handler body.
      method: route.method,
      handler: (req, res) => {
        // Exact routes bypass the `/api` prefix, so this route owns the same
        // admission decision: the Host/Origin fence and a live signed session.
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        if (req.method !== route.method) {
          res.writeHead(405, { allow: route.method, 'cache-control': 'no-store' })
          res.end()
          return
        }
        return route.handle(req, res)
      },
    }), `quadnest: ${route.method} ${route.path}`)
  }
}

/**
 * Report whether a companion can answer and which model would answer.
 * @param pool - companion pool that owns the Agents.
 * @param res - response owned to completion.
 */
function statusRoute(pool, res) {
  sendJson(res, 200, pool.status())
}

/**
 * Read what one companion remembers, or the per-target counts when no target
 * is named.
 * @param pool - companion pool that owns the memory.
 * @param req - admitted browser request; `?target=` selects one companion.
 * @param res - response owned to completion.
 */
function memoryRoute(pool, req, res) {
  const url = new URL(req.url ?? MEMORY_PATH, 'http://localhost')
  const raw = url.searchParams.get('target')
  const summary = pool.memorySummary()
  if (raw === null || raw.trim() === '') {
    sendJson(res, 200, { summary })
    return
  }
  const target = resolveChatTarget(raw)
  if (target === undefined) {
    sendFailure(res, 400, 'invalid-target', 'Choose a companion or the group chat.')
    return
  }
  sendJson(res, 200, { target, layers: pool.memoryOf(target), summary })
}

/**
 * Answer one on-demand recall: what would this companion be reminded of by these
 * words? The same call the turn prompt uses, so the page and the model agree.
 * @param pool - companion pool that owns the memory.
 * @param payload - `{ target, query }`.
 * @returns the recalled layers and the prompt lines they render to.
 */
function recallRoute(pool, payload) {
  const target = resolveChatTarget(payload.target)
  if (target === undefined) throw new QuadNestError('invalid-target', 'Choose a companion or the group chat.', 400)
  const query = typeof payload.query === 'string' ? payload.query : ''
  const recalled = pool.recall(target, query)
  return { target, query, lines: recalled.lines, layers: recalled.layers }
}

/**
 * Run one JSON-bodied turn request from an admitted browser request.
 * @param req - the browser request carrying `{ target, world }` and, for chat, `text`.
 * @param res - response owned to completion.
 * @param run - turn runner receiving the parsed payload and the abort signal.
 * @returns fulfillment after the response is written.
 */
async function turnRoute(req, res, run) {
  let raw
  try {
    raw = await readBody(req)
  } catch (error) {
    if (res.writableEnded || res.destroyed) return
    sendFailure(res, 400, 'invalid-body', error instanceof Error ? error.message : String(error))
    return
  }
  if (raw.length > MAX_BODY_CHARS) {
    sendFailure(res, 413, 'body-too-large', `Request bodies are limited to ${MAX_BODY_CHARS} characters.`)
    return
  }
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    sendFailure(res, 400, 'invalid-json', 'Request body must be JSON.')
    return
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    sendFailure(res, 400, 'invalid-json', 'Request body must be a JSON object.')
    return
  }
  const controller = new AbortController()
  const onClose = () => {
    if (!res.writableEnded) controller.abort()
  }
  res.once('close', onClose)
  try {
    const result = await run(payload, controller.signal)
    sendJson(res, 200, result)
  } catch (error) {
    if (controller.signal.aborted) {
      if (!res.writableEnded) res.writeHead(499, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (error instanceof QuadNestError) {
      sendFailure(res, error.status, error.code, error.message)
      return
    }
    const message = error instanceof Error && error.message !== '' ? error.message : String(error)
    sendFailure(res, 502, 'turn-failed', message)
  } finally {
    res.off('close', onClose)
  }
}

/**
 * Dispose every companion so the next message starts from a clean world.
 * @param pool - companion pool that owns the Agents.
 * @param req - admitted browser request.
 * @param res - response owned to completion.
 * @returns fulfillment after the response is written.
 */
async function resetRoute(pool, req, res) {
  try {
    await pool.reset()
    sendJson(res, 200, { ok: true })
  } catch (error) {
    const message = error instanceof Error && error.message !== '' ? error.message : String(error)
    sendFailure(res, 502, 'reset-failed', message)
  }
}

/**
 * Read one request body, stopping once it passes the accepted size.
 * @param req - request whose body is read once.
 * @returns the decoded body text; longer than {@link MAX_BODY_CHARS} when the cap was hit.
 */
async function readBody(req) {
  const chunks = []
  let length = 0
  for await (const chunk of req) {
    length += chunk.length
    chunks.push(chunk)
    if (length > MAX_BODY_CHARS) break
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Write one successful no-store JSON response.
 * @param res - response owned to completion.
 * @param status - HTTP status.
 * @param value - body to serialize.
 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Write one JSON failure response.
 * @param res - response owned to completion.
 * @param status - HTTP status.
 * @param code - stable machine-readable reason.
 * @param message - human-readable explanation.
 */
function sendFailure(res, status, code, message) {
  sendJson(res, status, { error: { code, message } })
}
