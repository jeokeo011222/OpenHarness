/**
 * SQLite store for the ontology object layer.
 *
 * The T-Box keeps living in Turtle, because a vocabulary is a small graph that
 * is rewritten wholesale and read as text. Objects are the opposite: hundreds
 * of thousands of flat rows that must be filtered, paged, and updated in place,
 * so they live in a relational table instead of the quad store.
 *
 * One file (`<root>/objects.db`) holds every domain: object type bindings,
 * link types, action types, synced rows, sync runs, and action proposals.
 * Bindings and rows share a transaction boundary, which is what makes a sync
 * run atomic — a reader never observes half of one.
 */

import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type {
  ActionProposal,
  ActionTypeBinding,
  AggregateResult,
  LinkTypeBinding,
  ObjectFilter,
  ObjectRecord,
  ObjectTypeBinding,
  ObjectTypeSummary,
  ProposalStatus,
  SyncRunRecord,
} from './types.ts'

/** Durable schema version for `objects.db`, bumped on incompatible changes. */
export const OBJECT_SCHEMA_VERSION = 1

/** Database file name inside the ontology root. */
const FILE_NAME = 'objects.db'

/** Field names must be safe to embed as a JSON path literal. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Open databases, keyed by ontology root. */
const openDatabases = new Map<string, ObjectDatabase>()

/** One column of a `SELECT` projection over a stored record. */
interface RowShape {
  readonly object_id: string
  readonly object_type: string
  readonly data: string
  readonly synced_at: string
  readonly run_id: string
}

/**
 * Build the stable object id from its three parts.
 * @param domain - business domain id.
 * @param objectType - object type id.
 * @param primaryKey - business key value.
 * @returns the id every tool, proposal, and audit entry refers to.
 */
export function objectIdOf(domain: string, objectType: string, primaryKey: string): string {
  return `${domain}:${objectType}:${primaryKey}`
}

/**
 * Split an object id back into its parts.
 * @param id - an id produced by {@link objectIdOf}.
 * @returns the parts, or `undefined` when the id is malformed.
 */
export function parseObjectId(id: string): { domain: string; objectType: string; primaryKey: string } | undefined {
  const first = id.indexOf(':')
  const second = id.indexOf(':', first + 1)
  if (first <= 0 || second <= first + 1 || second === id.length - 1) return undefined
  return {
    domain: id.slice(0, first),
    objectType: id.slice(first + 1, second),
    primaryKey: id.slice(second + 1),
  }
}

/**
 * Reject a field name that cannot be embedded in a JSON path.
 * @param name - declared or caller-supplied field name.
 * @returns the name, unchanged, when it is safe.
 */
function safeField(name: string): string {
  if (!FIELD_NAME.test(name)) throw new Error(`Invalid object field name: ${name}`)
  return name
}

/** One SQL comparison built from a filter clause. */
interface WhereClause {
  readonly sql: string
  readonly values: readonly (string | number)[]
}

/**
 * Compile one filter against a declared field.
 *
 * The field is validated against the binding before it reaches a JSON path, and
 * every value is bound as a parameter, so a caller can neither escape the path
 * nor the predicate.
 * @param filter - caller-supplied clause.
 * @param fields - field names the object type declares.
 * @returns the SQL fragment and its bound values.
 */
