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

test('apply registers dictionaries, the workbench page, the sidebar row, the tab type, the body, and styles', () => {
  assert.deepEqual(plugin.inject, [
    'slots', 'locale', 'layout', 'uiSession', 'sidebarRightTabs', 'sidebarRight', 'remote', 'remote.workspaceFiles',
  ])
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
  assert.equal(slots.length, 4)
  assert.equal(slots[0].spec.name, 'main')
  assert.equal(slots[0].spec.key, 'data-analysis')
  assert.equal(slots[0].spec.locale, 'dataAnalysis')
  assert.equal(typeof slots[0].component, 'function')
  assert.equal(slots[1].spec.name, 'sidebar.panellist')
  assert.equal(slots[1].spec.id, 'data-analysis')
  assert.equal(slots[1].spec.order, 30)
  assert.equal(slots[1].spec.label(), '数据分析')
  assert.equal(typeof slots[1].component, 'function')
  assert.equal(slots[1].component({}).type, 'svg')
  assert.equal(slots[2].spec.key, 'dsh-data-analysis')
  assert.equal(slots[2].spec.locale, 'dataAnalysis')
  assert.equal(typeof slots[2].spec.inject, 'function')
  assert.equal(slots[2].component.name, 'AnalysisPane')
  assert.equal(slots.length, 4)
  assert.equal(slots[3].spec.name, 'conversation.input.dock')
  assert.equal(slots[3].spec.id, 'data-analysis-ai-bridge')
  assert.equal(slots[3].component.name, 'AiDockBridge')
  assert.equal(slots[3].component({ inputActions: { setDraft() {} } }), null)
  assert.ok(effects.some(label => label.includes('workbench page')))
  assert.ok(effects.some(label => label.includes('sidebar row')))
  assert.ok(effects.some(label => label.includes('styles')))
  assert.ok(effects.some(label => label.includes('tab body')))
  assert.ok(effects.some(label => label.includes('ai bridge')))
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
 * @param sessionId - Session the tab is bound to; omit to stand for "no conversation open".
 * @returns The face.
 */
function faceFrom(ctx, sessionId = 'session-1') {
  let spec
  const slots = {
    inject(owner, factory) { factory() },
    register(value) {
      // The dock bridge registers last and carries no face; keep the panel body.
      if (value.name === 'sidebar.right.pane.tab') spec = value
      return () => {}
    },
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
  return spec.inject(sessionId)
}

/**
 * Answer one workbench API path the way the Host does.
 * @param pathname - Requested path below the plugin API prefix.
 * @param query - Query parameters.
 * @returns A Response carrying the shared envelope.
 */
function fakeApi(pathname, query) {
  const envelope = value => new Response(JSON.stringify({ ok: true, value }), { status: 200 })
  if (pathname === '/state') {
    return envelope({ datasets: [{ id: 'ds_00000001', name: '销售明细' }], charts: [{ id: 'ch_00000001' }], connections: [], sources: [] })
  }
  if (pathname === '/dataset') {
    if (query.get('id') !== 'ds_00000001') {
      return new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'no such dataset' } }), { status: 400 })
    }
    return envelope({ meta: metaDocument, profile: {}, preview: [] })
  }
  if (pathname === '/rows') return envelope({ rows: dataRows, lines: 5, eof: false })
  return new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'no route' } }), { status: 404 })
}

test('face reads state, meta, rows, and charts over the workbench API', async () => {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async input => {
    const url = new URL(String(input), 'http://localhost')
    seen.push({ pathname: url.pathname, session: url.searchParams.get('sessionId') })
    return fakeApi(url.pathname.slice('/plugins/data-analysis/api'.length), url.searchParams)
  }
  try {
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
    assert.equal(missing.error.code, 'not_found')
    assert.ok(seen.every(call => call.session === 'session-1'))
  } finally {
    globalThis.fetch = original
  }
})

test('face reports an expired sign-in instead of a generic failure', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('{}', { status: 401 })
  try {
    const face = faceFrom(faceCtx)
    const rows = await face.loadRows('ds_x', new AbortController().signal)
    assert.equal(rows.ok, false)
    assert.equal(rows.error.code, 'unauthorized')
  } finally {
    globalThis.fetch = original
  }
})

test('face reports an unreachable Host as a network failure', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('fetch failed') }
  try {
    const face = faceFrom(faceCtx)
    const state = await face.state(new AbortController().signal)
    assert.equal(state.ok, false)
    assert.equal(state.error.code, 'network')
  } finally {
    globalThis.fetch = original
  }
})

