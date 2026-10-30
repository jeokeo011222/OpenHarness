/**
 * Verification for the browser half: module registration protocol, locale
 * parity, workspace loading, aggregation semantics, and SVG output. Runs in
 * plain Node with a React element stub; it does not exercise a real browser.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

let config
const windowStub = {
  __DSH_DATA_ANALYSIS_TEST__: true,
  __ModuleLoader__: { load(value) { config = value } },
}
const styleElement = { dataset: {}, style: {}, textContent: '', remove() {} }
const documentStub = {
  documentElement: { lang: 'zh-CN' },
  createElement: () => styleElement,
  head: { append() {} },
}
new Function('window', 'document', source)(windowStub, documentStub)

assert.equal(config.id, 'dsh-data-analysis', 'module id')

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat() }
  },
  useState(value) { return [value, () => {}] },
  useEffect() {},
  useMemo(factory) { return factory() },
  useRef(value) { return { current: value } },
}
const plugin = config.factory(name => {
  if (name === 'react') return React
  throw new Error('unexpected require(' + name + ')')
})

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// --- dictionaries ---------------------------------------------------------

const dictionaries = plugin.__test.dictionaries
test('locale dictionaries share every key and translate all prose', () => {
  const zhKeys = Object.keys(dictionaries.zh).sort()
  const enKeys = Object.keys(dictionaries.en).sort()
  assert.deepEqual(zhKeys, enKeys)
  // Keys whose value is only placeholders and punctuation are structurally identical.
  const structural = new Set(['chart.measureLabel', 'chart.share', 'chart.chip'])
  const identical = Object.keys(dictionaries.en).filter(key => !structural.has(key) && dictionaries.en[key] === dictionaries.zh[key])
  assert.deepEqual(identical, [], 'every other English string differs from Chinese')
})

/**
 * Translate one dictionary key for tests.
 * @param key - Dictionary key.
 * @param params - Optional `{name}` substitutions.
 * @returns The translated text.
 */
function makeT(locale = 'zh') {
  return (key, params) => {
    const dict = dictionaries[locale]
    assert.ok(dict[key] !== undefined, 'missing dictionary key: ' + key)
    return String(dict[key]).replace(/\{(.*?)\}/g, (match, name) => (
      params && params[name] !== undefined ? String(params[name]) : match
    ))
  }
}
const t = makeT('zh')

// --- registration ---------------------------------------------------------

const cssSource = source.slice(source.indexOf('const CSS = `'), source.indexOf('\n    /**\n     * Draw the sidebar guide glyph'))
test('no hardcoded colors in panel styles', () => {
  assert.ok(cssSource.length > 0)
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(cssSource), false, 'CSS must use design tokens, not hex')
  assert.ok(cssSource.includes('var(--dsw-alias-'))
})

test('apply registers dictionaries, the tab type, the body, and styles', () => {
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'remote', 'remote.workspaceFiles'])
  const effects = []
  const locales = []
  const tabs = []
  const slots = []
  const ctx = {
    effect(fn, label) {
      effects.push(label)
      fn()
      return () => {}
    },
    locale: {
      register(namespace, dicts) {
        locales.push({ namespace, dicts })
        return () => {}
      },
      bind: () => t,
    },
    sidebarRightTabs: { register(definition) { tabs.push(definition); return () => {} } },
    slots: {
      inject(owner, factory) { factory(); return () => {} },
      register(spec, component) { slots.push({ spec, component }); return () => {} },
    },
    remote: { workspaceFiles: { read: async () => ({ ok: false, error: { code: 'workspace-file/not-found', message: 'missing' } }) } },
  }
  plugin.apply(ctx)
  assert.deepEqual(locales.map(entry => entry.namespace), ['dataAnalysis'])
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].id, 'dsh-data-analysis')
  assert.equal(tabs[0].kind, 'data-analysis')
  assert.equal(tabs[0].priority, 'extension')
  assert.equal(tabs[0].title(), '数据分析')
  assert.equal(tabs[0].guide[0].title(), '数据分析')
  assert.equal(typeof tabs[0].guide[0].icon, 'function')
  assert.equal(tabs[0].guide[0].icon({}).type, 'svg')
  assert.equal(slots.length, 1)
  assert.equal(slots[0].spec.key, 'dsh-data-analysis')
  assert.equal(slots[0].spec.locale, 'dataAnalysis')
  assert.equal(typeof slots[0].spec.inject, 'function')
  assert.equal(slots[0].component.name, 'AnalysisPanel')
  assert.ok(effects.some(label => label.includes('styles')))
  assert.ok(effects.some(label => label.includes('tab body')))
})

