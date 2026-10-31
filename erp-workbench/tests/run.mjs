/**
 * Host-side checks for the ERP workbench: the connection store, the API routes
 * the page drives, and the secret handling that keeps tokens out of responses.
 *
 * Execute with `node erp-workbench/tests/run.mjs`.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'

const home = await mkdtemp(path.join(os.tmpdir(), 'erp-home-'))
process.env.DSH_HOME = home

const { API_PREFIX } = await import('../host/api.js')
const { registerApi } = await import('../host/api.js')
const { connectorStatus, validateMapping } = await import('../host/runtime.js')
const { normalizeConnection, publicConnection, storePath } = await import('../host/config-store.js')

const checks = []
/**
 * Record one assertion.
 * @param name - What is proven.
 * @param condition - Truthy when it holds.
 * @param detail - Evidence on failure.
 */
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail })
}

/** Build the cordis-like context the API mounts on. */
function strictContext(services) {
  const base = {
    /**
     * @param name - Service name.
     * @returns The service or undefined.
     */
    get(name) { return services[name] },
    /**
     * @param fn - Effect body.
     * @returns Its result.
     */
    effect(fn) { return fn() },
  }
  return new Proxy(base, {
    get(target, key, receiver) {
      if (typeof key === 'symbol' || key in target) return Reflect.get(target, key, receiver)
      throw new Error(`cannot get property "${String(key)}" without inject`)
    },
    has(target, key) { return key in target },
  })
}

/** One request the handler can read. */
function request(url, init = {}) {
  const payload = init.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(init.body), 'utf8')
  return {
    url,
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) yield payload
    },
  }
}

/** One response recorder. */
function response() {
  const box = { status: 0, body: '' }
  box.res = {
    /**
     * @param status - HTTP status.
     * @param headers - Headers, unused here.
     */
    writeHead(status, headers) { box.status = status; box.headers = headers },
    /**
     * @param chunk - Body.
     */
    end(chunk) { box.body = chunk ?? '' },
  }
  return box
}

const routes = []
const ctx = strictContext({
  webServer: {
    /**
     * @param route - Mounted route.
     * @returns A disposer.
     */
    register(route) { routes.push(route); return () => {} },
  },
  connection: {
    browserPeer: { id: 'browser', principal: { kind: 'owner' } },
    /**
     * No identity provider in this profile.
     * @returns Undefined.
     */
    identityPeer() { return undefined },
  },
})
const dispose = registerApi(ctx)
check('mounts one prefix route', routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === API_PREFIX)

/**
 * Drive one request through the mounted handler.
 * @param url - URL below the prefix.
 * @param init - Method and body.
 * @returns Parsed payload with its status.
 */
