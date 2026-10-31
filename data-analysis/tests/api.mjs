/**
 * Regression checks for the workbench API mounted on the Host web server.
 *
 * The context handed to `registerApi` is a strict stand-in for cordis: reading a
 * service the plugin never injected throws the same
 * `cannot get property "X" without inject` error a real context throws. That is
 * the failure this file exists to catch — the API used to reach `ctx.connection`
 * directly, which answered every workbench request with a 500.
 *
 * Execute with `node tests/api.mjs`.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { crc32 } from 'node:zlib'
import { API_PREFIX, registerApi } from '../host/api.js'
import { composeConnectionUrl } from '../host/database.js'

const results = []
let failures = 0

/**
 * Record one assertion.
 * @param name - What is being proven.
 * @param condition - Truthy when the assertion holds.
 * @param detail - Evidence shown on failure.
 */
function check(name, condition, detail) {
  if (condition) {
    results.push({ ok: true, name })
  } else {
    failures += 1
    results.push({ ok: false, name, detail })
  }
}

/**
 * Build the cordis-like context the API is mounted on.
 *
 * Property reads that are not part of the stand-in throw, so any leftover
 * `ctx.<service>` access fails loudly instead of silently returning undefined.
 * @param services - Service table keyed by name.
 * @returns A context whose unknown properties throw.
 */
function strictContext(services) {
  const base = {
    /**
     * Resolve one mounted service.
     * @param name - Service name.
     * @returns The service, or undefined when the profile does not mount it.
     */
    get(name) {
      return services[name]
    },
    /**
     * Run a mount effect immediately, like an already-started plugin fiber.
     * @param fn - Effect body.
     * @returns Whatever the body returned.
     */
    effect(fn) {
      return fn()
    },
  }
  return new Proxy(base, {
    get(target, key, receiver) {
      if (typeof key === 'symbol' || key in target) return Reflect.get(target, key, receiver)
      throw new Error(`cannot get property "${String(key)}" without inject`)
    },
    has(target, key) {
      return key in target
    },
  })
}

/**
 * Compose a request the handler can read.
 * @param url - Request URL, query included.
 * @param init - Optional method and JSON body.
 * @returns A minimal `IncomingMessage` stand-in.
 */
function request(url, init = {}) {
  const method = init.method ?? 'GET'
  const payload = init.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(init.body), 'utf8')
  return {
    url,
    method,
    headers: { 'content-type': 'application/json' },
    /**
     * Yield the body in one chunk.
     * @returns Async iterator over the payload.
     */
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) yield payload
    },
  }
}

/**
 * Compose a response that records status and body.
 * @returns `{ status, body, res }`.
 */
function response() {
  const box = { status: 0, body: '', headers: {} }
  box.res = {
    /**
     * Record the status line.
     * @param status - HTTP status.
     * @param headers - Response headers.
     */
    writeHead(status, headers) {
      box.status = status
      box.headers = headers ?? {}
    },
    /**
     * Record the body.
     * @param chunk - Serialized payload.
     */
    end(chunk) {
      box.body = chunk ?? ''
    },
  }
  return box
}

/**
 * Read the recorded response as parsed JSON.
 * @param box - Response box.
 * @returns Parsed payload.
 */
function parse(box) {
  try {
    return JSON.parse(box.body)
  } catch {
    return { ok: false, error: { message: `unparseable body: ${box.body.slice(0, 120)}` } }
  }
}

const workspace = await mkdtemp(path.join(os.tmpdir(), 'da-api-'))
const otherDir = await mkdtemp(path.join(os.tmpdir(), 'da-api-other-'))
// The folder-less Session store lives under the harness home; pointing that at a
// temp directory keeps the check from writing into the real `~/.dsh`.
const dshHome = await mkdtemp(path.join(os.tmpdir(), 'da-home-'))
process.env.DSH_HOME = dshHome
const csvPath = path.join(workspace, 'sales.csv')
await writeFile(csvPath, '日期,区域,销售额\n2026-01-01,华北,1200\n2026-01-02,华东,900\n', 'utf8')

