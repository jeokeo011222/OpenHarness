/**
 * Workspace-scoped source registry.
 *
 * Connections and REST sources used to live only in the plugin's `config`
 * block inside `cordis.yml`, which meant adding one required editing a file and
 * restarting. The workbench needs to add, test, and remove them while it runs,
 * so the editable copy lives in `<workspace>/.analysis/config.json` and the
 * `cordis.yml` values stay as read-only seeds for a deployment that wants to
 * ship defaults.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AnalysisError } from './util.js'
import { ANALYSIS_DIR } from './workspace.js'

/** Connection kinds the host can open. */
export const CONNECTION_KINDS = ['sqlite', 'postgres', 'mysql']

/** Port a network database listens on when the form leaves it blank. */
export const DEFAULT_PORTS = { postgres: 5432, mysql: 3306 }

/** File holding the workspace copy. */
const CONFIG_FILE = 'config.json'

/**
 * Read one port from the form, substituting the driver default.
 * @param value - Raw value from the browser.
 * @param kind - Connection kind, used for the default.
 * @returns A whole port number.
 */
function parsePort(value, kind) {
  const text = String(value ?? '').trim()
  if (text.length === 0) return DEFAULT_PORTS[kind]
  const port = Number(text)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AnalysisError('Port must be a whole number between 1 and 65535.', 'bad_connection')
  }
  return port
}

/**
 * Read a TLS preference from the form.
 * @param value - Raw value from the browser (`require` / `disable` / boolean).
 * @param fallback - Value to use when the form says nothing.
 * @returns `'require'` or `'disable'`.
 */
function parseSsl(value, fallback) {
  if (value === true || value === 'require' || value === 'on' || value === 'true') return 'require'
  if (value === false || value === 'disable' || value === 'off' || value === 'false') return 'disable'
  return fallback === 'require' ? 'require' : 'disable'
}

/**
 * Read the workspace registry, tolerating an absent or malformed file.
 * @param cwd - Absolute workspace root.
 * @returns `{ connections, sources }`, both possibly empty.
 */
export async function readConfig(cwd) {
  try {
    const text = await readFile(path.join(cwd, ANALYSIS_DIR, CONFIG_FILE), 'utf8')
    const parsed = JSON.parse(text)
    return {
      connections: Array.isArray(parsed.connections) ? parsed.connections : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    }
  } catch {
    return { connections: [], sources: [] }
  }
}

/**
 * Persist the workspace registry.
 * @param cwd - Absolute workspace root.
 * @param config - Whole registry.
 * @returns Nothing.
 */
async function writeConfig(cwd, config) {
  const directory = path.join(cwd, ANALYSIS_DIR)
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, CONFIG_FILE),
    `${JSON.stringify({ connections: config.connections, sources: config.sources }, null, 2)}\n`,
    'utf8',
  )
}

/**
 * Merge the deployment's config block with the workspace registry.
 *
 * Workspace entries win on id, so someone who edits a seeded connection from
 * the workbench keeps the edit across restarts.
 * @param runtime - `{ connections, sources }` from the plugin config.
 * @param workspace - `{ connections, sources }` from the workspace file.
 * @returns The effective lists.
 */
export function mergeConfig(runtime, workspace) {
  const byId = (left, right) => {
    const map = new Map()
    for (const entry of left ?? []) map.set(entry.id, entry)
    for (const entry of right ?? []) map.set(entry.id, entry)
    return [...map.values()]
  }
  return {
    connections: byId(runtime?.connections, workspace.connections),
    sources: byId(runtime?.sources, workspace.sources),
  }
}

/**
 * Strip the secret parts of a connection before it goes to the browser.
 *
 * The password never crosses the wire in either direction: reads report only
 * `hasPassword`, and an edit that leaves the field blank keeps the stored one.
 * @param connection - Stored connection.
 * @returns Connection with the password removed and `url` masked.
 */
export function redactConnection(connection) {
  const masked = { ...connection }
  if (typeof masked.password === 'string' && masked.password.length > 0) {
    masked.hasPassword = true
    delete masked.password
  }
  if (typeof masked.url === 'string' && masked.url.length > 0) masked.url = maskUrl(masked.url)
  return masked
}

/**
 * Replace the password (and query secrets) of a URL with asterisks.
 * @param url - Connection URL.
 * @returns Masked URL that still shows host and database.
 */
function maskUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.password.length > 0) parsed.password = '***'
    for (const key of ['password', 'token', 'apikey', 'apiKey', 'secret']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '***')
    }
    return parsed.toString()
  } catch {
    return '***'
  }
}

/**
 * Validate and normalize one connection from the browser.
 * @param input - Raw form values.
 * @param existing - Current entry with the same id, when editing.
 * @returns A connection safe to store.
 */
