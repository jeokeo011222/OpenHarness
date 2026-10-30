/** Database sources: read-only SQLite locally, Postgres/MySQL through optional drivers. */
import { access } from 'node:fs/promises'
import path from 'node:path'
import { AnalysisError } from './util.js'
import { assertReadOnlySql } from './sql.js'

/** Hard cap on rows returned by one query. */
export const MAX_ROWS = 10_000
/** Default statement timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Look up a configured connection.
 * @param connections - Configured connection list.
 * @param id - Connection id from the tool call.
 * @returns The matching connection descriptor.
 */
export function findConnection(connections, id) {
  const connection = (connections ?? []).find(candidate => candidate.id === id)
  if (connection === undefined) {
    const known = (connections ?? []).map(candidate => candidate.id).join(', ') || '(none configured)'
    throw new AnalysisError(
      `Unknown connection "${id}". Configured connections: ${known}. Add one under the plugin's config.connections.`,
      'unknown_connection',
    )
  }
  return connection
}

/**
 * Resolve a connection URL from an environment variable, never from stored config.
 * @param connection - Connection descriptor.
 * @returns Connection string.
 */
function resolveConnectionUrl(connection) {
  if (typeof connection.urlEnv !== 'string' || connection.urlEnv.length === 0) {
    throw new AnalysisError(
      `Connection "${connection.id}" needs urlEnv naming an environment variable that holds its URL; secrets never live in config.`,
      'missing_credentials',
    )
  }
  const value = process.env[connection.urlEnv]
  if (value === undefined || value.length === 0) {
    throw new AnalysisError(`Environment variable "${connection.urlEnv}" is not set.`, 'missing_credentials')
  }
  return value
}

/**
 * Resolve and verify the SQLite file path inside the workspace.
 * @param connection - Connection descriptor.
 * @param cwd - Session workspace.
 * @returns Absolute database path.
 */
async function resolveSqlitePath(connection, cwd) {
  const raw = connection.path ?? connection.file
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AnalysisError(`SQLite connection "${connection.id}" needs a path.`, 'bad_connection')
  }
  const absolute = path.resolve(cwd, raw)
  try {
    await access(absolute)
  } catch {
    throw new AnalysisError(`SQLite file "${absolute}" does not exist inside the workspace.`, 'missing_database')
  }
  return absolute
}

/**
 * Convert driver values into JSON-safe scalars.
 * @param value - Raw driver value.
 * @returns JSON-safe value.
 */
function jsonSafe(value) {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value === undefined) return null
  if (value !== null && typeof value === 'object') return JSON.stringify(value)
  return value
}

/**
 * Infer column types from the first row.
 * @param columns - Column names.
 * @param rows - Result rows.
 * @returns Schema entries.
 */
function inferResultColumns(columns, rows) {
  return columns.map(name => {
    const probe = rows.find(row => row[name] !== null && row[name] !== undefined)
    const value = probe === undefined ? null : probe[name]
    const type = typeof value === 'number'
      ? (Number.isInteger(value) ? 'integer' : 'number')
      : typeof value === 'boolean'
        ? 'boolean'
        : 'string'
    return { name, type }
  })
}

/**
 * Open a SQLite database read-only.
 * @param connection - Connection descriptor.
 * @param cwd - Session workspace.
 * @returns `{ run, close }` bound to that database.
 */
async function openSqlite(connection, cwd) {
  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    throw new AnalysisError('This Node build has no `node:sqlite` module; upgrade Node to 22.5 or newer.', 'sqlite_unavailable')
  }
  const file = await resolveSqlitePath(connection, cwd)
  const database = new DatabaseSync(file, { readOnly: true })
  return {
    /**
     * @param sql - Read-only statement.
     * @returns Driver rows.
     */
    run(sql) {
      const statement = database.prepare(sql)
      return statement.all().map(row => {
        const clean = {}
        for (const [key, value] of Object.entries(row)) clean[key] = jsonSafe(value)
        return clean
      })
    },
    close() {
      database.close()
    },
  }
}

/**
 * Open a Postgres connection.
 * @param connection - Connection descriptor.
 * @param timeoutMs - Statement timeout.
 * @returns `{ run, close }`.
 */
async function openPostgres(connection, timeoutMs) {
  let pg
  try {
    pg = await import('pg')
  } catch {
    throw new AnalysisError('Postgres support needs the optional `pg` package in the profile; add it before using this connection.', 'driver_missing')
  }
  const url = resolveConnectionUrl(connection)
  const client = new (pg.default?.Client ?? pg.Client)({
    connectionString: url,
    statement_timeout: timeoutMs,
    connectionTimeoutMillis: timeoutMs,
  })
  await client.connect()
  return {
    async run(sql) {
      const result = await client.query(sql)
      return result.rows.map(row => {
        const clean = {}
        for (const [key, value] of Object.entries(row)) clean[key] = jsonSafe(value)
        return clean
      })
    },
    async close() {
      await client.end()
    },
  }
}

/**
 * Open a MySQL connection.
 * @param connection - Connection descriptor.
 * @param timeoutMs - Statement timeout.
 * @returns `{ run, close }`.
 */
async function openMysql(connection, timeoutMs) {
  let mysql
  try {
    mysql = await import('mysql2/promise')
  } catch {
    throw new AnalysisError('MySQL support needs the optional `mysql2` package in the profile; add it before using this connection.', 'driver_missing')
  }
  const url = resolveConnectionUrl(connection)
  const client = await mysql.createConnection({ uri: url, connectTimeout: timeoutMs })
  await client.query(`SET SESSION max_execution_time = ${Math.max(1000, Math.trunc(timeoutMs))}`)
  return {
    async run(sql) {
      const [rows] = await client.query(sql)
      return rows.map(row => {
        const clean = {}
        for (const [key, value] of Object.entries(row)) clean[key] = jsonSafe(value)
        return clean
      })
    },
    async close() {
      await client.end()
    },
  }
}