const routes = []
const services = {
  webServer: {
    /**
     * Record one route mount.
     * @param route - Route descriptor.
     * @returns A disposer.
     */
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  connection: {
    browserPeer: { id: 'browser', principal: { kind: 'owner' } },
    /**
     * No identity provider is mounted in this profile.
     * @returns Undefined.
     */
    identityPeer() {
      return undefined
    },
  },
  // A blank Session carries no cwd in its header; the Workspace registry still
  // knows its directory. `session_live` proves a real cwd wins over the registry.
  sessions: {
    get(id) {
      if (id === 'session_live') return { header: { id, cwd: otherDir } }
      if (id === 'session_no_cwd') return { header: { id } }
      return undefined
    },
  },
  workspaceRegistry: {
    list() {
      return [{ path: workspace, sessionIds: ['session_no_cwd', 'session_live'] }]
    },
  },
}

const ctx = strictContext(services)
const dispose = registerApi(ctx, { config: { connections: [], sources: [] }, queryCache: new Map() })

check('mounts one prefix route on the Host web server', routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === API_PREFIX)

/**
 * Wait until the handler writes its response.
 *
 * The mounted handler starts an async task and returns immediately, the way it
 * does on the real server.
 * @param box - Response box.
 * @returns The same box, once a status is recorded.
 */
async function settled(box) {
  for (let attempt = 0; attempt < 400 && box.status === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return box
}

/**
 * Drive one request through the mounted handler.
 * @param url - Request URL.
 * @param init - Optional method and body.
 * @returns Parsed payload with the recorded status.
 */
async function call(url, init) {
  const box = response()
  await routes[0].handler(request(url, init), box.res)
  await settled(box)
  return { status: box.status, ...parse(box) }
}

// Liveness answers before a workspace is known: it is how a caller finds out
// whether this plugin is served at all.
const health = await call(`${API_PREFIX}/health`)
check('health answers without a workspace', health.status === 200 && health.value?.status === 'ok', JSON.stringify(health))

const empty = await call(`${API_PREFIX}/state?cwd=${encodeURIComponent(workspace)}`)
check('state reads an empty workbench', empty.status === 200 && Array.isArray(empty.value?.datasets) && empty.value.datasets.length === 0, JSON.stringify(empty).slice(0, 300))

const imported = await call(`${API_PREFIX}/import?cwd=${encodeURIComponent(workspace)}`, { method: 'POST', body: { path: csvPath, name: '销售' } })
check('import reads a CSV into a dataset', imported.status === 200 && imported.value?.rowCount === 2, JSON.stringify(imported).slice(0, 300))

const chart = await call(`${API_PREFIX}/chart?cwd=${encodeURIComponent(workspace)}`, {
  method: 'POST',
  body: { datasetId: imported.value?.datasetId, x: { field: '区域' }, y: [{ field: '销售额', agg: 'sum' }], type: 'bar' },
})
check('chart composes and stores a spec', chart.status === 200 && typeof chart.value?.chartId === 'string', JSON.stringify(chart).slice(0, 300))

const after = await call(`${API_PREFIX}/state?cwd=${encodeURIComponent(workspace)}`)
check('state lists the new dataset and chart', after.value?.datasets?.length === 1 && after.value?.charts?.length === 1, JSON.stringify(after).slice(0, 300))

const missing = await call(`${API_PREFIX}/state`)
check('state without a workspace answers 400', missing.status === 400 && missing.error?.code === 'missing_workspace', JSON.stringify(missing))

// Sessions whose header has no cwd used to fail every request with the generic
// "needs a sessionId" error, which is what the workbench surfaced as
// "加载失败". The Workspace that owns the Session is the right answer instead.
const ownedByWorkspace = await call(`${API_PREFIX}/state?sessionId=session_no_cwd`)
check(
  'a Session without a cwd resolves through its Workspace',
  ownedByWorkspace.status === 200 && ownedByWorkspace.value?.datasets?.length === 1,
  JSON.stringify(ownedByWorkspace).slice(0, 300),
)

const liveCwd = await call(`${API_PREFIX}/state?sessionId=session_live`)
check(
  'a live Session cwd wins over the Workspace registry',
  liveCwd.status === 200 && liveCwd.value?.datasets?.length === 0,
  JSON.stringify(liveCwd).slice(0, 300),
)

// A conversation can exist without a folder at all: a preset shell, a project
// entry, a Session whose cwd was never bound. It used to answer 400 and the page
// showed "加载失败"; now it gets a private store under the harness home instead.
const unknownSession = await call(`${API_PREFIX}/state?sessionId=session_unknown`)
check(
  'a folder-less Session gets its own store under the harness home',
  unknownSession.status === 200
    && unknownSession.value?.scope?.detached === true
    && Array.isArray(unknownSession.value?.datasets)
    && unknownSession.value.datasets.length === 0,
  JSON.stringify(unknownSession).slice(0, 300),
)

const storeRoot = path.join(dshHome, 'data-analysis', 'sessions', 'session_unknown')
const storeUpload = await call(`${API_PREFIX}/upload?sessionId=session_unknown`, {
  method: 'POST',
  body: { filename: 'store.csv', dataBase64: Buffer.from('城市,销量\n上海,12\n', 'utf8').toString('base64') },
})
const stagedFiles = await readdir(path.join(storeRoot, '.analysis', 'tmp')).catch(() => [])
check(
  'the folder-less store accepts an uploaded file',
  storeUpload.status === 200
    && storeUpload.value?.rowCount === 1
    // The staged file carries a timestamp prefix; the dataset keeps the name the
    // reader picked instead of that prefix.
    && storeUpload.value?.name === 'store'
    && String(storeUpload.value?.staged ?? '').startsWith('.analysis/tmp/')
    && stagedFiles.length === 1,
  JSON.stringify({ ...storeUpload, stagedFiles }).slice(0, 300),
)

// The scope the page renders: a real folder is not detached, and the store is
// per Session, so two folder-less conversations never share datasets.
const scoped = await call(`${API_PREFIX}/state?cwd=${encodeURIComponent(workspace)}`)
check(
  'a real folder reports a non-detached scope',
  scoped.value?.scope?.detached === false && scoped.value.scope.path === path.resolve(workspace),
  JSON.stringify(scoped.value?.scope),
)
const otherStore = await call(`${API_PREFIX}/state?sessionId=session_other`)
check(
  'two folder-less Sessions do not share a store',
  otherStore.value?.scope?.path !== unknownSession.value?.scope?.path
    && otherStore.value.scope.path === path.join(dshHome, 'data-analysis', 'sessions', 'session_other'),
  JSON.stringify(otherStore.value?.scope),
)

const unknown = await call(`${API_PREFIX}/nope?cwd=${encodeURIComponent(workspace)}`)
check('unknown routes answer 404', unknown.status === 404 && unknown.error?.code === 'not_found', JSON.stringify(unknown))

// A network connection is saved from the host / port / user / password /
// database form, and the password never travels back to the browser.
const savedMysql = await call(`${API_PREFIX}/connections?cwd=${encodeURIComponent(workspace)}`, {
  method: 'POST',
  body: {
    connection: {
      id: 'conn_mysql', kind: 'mysql', label: '订单库',
      host: '10.0.0.9', port: 3307, user: 'shop', password: 's3cr@t', database: 'shop', ssl: 'require',
    },
  },
})
const listed = (savedMysql.value?.connections ?? []).find(entry => entry.id === 'conn_mysql')
check(
  'saves a MySQL connection from form fields',
  savedMysql.status === 200
    && listed !== undefined
    && listed.host === '10.0.0.9'
    && listed.port === 3307
    && listed.user === 'shop'
    && listed.database === 'shop'
    && listed.ssl === 'require'
    && listed.password === undefined
    && listed.hasPassword === true,
  JSON.stringify(savedMysql).slice(0, 400),
)

const edited = await call(`${API_PREFIX}/connections?cwd=${encodeURIComponent(workspace)}`, {
  method: 'POST',
  body: { connection: { id: 'conn_mysql', kind: 'mysql', host: '10.0.0.9', port: 3307, user: 'shop', database: 'warehouse', password: '', ssl: 'disable' } },
})
const storedFile = JSON.parse(await readFile(path.join(workspace, '.analysis', 'config.json'), 'utf8'))
const stored = storedFile.connections.find(entry => entry.id === 'conn_mysql')
check(
  'a blank password keeps the stored secret, other fields still edit',
  edited.status === 200 && stored?.password === 's3cr@t' && stored.database === 'warehouse' && stored.ssl === 'disable',
  JSON.stringify(stored),
)

const noUser = await call(`${API_PREFIX}/connections?cwd=${encodeURIComponent(workspace)}`, {
  method: 'POST',
  body: { connection: { id: 'conn_bad', kind: 'mysql', host: '10.0.0.9', user: '', database: 'shop' } },
})
check('a network connection without a user is rejected', noUser.status === 400 && noUser.error?.code === 'bad_connection', JSON.stringify(noUser))

// The dialog tests what is on screen, before it is saved.
const probe = await call(`${API_PREFIX}/connections/test?cwd=${encodeURIComponent(workspace)}`, {
  method: 'POST',
  body: { connection: { id: 'conn_probe', kind: 'mysql', host: '127.0.0.1', port: 1, user: 'shop', password: 'x', database: 'shop' } },
})
check('an unsaved form can be tested and reports the driver error', probe.status === 400 && probe.error?.code === 'connect_failed', JSON.stringify(probe).slice(0, 300))

check(
  'structured fields compose a masked-friendly URL',
  composeConnectionUrl({ id: 'x', kind: 'mysql', host: '10.0.0.9', port: 3307, user: 'shop', password: 's3cr@t', database: 'shop' })
    === 'mysql://shop:s3cr%40t@10.0.0.9:3307/shop',
  composeConnectionUrl({ id: 'x', kind: 'mysql', host: '10.0.0.9', port: 3307, user: 'shop', password: 's3cr@t', database: 'shop' }),
)
check(
  'Postgres defaults to 5432 and brackets IPv6 hosts',
  composeConnectionUrl({ id: 'x', kind: 'postgres', host: '::1', user: 'u', database: 'd' }) === 'postgres://u@[::1]:5432/d',
  composeConnectionUrl({ id: 'x', kind: 'postgres', host: '::1', user: 'u', database: 'd' }),
)

const dropped = await call(`${API_PREFIX}/connections?cwd=${encodeURIComponent(workspace)}&id=conn_mysql`, { method: 'DELETE' })
check('removing a connection hides it from state', dropped.status === 200 && (dropped.value?.connections ?? []).every(entry => entry.id !== 'conn_mysql'), JSON.stringify(dropped).slice(0, 200))

const signedOut = await (async () => {
  const bare = strictContext({ webServer: services.webServer })
  const otherRoutes = []
  services.webServer.register = route => {
    otherRoutes.push(route)
    return () => {}
  }
  registerApi(bare, { config: { connections: [], sources: [] }, queryCache: new Map() })
  const box = response()
  // A profile with no Connection service cannot admit anyone; the workbench must
  // answer 401 rather than throwing on the missing seat.
  await otherRoutes[0].handler(request(`${API_PREFIX}/state?cwd=${encodeURIComponent(workspace)}`), box.res)
  await settled(box)
  return { status: box.status, ...JSON.parse(box.body) }
})()
check('a profile without Connection answers 401', signedOut.status === 401 && signedOut.error?.code === 'unauthorized', JSON.stringify(signedOut))

// --- workbook worksheets ---------------------------------------------------
// A workbook is imported tab by tab: the dialog stages the bytes, lists the
// worksheets, then imports the ticked ones as separate datasets.

/**
 * Build an uncompressed zip archive, which is enough for the `.xlsx` reader.
 * @param files - Entry name → text.
 * @returns Archive bytes.
 */
function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const content = Buffer.from(text, 'utf8')
    const nameBuffer = Buffer.from(name, 'utf8')
    const checksum = crc32(content)
    const local = Buffer.alloc(30 + nameBuffer.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(content.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    nameBuffer.copy(local, 30)
    const central = Buffer.alloc(46 + nameBuffer.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(content.length, 20)
    central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBuffer.copy(central, 46)
    locals.push(local, content)
    centrals.push(central)
    offset += local.length + content.length
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}

const sheetXml = rows => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
const inlineRow = (index, cells) => `<row r="${index}">${cells.map((cell, position) => `<c r="${String.fromCharCode(65 + position)}${index}" t="inlineStr"><is><t>${cell}</t></is></c>`).join('')}</row>`
const numberRow = (index, cells) => `<row r="${index}">${cells.map((cell, position) => `<c r="${String.fromCharCode(65 + position)}${index}"><v>${cell}</v></c>`).join('')}</row>`
const bookBytes = makeZip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="明细" sheetId="1" r:id="rId1"/><sheet name="汇总" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': sheetXml(`${inlineRow(1, ['区域', '金额'])}${inlineRow(2, ['华北', '1'])}${numberRow(3, ['', 900])}`),
  'xl/worksheets/sheet2.xml': sheetXml(`${inlineRow(1, ['目标'])}${numberRow(2, [500])}`),
})
const bookPath = path.join(workspace, 'book.xlsx')
await writeFile(bookPath, bookBytes)

const sheetsListed = await call(`${API_PREFIX}/sheets?cwd=${encodeURIComponent(workspace)}&path=book.xlsx`)
check(
  'lists a workbook’s worksheets with row and column facts',
  sheetsListed.status === 200
    && sheetsListed.value?.sheets?.length === 2
    && sheetsListed.value.sheets[0].name === '明细'
    && sheetsListed.value.sheets[0].rows === 2
    && sheetsListed.value.sheets[1].columns === 1
    && sheetsListed.value.preferred === '明细',
  JSON.stringify(sheetsListed).slice(0, 400),
)

const stagedBook = await call(`${API_PREFIX}/upload?cwd=${encodeURIComponent(workspace)}`, {
  method: 'POST',
  body: { filename: 'book.xlsx', dataBase64: bookBytes.toString('base64'), stage: true },
})
check(
  'staging a workbook lists its worksheets without importing it',
  stagedBook.status === 200
    && typeof stagedBook.value?.staged === 'string'
    && stagedBook.value.sheets.length === 2
    && stagedBook.value.datasetId === undefined,
  JSON.stringify(stagedBook).slice(0, 400),
)

const beforeSheets = await call(`${API_PREFIX}/state?cwd=${encodeURIComponent(workspace)}`)
check(
  'a staged workbook adds no dataset yet',
  beforeSheets.value?.datasets?.length === 1,
  JSON.stringify(beforeSheets.value?.datasets?.map(entry => entry.name)),
)

const multi = await call(`${API_PREFIX}/import/sheets?cwd=${encodeURIComponent(workspace)}`, {
  method: 'POST',
  body: { path: stagedBook.value.staged, sheets: ['明细', '汇总'] },
})
check(
  'imports each ticked worksheet as its own dataset',
  multi.status === 200
    && multi.value?.datasets?.length === 2
    && multi.value.datasets[0].name.endsWith('· 明细')
    && multi.value.datasets[0].rowCount === 2
    && multi.value.datasets[1].name.endsWith('· 汇总')
    && multi.value.failures.length === 0,
  JSON.stringify(multi).slice(0, 400),
)

const afterSheets = await call(`${API_PREFIX}/state?cwd=${encodeURIComponent(workspace)}`)
check(
  'both worksheets show up in the workbench state',
  afterSheets.value?.datasets?.length === 3,
  JSON.stringify(afterSheets.value?.datasets?.map(entry => entry.name)),
)

const badSheet = await call(`${API_PREFIX}/import/sheets?cwd=${encodeURIComponent(workspace)}`, {
  method: 'POST',
  body: { path: 'book.xlsx', sheets: ['不存在'] },
})
check('an unknown worksheet is rejected by name', badSheet.status === 400 && badSheet.error?.code === 'missing_sheet', JSON.stringify(badSheet))

// Reading a database is the path the page had no entry for: save the
// connection, list its tables, read one table's columns, then import it as a
// dataset. SQLite keeps the check self-contained — no external server.
const { DatabaseSync } = await import('node:sqlite')
await mkdir(path.join(workspace, 'data'), { recursive: true })
const sqliteFile = path.join(workspace, 'data', 'app.db')
const sqlite = new DatabaseSync(sqliteFile)
sqlite.exec('CREATE TABLE orders (region TEXT, amount REAL, ordered_at TEXT)')
sqlite.exec("INSERT INTO orders VALUES ('华北', 120.5, '2026-01-02'), ('华东', 80, '2026-01-03'), ('华北', 40, '2026-01-04')")
sqlite.close()

const savedSqlite = await call(`${API_PREFIX}/connections?cwd=${encodeURIComponent(workspace)}`, {
  method: 'POST',
  body: { connection: { id: 'conn_sqlite', kind: 'sqlite', label: '本地库', path: 'data/app.db' } },
})
check('saves a SQLite connection by workspace-relative path',
  savedSqlite.status === 200 && (savedSqlite.value?.connections ?? []).some(entry => entry.id === 'conn_sqlite'),
  JSON.stringify(savedSqlite).slice(0, 300))

const listedTables = await call(`${API_PREFIX}/connections/tables?cwd=${encodeURIComponent(workspace)}`, {
  method: 'POST',
  body: { connectionId: 'conn_sqlite' },
})
check('lists the tables a connection exposes',
  listedTables.status === 200
    && (listedTables.value?.objects ?? []).some(entry => entry.name === 'orders'),
  JSON.stringify(listedTables).slice(0, 300))

const described = await call(`${API_PREFIX}/connections/describe?cwd=${encodeURIComponent(workspace)}`, {
  method: 'POST',
  body: { connectionId: 'conn_sqlite', table: 'orders' },
})
check('describes a table before importing it',
  described.status === 200
    && (described.value?.columns ?? []).map(column => column.name).join(',') === 'region,amount,ordered_at',
  JSON.stringify(described).slice(0, 300))

const tableImport = await call(`${API_PREFIX}/connections/import?cwd=${encodeURIComponent(workspace)}`, {
  method: 'POST',
  body: { connectionId: 'conn_sqlite', table: 'orders', name: '订单明细' },
})
check('imports a table as a dataset under the typed name',
  tableImport.status === 200
    && tableImport.value?.rowCount === 3
    && tableImport.value?.name === '订单明细'
    && tableImport.value?.source?.kind === 'database'
    && tableImport.value?.source?.detail?.table === 'orders',
  JSON.stringify(tableImport).slice(0, 300))

const afterDb = await call(`${API_PREFIX}/state?cwd=${encodeURIComponent(workspace)}`)
check('the imported table shows up in the dataset list',
  afterDb.value?.datasets?.some(entry => entry.id === tableImport.value?.datasetId),
  JSON.stringify(afterDb.value?.datasets ?? []).slice(0, 300))

const dbRows = await call(`${API_PREFIX}/rows?cwd=${encodeURIComponent(workspace)}&id=${encodeURIComponent(String(tableImport.value?.datasetId ?? ''))}&limit=5`)
check('the imported table carries its rows',
  dbRows.status === 200 && dbRows.value?.rows?.length === 3 && String(dbRows.value.rows[0].region) === '华北',
  JSON.stringify(dbRows).slice(0, 300))

dispose()
await rm(workspace, { recursive: true, force: true })

for (const entry of results) {
  if (entry.ok) {
    console.log(`ok   ${entry.name}`)
  } else {
    console.log(`FAIL ${entry.name}${entry.detail === undefined ? '' : ` — ${entry.detail}`}`)
  }
}
console.log(`\n${results.length - failures}/${results.length} api checks passed`)
if (failures > 0) process.exitCode = 1
