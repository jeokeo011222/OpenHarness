/** Query DSL: streaming aggregation over `data.ndjson`, time grains, caching, and data profiles. */
import { AnalysisError, clampInt, sha256, stableStringify } from './util.js'
import { readDatasetRows } from './dataset.js'

/** Default row cap for a query result. */
export const DEFAULT_LIMIT = 1000
/** Hard row cap; larger requests are truncated instead of failing. */
export const HARD_LIMIT = 10_000
/** Maximum number of distinct groups a single query may materialize. */
const MAX_GROUPS = 10_000

const AGGREGATES = ['count', 'countDistinct', 'sum', 'avg', 'min', 'max', 'p50', 'p95']
const FILTER_OPERATORS = ['=', '!=', '>', '>=', '<', '<=', 'in', 'notIn', 'contains', 'startsWith', 'isNull', 'notNull', 'between']
const GRAINS = ['day', 'week', 'month', 'quarter', 'year']

/**
 * Build a name to schema-entry map for validation and error text.
 * @param meta - Dataset metadata.
 * @returns Field lookup.
 */
export function fieldMap(meta) {
  return new Map(meta.schema.map(entry => [entry.name, entry]))
}

/**
 * Throw a field error that lists what is available.
 * @param meta - Dataset metadata.
 * @param field - Unknown field name.
 * @param role - Which slot the field occupied.
 */
function assertKnownField(meta, field, role) {
  if (typeof field !== 'string' || field.length === 0) {
    throw new AnalysisError(`${role} entries need a "field".`, 'bad_query')
  }
  if (!meta.schema.some(entry => entry.name === field)) {
    throw new AnalysisError(
      `Unknown field "${field}" in ${role}. Available fields: ${meta.schema.map(entry => entry.name).join(', ')}.`,
      'unknown_field',
    )
  }
}

/**
 * Truncate a date-like value to a grain label.
 * @param value - Stored `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss`.
 * @param grain - Time grain.
 * @returns The label, or null for a null input.
 */
export function truncateTime(value, grain) {
  if (value === null || value === undefined) return null
  if (!GRAINS.includes(grain)) throw new AnalysisError(`Unknown time grain "${grain}".`, 'bad_query')
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value))
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const pad = number => String(number).padStart(2, '0')
  if (grain === 'year') return `${year}`
  if (grain === 'quarter') return `${year}-Q${Math.floor((month - 1) / 3) + 1}`
  if (grain === 'month') return `${year}-${pad(month)}`
  if (grain === 'day') return `${year}-${pad(month)}-${pad(day)}`
  const date = new Date(year, month - 1, day)
  const weekday = date.getDay() === 0 ? 7 : date.getDay()
  date.setDate(date.getDate() - (weekday - 1))
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Normalize and validate a query request against the dataset schema.
 * @param meta - Dataset metadata.
 * @param args - Raw tool arguments.
 * @returns A canonical query description.
 */
