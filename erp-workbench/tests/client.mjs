/**
 * Verification for the browser half of the ERP workbench: module registration,
 * dictionary parity, the sidebar entry, the connection form's payload rules
 * (a blank secret must never overwrite a stored one), and the stylesheet's use
 * of design tokens.
 *
 * Runs in plain Node with a React element stub; it does not exercise a browser.
 * Execute with `node erp-workbench/tests/client.mjs`.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

let config
const windowStub = {
  __DSH_ERP_WORKBENCH_TEST__: true,
  __ModuleLoader__: { load(value) { config = value } },
}
const styleElement = { id: '', dataset: {}, style: {}, textContent: '', remove() {} }
const documentStub = {
  documentElement: { lang: 'zh-CN' },
  getElementById() { return null },
  createElement: () => styleElement,
  head: { append() {} },
}
new Function('window', 'document', source)(windowStub, documentStub)

assert.equal(config.id, 'dsh-erp-workbench', 'module id')

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat() }
  },
  /**
   * @param initial - Value or lazy initializer.
   * @returns State pair; the setter is inert in a static render.
   */
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
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

// --- dictionaries -----------------------------------------------------------

const { dictionaries, families, blankConnection, formOf, connectionPayload, parseObject, actionLabel } = plugin.__test

test('every dictionary key exists in both languages', () => {
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort())
})

test('no English string is left untranslated', () => {
  const same = Object.keys(dictionaries.en)
    .filter(key => dictionaries.en[key] === dictionaries.zh[key])
  assert.deepEqual(same, [], 'these keys read the same in both languages')
})

test('every dictionary value is non-empty text', () => {
  const empty = Object.entries(dictionaries.zh)
    .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
    .map(([key]) => key)
  assert.deepEqual(empty, [])
})

// --- stylesheet -------------------------------------------------------------

const stylesSource = source.slice(source.indexOf('const styles = `'), source.indexOf('function injectStyles'))

