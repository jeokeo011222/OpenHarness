/** Column typing and statistics for imported tables, shared by every data source. */
import { AnalysisError } from './util.js'

const NULL_MARKERS = new Set(['', 'null', 'n/a', 'na', '-', 'null值', '空'])
const BOOLEAN_TRUE = new Set(['true', 'yes', 'y', '是'])
const BOOLEAN_FALSE = new Set(['false', 'no', 'n', '否'])
const DATE_PATTERN = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/
const DATETIME_PATTERN = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/
const INTEGER_PATTERN = /^[+-]?\d+$/
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/
const LEADING_ZERO_PATTERN = /^[+-]?0\d/

/** Column types stored in dataset metadata. */
export const COLUMN_TYPES = ['string', 'integer', 'number', 'boolean', 'date', 'datetime']

/**
 * Pad a number to two digits.
 * @param value - Non-negative integer.
 * @returns Two-character string.
 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * Classify one raw cell.
 * @param raw - Cell text as parsed from the source.
 * @returns The candidate kind (`null` for empty markers) and its typed value.
 */
export function classifyValue(raw) {
  const text = typeof raw === 'string' ? raw.trim() : raw === null || raw === undefined ? '' : String(raw)
  if (NULL_MARKERS.has(text.toLowerCase())) return { kind: 'null', value: null }
  if (LEADING_ZERO_PATTERN.test(text)) return { kind: 'string', value: text }
  const lower = text.toLowerCase()
  if (BOOLEAN_TRUE.has(lower)) return { kind: 'boolean', value: true }
  if (BOOLEAN_FALSE.has(lower)) return { kind: 'boolean', value: false }
  if (INTEGER_PATTERN.test(text)) return { kind: 'integer', value: Number(text) }
  if (NUMBER_PATTERN.test(text)) return { kind: 'number', value: Number(text) }
  const date = DATE_PATTERN.exec(text)
  if (date !== null) {
    const [, year, month, day] = date
    return { kind: 'date', value: `${year}-${pad2(month)}-${pad2(day)}` }
  }
  const datetime = DATETIME_PATTERN.exec(text)
  if (datetime !== null) {
    const [, year, month, day, hour, minute, second] = datetime
    return { kind: 'datetime', value: `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second ?? '0')}` }
  }
  return { kind: 'string', value: text }
}

/**
 * Convert a raw cell to the value stored in a dataset column.
 * @param raw - Cell text from the source.
 * @param type - Declared column type.
 * @param keepNullMarkers - When true, marker text such as `N/A` stays literal because the column is textual.
 * @returns Typed value, or null for empty markers and unparseable numbers.
 */
export function coerceValue(raw, type, keepNullMarkers = false) {
  const classified = classifyValue(raw)
  if (classified.kind === 'null') {
    const literal = String(raw ?? '').trim()
    return keepNullMarkers && literal.length > 0 ? literal : null
  }
  if (type === 'string') return classified.kind === 'string' ? classified.value : String(raw).trim()
  if (type === 'integer' || type === 'number') {
    if (classified.kind === 'integer' || classified.kind === 'number') return classified.value
    const number = Number(classified.value)
    return Number.isFinite(number) ? number : null
  }
  if (type === 'boolean') {
    if (classified.kind === 'boolean') return classified.value
    return typeof classified.value === 'string' ? classified.value.toLowerCase() === 'true' : Boolean(classified.value)
  }
  if (type === 'date' || type === 'datetime') {
    if (classified.kind === 'date' || classified.kind === 'datetime') return classified.value
    return null
  }
  return classified.value === null ? null : String(classified.value)
}

/**
 * Compute an order statistic on a sorted ascending array.
 * @param sorted - Ascending numeric values.
 * @param ratio - Fractional position in `[0, 1]`.
 * @returns The value at that position, or null for an empty array.
 */
