/** Read-only SQL gate for database sources: rejects writes, stacked statements, and comment tricks. */
import { AnalysisError } from './util.js'

const FORBIDDEN = [
  'insert', 'update', 'delete', 'merge', 'replace', 'upsert',
  'drop', 'alter', 'create', 'truncate', 'rename',
  'attach', 'detach', 'vacuum', 'reindex', 'pragma',
  'grant', 'revoke', 'call', 'exec', 'execute',
  'into\s+outfile', 'load_file', 'pg_sleep', 'benchmark', 'copy\s+',
  'set\s+', 'begin', 'commit', 'rollback', 'savepoint', 'lock\s+tables',
]

/**
 * Remove comments and string literals so keyword checks cannot be smuggled through them.
 * @param sql - Raw SQL.
 * @returns SQL with strings replaced by `''` and comments removed.
 */
function scrub(sql) {
  let output = ''
  let index = 0
  while (index < sql.length) {
    const char = sql[index]
    if (char === '-' && sql[index + 1] === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && sql[index + 1] === '*') {
      index += 2
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      output += "''"
      index += 1
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) index += 2
          else {
            index += 1
            break
          }
        } else {
          index += 1
        }
      }
      continue
    }
    output += char
    index += 1
  }
  return output
}

/**
 * Prove a statement is a single read-only SELECT.
 * @param sql - SQL from the model.
 * @returns The original SQL, trimmed, when it passes.
 */
export function assertReadOnlySql(sql) {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new AnalysisError('sql is required.', 'bad_sql')
  }
  const scrubbed = scrub(sql)
  const statements = scrubbed.split(';').filter(statement => statement.trim().length > 0)
  if (statements.length > 1) {
    throw new AnalysisError('Only one statement is allowed per query; stacked statements are rejected.', 'multi_statement')
  }
  const trimmed = sql.trim().replace(/;\s*$/, '')
  const head = scrubbed.trim().toLowerCase()
  if (!/^(select|with)\b/.test(head)) {
    throw new AnalysisError('Only read-only SELECT statements are allowed (a leading WITH clause is fine).', 'not_select')
  }
  for (const pattern of FORBIDDEN) {
    const expression = new RegExp(`(^|[^a-z0-9_])${pattern}`, 'i')
    if (expression.test(scrubbed)) {
      throw new AnalysisError(`The statement uses "${pattern.replaceAll('\\s+', ' ')}", which is not allowed on a read-only connection.`, 'write_attempt')
    }
  }
  return trimmed
}