// --- workspace loading ----------------------------------------------------

const indexDocument = {
  generatedAt: '2026-10-30T00:00:00.000Z',
  datasets: [{ id: 'ds_00000001', name: '销售明细', rowCount: 5, columnCount: 3, createdAt: '', updatedAt: '' }],
}
const metaDocument = {
  id: 'ds_00000001',
  name: '销售明细',
  version: 1,
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
  source: { kind: 'csv' },
  schema: [
    { name: 'region', type: 'string', role: 'dimension', nullable: false },
    { name: 'amount', type: 'number', role: 'measure', nullable: true },
    { name: 'month', type: 'date', role: 'dimension', nullable: false },
  ],
  rows: 5,
  stats: { nullRateByColumn: { amount: 0.2 }, distinctByColumn: { region: 3 }, columns: {} },
  derived: [{ name: 'gross', expression: 'amount * 1.1', type: 'number', dependsOn: ['amount'] }],
}
const dataRows = [
  { region: '东', amount: 10, month: '2026-01-01' },
  { region: '西', amount: 20, month: '2026-02-01' },
  { region: '东', amount: 5, month: '2026-01-01' },
  { region: '西', amount: null, month: '2026-02-01' },
  { region: '北', amount: 3, month: '2026-03-01' },
]
const chartsDocument = {
  updatedAt: '2026-10-30T00:00:00.000Z',
  charts: [{
    id: 'ch_00000001', datasetId: 'ds_00000001', datasetVersion: 1, name: '按区域', createdAt: '2026-10-30T00:00:00.000Z',
    type: 'bar', encoding: { x: { field: 'region', type: 'dimension' }, y: [{ field: 'amount', agg: 'sum' }] }, filters: [], options: {},
  }],
}

/**
 * Helper to make a workspace text value.
 * @param text - File text without trailing newline.
 * @returns A `WorkspaceFileText`-shaped value.
 */
function textOf(text) {
  const lines = text.length === 0 ? 0 : text.split('\n').length
  return { offset: 1, lines, eof: true, size: text.length, text, mtime: '2026-10-30T00:00:00.000Z' }
}

// The registration above is awkward; exercise the shipped face factory directly.
const remoteCalls = []
const faceCtx = {
  remote: {
    workspaceFiles: {
      async read(sessionId, path, range) {
        remoteCalls.push({ sessionId, path, range })
        if (path === '.analysis/datasets/_index.json') return { ok: true, value: textOf(JSON.stringify(indexDocument, null, 2)) }
        if (path === '.analysis/datasets/ds_00000001/meta.json') return { ok: true, value: textOf(JSON.stringify(metaDocument, null, 2)) }
        if (path === '.analysis/datasets/ds_00000001/data.ndjson') {
          return { ok: true, value: { ...textOf(dataRows.map(row => JSON.stringify(row)).join('\n')), eof: false } }
        }
        if (path === '.analysis/charts/_index.json') return { ok: true, value: textOf(JSON.stringify(chartsDocument, null, 2)) }
        return { ok: false, error: { code: 'workspace-file/not-found', message: path + ' not found' } }
      },
    },
  },
}

/**
 * Create the face through the registered slot's inject factory.
 * @param ctx - Fake client context.
 * @returns The face.
 */
function faceFrom(ctx) {
  let spec
  const slots = {
    inject(owner, factory) { factory() },
    register(value) { spec = value; return () => {} },
  }
  const apply = plugin.apply
  const fakeCtx = {
    ...ctx,
    effect(fn) { fn(); return () => {} },
    locale: { register() { return () => {} }, bind: () => t },
    sidebarRightTabs: { register() { return () => {} } },
    slots,
    remote: ctx.remote,
  }
  apply(fakeCtx)
  return spec.inject('session-1')
}

test('face reads index, meta, rows, and charts from the workspace', async () => {
  const face = faceFrom(faceCtx)
  const index = await face.loadIndex(new AbortController().signal)
  assert.equal(index.ok, true)
  assert.equal(index.value.datasets[0].name, '销售明细')
  const meta = await face.loadMeta('ds_00000001', new AbortController().signal)
  assert.equal(meta.ok, true)
  assert.equal(meta.value.schema.length, 3)
  const rows = await face.loadRows('ds_00000001', new AbortController().signal)
  assert.equal(rows.ok, true)
  assert.equal(rows.value.rows.length, 5)
  assert.equal(rows.value.eof, false)
  const charts = await face.loadCharts(new AbortController().signal)
  assert.equal(charts.ok, true)
  assert.equal(charts.value.charts[0].id, 'ch_00000001')
  const missing = await face.loadMeta('ds_missing', new AbortController().signal)
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'workspace-file/not-found')
  assert.ok(remoteCalls.every(call => call.sessionId === 'session-1'))
})