test('the stylesheet uses design tokens instead of hardcoded colors', () => {
  assert.ok(stylesSource.length > 0)
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(stylesSource), false, 'no hex colors')
  assert.equal(/\brgb\(|\bhsl\(/.test(stylesSource), false, 'no raw color functions')
  assert.ok(stylesSource.includes('var(--dsw-alias-'))
})

test('no rule is declared twice in the stylesheet', () => {
  const rules = stylesSource
    .split('}')
    .map(rule => rule.trim())
    .filter(rule => rule !== '')
  const duplicates = rules.filter((rule, index) => rules.indexOf(rule) !== index)
  assert.deepEqual(duplicates, [])
})

// --- families ---------------------------------------------------------------

test('both ERP families are offered, and only U8 has versions', () => {
  assert.deepEqual(families.map(entry => entry.id), ['yonyou', 'kingdee'])
  assert.deepEqual(families.find(entry => entry.id === 'yonyou').versions, ['v13', 'v15'])
  assert.deepEqual(families.find(entry => entry.id === 'kingdee').versions, [])
})

// --- connection form --------------------------------------------------------

test('a blank U8 form defaults to v13 and carries no secret', () => {
  const form = blankConnection('yonyou')
  assert.equal(form.version, 'v13')
  assert.equal(form.token, '')
  assert.equal(form.hasToken, false)
})

test('a blank Kingdee form has no version to pick', () => {
  const form = blankConnection('kingdee')
  assert.equal(form.family, 'kingdee')
  assert.equal(form.version, '')
})

test('a stored connection fills the form without restoring its secret', () => {
  const form = formOf({ id: 'conn_1', label: 'U8 生产', family: 'yonyou', version: 'v15', baseUrl: 'https://u8.example.com', hasToken: true })
  assert.equal(form.label, 'U8 生产')
  assert.equal(form.version, 'v15')
  assert.equal(form.baseUrl, 'https://u8.example.com')
  assert.equal(form.hasToken, true)
  // The host never sends the secret back, so the field stays blank; the page
  // shows "saved, leave blank to keep" from hasToken alone.
  assert.equal(form.token, '')
})

test('a new connection gets a generated id and trimmed fields', () => {
  const payload = connectionPayload({
    id: '',
    label: '  本地 U8  ',
    family: 'yonyou',
    version: 'v15',
    baseUrl: '  http://127.0.0.1:8000  ',
    pathPrefix: '   ',
    token: 'tk',
  })
  assert.match(payload.id, /^erp_[0-9a-z]+$/)
  assert.equal(payload.label, '本地 U8')
  assert.equal(payload.baseUrl, 'http://127.0.0.1:8000')
  assert.equal(payload.version, 'v15')
  // A blank prefix is omitted so the connector default applies, not "".
  assert.equal('pathPrefix' in payload, false)
  assert.equal(payload.token, 'tk')
})

test('a blank secret is omitted so the stored one survives an edit', () => {
  const payload = connectionPayload({
    id: 'conn_1',
    label: 'U8',
    family: 'yonyou',
    version: 'v13',
    baseUrl: 'https://u8.example.com',
    token: '',
  })
  assert.equal('token' in payload, false)
})

test('a Kingdee payload carries its own field set, not the U8 one', () => {
  const payload = connectionPayload({
    id: 'conn_2',
    label: '金蝶',
    family: 'kingdee',
    verdict: 'ignored',
    baseUrl: 'https://k3.example.com',
    appId: ' app ',
    appSecret: 'sec',
    acctId: ' acct ',
    token: '',
  })
  assert.deepEqual(Object.keys(payload).sort(), ['acctId', 'appId', 'appSecret', 'baseUrl', 'family', 'id', 'label'])
  assert.equal(payload.appId, 'app')
  assert.equal(payload.acctId, 'acct')
})

test('an unknown version falls back to v13', () => {
  const payload = connectionPayload({ id: 'c', label: 'x', family: 'yonyou', version: 'v99', baseUrl: 'https://a.b', token: 't' })
  assert.equal(payload.version, 'v13')
})

// --- mapping text -----------------------------------------------------------

test('the mapping textarea accepts an object and nothing else', () => {
  assert.deepEqual(parseObject(''), {})
  assert.deepEqual(parseObject('{"version":1}'), { version: 1 })
  assert.equal(parseObject('[1,2]'), undefined, 'an array is not a mapping document')
  assert.equal(parseObject('{"broken":'), undefined)
  assert.equal(parseObject('"text"'), undefined)
})

test('an action is labelled by domain, action, and target api', () => {
  assert.equal(
    actionLabel({ domain: 'contract', action: 'queryPurchaseOrders', api: 'u8_purchase_order_query' }),
    'contract / queryPurchaseOrders → u8_purchase_order_query',
  )
})

// --- registration -----------------------------------------------------------

const registered = []
const localeCalls = []
const ctx = {
  /**
   * @param fn - Effect body.
   * @returns Its disposer.
   */
  effect(fn) { return fn() },
  locale: {
    /**
     * @param namespace - Dictionary namespace.
     * @param values - Dictionaries by language.
     * @returns A disposer.
     */
    register(namespace, values) { localeCalls.push({ namespace, values }); return () => {} },
    /**
     * @param namespace - Dictionary namespace.
     * @returns Translator over that namespace.
     */
    bind(namespace) {
      return (key, params) => {
        const dict = dictionaries.zh
        assert.ok(dict[key] !== undefined, 'missing dictionary key: ' + key)
        return String(dict[key]).replace(/\{(.*?)\}/g, (match, name) => (
          params?.[name] === undefined ? match : String(params[name])
        ))
      }
    },
  },
  slots: {
    /**
     * @param name - Slot name.
     * @param body - Registration body.
     * @returns Its result.
     */
    inject(name, body) { return body(name) },
    /**
     * @param meta - Slot metadata.
     * @param component - Slot component.
     * @returns The registration.
     */
    register(meta, component) { registered.push({ meta, component }); return () => {} },
  },
  layout: { selectPanel() {} },
}

plugin.apply(ctx)

test('applying registers the dictionaries under one namespace', () => {
  assert.equal(localeCalls.length, 1)
  assert.equal(localeCalls[0].namespace, 'erpWorkbench')
  assert.deepEqual(localeCalls[0].values, dictionaries)
})

test('applying contributes the page and exactly one sidebar row', () => {
  assert.equal(registered.length, 2)
  assert.deepEqual(registered.map(entry => entry.meta.name), ['main', 'sidebar.panellist'])
})

test('the page is keyed so the layout can select it', () => {
  const main = registered.find(entry => entry.meta.name === 'main')
  assert.equal(main.meta.key, 'erp-workbench')
  assert.equal(main.meta.locale, 'erpWorkbench')
})

test('the sidebar row is ordered after the built-in panes and labelled in the panel language', () => {
  const row = registered.find(entry => entry.meta.name === 'sidebar.panellist')
  assert.equal(row.meta.id, 'erp-workbench')
  assert.equal(row.meta.order, 31)
  assert.equal(row.meta.label(), dictionaries.zh['tab.title'])
})

test('the sidebar row draws a themed glyph rather than a color-filled icon', () => {
  const row = registered.find(entry => entry.meta.name === 'sidebar.panellist')
  const icon = row.component({})
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props['aria-hidden'], 'true')
  const shapes = icon.children
  assert.ok(shapes.length >= 3)
  for (const shape of shapes) {
    assert.equal(shape.props.stroke, 'currentColor')
    assert.equal(shape.props.fill, 'none')
  }
})

test('the page renders its shell before any request comes back', () => {
  const main = registered.find(entry => entry.meta.name === 'main')
  // The slot layer supplies `t`; here the same translator is passed directly.
  const html = walk(main.component({ ctx, t: ctx.locale.bind('erpWorkbench'), onBack: () => {} }))
  // The frame is there while data loads: title, subtitle, refresh, and a hint.
  assert.ok(html.includes(dictionaries.zh['tab.title']), 'title')
  assert.ok(html.includes(dictionaries.zh['tab.subtitle']), 'subtitle')
  assert.ok(html.includes(dictionaries.zh['action.refresh']), 'refresh')
  assert.ok(html.includes(dictionaries.zh['state.loading']), 'loading hint')
})

/**
 * Flatten a rendered tree into its text, evaluating function components.
 * @param node - Element, child component, string, or array.
 * @param depth - Recursion guard.
 * @returns Concatenated text.
 */
function walk(node, depth = 0) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(child => walk(child, depth)).join(' ')
  assert.ok(depth < 40, 'components nest too deeply; a component probably renders itself')
  if (typeof node.type === 'function') return walk(node.type(node.props), depth + 1)
  return (node.children ?? []).map(child => walk(child, depth + 1)).join(' ')
}

// --- report -----------------------------------------------------------------

let failures = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log('ok   ' + name)
  } catch (error) {
    failures += 1
    console.log('FAIL ' + name + ' — ' + String(error?.message ?? error))
  }
}
console.log('\n' + (tests.length - failures) + '/' + tests.length + ' erp workbench client checks passed')
if (failures > 0) process.exitCode = 1