async function call(url, init) {
  const box = response()
  await routes[0].handler(request(API_PREFIX + url, init), box.res)
  for (let attempt = 0; attempt < 400 && box.status === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  let parsed
  try {
    parsed = JSON.parse(box.body)
  } catch {
    parsed = { raw: box.body }
  }
  return { status: box.status, ...parsed }
}

// --- secret handling -------------------------------------------------------

const saved = await call('/connections', {
  method: 'POST',
  body: { connection: { id: 'conn_u8', label: 'U8 生产', family: 'yonyou', version: 'v13', baseUrl: 'https://u8.example.com', token: 'tk-1' } },
})
const stored = JSON.parse(await readFile(storePath(), 'utf8')).connections[0]
check('saves a U8 connection with its token on disk',
  saved.status === 200 && stored.token === 'tk-1' && stored.baseUrl === 'https://u8.example.com',
  JSON.stringify(stored))
check('a stored token never comes back to the browser',
  saved.value.connection.token === undefined
    && saved.value.connection.hasToken === true
    && !JSON.stringify(saved).includes('tk-1'),
  JSON.stringify(saved.value.connection))

const edited = await call('/connections', {
  method: 'POST',
  body: { connection: { id: 'conn_u8', label: 'U8 生产', family: 'yonyou', version: 'v15', baseUrl: 'https://u8.example.com', token: '' } },
})
const editedStored = JSON.parse(await readFile(storePath(), 'utf8')).connections[0]
check('a blank token keeps the stored one and other fields still edit',
  edited.status === 200 && editedStored.token === 'tk-1' && editedStored.version === 'v15',
  JSON.stringify(editedStored))

const badUrl = await call('/connections', {
  method: 'POST',
  body: { connection: { id: 'conn_bad', family: 'yonyou', baseUrl: 'not-a-url', token: 'x' } },
})
check('a relative URL is refused', badUrl.status === 400 && badUrl.error.code === 'bad_connection', JSON.stringify(badUrl))

const badFamily = await call('/connections', {
  method: 'POST',
  body: { connection: { id: 'conn_bad', family: 'sap', baseUrl: 'https://sap.example.com', token: 'x' } },
})
check('an unknown ERP family is refused', badFamily.status === 400 && badFamily.error.code === 'bad_family', JSON.stringify(badFamily))

const missingSecret = await call('/connections', {
  method: 'POST',
  body: { connection: { id: 'conn_kd', family: 'kingdee', baseUrl: 'https://k3.example.com', appId: 'a' } },
})
check('a Kingdee connection without its secret is refused',
  missingSecret.status === 400 && missingSecret.error.code === 'bad_connection', JSON.stringify(missingSecret))

// --- state -----------------------------------------------------------------

const state = await call('/state')
check('state reports connections, the store path, and connector readiness',
  state.status === 200
    && state.value.connections.length === 1
    && state.value.connections[0].hasToken === true
    && typeof state.value.store === 'string'
    && typeof state.value.connector.ready === 'boolean',
  JSON.stringify(state.value))

// Readiness is judged on the exported surface, because the connector registers
// adapters per call: an importable module alone does not mean a usable build.
const connector = await connectorStatus()
check('the connector reports its adapters or a build instruction',
  connector.ready === true
    ? Array.isArray(connector.adapters)
      && connector.adapters.includes('YonyouU8Adapter')
      && connector.adapters.includes('KingdeeGalaxyAdapter')
    : typeof connector.error === 'string' && connector.error.includes('npm --prefix erp-connector run build'),
  JSON.stringify(connector))

// --- mapping ---------------------------------------------------------------

const emptyMapping = await call('/mappings', { method: 'POST', body: { text: '' } })
check('an empty mapping is refused', emptyMapping.status === 400 && emptyMapping.error.code === 'mapping_invalid', JSON.stringify(emptyMapping))

const brokenMapping = await call('/mappings', { method: 'POST', body: { text: '{"version":1,"mappings":[{"domain":"x"}]}' } })
check('a mapping missing required fields is refused by the connector schema',
  brokenMapping.status === 400 && brokenMapping.error.code === 'mapping_invalid',
  JSON.stringify(brokenMapping))

const example = await call('/mappings/example', { method: 'POST' })
check('the example mapping loads and is summarized',
  example.status === 200
    && example.value.mapping.configured === true
    && example.value.mapping.count >= 1
    && Array.isArray(example.value.mapping.actions),
  JSON.stringify(example))

const afterMapping = await call('/state')
check('the saved mapping is visible in state',
  afterMapping.value.mapping.configured === true && afterMapping.value.mapping.count === example.value.mapping.count,
  JSON.stringify(afterMapping.value.mapping))

// A mapping aimed at the other ERP must be refused for this connection rather
// than silently sent to the wrong system.
const mismatched = await call('/invoke', {
  method: 'POST',
  body: { connectionId: 'conn_u8', domain: 'contract', action: 'querySalesOrders', params: {} },
})
check('a mapping for another ERP family is refused',
  mismatched.status === 400 && mismatched.error.code === 'adapter_mismatch',
  JSON.stringify(mismatched))

const unknownAction = await call('/invoke', {
  method: 'POST',
  body: { connectionId: 'conn_u8', domain: 'contract', action: 'nope', params: {} },
})
check('an unmapped action is refused',
  unknownAction.status === 400 && unknownAction.error.code === 'mapping_not_found',
  JSON.stringify(unknownAction))

const unknownConnection = await call('/invoke', {
  method: 'POST',
  body: { connectionId: 'conn_ghost', domain: 'contract', action: 'queryPurchaseOrders', params: {} },
})
check('an unknown connection is refused with 404',
  unknownConnection.status === 404 && unknownConnection.error.code === 'connection_not_found',
  JSON.stringify(unknownConnection))

// --- one real call through a local ERP stand-in ------------------------------

// Everything above proves refusals. This proves the route the page actually
// uses: a stored mapping, a stored connection, one real HTTP request out.
const received = []
const erpServer = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ rows: [{ id: 'po-1' }] }))
  })
})
const erpPort = await new Promise((resolve, reject) => {
  erpServer.once('error', reject)
  erpServer.listen(0, '127.0.0.1', () => resolve(erpServer.address().port))
})