export function normalizeQuery(meta, args) {
  const fields = fieldMap(meta)
  const dimensions = (args.dimensions ?? []).map(dimension => {
    assertKnownField(meta, dimension.field, 'dimensions')
    const entry = fields.get(dimension.field)
    if (dimension.timeGrain !== undefined) {
      if (!GRAINS.includes(dimension.timeGrain)) {
        throw new AnalysisError(`Unknown time grain "${dimension.timeGrain}".`, 'bad_query')
      }
      if (entry.type !== 'date' && entry.type !== 'datetime') {
        throw new AnalysisError(`Field "${dimension.field}" is ${entry.type}; timeGrain only applies to date or datetime fields.`, 'bad_query')
      }
    }
    return { field: dimension.field, timeGrain: dimension.timeGrain, alias: dimension.alias }
  })
  const measures = (args.measures ?? []).map(measure => {
    assertKnownField(meta, measure.field, 'measures')
    const aggregate = measure.agg ?? 'count'
    if (!AGGREGATES.includes(aggregate)) {
      throw new AnalysisError(`Unknown aggregate "${aggregate}". Allowed: ${AGGREGATES.join(', ')}.`, 'bad_query')
    }
    if (['sum', 'avg', 'p50', 'p95'].includes(aggregate)) {
      const entry = fields.get(measure.field)
      if (entry.type !== 'integer' && entry.type !== 'number') {
        throw new AnalysisError(`Aggregate "${aggregate}" needs a numeric field; "${measure.field}" is ${entry.type}.`, 'bad_query')
      }
    }
    return { field: measure.field, agg: aggregate, alias: measure.alias }
  })
  if (dimensions.length === 0 && measures.length === 0) {
    throw new AnalysisError('Provide at least one dimension or measure.', 'bad_query')
  }
  const filters = (args.filters ?? []).map(filter => {
    assertKnownField(meta, filter.field, 'filters')
    if (!FILTER_OPERATORS.includes(filter.op)) {
      throw new AnalysisError(`Unknown filter operator "${filter.op}". Allowed: ${FILTER_OPERATORS.join(', ')}.`, 'bad_query')
    }
    return { field: filter.field, op: filter.op, value: filter.value }
  })
  const orderBy = (args.orderBy ?? []).map(order => {
    if (typeof order.field !== 'string') throw new AnalysisError('orderBy entries need a "field".', 'bad_query')
    if (order.direction !== undefined && !['asc', 'desc'].includes(order.direction)) {
      throw new AnalysisError('orderBy direction must be "asc" or "desc".', 'bad_query')
    }
    return { field: order.field, direction: order.direction ?? 'asc' }
  })
  return {
    dimensions,
    measures,
    filters,
    orderBy,
    limit: clampInt(args.limit, 1, HARD_LIMIT, DEFAULT_LIMIT),
    offset: clampInt(args.offset, 0, 1_000_000, 0),
  }
}

/**
 * Output column name for a measure.
 * @param measure - Normalized measure.
 * @returns Alias or `agg(field)`.
 */
function measureName(measure) {
  return measure.alias ?? `${measure.agg}(${measure.field})`
}

/**
 * Compare a stored value against a filter value using the field type.
 * @param value - Row value.
 * @param filter - Normalized filter.
 * @param entry - Schema entry for the field.
 * @returns Whether the row passes.
 */
function passesFilter(value, filter, entry) {
  if (filter.op === 'isNull') return value === null || value === undefined
  if (filter.op === 'notNull') return value !== null && value !== undefined
  if (filter.op === 'in' || filter.op === 'notIn') {
    const list = Array.isArray(filter.value) ? filter.value.map(item => String(item)) : []
    const found = list.includes(String(value))
    return filter.op === 'in' ? found : !found
  }
  if (filter.op === 'between') {
    if (!Array.isArray(filter.value) || filter.value.length !== 2) return false
    if (typeof value === 'number') {
      return value >= Number(filter.value[0]) && value <= Number(filter.value[1])
    }
    return String(value) >= String(filter.value[0]) && String(value) <= String(filter.value[1])
  }
  if (filter.op === 'contains' || filter.op === 'startsWith') {
    const text = String(value ?? '')
    const needle = String(filter.value ?? '')
    return filter.op === 'contains' ? text.includes(needle) : text.startsWith(needle)
  }
  const numeric = entry.type === 'integer' || entry.type === 'number'
  const left = numeric ? Number(value) : String(value ?? '')
  const right = numeric ? Number(filter.value) : String(filter.value ?? '')
  if (numeric && (Number.isNaN(left) || Number.isNaN(right))) return false
  if (filter.op === '=') return left === right
  if (filter.op === '!=') return left !== right
  if (filter.op === '>') return left > right
  if (filter.op === '>=') return left >= right
  if (filter.op === '<') return left < right
  return left <= right
}

/** One aggregation accumulator per (group, measure). */
class Accumulator {
  /**
   * @param measure - Normalized measure.
   */
  constructor(measure) {
    this.measure = measure
    this.rows = 0
    this.sum = 0
    this.used = 0
    this.min = null
    this.max = null
    this.values = []
    this.distinct = new Set()
    this.distinctOverflow = false
  }

