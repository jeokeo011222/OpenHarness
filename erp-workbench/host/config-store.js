/**
 * Durable ERP workbench state: connections and the action-to-API mapping.
 *
 * One file under the harness home rather than the conversation workspace: an
 * ERP endpoint belongs to the deployment, not to the folder a conversation
 * happens to open. Secrets stay in that file and never travel back to the
 * browser — a response says `hasToken`/`hasAppSecret` instead.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ErpError, pickText, text } from './util.js'

/** Families this workbench can build an adapter for. */
export const FAMILIES = ['yonyou', 'kingdee']

/** Fields a connection carries, per family; secrets included. */
const PUBLIC_FIELDS = ['id', 'label', 'family', 'version', 'baseUrl', 'pathPrefix', 'appId', 'acctId', 'updatedAt']

/**
 * Directory holding the workbench store.
 * @returns Absolute path under the harness home.
 */
export function storeDir() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'erp')
}

/**
 * Path of the store file.
 * @returns Absolute path.
 */
export function storePath() {
  return path.join(storeDir(), 'config.json')
}

/** An empty store. */
function blankStore() {
  return { version: 1, connections: [], mapping: null }
}

/**
 * Read the store, tolerating a missing or unreadable file.
 *
 * A corrupt file is reported rather than silently replaced: losing a mapping an
 * operator spent an afternoon on is worse than an error message.
 * @returns Parsed store.
 */
export async function readStore() {
  let raw
  try {
    raw = await readFile(storePath(), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return blankStore()
    throw new ErpError('store_unreadable', `Cannot read ${storePath()}: ${String(error?.message ?? error)}`, 500)
  }
  try {
    const parsed = JSON.parse(raw)
    return {
      version: 1,
      connections: Array.isArray(parsed?.connections) ? parsed.connections : [],
      mapping: parsed?.mapping ?? null,
    }
  } catch {
    throw new ErpError('store_corrupt', `${storePath()} is not valid JSON; fix or delete it.`, 500)
  }
}

/**
 * Replace the store atomically, so a crash mid-write cannot truncate it.
 * @param store - Complete store to write.
 * @returns Nothing.
 */
export async function writeStore(store) {
  await mkdir(storeDir(), { recursive: true })
  const target = storePath()
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  await rename(temporary, target)
}

/**
 * One connection as the browser sees it: no token, no app secret.
 * @param connection - Stored connection.
 * @returns masked descriptor.
 */
export function publicConnection(connection) {
  const masked = {}
  for (const key of PUBLIC_FIELDS) {
    if (connection[key] !== undefined) masked[key] = connection[key]
  }
  masked.hasToken = typeof connection.token === 'string' && connection.token !== ''
  masked.hasAppSecret = typeof connection.appSecret === 'string' && connection.appSecret !== ''
  return masked
}

/**
 * Normalize one submitted connection, keeping stored secrets a blank field did
 * not replace.
 * @param body - Untrusted connection payload.
 * @param existing - Stored copy with the same id, when there is one.
 * @returns Complete stored connection.
 */
export function normalizeConnection(body, existing) {
  const id = text(body?.id) || `erp_${Date.now().toString(36)}`
  const family = text(body?.family, existing?.family ?? 'yonyou')
  if (!FAMILIES.includes(family)) {
    throw new ErpError('bad_family', `Unknown ERP family "${family}". Choose one of: ${FAMILIES.join(', ')}.`)
  }
  const baseUrl = text(body?.baseUrl, existing?.baseUrl ?? '')
  if (baseUrl === '') throw new ErpError('bad_connection', 'An ERP connection needs a base URL.')
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new ErpError('bad_connection', `"${baseUrl}" is not an absolute URL.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ErpError('bad_connection', 'The base URL must be http or https.')
  }

  const connection = {
    id,
    label: text(body?.label, existing?.label ?? '') || id,
    family,
    baseUrl: parsed.toString().replace(/\/$/, ''),
    updatedAt: new Date().toISOString(),
    ...pickText(body, ['version', 'pathPrefix', 'appId', 'acctId']),
  }
  if (connection.version !== undefined && !['v13', 'v15'].includes(connection.version)) {
    throw new ErpError('bad_connection', 'U8 version must be v13 or v15.')
  }
  // A blank secret means "keep the stored one": the browser never holds it.
  const token = typeof body?.token === 'string' ? body.token : ''
  if (token !== '') connection.token = token
  else if (existing?.token !== undefined) connection.token = existing.token
  const appSecret = typeof body?.appSecret === 'string' ? body.appSecret : ''
  if (appSecret !== '') connection.appSecret = appSecret
  else if (existing?.appSecret !== undefined) connection.appSecret = existing.appSecret

  if (family === 'yonyou' && (connection.token === undefined || connection.token === '')) {
    throw new ErpError('bad_connection', 'A Yonyou U8 connection needs an API token.')
  }
  if (family === 'kingdee') {
    const missing = ['appId', 'appSecret', 'acctId'].filter(key => connection[key] === undefined || connection[key] === '')
    if (missing.length > 0) {
      throw new ErpError('bad_connection', `A Kingdee connection needs ${missing.join(', ')}.`)
    }
  }
  return connection
}

/**
 * Insert or replace one connection.
 * @param store - Current store.
 * @param connection - Normalized connection.
 * @returns The updated store.
 */
export function withConnection(store, connection) {
  const kept = store.connections.filter(entry => entry.id !== connection.id)
  return { ...store, connections: [...kept, connection] }
}

/**
 * Drop one connection.
 * @param store - Current store.
 * @param id - Connection id.
 * @returns The updated store.
 */
export function withoutConnection(store, id) {
  return { ...store, connections: store.connections.filter(entry => entry.id !== id) }
}

/**
 * A summary of the stored mapping for the page header.
 * @param mapping - Stored mapping file, or null.
 * @returns counts and families, without the mapping body.
 */
export function mappingSummary(mapping) {
  if (mapping === null) return { configured: false, version: 0, count: 0, families: [], actions: [] }
  const mappings = Array.isArray(mapping.mappings) ? mapping.mappings : []
  return {
    configured: true,
    version: Number(mapping.version ?? 0),
    count: mappings.length,
    families: Array.from(new Set(mappings.map(entry => entry.erp))).sort(),
    actions: mappings.map(entry => ({
      domain: entry.domain,
      action: entry.action,
      erp: entry.erp,
      api: entry.api,
      params: Array.isArray(entry.params) ? entry.params.length : 0,
    })),
  }
}