// The right-sidebar tab can be mounted with no conversation in view. Firing a
// request then only earns "needs a sessionId with a workspace" on the Host, so
// the face answers locally and the pane shows its empty state instead.
test('face without a Session refuses locally instead of calling the Host', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response('{}', { status: 200 })
  }
  try {
    // `null` keeps the missing-Session path while still bypassing faceFrom's
    // default; the guard treats every non-string the same way, `undefined` too.
    const face = faceFrom(faceCtx, null)
    assert.equal(face.sessionMissing, true)
    const state = await face.state(new AbortController().signal)
    assert.equal(state.ok, false)
    assert.equal(state.error.code, 'no_session')
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('face explains a missing workspace in the reader language', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    error: { code: 'missing_workspace', message: 'This request needs a sessionId with a workspace, or an absolute cwd.' },
  }), { status: 400 })
  try {
    const face = faceFrom(faceCtx)
    const state = await face.state(new AbortController().signal)
    assert.equal(state.ok, false)
    assert.equal(state.error.code, 'missing_workspace')
    // The Host phrase is a log line; the page owes the reader what to do about
    // it, in their own language.
    assert.ok(state.error.message.includes('对话'), state.error.message)
    assert.notEqual(state.error.message, 'This request needs a sessionId with a workspace, or an absolute cwd.')
  } finally {
    globalThis.fetch = original
  }
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

// --- workbook worksheet picker ---------------------------------------------

/**
 * Collect the text nodes and checkbox props of a rendered tree.
 * @param node - Element or children array.
 * @param out - `{ texts, checks }` collector.
 * @returns The collector.
 */
function survey(node, out = { texts: [], checks: [] }) {
  if (Array.isArray(node)) {
    for (const child of node) survey(child, out)
    return out
  }
  if (typeof node === 'string') {
    out.texts.push(node)
    return out
  }
  if (!node || typeof node !== 'object') return out
  if (node.type === 'input') out.checks.push(node.props)
  survey(node.children, out)
  return out
}

test('worksheet picker lists every tab with its size and locks empty ones', () => {
  const element = plugin.__test.SheetPicker({
    sheets: [
      { name: '订单', rows: 120, columns: 4, header: ['日期', '金额'] },
      { name: '空白', rows: 0, columns: 1, empty: true, header: ['备注'] },
    ],
    picked: { 订单: true },
    busy: false,
    t,
    onPick: () => {},
    onPickAll: () => {},
    onPickNone: () => {},
  })
  const { texts, checks } = survey(element)
  assert.equal(checks.length, 2, 'one checkbox per worksheet')
  assert.equal(checks[0].checked, true)
  assert.equal(checks[0].disabled, false)
  assert.equal(checks[1].checked, false)
  assert.equal(checks[1].disabled, true, 'a header-only tab cannot be imported')
  assert.ok(texts.includes('订单'))
  assert.ok(texts.includes('120 行 · 4 列'))
  assert.ok(texts.includes('空工作表'))
  assert.ok(texts.includes('共 2 个工作表 · 已选 1 个'))
  assert.ok(texts.includes('首行：日期 · 金额'))
})

test('multi-dataset brief covers every table and asks for join keys', () => {
  const meta = (id, name, columns) => ({
    id,
    name,
    rowCount: 100,
    columnCount: columns.length,
    schema: columns.map(column => ({ name: column, type: 'number', role: 'measure' })),
    stats: { columns: {}, nullRateByColumn: {} },
  })
  const balance = meta('ds_bs', '资产负债表', ['期间', '货币资金', '资产总计'])
  const income = meta('ds_is', '利润表', ['期间', '营业收入', '净利润'])
  const cash = meta('ds_cf', '现金流量表', ['期间', '经营现金流净额'])

  const single = plugin.__test.composeBrief([balance], ['overview'], '')
  assert.ok(single.includes('请分析数据集「资产负债表」'), single.slice(0, 120))
  assert.equal(single.includes('跨数据集要求'), false, 'one dataset needs no join rule')
  assert.equal(single.includes('每次调用都要带自己的 datasetId'), false)

  const multi = plugin.__test.composeBrief([balance, income, cash], ['overview', 'compare'], '单位：万元')
  for (const item of [balance, income, cash]) {
    assert.ok(multi.includes('「' + item.name + '」'), item.name)
    assert.ok(multi.includes(item.id), item.id)
  }
  assert.ok(multi.includes('请一起分析以下 3 个数据集'))
  assert.ok(multi.includes('跨数据集要求'))
  assert.ok(multi.includes('关联键'))
  assert.ok(multi.includes('每次调用都要带自己的 datasetId'))
  assert.ok(multi.includes('补充说明：单位：万元'))
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