  /**
   * Absorb one row value.
   * @param value - Row value.
   */
  add(value) {
    this.rows += 1
    const { agg, field } = this.measure
    if (agg === 'count') return
    if (value === null || value === undefined) return
    if (agg === 'countDistinct') {
      if (this.distinct.size < 10_000) this.distinct.add(String(value))
      else this.distinctOverflow = true
      return
    }
    if (typeof value !== 'number') return
    this.used += 1
    if (agg === 'sum' || agg === 'avg') this.sum += value
    if (agg === 'min') this.min = this.min === null ? value : Math.min(this.min, value)
    if (agg === 'max') this.max = this.max === null ? value : Math.max(this.max, value)
    if ((agg === 'p50' || agg === 'p95') && this.values.length < 500_000) this.values.push(value)
    if (field === undefined) throw new AnalysisError('measure field missing', 'bad_query')
  }

  /**
   * @returns The aggregate value, JSON-safe (null for empty or non-finite).
   */
  result() {
    const { agg } = this.measure
    if (agg === 'count') return this.rows
    if (agg === 'countDistinct') return this.distinct.size
    if (agg === 'sum') return this.used === 0 ? null : this.sum
    if (agg === 'avg') return this.used === 0 ? null : this.sum / this.used
    if (agg === 'min') return this.min
    if (agg === 'max') return this.max
    const values = this.values.slice().sort((left, right) => left - right)
    if (values.length === 0) return null
    const ratio = agg === 'p50' ? 0.5 : 0.95
    const position = (values.length - 1) * ratio
    const lower = Math.floor(position)
    const upper = Math.ceil(position)
    const result = lower === upper ? values[lower] : values[lower] + (values[upper] - values[lower]) * (position - lower)
    return Number.isFinite(result) ? result : null
  }
}

/**
 * Run a normalized query by streaming the dataset.
 * @param root - Analysis root.
 * @param meta - Dataset metadata.
 * @param args - Raw tool arguments.
 * @param cache - Query result cache owned by the plugin instance.
 * @returns Result columns, rows, and timing.
 */
export async function runQuery(root, meta, args, cache) {
  const query = normalizeQuery(meta, args)
  const hash = sha256(stableStringify({ datasetId: meta.id, version: meta.version, query }))
  const cached = cache.get(hash)
  if (cached !== undefined) {
    return { ...cached, cached: true, elapsedMs: 0 }
  }
  const started = Date.now()
  const fields = fieldMap(meta)
  const groups = new Map()
  let truncated = false
  const dimensionNames = query.dimensions.map(dimension => dimension.alias ?? dimension.field)

  for await (const row of readDatasetRows(root, meta.id)) {
    let keep = true
    for (const filter of query.filters) {
      if (!passesFilter(row[filter.field], filter, fields.get(filter.field))) {
        keep = false
        break
      }
    }
    if (!keep) continue
    const keyParts = []
    for (const dimension of query.dimensions) {
      const entry = fields.get(dimension.field)
      const raw = row[dimension.field]
      const value = dimension.timeGrain !== undefined && (entry.type === 'date' || entry.type === 'datetime')
        ? truncateTime(raw, dimension.timeGrain)
        : raw ?? null
      keyParts.push(value)
    }
    const key = JSON.stringify(keyParts)
    let group = groups.get(key)
    if (group === undefined) {
      if (groups.size >= MAX_GROUPS) {
        truncated = true
        break
      }
      group = { values: keyParts, accumulators: query.measures.map(measure => new Accumulator(measure)) }
      groups.set(key, group)
    }
    for (let index = 0; index < query.measures.length; index += 1) {
      group.accumulators[index].add(row[query.measures[index].field])
    }
  }

  const columns = [
    ...query.dimensions.map((dimension, index) => ({ name: dimensionNames[index], type: fields.get(dimension.field).type })),
    ...query.measures.map(measure => ({ name: measureName(measure), type: measure.agg === 'count' || measure.agg === 'countDistinct' ? 'integer' : 'number' })),
  ]
  const rows = [...groups.values()].map(group => [
    ...group.values,
    ...group.accumulators.map(accumulator => {
      const value = accumulator.result()
      return typeof value === 'number' && !Number.isFinite(value) ? null : value
    }),
  ])

  const orderColumns = query.orderBy.length > 0
    ? query.orderBy
    : query.dimensions.length > 0
      ? [{ field: dimensionNames[0], direction: 'asc' }]
      : []
  const columnIndex = new Map(columns.map((column, index) => [column.name, index]))
  if (orderColumns.length > 0) {
    rows.sort((left, right) => {
      for (const order of orderColumns) {
        const index = columnIndex.get(order.field)
        if (index === undefined) {
          throw new AnalysisError(`orderBy field "${order.field}" is not in the result columns (${columns.map(column => column.name).join(', ')}).`, 'bad_query')
        }
        const a = left[index]
        const b = right[index]
        if (a === b) continue
        if (a === null) return 1
        if (b === null) return -1
        const comparison = typeof a === 'number' && typeof b === 'number'
          ? a - b
          : String(a).localeCompare(String(b), 'zh')
        if (comparison !== 0) return order.direction === 'desc' ? -comparison : comparison
      }
      return 0
    })
  }

  const sliced = rows.slice(query.offset, query.offset + query.limit)
  if (rows.length > query.offset + query.limit) truncated = true
  const result = {
    columns,
    rows: sliced,
    rowCount: rows.length,
    truncated,
    elapsedMs: Date.now() - started,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    queryHash: hash.slice(0, 16),
    notes: [
      'sum/avg skip null; count counts rows; countDistinct skips null.',
      'Division and empty aggregates return null, never Infinity or NaN.',
    ],
  }
  if (cache.size >= 64) cache.delete(cache.keys().next().value)
  cache.set(hash, result)
  return { ...result, cached: false }
}