test('face retries the row read with a smaller limit after a bad-request', async () => {
  const calls = []
  const ctx = {
    remote: {
      workspaceFiles: {
        async read(sessionId, path, range) {
          calls.push({ path, range })
          if (path.endsWith('data.ndjson') && range.limit === 5000) {
            return { ok: false, error: { code: 'gateway/bad-request', message: 'limit exceeds the configured maximum' } }
          }
          return { ok: true, value: { ...textOf(JSON.stringify({ a: 1 })), eof: true } }
        },
      },
    },
  }
  const face = faceFrom(ctx)
  const rows = await face.loadRows('ds_x', new AbortController().signal)
  assert.equal(rows.ok, true)
  assert.equal(rows.value.rows.length, 1)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].range.limit, 5000)
  assert.equal(calls[1].range.limit, 1000)
})

// --- aggregation ----------------------------------------------------------

const schema = metaDocument.schema
const rows = dataRows

const sumBar = plugin.__test.computeChart({
  type: 'bar',
  encoding: { x: { field: 'region', type: 'dimension' }, y: [{ field: 'amount', agg: 'sum' }] },
  filters: [],
  options: {},
}, rows, schema, t)

test('bar aggregates sum per category and skips null cells', () => {
  assert.equal(sumBar.kind, 'series')
  assert.deepEqual(sumBar.categories.map(category => category.label), ['东', '西', '北'])
  assert.deepEqual(sumBar.series[0].values, [15, 20, 3])
  assert.equal(sumBar.series[0].name, '求和(amount)')
})

test('average uses only non-null cells', () => {
  const avg = plugin.__test.computeChart({
    type: 'bar',
    encoding: { x: { field: 'region', type: 'dimension' }, y: [{ field: 'amount', agg: 'avg' }] },
    filters: [], options: {},
  }, rows, schema, t)
  assert.deepEqual(avg.series[0].values, [7.5, 20, 3])
})

test('median matches a hand-computed quantile', () => {
  const median = plugin.__test.computeChart({
    type: 'kpi',
    encoding: { y: [{ field: 'amount', agg: 'p50' }] },
    filters: [], options: {},
  }, rows, schema, t)
  assert.equal(median.kind, 'kpi')
  // Non-null amounts are 3, 5, 10, 20; the interpolated median of an even count is 7.5.
  assert.equal(median.value, 7.5)
  assert.equal(median.rows, 5)
})

test('count counts rows, countDistinct skips null', () => {
  const count = plugin.__test.computeChart({
    type: 'kpi', encoding: { y: [{ field: 'amount', agg: 'count' }] }, filters: [], options: {},
  }, rows, schema, t)
  assert.equal(count.value, 5)
  const distinct = plugin.__test.computeChart({
    type: 'kpi', encoding: { y: [{ field: 'region', agg: 'countDistinct' }] }, filters: [], options: {},
  }, rows, schema, t)
  assert.equal(distinct.value, 3)
})

test('date categories are grouped by day and sorted', () => {
  const line = plugin.__test.computeChart({
    type: 'line',
    encoding: { x: { field: 'month', type: 'time' }, y: [{ field: 'amount', agg: 'sum' }] },
    filters: [], options: {},
  }, rows, schema, t)
  assert.deepEqual(line.categories.map(category => category.label), ['2026-01-01', '2026-02-01', '2026-03-01'])
  assert.deepEqual(line.series[0].values, [15, 20, 3])
})

test('pie slices carry raw values and percentages', () => {
  const pie = plugin.__test.computeChart({
    type: 'pie',
    encoding: { x: { field: 'region', type: 'dimension' }, y: [{ field: 'amount', agg: 'sum' }] },
    filters: [], options: {},
  }, rows, schema, t)
  assert.equal(pie.kind, 'pie')
  assert.deepEqual(pie.slices.map(slice => slice.label), ['西', '东', '北'])
  assert.deepEqual(pie.slices.map(slice => slice.value), [20, 15, 3])
  assert.equal(pie.slices[0].raw, '西')
  assert.equal(pie.total, 38)
})