function compileFilter(filter: ObjectFilter, fields: ReadonlySet<string>): WhereClause {
  if (!fields.has(filter.property)) {
    throw new Error(`Unknown object field: ${filter.property}`)
  }
  const path = `'$.${safeField(filter.property)}'`
  const value = filter.value
  switch (filter.op) {
    case 'exists':
      return { sql: `json_extract(data, ${path}) IS NOT NULL`, values: [] }
    case 'missing':
      return { sql: `json_extract(data, ${path}) IS NULL`, values: [] }
    case 'contains':
      return { sql: `CAST(json_extract(data, ${path}) AS TEXT) LIKE ?`, values: [`%${value ?? ''}%`] }
    case 'eq':
      return { sql: `CAST(json_extract(data, ${path}) AS TEXT) = ?`, values: [value ?? ''] }
    case 'neq':
      return { sql: `CAST(json_extract(data, ${path}) AS TEXT) IS NOT ?`, values: [value ?? ''] }
    case 'gt':
      return { sql: `CAST(json_extract(data, ${path}) AS REAL) > ?`, values: [Number(value ?? '0')] }
    case 'gte':
      return { sql: `CAST(json_extract(data, ${path}) AS REAL) >= ?`, values: [Number(value ?? '0')] }
    case 'lt':
      return { sql: `CAST(json_extract(data, ${path}) AS REAL) < ?`, values: [Number(value ?? '0')] }
    case 'lte':
      return { sql: `CAST(json_extract(data, ${path}) AS REAL) <= ?`, values: [Number(value ?? '0')] }
    case 'in': {
      const items = (value ?? '').split(',').map(item => item.trim()).filter(item => item.length > 0)
      if (items.length === 0) return { sql: '0 = 1', values: [] }
      return {
        sql: `CAST(json_extract(data, ${path}) AS TEXT) IN (${items.map(() => '?').join(', ')})`,
        values: items,
      }
    }
    default: {
      const unreachable: never = filter.op
      throw new Error(`Unsupported filter operator: ${String(unreachable)}`)
    }
  }
}

/** Storage for the object layer of one ontology root. */
export class ObjectDatabase {
  private readonly db: DatabaseSync

