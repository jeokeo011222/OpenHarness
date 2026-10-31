/**
 * Public surface of the ontology object layer.
 *
 * The injector, the agent tools, and the operator CLI all go through this
 * barrel, so the SQL and the action rules stay behind one boundary.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { objectDatabaseAt } from './db.ts'

export { OBJECT_SCHEMA_VERSION, ObjectDatabase, forgetObjectDatabase, objectDatabaseAt, objectIdOf, parseObjectId } from './db.ts'
export { parseCsv } from './csv.ts'
export { syncObjectType } from './sync.ts'
export type { SyncOptions } from './sync.ts'
export { aggregateObjects, clampLimit, getObject, searchObjects, traverseLinks } from './query.ts'
export { commitProposal, decideProposal, proposeAction } from './actions.ts'
export type { ProposeInput } from './actions.ts'
export { registerObjectTools } from './tools.ts'
export type { ObjectToolOptions } from './tools.ts'
export type * from './types.ts'

/**
 * Render the one-line object index injected at the start of a turn.
 *
 * The vocabulary summary says what the domain *means*; this line says what the
 * domain can actually be *asked* and *changed*, which is what decides whether a
 * model reaches for a tool or invents an answer.
 * @param storePath - ontology root holding `objects.db`.
 * @param domain - business domain id.
 * @returns one line, or an empty string when nothing is bound and no action exists.
 */
export function objectIndexLine(storePath: string, domain: string): string {
  // The prompt path must never create the object database: an unbound store
  // simply contributes no line.
  if (!existsSync(join(storePath, 'objects.db'))) return ''
  const db = objectDatabaseAt(storePath)
  const types = db.listObjectTypes(domain)
  const actions = db.listActionTypes(domain)
  if (types.length === 0 && actions.length === 0) return ''
  const typePart = types.length === 0
    ? '尚未绑定对象类型'
    : types
      .map(item => `${item.objectType}（${item.rowCount} 条，主键 ${item.primaryKey}）`)
      .join('、')
  const actionPart = actions.length === 0
    ? '无可用动作'
    : actions.map(item => item.actionId).join('、')
  return `可查对象：${typePart}；可执行动作：${actionPart}。用 list_object_types / search_objects 读取对象，propose_action 提出变更（需人工批准后 commit_action 才执行）。`
}