test('saved filters narrow the local sample', () => {
  const filtered = plugin.__test.computeChart({
    type: 'bar',
    encoding: { x: { field: 'region', type: 'dimension' }, y: [{ field: 'amount', agg: 'sum' }] },
    filters: [{ field: 'region', op: 'in', value: ['东'] }],
    options: {},
  }, rows, schema, t)
  assert.deepEqual(filtered.categories.map(category => category.label), ['东'])
  assert.deepEqual(filtered.series[0].values, [15])
  const byDate = plugin.__test.computeChart({
    type: 'kpi', encoding: { y: [{ field: 'amount', agg: 'sum' }] },
    filters: [{ field: 'month', op: 'startsWith', value: '2026-02' }], options: {},
  }, rows, schema, t)
  assert.equal(byDate.value, 20)
})

test('scatter plots numeric pairs', () => {
  const scatter = plugin.__test.computeChart({
    type: 'scatter',
    encoding: { x: { field: 'amount', type: 'measure' }, y: [{ field: 'amount', agg: 'none' }, { field: 'amount', agg: 'none' }] },
    filters: [], options: {},
  }, [
    { amount: 1, other: 2 },
    { amount: 3, other: 4 },
  ], [
    { name: 'amount', type: 'number', role: 'measure' },
    { name: 'other', type: 'number', role: 'measure' },
  ], t)
  assert.equal(scatter.kind, 'scatter')
  assert.equal(scatter.points.length, 2)
  assert.equal(scatter.xField, 'amount')
})

test('table returns filtered rows in schema order', () => {
  const table = plugin.__test.computeChart({
    type: 'table', encoding: {}, filters: [{ field: 'region', op: '=', value: '东' }], options: {},
  }, rows, schema, t)
  assert.equal(table.kind, 'table')
  assert.deepEqual(table.columns, ['region', 'amount', 'month'])
  assert.equal(table.rows.length, 2)
  assert.equal(table.total, 2)
})

test('empty models explain the missing encoding', () => {
  const noDimension = plugin.__test.computeChart({ type: 'bar', encoding: { y: [{ field: 'amount', agg: 'sum' }] }, filters: [], options: {} }, rows, schema, t)
  assert.deepEqual(noDimension, { kind: 'empty', reason: 'needDimension' })
  const noMeasure = plugin.__test.computeChart({ type: 'bar', encoding: { x: { field: 'region' } }, filters: [], options: {} }, rows, schema, t)
  assert.deepEqual(noMeasure, { kind: 'empty', reason: 'needMeasure' })
  const noRows = plugin.__test.computeChart({ type: 'bar', encoding: { x: { field: 'region' }, y: [{ field: 'amount', agg: 'sum' }] }, filters: [{ field: 'region', op: '=', value: '南' }], options: {} }, rows, schema, t)
  assert.deepEqual(noRows, { kind: 'empty', reason: 'noRows' })
  const badScatter = plugin.__test.computeChart({ type: 'scatter', encoding: { y: [{ field: 'region', agg: 'none' }] }, filters: [], options: {} }, rows, schema, t)
  assert.deepEqual(badScatter, { kind: 'empty', reason: 'needTwoMeasures' })
})

test('draft spec mirrors the builder controls', () => {
  const spec = plugin.__test.draftSpec({ type: 'bar', dimension: 'region', measure: 'amount', agg: 'sum', series: '', horizontal: true, stacked: false, showValues: false })
  assert.deepEqual(spec.encoding.y, [{ field: 'amount', agg: 'sum' }])
  assert.equal(spec.options.horizontal, true)
  const count = plugin.__test.draftSpec({ type: 'kpi', dimension: '', measure: '', agg: 'count' })
  assert.deepEqual(count.encoding.y, [{ field: '*', agg: 'count' }])
  const table = plugin.__test.draftSpec({ type: 'table', dimension: '', measure: '', agg: 'sum' })
  assert.deepEqual(table.encoding, { y: [] })
})

test('tick selection stays monotonic and bounded', () => {
  const ticks = plugin.__test.niceTicks(-3, 27, 4)
  assert.ok(ticks.length > 1 && ticks.length <= 12)
  for (let index = 1; index < ticks.length; index += 1) assert.ok(ticks[index] > ticks[index - 1])
  assert.ok(ticks[0] <= -3 && ticks[ticks.length - 1] >= 27)
})

// --- SVG output -----------------------------------------------------------