function quantile(sorted, ratio) {
  if (sorted.length === 0) return null
  const position = (sorted.length - 1) * ratio
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/** Aggregates one column across every row of an import. */
export class ColumnStats {
  /**
   * @param name - Column name already de-duplicated.
   */
  constructor(name) {
    this.name = name
    this.total = 0
    this.nullCount = 0
    this.markerCount = 0
    this.markers = new Map()
    this.kinds = { integer: 0, number: 0, boolean: 0, date: 0, datetime: 0, string: 0 }
    this.numbers = []
    this.values = new Map()
    this.distinctCapped = false
    this.distinctExact = true
    this.minText = undefined
    this.maxText = undefined
  }

  /**
   * Absorb one raw cell.
   * @param raw - Cell text.
   */
  add(raw) {
    this.total += 1
    const classified = classifyValue(raw)
    if (classified.kind === 'null') {
      const literal = String(raw ?? '').trim()
      if (literal.length > 0) {
        this.markerCount += 1
        this.markers.set(literal, (this.markers.get(literal) ?? 0) + 1)
      }
      this.nullCount += 1
      return
    }
    this.kinds[classified.kind] += 1
    if (classified.kind === 'integer' || classified.kind === 'number') {
      if (this.numbers.length < 500_000) this.numbers.push(classified.value)
    }
    if (classified.kind === 'date' || classified.kind === 'datetime') {
      const text = String(classified.value)
      if (this.minText === undefined || text < this.minText) this.minText = text
      if (this.maxText === undefined || text > this.maxText) this.maxText = text
    }
    this.trackValue(String(classified.value))
  }

  /**
   * Record a distinct value for `distinct` and `topValues`.
   * @param value - Canonical string form of the cell.
   */
  trackValue(value) {
    if (this.values.has(value)) {
      this.values.set(value, this.values.get(value) + 1)
      return
    }
    if (this.values.size >= 10_000) {
      this.distinctExact = false
      return
    }
    if (this.values.size >= 2_000) this.distinctCapped = true
    this.values.set(value, 1)
  }

  /**
   * Decide the column type from the observed kinds.
   * @returns One of `COLUMN_TYPES`.
   */
  inferredType() {
    const nonNull = this.total - this.nullCount
    if (nonNull === 0) return 'string'
    const numeric = this.kinds.integer + this.kinds.number
    if (numeric / nonNull >= 0.9) return this.kinds.integer / numeric >= 0.9 ? 'integer' : 'number'
    if (this.kinds.boolean / nonNull >= 0.9) return 'boolean'
    const temporal = this.kinds.date + this.kinds.datetime
    if (temporal / nonNull >= 0.9) return this.kinds.datetime > 0 ? 'datetime' : 'date'
    return 'string'
  }

  /**
   * Build the schema entry plus statistics for metadata.
   * @param warnings - Collector for human-readable import warnings.
   * @returns A column descriptor.
   */
  finish(warnings = []) {
    const type = this.inferredType()
    const nonNull = this.total - this.nullCount
    const numeric = this.kinds.integer + this.kinds.number
    if (nonNull > 0 && numeric > 0 && this.kinds.string > 0) {
      warnings.push(`Column "${this.name}" mixes types; it was kept as string.`)
    }
    if (this.distinctExact === false) {
      warnings.push(`Column "${this.name}" has more than 10000 distinct values; the count is an approximation.`)
    }
    const numbers = this.numbers.slice().sort((a, b) => a - b)
    const min = numbers.length > 0 ? numbers[0] : null
    const max = numbers.length > 0 ? numbers[numbers.length - 1] : null
    const mean = numbers.length > 0 ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null
    const p50 = quantile(numbers, 0.5)
    const p95 = quantile(numbers, 0.95)
    const role = type === 'integer' || type === 'number' ? 'measure' : 'dimension'
    const literalNullMarkers = type === 'string' && this.markerCount > 0
    const effectiveNulls = literalNullMarkers ? this.nullCount - this.markerCount : this.nullCount
    const counts = new Map(this.values)
    if (literalNullMarkers) {
      for (const [value, count] of this.markers) counts.set(value, (counts.get(value) ?? 0) + count)
    }
    const topValues = [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([value, count]) => ({
        value,
        count,
        pct: this.total === 0 ? 0 : Math.round((count / this.total) * 1000) / 10,
      }))
    return {
      name: this.name,
      type,
      nullable: effectiveNulls > 0,
      role,
      nullRate: this.total === 0 ? 0 : Math.round((effectiveNulls / this.total) * 1000) / 1000,
      distinct: counts.size,
      distinctExact: this.distinctExact && !literalNullMarkers,
      literalNullMarkers,
      min,
      max,
      mean,
      p50,
      p95,
      topValues,
    }
  }
}

/**
 * Clean raw header cells into unique column names.
 * @param raw - Header cells in source order.
 * @param warnings - Collector for adjustments.
 * @returns De-duplicated names with blanks filled and whitespace trimmed.
 */
export function normalizeHeaders(raw, warnings) {
  let index = 0
  let seen = new Map()
  return raw.map((cell, position) => {
    let name = String(cell ?? '').replace(/^\uFEFF/, '').trim()
    if (name.length === 0) {
      index += 1
      name = `column_${index}`
      warnings.push(`Header column ${position + 1} was blank and is named "${name}".`)
    }
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    if (count > 0) {
      const renamed = `${name}_${count + 1}`
      warnings.push(`Duplicate header "${name}" renamed to "${renamed}".`)
      return renamed
    }
    return name
  })
}

/**
 * Reject an import target that is too large for a single dataset.
 * @param rowCount - Rows discovered during the scan pass.
 * @param bytes - Source size when known.
 * @param options - `force` bypasses the generous limits.
 */
export function assertWithinLimits(rowCount, bytes, options = {}) {
  if (options.force === true) return
  if (rowCount > 1_000_000) {
    throw new AnalysisError(
      `This source has ${rowCount} rows, above the 1,000,000-row default limit. Pass force: true to continue anyway.`,
      'too_many_rows',
    )
  }
  if (typeof bytes === 'number' && bytes > 200 * 1024 * 1024) {
    throw new AnalysisError(
      `This source is ${Math.round(bytes / 1024 / 1024)} MB, above the 200 MB default limit. Pass force: true to continue anyway.`,
      'source_too_large',
    )
  }
}