export function normalizeConnection(input, existing) {
  const kind = String(input.kind ?? existing?.kind ?? '').toLowerCase()
  if (!CONNECTION_KINDS.includes(kind)) {
    throw new AnalysisError(`Connection kind must be one of ${CONNECTION_KINDS.join(', ')}.`, 'bad_connection')
  }
  const label = String(input.label ?? input.name ?? existing?.label ?? '').trim()
  const id = String(input.id ?? existing?.id ?? `conn_${Date.now().toString(36)}`)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new AnalysisError('Connection ids may only contain letters, digits, underscore, and dash.', 'bad_connection')
  }
  const connection = { id, kind, ...(label.length > 0 ? { label } : {}) }
  if (kind === 'sqlite') {
    const filePath = String(input.path ?? existing?.path ?? '').trim()
    if (filePath.length === 0) throw new AnalysisError('A SQLite connection needs the database file path inside the workspace.', 'bad_connection')
    connection.path = filePath
    return connection
  }
  // Three ways to describe a network database, in order of explicitness:
  // a full URL (advanced), a host, port, user, password, and database form, or
  // the name of an environment variable holding the URL. A blank password while
  // editing keeps the stored one, because the browser only ever sees
  // `hasPassword` and never the secret itself.
  const url = String(input.url ?? '').trim()
  const urlEnv = String(input.urlEnv ?? existing?.urlEnv ?? '').trim()
  const host = String(input.host ?? existing?.host ?? '').trim()
  const user = String(input.user ?? existing?.user ?? '').trim()
  const database = String(input.database ?? existing?.database ?? '').trim()
  const ssl = parseSsl(input.ssl, existing?.ssl)
  if (url.length > 0) {
    connection.url = url
  } else if (host.length > 0) {
    if (user.length === 0) {
      throw new AnalysisError(`A ${kind} connection needs a user name, or a full connection URL.`, 'bad_connection')
    }
    connection.host = host
    connection.port = parsePort(input.port ?? existing?.port, kind)
    connection.user = user
    if (database.length > 0) connection.database = database
    const password = typeof input.password === 'string' ? input.password : ''
    if (password.length > 0) connection.password = password
    else if (typeof existing?.password === 'string' && existing.password.length > 0) connection.password = existing.password
    connection.ssl = ssl
  } else if (urlEnv.length > 0) {
    connection.urlEnv = urlEnv
  } else if (existing?.url !== undefined) {
    connection.url = existing.url
  } else {
    throw new AnalysisError(
      'A Postgres or MySQL connection needs a host, port, user, and password, a full connection URL, or the name of an environment variable holding one.',
      'bad_connection',
    )
  }
  return connection
}

/**
 * Validate and normalize one REST source from the browser.
 * @param input - Raw form values.
 * @param existing - Current entry with the same id, when editing.
 * @returns A source safe to store.
 */
export function normalizeSource(input, existing) {
  const id = String(input.id ?? existing?.id ?? `src_${Date.now().toString(36)}`)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new AnalysisError('Source ids may only contain letters, digits, underscore, and dash.', 'bad_source')
  }
  const baseUrl = String(input.baseUrl ?? existing?.baseUrl ?? '').trim()
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new AnalysisError('The API source needs a valid absolute base URL.', 'bad_source')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AnalysisError('Only http and https base URLs are supported.', 'bad_source')
  }
  const name = String(input.name ?? existing?.name ?? id).trim()
  const allowedHosts = Array.isArray(input.allowedHosts)
    ? input.allowedHosts.map(host => String(host).trim()).filter(host => host.length > 0)
    : (parsed.host.length > 0 ? [parsed.host] : [])
  const headers = input.headers !== null && typeof input.headers === 'object' ? input.headers : (existing?.headers ?? undefined)
  return {
    id,
    name,
    baseUrl,
    allowedHosts,
    ...(headers === undefined ? {} : { headers }),
    ...(typeof input.recordsPath === 'string' && input.recordsPath.length > 0 ? { recordsPath: input.recordsPath } : {}),
    ...(input.pagination !== null && typeof input.pagination === 'object' ? { pagination: input.pagination } : {}),
  }
}

/**
 * Insert or replace one connection.
 * @param cwd - Absolute workspace root.
 * @param input - Raw form values.
 * @returns The stored connection and the whole effective list.
 */
export async function upsertConnection(cwd, input) {
  const config = await readConfig(cwd)
  const index = config.connections.findIndex(entry => entry.id === input.id)
  const existing = index >= 0 ? config.connections[index] : undefined
  const connection = normalizeConnection(input, existing)
  if (index >= 0) config.connections[index] = connection
  else config.connections.push(connection)
  await writeConfig(cwd, config)
  return { connection, connections: config.connections }
}

/**
 * Remove one connection from the workspace registry.
 * @param cwd - Absolute workspace root.
 * @param id - Connection id.
 * @returns The remaining list.
 */
export async function removeConnection(cwd, id) {
  const config = await readConfig(cwd)
  config.connections = config.connections.filter(entry => entry.id !== id)
  await writeConfig(cwd, config)
  return config.connections
}

/**
 * Insert or replace one REST source.
 * @param cwd - Absolute workspace root.
 * @param input - Raw form values.
 * @returns The stored source and the whole list.
 */
export async function upsertSource(cwd, input) {
  const config = await readConfig(cwd)
  const index = config.sources.findIndex(entry => entry.id === input.id)
  const existing = index >= 0 ? config.sources[index] : undefined
  const source = normalizeSource(input, existing)
  if (index >= 0) config.sources[index] = source
  else config.sources.push(source)
  await writeConfig(cwd, config)
  return { source, sources: config.sources }
}

/**
 * Remove one REST source from the workspace registry.
 * @param cwd - Absolute workspace root.
 * @param id - Source id.
 * @returns The remaining list.
 */
export async function removeSource(cwd, id) {
  const config = await readConfig(cwd)
  config.sources = config.sources.filter(entry => entry.id !== id)
  await writeConfig(cwd, config)
  return config.sources
}