/**
 * Open a connection of the requested kind.
 * @param connection - Connection descriptor.
 * @param cwd - Session workspace.
 * @returns `{ run, close, kind }`.
 */
async function openConnection(connection, cwd) {
  const timeoutMs = Number(connection.timeoutMs) > 0 ? Number(connection.timeoutMs) : DEFAULT_TIMEOUT_MS
  if (connection.kind === 'sqlite') {
    return { ...(await openSqlite(connection, cwd)), kind: 'sqlite' }
  }
  if (connection.kind === 'postgres' || connection.kind === 'postgresql') {
    return { ...(await openPostgres(connection, timeoutMs)), kind: 'postgres' }
  }
  if (connection.kind === 'mysql') {
    return { ...(await openMysql(connection, timeoutMs)), kind: 'mysql' }
  }
  throw new AnalysisError(`Unsupported connection kind "${connection.kind}". Use sqlite, postgres, or mysql.`, 'bad_connection')
}

/**
 * Test that a connection opens and answers a trivial read.
 * @param connection - Connection descriptor.
 * @param cwd - Session workspace.
 * @returns Latency and the statement that succeeded.
 */
export async function testConnection(connection, cwd) {
  const started = Date.now()
  const handle = await openConnection(connection, cwd)
  try {
    await handle.run('SELECT 1 AS ok')
    return { connectionId: connection.id, kind: handle.kind, ok: true, elapsedMs: Date.now() - started }
  } finally {
    await handle.close()
  }
}

/**
 * List relations visible to a read-only connection.
 * @param connection - Connection descriptor.
 * @param cwd - Session workspace.
 * @returns Table and view names with their kind.
 */
export async function listObjects(connection, cwd) {
  const handle = await openConnection(connection, cwd)
  try {
    const sql = handle.kind === 'sqlite'
      ? "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
      : 'SELECT table_schema AS schema, table_name AS name, table_type AS type FROM information_schema.tables ORDER BY table_schema, table_name LIMIT 500'
    const rows = await handle.run(sql)
    return { connectionId: connection.id, kind: handle.kind, objects: rows }
  } finally {
    await handle.close()
  }
}

/**
 * Describe one table's columns.
 * @param connection - Connection descriptor.
 * @param cwd - Session workspace.
 * @param table - Table name from the model.
 * @returns Column descriptors.
 */
export async function describeTable(connection, cwd, table) {
  if (typeof table !== 'string' || !/^[A-Za-z0-9_$."\-]+$/.test(table)) {
    throw new AnalysisError(`"${table}" is not a plain table name.`, 'bad_table')
  }
  const handle = await openConnection(connection, cwd)
  try {
    if (handle.kind === 'sqlite') {
      const rows = await handle.run(`PRAGMA table_info(${JSON.stringify(table)})`)
      return {
        connectionId: connection.id,
        table,
        columns: rows.map(row => ({ name: row.name, type: row.type, nullable: row.notnull === 0, primaryKey: row.pk === 1 })),
      }
    }
    const rows = await handle.run(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '${table.replaceAll("'", "''")}' ORDER BY ordinal_position`,
    )
    return {
      connectionId: connection.id,
      table,
      columns: rows.map(row => ({ name: row.column_name, type: row.data_type, nullable: row.is_nullable === 'YES' })),
    }
  } finally {
    await handle.close()
  }
}

/**
 * Run one read-only statement.
 * @param connection - Connection descriptor.
 * @param cwd - Session workspace.
 * @param sql - Statement from the model.
 * @param maxRows - Row cap.
 * @returns Columns, rows, and timing.
 */
export async function runReadOnlyQuery(connection, cwd, sql, maxRows = 1000) {
  const statement = assertReadOnlySql(sql)
  const limit = Math.min(MAX_ROWS, Math.max(1, Math.trunc(maxRows)))
  const started = Date.now()
  const handle = await openConnection(connection, cwd)
  try {
    const rows = await handle.run(statement)
    const columns = inferResultColumns(rows.length > 0 ? Object.keys(rows[0]) : [], rows)
    const truncated = rows.length > limit
    return {
      connectionId: connection.id,
      columns,
      rows: rows.slice(0, limit).map(row => columns.map(column => row[column.name])),
      rowCount: rows.length,
      truncated,
      elapsedMs: Date.now() - started,
      ...(handle.kind === 'sqlite'
        ? { note: 'SQLite runs synchronously, so a statement timeout cannot interrupt it; keep statements narrow.' }
        : {}),
    }
  } finally {
    await handle.close()
  }
}

/**
 * Read a whole table into row objects for dataset import.
 * @param connection - Connection descriptor.
 * @param cwd - Session workspace.
 * @param table - Table name.
 * @param limit - Row cap.
 * @returns Column names and row objects.
 */
export async function readTable(connection, cwd, table, limit) {
  const result = await runReadOnlyQuery(connection, cwd, `SELECT * FROM ${quoteIdentifier(connection.kind, table)}`, limit)
  return result
}

/**
 * Quote a table identifier for a dialect.
 * @param kind - Connection kind.
 * @param table - Table name.
 * @returns Quoted identifier.
 */
function quoteIdentifier(kind, table) {
  if (typeof table !== 'string' || !/^[A-Za-z0-9_.$]+$/.test(table)) {
    throw new AnalysisError(`"${table}" is not a plain table name.`, 'bad_table')
  }
  return kind === 'mysql' ? `\`${table.replaceAll('.', '`.`')}\`` : table
}
