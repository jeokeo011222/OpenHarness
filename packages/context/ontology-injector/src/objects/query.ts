/**
 * Read paths over bound objects.
 *
 * Everything here returns references rather than rows: an id, a label, and the
 * few fields the caller asked for. That is deliberate — a model given a table
 * answers from the table, while a model given references keeps drilling down
 * with the tools, which is the whole point of putting an ontology in front of
 * the data in the first place.
 */

import { objectDatabaseAt, parseObjectId } from './db.ts'
import type {
  AggregateResult,
  LinkRef,
  ObjectAggregateMetric,
  ObjectFilter,
  ObjectPage,
  ObjectRecord,
  ObjectRef,
  ObjectTypeBinding,
} from './types.ts'

/** Default page size for a reference query. */
export const DEFAULT_PAGE_LIMIT = 20

/** Hard ceiling on one page, so one call can never dump a table. */
export const MAX_PAGE_LIMIT = 50

/** Fields projected onto a reference when the caller names none. */
const REF_FIELD_BUDGET = 5

/**
 * Clamp a requested page size into the supported range.
 * @param limit - caller-supplied size, possibly absent or unreasonable.
 * @returns a size between 1 and {@link MAX_PAGE_LIMIT}.
 */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.trunc(limit)))
}

/**
 * Project a record down to a reference.
 * @param record - the stored object.
 * @param binding - its object type, supplying the default projection.
 * @param fields - fields the caller asked for; `undefined` uses the default set.
 * @returns the reference the tools render.
 */
function project(
  record: ObjectRecord,
  binding: ObjectTypeBinding,
  fields: readonly string[] | undefined,
): ObjectRef {
  const wanted = fields === undefined || fields.length === 0
    ? binding.fields
      .filter(field => field.filterable === true || field.name === binding.labelField)
      .slice(0, REF_FIELD_BUDGET)
      .map(field => field.name)
    : fields
  const projected: Record<string, string> = {}
  for (const name of wanted) {
    const value = record.fields[name]
    if (value !== undefined) projected[name] = value
  }
  return { id: record.id, objectType: record.objectType, label: record.label, fields: projected }
}

/**
 * Read one binding, failing with an actionable message when it is missing.
 * @param storePath - ontology root.
 * @param domain - business domain id.
 * @param objectType - object type id.
 * @returns the binding.
 */
function requireBinding(storePath: string, domain: string, objectType: string): ObjectTypeBinding {
  const binding = objectDatabaseAt(storePath).readObjectType(domain, objectType)
  if (binding === undefined) {
    throw new Error(`Object type is not bound: ${domain}/${objectType}. Bind it with objects-cli bind first.`)
  }
  return binding
}

/**
 * Page one object type.
 * @param storePath - ontology root.
 * @param domain - business domain id.
 * @param objectType - object type id.
 * @param filters - clauses over declared fields.
 * @param limit - requested page size.
 * @param fields - reference projection; `undefined` uses the type's defaults.
 * @returns the page plus the unpaged total.
 */
export function searchObjects(
  storePath: string,
  domain: string,
  objectType: string,
  filters: readonly ObjectFilter[],
  limit: number | undefined,
  fields?: readonly string[],
): ObjectPage {
  const binding = requireBinding(storePath, domain, objectType)
  const page = objectDatabaseAt(storePath).searchObjects(domain, binding, filters, clampLimit(limit))
  return {
    total: page.total,
    items: page.items.map(record => project(record, binding, fields)),
  }
}

/**
 * Read one object by its business key.
 * @param storePath - ontology root.
 * @param domain - business domain id.
 * @param objectType - object type id.
 * @param primaryKey - business key value, or a full object id.
 * @returns the record, or `undefined` when no such object was synced.
 */
export function getObject(
  storePath: string,
  domain: string,
  objectType: string,
  primaryKey: string,
): ObjectRecord | undefined {
  const parsed = primaryKey.includes(':') ? parseObjectId(primaryKey) : undefined
  const key = parsed === undefined ? primaryKey : parsed.primaryKey
  const type = parsed === undefined ? objectType : parsed.objectType
  requireBinding(storePath, domain, type)
  return objectDatabaseAt(storePath).readObject(domain, type, key)
}

/**
 * Traverse the link types attached to one object.
 * @param storePath - ontology root.
 * @param domain - business domain id.
 * @param objectId - the object the traversal starts from.
 * @param linkId - restrict to one link type when given.
 * @param direction - follow downstream, upstream, or both.
 * @param limit - maximum references returned.
 * @returns downstream and upstream references, tagged with their link type.
 */
export function traverseLinks(
  storePath: string,
  domain: string,
  objectId: string,
  linkId: string | undefined,
  direction: 'out' | 'in' | 'both',
  limit: number | undefined,
): LinkRef[] {
  const db = objectDatabaseAt(storePath)
  const parsed = parseObjectId(objectId)
  if (parsed === undefined) throw new Error(`Malformed object id: ${objectId}`)
  const anchor = db.readObject(parsed.domain, parsed.objectType, parsed.primaryKey)
  if (anchor === undefined) throw new Error(`Object not found: ${objectId}`)

  const wanted = db.listLinkTypes(domain).filter(item => linkId === undefined || item.linkId === linkId)
  const capped = clampLimit(limit)
  const refs: LinkRef[] = []

  for (const link of wanted) {
    if (direction !== 'in' && link.fromType === parsed.objectType) {
      const key = anchor.fields[link.fromProperty] ?? ''
      if (key.length === 0) continue
      const target = db.readObjectType(domain, link.toType)
      if (target === undefined) continue
      for (const record of db.findByField(domain, link.toType, link.toProperty, key, capped)) {
        refs.push({ ...project(record, target, undefined), via: link.linkId, direction: 'out' })
      }
    }
    if (direction !== 'out' && link.toType === parsed.objectType) {
      const key = anchor.fields[link.toProperty] ?? ''
      if (key.length === 0) continue
      const source = db.readObjectType(domain, link.fromType)
      if (source === undefined) continue
      for (const record of db.findByField(domain, link.fromType, link.fromProperty, key, capped)) {
        refs.push({ ...project(record, source, undefined), via: link.linkId, direction: 'in' })
      }
    }
  }
  return refs.slice(0, capped)
}

/**
 * Aggregate one object type.
 * @param storePath - ontology root.
 * @param domain - business domain id.
 * @param objectType - object type id.
 * @param metric - aggregate function.
 * @param property - numeric field the metric reads; omitted for `count`.
 * @param groupBy - grouping field; omitted for one overall row.
 * @param filters - clauses narrowing the rows first.
 * @returns one row per group.
 */
export function aggregateObjects(
  storePath: string,
  domain: string,
  objectType: string,
  metric: ObjectAggregateMetric,
  property: string | undefined,
  groupBy: string | undefined,
  filters: readonly ObjectFilter[],
): AggregateResult {
  const binding = requireBinding(storePath, domain, objectType)
  return objectDatabaseAt(storePath).aggregateObjects(
    domain,
    binding,
    metric,
    property ?? null,
    groupBy ?? null,
    filters,
  )
}