/**
 * Build the compact data profile the model reads instead of raw rows.
 * @param meta - Dataset metadata.
 * @returns A profile capped near 2 KB.
 */
export function buildProfile(meta) {
  const columns = meta.schema.slice(0, 20).map(entry => {
    const stats = meta.stats?.columns?.[entry.name] ?? {}
    return {
      name: entry.name,
      type: entry.type,
      nullRate: meta.stats?.nullRateByColumn?.[entry.name] ?? 0,
      distinct: meta.stats?.distinctByColumn?.[entry.name] ?? null,
      min: stats.min ?? null,
      max: stats.max ?? null,
      mean: stats.mean ?? null,
      p50: stats.p50 ?? null,
      p95: stats.p95 ?? null,
      topValues: (stats.topValues ?? []).slice(0, 10),
    }
  })
  const timeColumn = meta.schema.find(entry => entry.type === 'date' || entry.type === 'datetime')
  const isIdentifierLike = name => /^(id|编号|序号|身份证|工号|code|key|uuid)$/i.test(name)
  const measure = meta.schema.find(entry => entry.role === 'measure' && !isIdentifierLike(entry.name))
    ?? meta.schema.find(entry => entry.role === 'measure')
  const dimension = meta.schema.find(entry => entry.type === 'string' && !isIdentifierLike(entry.name))
  const timeRange = meta.stats?.timeRange
  const year = timeRange?.min?.slice(0, 4)
  const suggestedQuestions = []
  if (timeColumn !== undefined && measure !== undefined && year !== undefined) {
    suggestedQuestions.push(
      `按 month 统计 ${measure.name} 的总和，覆盖 ${year} 年的 ${timeColumn.name}，哪个月最高？`,
    )
  }
  if (dimension !== undefined && measure !== undefined) {
    suggestedQuestions.push(`按 ${dimension.name} 统计 ${measure.name} 的总和，列出前 5 名。`)
  }
  if (measure !== undefined) {
    suggestedQuestions.push(`${measure.name} 的平均值和 p95 分别是多少？null 占多少？`)
  }
  if (suggestedQuestions.length === 0) {
    suggestedQuestions.push(`按第一个字段统计行数，找出记录最多的取值。`)
  }
  let topValueBudget = 10
  let profile = {
    datasetId: meta.id,
    name: meta.name,
    version: meta.version,
    rowCount: meta.rowCount,
    columnCount: meta.columnCount,
    timeRange: timeRange ?? null,
    columns,
    suggestedQuestions,
  }
  while (JSON.stringify(profile).length > 2048 && topValueBudget > 0) {
    topValueBudget -= 2
    profile = { ...profile, columns: profile.columns.map(column => ({ ...column, topValues: column.topValues.slice(0, topValueBudget) })) }
  }
  while (JSON.stringify(profile).length > 2048 && profile.columns.length > 0) {
    profile = { ...profile, columns: profile.columns.slice(0, profile.columns.length - 1) }
  }
  return profile
}