const localSaved = await call('/connections', {
  method: 'POST',
  body: { connection: { id: 'conn_local', label: 'U8 本地', family: 'yonyou', version: 'v13', baseUrl: `http://127.0.0.1:${erpPort}`, token: 'tk-local' } },
})
check('a connection can point at a local endpoint',
  localSaved.status === 200 && localSaved.value.connection.baseUrl === `http://127.0.0.1:${erpPort}`,
  JSON.stringify(localSaved))

const probed = await call('/connections/test', { method: 'POST', body: { connectionId: 'conn_local' } })
// A probe is a reachability check, so it must touch the host root and nothing
// else: testing a connection can never create or approve a business document.
check('testing a connection reaches the host root only, never a business API',
  probed.status === 200
    && probed.value.reachable === true
    && probed.value.status === 200
    && received.length === 1
    && received[0].method === 'GET'
    && received[0].url === '/',
  JSON.stringify({ probed, received }))
received.length = 0

const invoked = await call('/invoke', {
  method: 'POST',
  body: {
    connectionId: 'conn_local',
    domain: 'contract',
    action: 'queryPurchaseOrders',
    // Noon local time keeps the date transform timezone-independent.
    params: { region: '华北', status: '未交货', date: '2024-01-02T12:00:00' },
  },
})
check('an invoke transforms params, calls the ERP, and returns its payload',
  invoked.status === 200
    && invoked.value.request.params.cRegion === '华北'
    && invoked.value.request.params.cStatus === '0'
    && invoked.value.request.params.dDate === '20240102'
    && invoked.value.response.success === true
    && invoked.value.response.data.rows[0].id === 'po-1',
  JSON.stringify(invoked))
check('the outgoing ERP request carries the stored token, the mapped path, and no other field',
  received.length === 1
    && received[0].auth === 'Bearer tk-local'
    && received[0].url === '/apilink/u8api/Yonyou.U8.U9.PurchaseOrder.Query/Query'
    && received[0].body === JSON.stringify({ cRegion: '华北', cStatus: '0', dDate: '20240102' }),
  JSON.stringify(received))

await new Promise(resolve => erpServer.close(resolve))

// --- validation is shared with the connector ---------------------------------

let refusal
try {
  await validateMapping({ version: 1, mappings: [{ domain: 'd', action: 'a', erp: 'e', api: 'i' }] })
} catch (error) {
  refusal = error
}
check('the connector rejects a mapping entry with no params array',
  refusal !== undefined && refusal.code === 'mapping_invalid',
  refusal === undefined ? 'no refusal' : refusal.message)

// --- normalization ---------------------------------------------------------

check('connection normalization strips a trailing slash',
  normalizeConnection({ family: 'yonyou', baseUrl: 'https://u8.example.com/', token: 't' }).baseUrl === 'https://u8.example.com',
  normalizeConnection({ family: 'yonyou', baseUrl: 'https://u8.example.com/', token: 't' }).baseUrl)
check('a public connection never carries a secret',
  publicConnection({ id: 'x', token: 't', appSecret: 's' }).token === undefined
    && publicConnection({ id: 'x', token: 't', appSecret: 's' }).hasAppSecret === true,
  JSON.stringify(publicConnection({ id: 'x', token: 't', appSecret: 's' })))

// --- report ----------------------------------------------------------------

dispose()
await rm(home, { recursive: true, force: true })

let failures = 0
for (const entry of checks) {
  if (entry.ok) {
    console.log(`ok   ${entry.name}`)
  } else {
    failures += 1
    console.log(`FAIL ${entry.name}${entry.detail === undefined ? '' : ` — ${entry.detail}`}`)
  }
}
console.log(`\n${checks.length - failures}/${checks.length} erp workbench checks passed`)
if (failures > 0) process.exitCode = 1