/**
 * Collect every element type in a rendered tree.
 * @param node - Element or children array.
 * @param types - Collector.
 * @param classes - Collector of className values.
 */
function collect(node, types = [], classes = []) {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, types, classes)
    return { types, classes }
  }
  if (!node || typeof node !== 'object') return { types, classes }
  types.push(node.type)
  if (node.props && typeof node.props.className === 'string') classes.push(node.props.className)
  collect(node.children, types, classes)
  return { types, classes }
}

test('bar chart renders an SVG with palette classes and tooltips', () => {
  const element = plugin.__test.ChartBody({
    model: sumBar, t, hidden: [], onToggleSeries: () => {}, onDrill: () => {}, schema,
  })
  const { types, classes } = collect(element)
  assert.ok(types.includes('svg'))
  assert.ok(types.filter(type => type === 'rect').length >= 3)
  assert.ok(types.filter(type => type === 'title').length >= 3)
  assert.ok(classes.some(value => value.includes('da-c1')))
  assert.ok(classes.every(value => !value.includes('#')))
})

test('stacked horizontal bars and lines render', () => {
  const horizontal = plugin.__test.computeChart({
    type: 'bar',
    encoding: { x: { field: 'region', type: 'dimension' }, y: [{ field: 'amount', agg: 'sum' }] },
    filters: [], options: { horizontal: true, stacked: false },
  }, rows, schema, t)
  const tree = collect(plugin.__test.ChartBody({ model: horizontal, t, hidden: [], onToggleSeries: () => {}, onDrill: () => {}, schema }))
  assert.ok(tree.types.includes('svg'))

  const line = plugin.__test.computeChart({
    type: 'line',
    encoding: { x: { field: 'month', type: 'time' }, y: [{ field: 'amount', agg: 'sum' }] },
    filters: [], options: {},
  }, rows, schema, t)
  const lineTree = collect(plugin.__test.ChartBody({ model: line, t, hidden: [], onToggleSeries: () => {}, onDrill: () => {}, schema }))
  assert.ok(lineTree.types.includes('polyline'))
})

test('pie, scatter, kpi, and table models render', () => {
  const pie = plugin.__test.computeChart({
    type: 'pie',
    encoding: { x: { field: 'region', type: 'dimension' }, y: [{ field: 'amount', agg: 'sum' }] },
    filters: [], options: {},
  }, rows, schema, t)
  const pieTree = collect(plugin.__test.ChartBody({ model: pie, t, hidden: [], onToggleSeries: () => {}, onDrill: () => {}, schema }))
  assert.ok(pieTree.types.includes('path'))

  const scatter = plugin.__test.computeChart({
    type: 'scatter',
    encoding: { y: [{ field: 'amount', agg: 'none' }, { field: 'amount', agg: 'none' }] },
    filters: [], options: {},
  }, rows, schema, t)
  assert.equal(scatter.kind, 'scatter')
  const scatterTree = collect(plugin.__test.ChartBody({ model: scatter, t, hidden: [], onToggleSeries: () => {}, onDrill: () => {}, schema }))
  assert.ok(scatterTree.types.filter(type => type === 'circle').length >= 2)

  const kpi = plugin.__test.computeChart({
    type: 'kpi', encoding: { y: [{ field: 'amount', agg: 'sum' }] }, filters: [], options: {},
  }, rows, schema, t)
  const kpiTree = collect(plugin.__test.ChartBody({ model: kpi, t, hidden: [], onToggleSeries: () => {}, onDrill: () => {}, schema }))
  assert.ok(kpiTree.classes.some(value => value.includes('da-kpi-value')))

  const table = plugin.__test.computeChart({ type: 'table', encoding: {}, filters: [], options: {} }, rows, schema, t)
  const tableTree = collect(plugin.__test.ChartBody({ model: table, t, hidden: [], onToggleSeries: () => {}, onDrill: () => {}, schema }))
  assert.ok(tableTree.types.includes('table'))
})

test('hidden series empties the chart with an explanation', () => {
  const tree = collect(plugin.__test.ChartBody({ model: sumBar, t, hidden: ['求和(amount)'], onToggleSeries: () => {}, onDrill: () => {}, schema }))
  assert.equal(tree.types.includes('svg'), false)
})

// --- run ------------------------------------------------------------------

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log('ok   ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL ' + name)
    console.log('     ' + String(error && error.message ? error.message : error))
  }
}
console.log('')
console.log((tests.length - failed) + '/' + tests.length + ' client checks passed')
if (failed > 0) process.exitCode = 1
