/** ChartSpec construction, automatic chart-type choice, and saved chart storage. */
import { randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AnalysisError } from './util.js'

/** Chart types the panel can render. */
export const CHART_TYPES = ['bar', 'line', 'area', 'pie', 'scatter', 'table', 'kpi']

/**
 * Choose a chart type from the dimension shape of a query result.
 * Pure function so the panel and the host agree.
 * @param input - Dimension kinds, category count, and measure count.
 * @returns The recommended type and whether bars should be horizontal.
 */
export function suggestChart(input) {
  const { hasTime, dimensionCount, categoryCount, measureCount, dimensionName } = input
  if (dimensionCount === 0 && measureCount > 0) return { type: 'kpi', horizontal: false }
  if (measureCount === 0 || dimensionCount > 2) return { type: 'table', horizontal: false }
  if (hasTime) return { type: measureCount > 1 ? 'line' : 'line', horizontal: false }
  if (measureCount >= 2 && dimensionCount === 2) return { type: 'scatter', horizontal: false }
  if (categoryCount > 0 && /类型|类别|分类|渠道|来源|状态|占比|category|type|status|channel|source/i.test(dimensionName ?? '') && categoryCount <= 6) {
    return { type: 'pie', horizontal: false }
  }
  if (categoryCount <= 12) return { type: 'bar', horizontal: false }
  return { type: 'bar', horizontal: true }
}

/**
 * Summarize a result for the model-facing tool response.
 * @param spec - Chart specification.
 * @param result - Query result.
 * @returns A one-paragraph digest with the peak row.
 */
export function summarizeChart(spec, result) {
  const xIndex = 0
  const yIndex = spec.encoding.y?.length ? spec.encoding.x === undefined ? 0 : 1 : 0
  const points = result.rows.length
  if (points === 0) return `${spec.type} chart: no rows match the filters.`
  const xs = result.rows.map(row => row[xIndex])
  const peak = result.rows.reduce((best, row) => (typeof row[yIndex] === 'number' && (best === null || row[yIndex] > best[yIndex]) ? row : best), null)
  const low = String(xs[0])
  const high = String(xs[xs.length - 1])
  const measureName = result.columns[yIndex]?.name ?? 'value'
  if (peak === null) return `${spec.type} over ${points} rows (${low} … ${high}); no numeric measure.`
  return `${spec.type}: "${measureName}" across ${low} … ${high}, ${points} points; peak at ${peak[xIndex]} (${peak[yIndex]}).`
}

/**
 * Build a ChartSpec from a normalized request and its query result.
 * @param meta - Dataset metadata.
 * @param request - Tool arguments.
 * @param query - Normalized DSL query.
 * @param result - Query result.
 * @returns The serializable specification.
 */
export function buildChartSpec(meta, request, query, result) {
  const dimensionName = query.dimensions[0]?.field
  const dimensionEntry = meta.schema.find(entry => entry.name === dimensionName)
  const recommendation = request.type === undefined || request.type === 'auto'
    ? suggestChart({
      hasTime: dimensionEntry !== undefined && (dimensionEntry.type === 'date' || dimensionEntry.type === 'datetime'),
      dimensionCount: query.dimensions.length,
      categoryCount: result.rowCount,
      measureCount: query.measures.length,
      dimensionName,
    })
    : { type: request.type, horizontal: request.options?.horizontal === true }
  if (!CHART_TYPES.includes(recommendation.type)) {
    throw new AnalysisError(`Unknown chart type "${request.type}". Allowed: ${CHART_TYPES.join(', ')}.`, 'bad_chart')
  }
  const encoding = {}
  if (query.dimensions.length > 0) {
    encoding.x = {
      field: query.dimensions[0].field,
      type: dimensionEntry !== undefined && (dimensionEntry.type === 'date' || dimensionEntry.type === 'datetime') ? 'time' : 'dimension',
      ...(query.dimensions[0].timeGrain === undefined ? {} : { timeGrain: query.dimensions[0].timeGrain }),
    }
  }
  if (query.measures.length > 0) {
    encoding.y = query.measures.map(measure => ({
      field: measure.field,
      agg: measure.agg,
      ...(measure.alias === undefined ? {} : { alias: measure.alias }),
    }))
  }
  if (query.dimensions.length > 1) encoding.series = { field: query.dimensions[1].field }
  return {
    id: `ch_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    datasetId: meta.id,
    datasetVersion: meta.version,
    name: request.name ?? `${recommendation.type} · ${meta.name}`,
    createdAt: new Date().toISOString(),
    type: recommendation.type,
    encoding,
    filters: query.filters,
    options: {
      stacked: request.options?.stacked === true,
      horizontal: recommendation.horizontal || request.options?.horizontal === true,
      showLegend: request.options?.showLegend !== false,
      showValues: request.options?.showValues === true,
      xAxisTitle: request.options?.xAxisTitle ?? (query.dimensions[0]?.field ?? ''),
      yAxisTitle: request.options?.yAxisTitle ?? (query.measures[0] ? `${query.measures[0].agg}(${query.measures[0].field})` : ''),
    },
  }
}

/**
 * Persist a chart specification.
 * @param root - Analysis root.
 * @param spec - Chart specification.
 * @returns The stored id.
 */
export async function saveChart(root, spec) {
  const directory = path.join(root, 'charts')
  await writeFile(path.join(directory, `${spec.id}.json`), `${JSON.stringify(spec, null, 2)}\n`, 'utf8')
  const charts = await listCharts(root)
  await writeFile(
    path.join(directory, '_index.json'),
    `${JSON.stringify({ updatedAt: new Date().toISOString(), charts }, null, 2)}\n`,
    'utf8',
  )
  return spec.id
}

/**
 * List saved charts.
 * @param root - Analysis root.
 * @returns Chart specs, oldest first.
 */
export async function listCharts(root) {
  let names
  try {
    names = await readdir(path.join(root, 'charts'))
  } catch {
    return []
  }
  const charts = []
  for (const name of names) {
    if (!name.startsWith('ch_') || !name.endsWith('.json')) continue
    try {
      charts.push(JSON.parse(await readFile(path.join(root, 'charts', name), 'utf8')))
    } catch {
      continue
    }
  }
  return charts.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}