  /**
   * Open (and on first use initialise) the object database.
   * @param root - ontology store root; the file is created under it.
   */
  constructor(root: string) {
    const file = `${root}/${FILE_NAME}`.replace(/\\/g, '/')
    mkdirSync(root, { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  /** Create every table and record the schema version. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS object_type (
        domain TEXT NOT NULL,
        object_type TEXT NOT NULL,
        label TEXT NOT NULL,
        primary_key TEXT NOT NULL,
        label_field TEXT,
        updated_at_field TEXT,
        datasource_kind TEXT NOT NULL,
        datasource TEXT NOT NULL,
        fields TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (domain, object_type)
      );
      CREATE TABLE IF NOT EXISTS object_row (
        domain TEXT NOT NULL,
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        pk TEXT NOT NULL,
        data TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        run_id TEXT NOT NULL,
        PRIMARY KEY (domain, object_type, object_id)
      );
      CREATE INDEX IF NOT EXISTS object_row_key ON object_row (domain, object_type, pk);
      CREATE TABLE IF NOT EXISTS link_type (
        domain TEXT NOT NULL,
        link_id TEXT NOT NULL,
        label TEXT NOT NULL,
        from_type TEXT NOT NULL,
        to_type TEXT NOT NULL,
        from_property TEXT NOT NULL,
        to_property TEXT NOT NULL,
        PRIMARY KEY (domain, link_id)
      );
      CREATE TABLE IF NOT EXISTS action_type (
        domain TEXT NOT NULL,
        action_id TEXT NOT NULL,
        label TEXT NOT NULL,
        target_type TEXT NOT NULL,
        parameters TEXT NOT NULL,
        preconditions TEXT NOT NULL,
        effects TEXT NOT NULL,
        approval TEXT NOT NULL,
        PRIMARY KEY (domain, action_id)
      );
      CREATE TABLE IF NOT EXISTS sync_run (
        run_id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        object_type TEXT NOT NULL,
        mode TEXT NOT NULL,
        read_count INTEGER NOT NULL,
        inserted INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        skipped INTEGER NOT NULL,
        watermark TEXT,
        failed_reason TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS action_proposal (
        proposal_id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        action_id TEXT NOT NULL,
        action_label TEXT NOT NULL,
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        object_label TEXT NOT NULL,
        params TEXT NOT NULL,
        status TEXT NOT NULL,
        before_data TEXT NOT NULL,
        after_data TEXT NOT NULL,
        changes TEXT NOT NULL,
        violations TEXT NOT NULL,
        impacts TEXT NOT NULL,
        deferred TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        committed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS action_proposal_status ON action_proposal (domain, status);
    `)
    this.db.exec(`PRAGMA user_version = ${OBJECT_SCHEMA_VERSION}`)
  }

  /** Close the handle; the next access reopens it. */
  close(): void {
    this.db.close()
  }

  /**
   * Create or replace one object type binding.
   * @param binding - the deployment half of one class.
   */
  upsertObjectType(binding: ObjectTypeBinding): void {
    const datasource = JSON.stringify(binding.datasource)
    this.db.prepare(`
      INSERT INTO object_type
        (domain, object_type, label, primary_key, label_field, updated_at_field, datasource_kind, datasource, fields, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (domain, object_type) DO UPDATE SET
        label = excluded.label,
        primary_key = excluded.primary_key,
        label_field = excluded.label_field,
        updated_at_field = excluded.updated_at_field,
        datasource_kind = excluded.datasource_kind,
        datasource = excluded.datasource,
        fields = excluded.fields,
        updated_at = excluded.updated_at
    `).run(
      binding.domain,
      binding.objectType,
      binding.label,
      binding.primaryKey,
      binding.labelField ?? null,
      binding.updatedAtField ?? null,
      binding.datasource.kind,
      datasource,
      JSON.stringify(binding.fields),
      new Date().toISOString(),
    )
  }

  /**
   * Read one binding.
   * @param domain - business domain id.
   * @param objectType - object type id.
   * @returns the binding, or `undefined` when the type is not bound.
   */
  readObjectType(domain: string, objectType: string): ObjectTypeBinding | undefined {
    const row = this.db.prepare(
      'SELECT * FROM object_type WHERE domain = ? AND object_type = ?',
    ).get(domain, objectType) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return this.toBinding(row)
  }

  /** Convert one stored row into a binding. */
  private toBinding(row: Record<string, unknown>): ObjectTypeBinding {
    const labelField = row['label_field']
    const updatedAtField = row['updated_at_field']
    const datasource = JSON.parse(String(row['datasource'])) as ObjectTypeBinding['datasource']
    return {
      domain: String(row['domain']),
      objectType: String(row['object_type']),
      label: String(row['label']),
      primaryKey: String(row['primary_key']),
      ...(typeof labelField === 'string' && labelField.length > 0 ? { labelField } : {}),
      ...(typeof updatedAtField === 'string' && updatedAtField.length > 0 ? { updatedAtField } : {}),
      datasource,
      fields: JSON.parse(String(row['fields'])) as ObjectTypeBinding['fields'],
    }
  }

  /**
   * List the object types bound in one domain.
   * @param domain - business domain id.
   * @returns one summary per type, ordered by id.
   */
  listObjectTypes(domain: string): ObjectTypeSummary[] {
    const rows = this.db.prepare(`
      SELECT t.*, (
        SELECT COUNT(*) FROM object_row r
        WHERE r.domain = t.domain AND r.object_type = t.object_type
      ) AS row_count,
      (
        SELECT MAX(r.synced_at) FROM object_row r
        WHERE r.domain = t.domain AND r.object_type = t.object_type
      ) AS last_synced_at
      FROM object_type t
      WHERE t.domain = ?
      ORDER BY t.object_type
    `).all(domain) as Record<string, unknown>[]
    return rows.map((row) => {
      const lastSynced = row['last_synced_at']
      return {
        domain: String(row['domain']),
        objectType: String(row['object_type']),
        label: String(row['label']),
        primaryKey: String(row['primary_key']),
        fieldCount: (JSON.parse(String(row['fields'])) as unknown[]).length,
        rowCount: Number(row['row_count'] ?? 0),
        lastSyncedAt: typeof lastSynced === 'string' ? lastSynced : null,
        datasourceKind: String(row['datasource_kind']),
      }
    })
  }

  /**
   * Drop one object type, its rows, and its sync runs.
   * @param domain - business domain id.
   * @param objectType - object type id.
   * @returns the number of rows removed.
   */
  deleteObjectType(domain: string, objectType: string): number {
    const removed = this.db.prepare(
      'DELETE FROM object_row WHERE domain = ? AND object_type = ?',
    ).run(domain, objectType)
    this.db.prepare('DELETE FROM object_type WHERE domain = ? AND object_type = ?').run(domain, objectType)
    this.db.prepare('DELETE FROM sync_run WHERE domain = ? AND object_type = ?').run(domain, objectType)
    return Number(removed.changes)
  }

  /**
   * Create or replace one link type.
   * @param binding - how two object types join.
   */
  upsertLinkType(binding: LinkTypeBinding): void {
    this.db.prepare(`
      INSERT INTO link_type (domain, link_id, label, from_type, to_type, from_property, to_property)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (domain, link_id) DO UPDATE SET
        label = excluded.label,
        from_type = excluded.from_type,
        to_type = excluded.to_type,
        from_property = excluded.from_property,
        to_property = excluded.to_property
    `).run(
      binding.domain,
      binding.linkId,
      binding.label,
      binding.fromType,
      binding.toType,
      binding.fromProperty,
      binding.toProperty,
    )
  }

  /**
   * List the link types of one domain.
   * @param domain - business domain id.
   * @returns every link type, ordered by id.
   */
  listLinkTypes(domain: string): LinkTypeBinding[] {
    const rows = this.db.prepare(
      'SELECT * FROM link_type WHERE domain = ? ORDER BY link_id',
    ).all(domain) as Record<string, unknown>[]
    return rows.map(row => ({
      domain: String(row['domain']),
      linkId: String(row['link_id']),
      label: String(row['label']),
      fromType: String(row['from_type']),
      toType: String(row['to_type']),
      fromProperty: String(row['from_property']),
      toProperty: String(row['to_property']),
    }))
  }

  /**
   * Read one link type.
   * @param domain - business domain id.
   * @param linkId - link type id.
   * @returns the binding, or `undefined` when it is not declared.
   */
  readLinkType(domain: string, linkId: string): LinkTypeBinding | undefined {
    return this.listLinkTypes(domain).find(item => item.linkId === linkId)
  }

  /**
   * Create or replace one action type.
   * @param binding - the writable half of one object type.
   */
  upsertActionType(binding: ActionTypeBinding): void {
    this.db.prepare(`
      INSERT INTO action_type
        (domain, action_id, label, target_type, parameters, preconditions, effects, approval)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (domain, action_id) DO UPDATE SET
        label = excluded.label,
        target_type = excluded.target_type,
        parameters = excluded.parameters,
        preconditions = excluded.preconditions,
        effects = excluded.effects,
        approval = excluded.approval
    `).run(
      binding.domain,
      binding.actionId,
      binding.label,
      binding.targetObjectType,
      JSON.stringify(binding.parameters),
      JSON.stringify(binding.preconditions),
      JSON.stringify(binding.effects),
      binding.approval,
    )
  }

  /**
   * List the action types of one domain.
   * @param domain - business domain id.
   * @returns every action type, ordered by id.
   */
  listActionTypes(domain: string): ActionTypeBinding[] {
    const rows = this.db.prepare(
      'SELECT * FROM action_type WHERE domain = ? ORDER BY action_id',
    ).all(domain) as Record<string, unknown>[]
    return rows.map(row => ({
      domain: String(row['domain']),
      actionId: String(row['action_id']),
      label: String(row['label']),
      targetObjectType: String(row['target_type']),
      parameters: JSON.parse(String(row['parameters'])) as ActionTypeBinding['parameters'],
      preconditions: JSON.parse(String(row['preconditions'])) as ActionTypeBinding['preconditions'],
      effects: JSON.parse(String(row['effects'])) as ActionTypeBinding['effects'],
      approval: String(row['approval']) === 'required' ? 'required' : 'none',
    }))
  }

  /**
   * Read one action type.
   * @param domain - business domain id.
   * @param actionId - action type id.
   * @returns the binding, or `undefined` when it is not declared.
   */
  readActionType(domain: string, actionId: string): ActionTypeBinding | undefined {
    return this.listActionTypes(domain).find(item => item.actionId === actionId)
  }

  /**
   * Upsert one batch of rows inside the caller's transaction.
   * @param domain - business domain id.
   * @param objectType - object type id.
   * @param rows - primary key plus the record to store, per object.
   * @param runId - sync run that produced these rows.
   * @param syncedAt - timestamp shared by the batch.
   * @returns how many rows were inserted and how many replaced an existing row.
   */
  writeRows(
    domain: string,
    objectType: string,
    rows: readonly { readonly primaryKey: string; readonly data: Readonly<Record<string, string>> }[],
    runId: string,
    syncedAt: string,
  ): { inserted: number; updated: number } {
    const existing = this.db.prepare(`
      SELECT object_id FROM object_row WHERE domain = ? AND object_type = ? AND object_id = ?
    `)
    const write = this.db.prepare(`
      INSERT INTO object_row (domain, object_type, object_id, pk, data, synced_at, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (domain, object_type, object_id) DO UPDATE SET
        pk = excluded.pk,
        data = excluded.data,
        synced_at = excluded.synced_at,
        run_id = excluded.run_id
    `)
    let inserted = 0
    let updated = 0
    for (const row of rows) {
      const id = objectIdOf(domain, objectType, row.primaryKey)
      const found = existing.get(domain, objectType, id)
      if (found === undefined) inserted += 1
      else updated += 1
      write.run(domain, objectType, id, row.primaryKey, JSON.stringify(row.data), syncedAt, runId)
    }
    return { inserted, updated }
  }

  /**
   * Read the highest value of one field, used as the incremental watermark.
   * @param domain - business domain id.
   * @param objectType - object type id.
   * @param field - declared field name.
   * @returns the maximum value, or `null` when the type has no rows.
   */
  maxField(domain: string, objectType: string, field: string): string | null {
    const row = this.db.prepare(`
      SELECT MAX(CAST(json_extract(data, ?) AS TEXT)) AS value
      FROM object_row WHERE domain = ? AND object_type = ?
    `).get(`$.${safeField(field)}`, domain, objectType) as Record<string, unknown> | undefined
    const value = row?.['value']
    return typeof value === 'string' && value.length > 0 ? value : null
  }

  /**
   * Read one object by id.
   * @param domain - business domain id.
   * @param objectType - object type id.
   * @param primaryKey - business key value.
   * @returns the record, or `undefined` when it was never synced.
   */
  readObject(domain: string, objectType: string, primaryKey: string): ObjectRecord | undefined {
    const row = this.db.prepare(`
      SELECT object_id, object_type, data, synced_at, run_id
      FROM object_row WHERE domain = ? AND object_type = ? AND object_id = ?
    `).get(domain, objectType, objectIdOf(domain, objectType, primaryKey)) as RowShape | undefined
    if (row === undefined) return undefined
    const data = JSON.parse(row.data) as Record<string, string>
    return {
      id: row.object_id,
      domain,
      objectType: row.object_type,
      label: data[this.bindingLabelField(domain, objectType)] ?? primaryKey,
      fields: data,
      syncedAt: row.synced_at,
      lastRunId: row.run_id,
    }
  }

  /** Field rendered as the display label for one object type. */
  private bindingLabelField(domain: string, objectType: string): string {
    const binding = this.readObjectType(domain, objectType)
    return binding?.labelField ?? binding?.primaryKey ?? '__pk'
  }

  /**
   * Page one object type with filters.
   * @param domain - business domain id.
   * @param binding - the object type whose rows are read.
   * @param filters - clauses already validated by the caller's schema.
   * @param limit - maximum rows returned.
   * @returns the page plus the unpaged total.
   */
  searchObjects(
    domain: string,
    binding: ObjectTypeBinding,
    filters: readonly ObjectFilter[],
    limit: number,
  ): { items: ObjectRecord[]; total: number } {
    const fields = new Set(binding.fields.map(field => field.name))
    const clauses = filters.map(filter => compileFilter(filter, fields))
    const where = clauses.length === 0 ? '' : ` AND ${clauses.map(item => item.sql).join(' AND ')}`
    const values = clauses.flatMap(item => item.values)
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS total FROM object_row WHERE domain = ? AND object_type = ?${where}
    `).get(domain, binding.objectType, ...values) as Record<string, unknown> | undefined
    const rows = this.db.prepare(`
      SELECT object_id, object_type, data, synced_at, run_id
      FROM object_row WHERE domain = ? AND object_type = ?${where}
      ORDER BY pk LIMIT ?
    `).all(domain, binding.objectType, ...values, limit) as unknown as RowShape[]
    return {
      total: Number(totalRow?.['total'] ?? 0),
      items: rows.map(row => this.toRecord(domain, binding, row)),
    }
  }

  /** Project a stored row into a record using one binding. */
  private toRecord(domain: string, binding: ObjectTypeBinding, row: RowShape): ObjectRecord {
    const data = JSON.parse(row.data) as Record<string, string>
    return {
      id: row.object_id,
      domain,
      objectType: row.object_type,
      label: data[binding.labelField ?? binding.primaryKey] ?? (data[binding.primaryKey] ?? ''),
      fields: data,
      syncedAt: row.synced_at,
      lastRunId: row.run_id,
    }
  }

  /**
   * Aggregate one object type, optionally grouped by a field.
   * @param domain - business domain id.
   * @param binding - the object type to aggregate.
   * @param metric - aggregate function.
   * @param property - numeric field the metric reads; `null` for `count`.
   * @param groupBy - grouping field, or `null` for one overall row.
   * @param filters - clauses narrowing the rows first.
   * @returns one row per group, ordered by group.
   */
  aggregateObjects(
    domain: string,
    binding: ObjectTypeBinding,
    metric: AggregateResult['metric'],
    property: string | null,
    groupBy: string | null,
    filters: readonly ObjectFilter[],
  ): AggregateResult {
    const fields = new Set(binding.fields.map(field => field.name))
    if (property !== null && !fields.has(property)) throw new Error(`Unknown object field: ${property}`)
    if (groupBy !== null && !fields.has(groupBy)) throw new Error(`Unknown object field: ${groupBy}`)
    const clauses = filters.map(filter => compileFilter(filter, fields))
    const where = clauses.length === 0 ? '' : ` AND ${clauses.map(item => item.sql).join(' AND ')}`
    const values = clauses.flatMap(item => item.values)
    const group = groupBy === null ? 'NULL' : `CAST(json_extract(data, '$.${safeField(groupBy)}') AS TEXT)`
    const amount = property === null ? '' : `CAST(json_extract(data, '$.${safeField(property)}') AS REAL)`
    const select = metric === 'count' ? 'COUNT(*)' : `${metric.toUpperCase()}(${amount})`
    const rows = this.db.prepare(`
      SELECT ${group} AS grp, ${select} AS value
      FROM object_row WHERE domain = ? AND object_type = ?${where}
      GROUP BY grp ORDER BY grp LIMIT 200
    `).all(domain, binding.objectType, ...values) as Record<string, unknown>[]
    return {
      metric,
      property,
      groupBy,
      rows: rows.map(row => ({
        group: typeof row['grp'] === 'string' ? row['grp'] : '',
        value: Number(row['value'] ?? 0),
      })),
    }
  }

  /**
   * Count objects on one side of a link whose shared key matches a value.
   * @param domain - business domain id.
   * @param objectType - object type counted.
   * @param field - its join field.
   * @param value - the shared key value.
   * @returns how many objects satisfy the join.
   */
  countByField(domain: string, objectType: string, field: string, value: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total FROM object_row
      WHERE domain = ? AND object_type = ? AND CAST(json_extract(data, ?) AS TEXT) = ?
    `).get(domain, objectType, `$.${safeField(field)}`, value) as Record<string, unknown> | undefined
    return Number(row?.['total'] ?? 0)
  }

  /**
   * Page objects on one side of a link whose shared key matches a value.
   * @param domain - business domain id.
   * @param objectType - object type read.
   * @param field - its join field.
   * @param value - the shared key value.
   * @param limit - maximum rows returned.
   * @returns the matching records.
   */
  findByField(
    domain: string,
    objectType: string,
    field: string,
    value: string,
    limit: number,
  ): ObjectRecord[] {
    const binding = this.readObjectType(domain, objectType)
    if (binding === undefined) return []
    const rows = this.db.prepare(`
      SELECT object_id, object_type, data, synced_at, run_id FROM object_row
      WHERE domain = ? AND object_type = ? AND CAST(json_extract(data, ?) AS TEXT) = ?
      ORDER BY pk LIMIT ?
    `).all(domain, objectType, `$.${safeField(field)}`, value, limit) as unknown as RowShape[]
    return rows.map(row => this.toRecord(domain, binding, row))
  }

  /**
   * Overwrite one field of one stored object.
   * @param domain - business domain id.
   * @param objectType - object type id.
   * @param primaryKey - business key value.
   * @param field - field to write.
   * @param value - new value.
   * @returns the updated record, or `undefined` when the object is missing.
   */
  writeField(
    domain: string,
    objectType: string,
    primaryKey: string,
    field: string,
    value: string,
  ): ObjectRecord | undefined {
    const current = this.readObject(domain, objectType, primaryKey)
    if (current === undefined) return undefined
    const next = { ...current.fields, [safeField(field)]: value }
    this.db.prepare(`
      UPDATE object_row SET data = ?, synced_at = ?
      WHERE domain = ? AND object_type = ? AND object_id = ?
    `).run(JSON.stringify(next), new Date().toISOString(), domain, objectType, current.id)
    return this.readObject(domain, objectType, primaryKey)
  }

  /**
   * Record one sync run.
   * @param run - the completed run, with `failedReason` when it aborted.
   */
  recordSyncRun(run: SyncRunRecord): void {
    this.db.prepare(`
      INSERT INTO sync_run
        (run_id, domain, object_type, mode, read_count, inserted, updated, skipped, watermark, failed_reason, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.runId,
      run.domain,
      run.objectType,
      run.mode,
      run.read,
      run.inserted,
      run.updated,
      run.skipped,
      run.watermark,
      run.failedReason,
      run.startedAt,
      run.finishedAt,
    )
  }

  /**
   * List recent sync runs for one object type.
   * @param domain - business domain id.
   * @param objectType - object type id, or `null` for every type in the domain.
   * @param limit - maximum runs returned.
   * @returns the runs, newest first.
   */
  listSyncRuns(domain: string, objectType: string | null, limit: number): SyncRunRecord[] {
    const rows = objectType === null
      ? this.db.prepare(
        'SELECT * FROM sync_run WHERE domain = ? ORDER BY started_at DESC LIMIT ?',
      ).all(domain, limit)
      : this.db.prepare(
        'SELECT * FROM sync_run WHERE domain = ? AND object_type = ? ORDER BY started_at DESC LIMIT ?',
      ).all(domain, objectType, limit)
    return (rows as Record<string, unknown>[]).map(row => ({
      runId: String(row['run_id']),
      domain: String(row['domain']),
      objectType: String(row['object_type']),
      mode: String(row['mode']) === 'incremental' ? 'incremental' : 'full',
      read: Number(row['read_count']),
      inserted: Number(row['inserted']),
      updated: Number(row['updated']),
      skipped: Number(row['skipped']),
      watermark: typeof row['watermark'] === 'string' ? row['watermark'] : null,
      startedAt: String(row['started_at']),
      finishedAt: String(row['finished_at']),
      failedReason: typeof row['failed_reason'] === 'string' ? row['failed_reason'] : null,
    }))
  }

  /**
   * Store one proposal.
   * @param proposal - the full proposal, already validated by the caller.
   */
  insertProposal(proposal: ActionProposal): void {
    this.db.prepare(`
      INSERT INTO action_proposal
        (proposal_id, domain, action_id, action_label, object_type, object_id, object_label,
         params, status, before_data, after_data, changes, violations, impacts, deferred,
         created_at, decided_at, decided_by, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.proposalId,
      proposal.domain,
      proposal.actionId,
      proposal.actionLabel,
      proposal.objectType,
      proposal.objectId,
      proposal.objectLabel,
      JSON.stringify(proposal.params),
      proposal.status,
      JSON.stringify(proposal.before),
      JSON.stringify(proposal.after),
      JSON.stringify(proposal.changes),
      JSON.stringify(proposal.violations),
      JSON.stringify(proposal.impacts),
      JSON.stringify(proposal.deferred),
      proposal.createdAt,
      proposal.decidedAt,
      proposal.decidedBy,
      proposal.committedAt,
    )
  }

  /**
   * Read one proposal.
   * @param proposalId - id returned by the propose call.
   * @returns the proposal, or `undefined` when it does not exist.
   */
  readProposal(proposalId: string): ActionProposal | undefined {
    const row = this.db.prepare(
      'SELECT * FROM action_proposal WHERE proposal_id = ?',
    ).get(proposalId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : this.toProposal(row)
  }

  /** Project one stored proposal row. */
  private toProposal(row: Record<string, unknown>): ActionProposal {
    return {
      proposalId: String(row['proposal_id']),
      domain: String(row['domain']),
      actionId: String(row['action_id']),
      actionLabel: String(row['action_label']),
      objectType: String(row['object_type']),
      objectId: String(row['object_id']),
      objectLabel: String(row['object_label']),
      params: JSON.parse(String(row['params'])) as Record<string, string>,
      status: String(row['status']) as ProposalStatus,
      before: JSON.parse(String(row['before_data'])) as Record<string, string>,
      after: JSON.parse(String(row['after_data'])) as Record<string, string>,
      changes: JSON.parse(String(row['changes'])) as ActionProposal['changes'],
      violations: JSON.parse(String(row['violations'])) as ActionProposal['violations'],
      impacts: JSON.parse(String(row['impacts'])) as ActionProposal['impacts'],
      deferred: JSON.parse(String(row['deferred'])) as string[],
      createdAt: String(row['created_at']),
      decidedAt: typeof row['decided_at'] === 'string' ? row['decided_at'] : null,
      decidedBy: typeof row['decided_by'] === 'string' ? row['decided_by'] : null,
      committedAt: typeof row['committed_at'] === 'string' ? row['committed_at'] : null,
    }
  }

  /**
   * List proposals for one domain.
   * @param domain - business domain id.
   * @param status - restrict to one lifecycle state, or `null` for all.
   * @param limit - maximum proposals returned.
   * @returns the proposals, newest first.
   */
  listProposals(domain: string, status: ProposalStatus | null, limit: number): ActionProposal[] {
    const rows = status === null
      ? this.db.prepare(
        'SELECT * FROM action_proposal WHERE domain = ? ORDER BY created_at DESC LIMIT ?',
      ).all(domain, limit)
      : this.db.prepare(
        'SELECT * FROM action_proposal WHERE domain = ? AND status = ? ORDER BY created_at DESC LIMIT ?',
      ).all(domain, status, limit)
    return (rows as Record<string, unknown>[]).map(row => this.toProposal(row))
  }

  /**
   * Move one proposal to a new lifecycle state.
   * @param proposalId - proposal to update.
   * @param status - the state it moves to.
   * @param decidedBy - account that made the decision, when a human did.
   * @param committedAt - commit timestamp, when the transition is a commit.
   */
  updateProposalStatus(
    proposalId: string,
    status: ProposalStatus,
    decidedBy: string | null,
    committedAt: string | null,
  ): void {
    this.db.prepare(`
      UPDATE action_proposal
      SET status = ?, decided_at = COALESCE(decided_at, ?), decided_by = ?, committed_at = ?
      WHERE proposal_id = ?
    `).run(
      status,
      decidedBy === null ? null : new Date().toISOString(),
      decidedBy,
      committedAt,
      proposalId,
    )
  }

  /**
   * Run a unit of work in one transaction.
   * @param work - the statements to run; a throw rolls the transaction back.
   * @returns whatever the work returned.
   */
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

/**
 * Get the shared object database handle for one ontology root.
 * @param root - ontology store root.
 * @returns the open handle, created on first use.
 */
export function objectDatabaseAt(root: string): ObjectDatabase {
  const key = root.replace(/\\/g, '/')
  const existing = openDatabases.get(key)
  if (existing !== undefined) return existing
  const created = new ObjectDatabase(key)
  openDatabases.set(key, created)
  return created
}

/**
 * Close and forget the handle for one root, so tests can delete the directory.
 * @param root - ontology store root.
 */
export function forgetObjectDatabase(root: string): void {
  const key = root.replace(/\\/g, '/')
  const existing = openDatabases.get(key)
  if (existing === undefined) return
  existing.close()
  openDatabases.delete(key)
}
