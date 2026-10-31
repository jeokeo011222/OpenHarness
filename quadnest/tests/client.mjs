/**
 * Verification for the QuadNest browser half: module registration protocol,
 * locale parity, stylesheet tokens, slot registrations, and the pure world
 * helpers the page runs on. Runs in plain Node with a React element stub; it
 * does not exercise a real browser or Canvas.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

let config
const windowStub = {
  __DSH_QUADNEST_TEST__: true,
  __ModuleLoader__: { load(value) { config = value } },
}
const styleElement = { dataset: {}, textContent: '', remove() {} }
const documentStub = {
  createElement: () => styleElement,
  head: { append() {} },
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
}
new Function('window', 'document', source)(windowStub, documentStub)

assert.equal(config.id, 'dsh-quadnest', 'module id')

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

/**
 * Minimal React stand-in that commits state and effects, so the page component
 * can be mounted in Node and its idle polling driven without a browser.
 * @returns the element factory, mount/flush helpers, and the latest rendered tree.
 */
function createHarness() {
  const hooks = []
  let index = 0
  let dirty = false
  let mounted = false
  let component = null
  let props = null
  let latest = null
  let renderQueued = false

  const sameDeps = (previous, next) => {
    if (previous === undefined || next === undefined) return false
    if (previous.length !== next.length) return false
    return previous.every((value, position) => Object.is(value, next[position]))
  }

  function scheduleRender() {
    if (renderQueued) return
    renderQueued = true
    queueMicrotask(() => {
      renderQueued = false
      if (mounted) render()
    })
  }

  function render() {
    index = 0
    dirty = false
    latest = component(props)
    for (const slot of hooks) {
      if (slot === undefined || slot.pending === undefined) continue
      if (sameDeps(slot.committed, slot.dependencies)) {
        slot.pending = undefined
        continue
      }
      if (typeof slot.cleanup === 'function') slot.cleanup()
      const cleanup = slot.pending()
      slot.pending = undefined
      slot.committed = slot.dependencies
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
    index = 0
    if (dirty) scheduleRender()
  }

  const React = {
    createElement(type, elementProps, ...children) {
      return { type, props: elementProps ?? {}, children: children.flat() }
    },
    useState(initial) {
      const id = index++
      if (hooks[id] === undefined) hooks[id] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = hooks[id]
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        dirty = true
        scheduleRender()
      }]
    },
    useRef(initial) {
      const id = index++
      if (hooks[id] === undefined) hooks[id] = { current: initial }
      return hooks[id]
    },
    useMemo(factory, dependencies) {
      const id = index++
      if (hooks[id] === undefined || !sameDeps(hooks[id].dependencies, dependencies)) {
        hooks[id] = { dependencies, value: factory() }
      }
      return hooks[id].value
    },
    useEffect(create, dependencies) {
      const id = index++
      if (hooks[id] === undefined) hooks[id] = {}
      hooks[id].pending = create
      hooks[id].dependencies = dependencies
    },
  }

  return {
    React,
    mount(page, pageProps) {
      component = page
      props = pageProps
      mounted = true
      render()
      return () => {
        mounted = false
        for (const slot of hooks) {
          if (slot !== undefined && typeof slot.cleanup === 'function') slot.cleanup()
        }
      }
    },
    async flush() {
      for (let round = 0; round < 4; round += 1) {
        await new Promise(resolve => setTimeout(resolve, 0))
        if (dirty && !renderQueued) render()
      }
    },
    /** @returns the newest rendered element tree. */
    get tree() {
      return latest
    },
  }
}

/**
 * Read the visible text of every bot transcript bubble in one rendered tree.
 * @param node - element, string, or array node.
 * @param found - accumulator for finished bubble text.
 * @returns the accumulated bubble texts.
 */
function bubbleTexts(node, found = []) {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'number') return found
  if (typeof node === 'string') return found
  const className = typeof node.props?.className === 'string' ? node.props.className : ''
  if (className.split(' ').includes('qn-msg-bot')) {
    found.push(node.children.filter(child => typeof child === 'string').join(''))
    return found
  }
  for (const child of node.children ?? []) bubbleTexts(child, found)
  return found
}

/**
 * Collect every visible string in one rendered tree, labels included.
 * @param node - element, string, or array node.
 * @param found - accumulator for collected text.
 * @returns the accumulated strings in document order.
 */
function textOf(node, found = []) {
  if (typeof node === 'string') {
    found.push(node)
    return found
  }
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, found)
    return found
  }
  for (const child of node.children ?? []) textOf(child, found)
  return found
}

/**
 * Collect every element in one rendered tree that satisfies a predicate.
 * @param node - element, string, or array node.
 * @param predicate - test applied to each element node.
 * @param found - accumulator for matches.
 * @returns the matching elements in document order.
 */
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, found)
  return found
}

/**
 * Find rendered elements carrying one class name.
 * @param tree - rendered tree root.
 * @param name - class name to match as a whole word.
 * @returns the matching elements in document order.
 */
function byClass(tree, name) {
  return findAll(tree, node => String(node.props?.className ?? '').split(' ').includes(name))
}

/**
 * Find the button whose visible text is exactly `label`.
 * @param tree - rendered tree root.
 * @param label - expected button text.
 * @returns the matching button, or undefined.
 */
function byText(tree, label) {
  return findAll(tree, node => node.type === 'button' && textOf(node).join('') === label)[0]
}

const MODEL = { provider: 'provider', model: 'model' }
const STATUS_PAYLOAD = { ready: true, model: MODEL, bots: ['star', 'suyou', 'spirit', 'nook'], idleMs: 60_000 }

/**
 * Build a response object shaped like the subset of `fetch` the page reads.
 * @param payload - JSON body to return.
 * @param ok - whether the response counts as successful.
 * @param status - HTTP status code.
 * @returns a stub response.
 */
function jsonResponse(payload, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => payload }
}

/**
 * Install the browser globals the page needs — a clock, localStorage, timers,
 * and a recording fetch — so the component can be driven in Node.
 * @param handler - receives each recorded request; returns a stub response.
 * @returns the live browser state plus `advance`, `tick`, and `restore`.
 */
function installBrowser(handler) {
  const state = {
    clock: 1_000,
    requests: [],
    intervals: [],
    store: new Map(),
  }
  const previous = {
    now: Date.now,
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    localStorage: globalThis.localStorage,
  }
  Date.now = () => state.clock
  globalThis.localStorage = {
    getItem: key => state.store.get(key) ?? null,
    setItem: (key, value) => { state.store.set(key, String(value)) },
  }
  globalThis.setInterval = (callback) => { state.intervals.push(callback); return state.intervals.length }
  globalThis.clearInterval = () => {}
  globalThis.fetch = async (url, init) => {
    const request = {
      url: String(url),
      method: init !== undefined && typeof init.method === 'string' ? init.method : 'GET',
      body: init !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : null,
    }
    state.requests.push(request)
    return handler(request, state)
  }
  /** Move the stub clock forward without firing timers. */
  state.advance = (ms) => { state.clock += ms }
  /** Fire the most recently installed interval callback. */
  state.tick = () => { const latest = state.intervals.at(-1); if (latest !== undefined) latest() }
  /** Put every patched global back, so one test cannot leak into the next. */
  state.restore = () => {
    Date.now = previous.now
    globalThis.fetch = previous.fetch
    globalThis.setInterval = previous.setInterval
    globalThis.clearInterval = previous.clearInterval
    globalThis.localStorage = previous.localStorage
  }
  return state
}

/**
 * Build the page factory against the harness React and mount it.
 * @param harness - harness from `createHarness`.
 * @returns the unmount function.
 */
function mountPage(harness) {
  const ui = config.factory((name) => {
    if (name === 'react') return harness.React
    throw new Error('unexpected require(' + name + ')')
  })
  return harness.mount(ui.__test.QuadNestPage, {
    ctx: { layout: { selectPanel() {} } },
    t,
  })
}

/** Store key the page persists its world under. */
const STORE_KEY = 'dsh.quadnest.world.v1'

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// --- dictionaries ---------------------------------------------------------

const dictionaries = plugin.__test.dictionaries
test('locale dictionaries share every key and hold prose', () => {
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort())
  const empty = Object.keys(dictionaries.zh).filter(key => String(dictionaries.zh[key]).trim() === '' || String(dictionaries.en[key]).trim() === '')
  assert.deepEqual(empty, [])
})

/**
 * Translate one dictionary key for tests.
 * @param locale - Dictionary to read.
 * @returns A translator with `{name}` substitution.
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

// --- stylesheet -----------------------------------------------------------

const cssSource = source.slice(source.indexOf('const CSS = `'), source.indexOf('\n    /**\n     * Build the locale key'))
test('the stylesheet uses design tokens instead of hex colors', () => {
  assert.ok(cssSource.length > 0)
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(cssSource), false, 'CSS must not hardcode hex colors')
  assert.ok(cssSource.includes('var(--dsw-alias-'))
})

// --- registration ---------------------------------------------------------

test('apply registers dictionaries, the world page, the sidebar row, and styles', () => {
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'layout'])
  const effects = []
  const locales = []
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
    slots: {
      inject(owner, factory) { factory(); return () => {} },
      register(spec, component) { slots.push({ spec, component }); return () => {} },
    },
  }
  plugin.apply(ctx)
  assert.deepEqual(locales.map(entry => entry.namespace), ['quadnest'])
  assert.equal(slots.length, 2)
  assert.equal(slots[0].spec.name, 'main')
  assert.equal(slots[0].spec.key, 'quadnest')
  assert.equal(slots[0].spec.locale, 'quadnest')
  assert.equal(typeof slots[0].component, 'function')
  assert.equal(slots[1].spec.name, 'sidebar.panellist')
  assert.equal(slots[1].spec.id, 'quadnest')
  assert.equal(slots[1].spec.order, 40)
  assert.equal(slots[1].spec.label(), '四机小境')
  assert.equal(slots[1].component({}).type, 'svg')
  assert.equal(styleElement.dataset.plugin, 'dsh-quadnest')
  assert.ok(effects.some(label => label.includes('world page')))
  assert.ok(effects.some(label => label.includes('sidebar row')))
  assert.ok(effects.some(label => label.includes('styles')))
})

// --- world state ----------------------------------------------------------

const now = 1_700_000_000_000
const fresh = plugin.__test.defaultWorld(now)
test('a fresh world starts at the beach with every companion and a full item catalogue', () => {
  assert.equal(fresh.version, 1)
  assert.equal(fresh.scene, 'beach')
  assert.equal(fresh.target, 'star')
  assert.deepEqual(Object.keys(fresh.bag), ['shell', 'flower', 'torch', 'book', 'gem', 'lantern'])
  assert.ok(Object.values(fresh.bag).every(count => count === 0))
  assert.deepEqual(Object.keys(fresh.chars), ['star', 'suyou', 'spirit', 'nook'])
  assert.equal(fresh.chars.star.scene, 'beach')
  assert.equal(fresh.updatedAt, now)
})

test('stored worlds are repaired rather than trusted', () => {
  const world = plugin.__test.normalizeWorld({
    scene: 'moon',
    target: 'group',
    bag: { shell: 3.9, gem: -2, lantern: 5000, mystery: 4 },
    items: [
      { item: 'shell', id: 'item-1', scene: 'cave', x: 100, z: -100, at: 5 },
      { item: 'rock', x: 1, z: 1 },
      null,
    ],
    chars: { star: { scene: 'moon', x: 100, z: 'x', anim: 'dance' } },
    messages: [
      { kind: 'user', text: '你好', at: 1, bot: 'star' },
      { kind: 'weird', text: 'hi', bot: 'stranger' },
      { kind: 'note', text: '' },
    ],
  }, now)
  assert.equal(world.scene, 'beach')
  assert.equal(world.target, 'group')
  assert.deepEqual(world.bag, { shell: 3, flower: 0, torch: 0, book: 0, gem: 0, lantern: 999 })
  assert.equal(world.items.length, 1)
  assert.equal(world.items[0].item, 'shell')
  assert.equal(world.items[0].id, 'item-1')
  assert.equal(world.items[0].scene, 'cave')
  assert.equal(world.items[0].x, 40)
  assert.equal(world.items[0].z, -40)
  assert.equal(world.chars.star.scene, 'beach')
  assert.equal(world.chars.star.x, 40)
  assert.equal(world.chars.star.z, 0.6)
  assert.equal(world.chars.star.anim, 'idle')
  assert.equal(world.messages.length, 2)
  assert.equal(world.messages[0].kind, 'user')
  assert.equal(world.messages[0].bot, 'star')
  assert.equal(world.messages[1].kind, 'note')
  assert.equal(world.messages[1].bot, undefined)
})

test('the transcript keeps only the newest entries at the bound', () => {
  const full = plugin.__test.defaultWorld(0)
  full.messages = Array.from({ length: 200 }, (_, index) => ({ id: 'm' + index, kind: 'note', text: 'n' + index, at: index }))
  const grown = plugin.__test.appendMessage(full, { kind: 'user', text: 'latest', at: 999 })
  assert.equal(grown.messages.length, 200)
  assert.equal(grown.messages[grown.messages.length - 1].text, 'latest')
  assert.equal(grown.messages[0].text, 'n1')
})

// --- picture instructions -------------------------------------------------

test('change_scene moves every companion and records one note', () => {
  const result = plugin.__test.applyActions(fresh, [{ cmd: 'change_scene', target: 'all', params: { scene: 'meadow' } }], t, now)
  assert.equal(result.world.scene, 'meadow')
  for (const id of ['star', 'suyou', 'spirit', 'nook']) assert.equal(result.world.chars[id].scene, 'meadow')
  assert.deepEqual(result.notes, [{ text: '你们来到了春日草地。', at: now }])
  assert.equal(result.world.chars.star.x, -1.8)
})

test('change_scene can leave a named companion behind', () => {
  const result = plugin.__test.applyActions(fresh, [{
    cmd: 'change_scene', target: 'all', params: { scene: 'starcliff', stay: ['nook'] },
  }], t, now)
  assert.equal(result.world.chars.star.scene, 'starcliff')
  assert.equal(result.world.chars.nook.scene, 'beach')
})

test('spawn_item lands beside the visitor and remove_item drops it by name and id', () => {
  const spawned = plugin.__test.applyActions(fresh, [{ cmd: 'spawn_item', target: 'all', params: { item: 'shell' } }], t, now)
  assert.equal(spawned.world.items.length, 1)
  const item = spawned.world.items[0]
  assert.equal(item.item, 'shell')
  assert.equal(item.scene, 'beach')
  assert.ok(Math.abs(item.x - 2.1) < 1e-9)
  assert.ok(Math.abs(item.z - 3.4) < 1e-9)

  const byName = plugin.__test.applyActions(spawned.world, [{ cmd: 'remove_item', params: { item: 'shell' } }], t, now)
  assert.equal(byName.world.items.length, 0)
  const byId = plugin.__test.applyActions(spawned.world, [{ cmd: 'remove_item', params: { id: item.id } }], t, now)
  assert.equal(byId.world.items.length, 0)
})

test('an unknown scene changes nothing and produces no note', () => {
  const result = plugin.__test.applyActions(fresh, [{ cmd: 'change_scene', target: 'all', params: { scene: 'moon' } }], t, now)
  assert.equal(result.world.scene, 'beach')
  assert.deepEqual(result.notes, [])
})

test('char_move retargets one companion and char_animate plays one animation', () => {
  const moved = plugin.__test.applyActions(fresh, [{ cmd: 'char_move', target: 'suyou', params: { x: 5, z: -3 } }], t, now)
  assert.equal(moved.world.chars.suyou.tx, 5)
  assert.equal(moved.world.chars.suyou.tz, -3)
  assert.equal(moved.world.chars.suyou.anim, 'idle')

  const animated = plugin.__test.applyActions(fresh, [{ cmd: 'char_animate', target: 'nook', params: { animation: 'jump' } }], t, now)
  assert.equal(animated.world.chars.nook.anim, 'jump')
  assert.equal(animated.world.chars.nook.animAt, now)
})

test('gather_all and disperse move companions without touching the scene', () => {
  const far = plugin.__test.defaultWorld(now)
  far.chars.star.scene = 'cave'
  const gathered = plugin.__test.applyActions(far, [{ cmd: 'gather_all' }], t, now)
  assert.equal(gathered.world.chars.star.scene, 'beach')
  assert.ok(Math.abs(gathered.world.chars.star.tz - (3.4 + Math.sin(-0.9) * 1.7)) < 1e-9)

  const spread = plugin.__test.applyActions(fresh, [{ cmd: 'disperse' }], t, now)
  assert.equal(spread.world.chars.star.tx, -1.7)
  assert.equal(spread.world.chars.nook.tz, 2.5)
})

test('pick_item moves one loose item into the backpack and notes it', () => {
  const spawned = plugin.__test.applyActions(fresh, [{ cmd: 'spawn_item', target: 'all', params: { item: 'gem' } }], t, now)
  const picked = plugin.__test.pickItem(spawned.world, spawned.world.items[0].id, t, now)
  assert.equal(picked.world.items.length, 0)
  assert.equal(picked.world.bag.gem, 1)
  assert.deepEqual(picked.notes, [{ text: '拾取了宝石，放进了背包。', at: now }])
  const missing = plugin.__test.pickItem(fresh, 'nope', t, now)
  assert.equal(missing.world.bag.gem, 0)
  assert.deepEqual(missing.notes, [])
})

test('gift_item spends one carried item and notes the companion', () => {
  const base = plugin.__test.normalizeWorld({ bag: { shell: 1 } }, now)
  const given = plugin.__test.giftItem(base, 'shell', 'suyou', t, now)
  assert.equal(given.world.bag.shell, 0)
  assert.deepEqual(given.notes, [{ text: '你把贝壳送给了溯游，溯游把它放在身边。', at: now }])
  assert.equal(base.bag.shell, 1, 'gifting does not mutate the source world')
  assert.deepEqual(plugin.__test.giftItem(plugin.__test.defaultWorld(now), 'shell', 'suyou', t, now).notes, [])
  assert.deepEqual(plugin.__test.giftItem(base, 'shell', 'group', t, now).notes, [])
})

test('a leading addressee overrides the selected target', () => {
  assert.equal(plugin.__test.mentionedTarget('大家，晚上好'), 'group')
  assert.equal(plugin.__test.mentionedTarget('hello there'), null)
  assert.equal(plugin.__test.mentionedTarget('星伴：你好呀'), 'star')
  assert.equal(plugin.__test.mentionedTarget('StarPaeon, hi'), 'star')
  assert.equal(plugin.__test.mentionedTarget('溯游你好'), null)
  assert.equal(plugin.__test.mentionedTarget('随便聊聊'), null)
})

test('a companion speaks first only after a quiet, visible, idle page', () => {
  const decide = plugin.__test.shouldOpenConversation
  const quiet = { lastActivityAt: 0, now: 60_000, idleMs: 60_000, busy: false, draft: '', visible: true }
  assert.equal(decide(quiet), true)
  assert.equal(decide({ ...quiet, now: 59_999 }), false, 'the visitor is not quiet yet')
  assert.equal(decide({ ...quiet, busy: true }), false, 'a reply is already in flight')
  assert.equal(decide({ ...quiet, draft: '在写' }), false, 'the visitor is typing')
  assert.equal(decide({ ...quiet, draft: '   ' }), true, 'whitespace is not a draft')
  assert.equal(decide({ ...quiet, visible: false }), false, 'a hidden page stays quiet')
  assert.equal(decide({ ...quiet, holdUntil: 90_000 }), false, 'the host asked for quiet for a while')
  assert.equal(decide({ ...quiet, holdUntil: 30_000 }), true, 'the requested quiet window has expired')
})

test('a mood survives normalization while an unknown one falls back to neutral', () => {
  const world = plugin.__test.normalizeWorld({
    chars: {
      star: { scene: 'beach', mood: 'happy', moodAt: 1_234 },
      suyou: { mood: 'furious', moodAt: 'soon' },
    },
  }, now)
  assert.equal(world.chars.star.mood, 'happy')
  assert.equal(world.chars.star.moodAt, 1_234)
  assert.equal(world.chars.suyou.mood, 'neutral', 'an unknown face is not painted')
  assert.equal(world.chars.suyou.moodAt, 0)

  const spoken = plugin.__test.appendMessage(world, { kind: 'bot', bot: 'star', text: '嗨', at: now, mood: 'happy' })
  assert.equal(spoken.messages.at(-1).mood, 'happy')
  assert.equal(plugin.__test.appendMessage(world, { kind: 'bot', bot: 'star', text: '嗨', at: now, mood: 'x' }).messages.at(-1).mood, undefined)
  assert.equal(plugin.__test.normalizeWorld(spoken, now).messages.at(-1).mood, 'happy', 'a reload keeps the face that went with the bubble')
})

test('the wire snapshot uses the fields the host reads', () => {
  const spawned = plugin.__test.applyActions(fresh, [{ cmd: 'spawn_item', target: 'all', params: { item: 'torch', x: 1, z: 2 } }], t, now)
  const wire = plugin.__test.wireWorld(spawned.world)
  assert.equal(wire.scene, 'beach')
  assert.deepEqual(wire.items, [{ type: 'torch', x: 1, z: 2 }])
  assert.deepEqual(Object.keys(wire.chars.star).sort(), ['scene', 'x', 'z'])
  assert.deepEqual(Object.keys(wire.chars), ['star', 'suyou', 'spirit', 'nook'])
})

test('catalogue labels resolve to locale keys', () => {
  const key = plugin.__test.labelKey
  assert.equal(key('scene', 'meadow'), 'sceneMeadow')
  assert.equal(key('bot', 'nook'), 'botNook')
  assert.equal(key('hint', 'cave'), 'hintCave')
  assert.equal(t(key('anim', 'wave')), '挥手')
})

// --- turn ownership -------------------------------------------------------

test('a reply lands under its own question even when it arrives late', () => {
  const base = plugin.__test.defaultWorld(now)
  const asked = plugin.__test.appendMessage(base, { kind: 'user', bot: 'star', text: '第一问', at: 1, turnId: 'turn-a' })
  const again = plugin.__test.appendMessage(asked, { kind: 'user', bot: 'nook', text: '第二问', at: 2, turnId: 'turn-b' })

  const answered = plugin.__test.appendToTurn(again, 'turn-a', { kind: 'bot', bot: 'star', text: '回答一', at: 3 })
  assert.deepEqual(answered.messages.map(message => message.text), ['第一问', '回答一', '第二问'])
  assert.equal(answered.messages[1].turnId, 'turn-a')
  assert.equal(answered.messages[2].turnId, 'turn-b', 'the newer question keeps its own id')

  const second = plugin.__test.appendToTurn(answered, 'turn-b', { kind: 'bot', bot: 'nook', text: '回答二', at: 4 })
  const third = plugin.__test.appendToTurn(second, 'turn-a', { kind: 'bot', bot: 'suyou', text: '补充一', at: 5 })
  assert.deepEqual(third.messages.map(message => message.text), ['第一问', '回答一', '补充一', '第二问', '回答二'])

  assert.equal(again.messages.length, 2, 'appending into a turn does not mutate the source world')
  const orphan = plugin.__test.appendToTurn(again, 'turn-gone', { kind: 'bot', bot: 'star', text: '迟到的回答', at: 6 })
  assert.equal(orphan.messages.at(-1).text, '迟到的回答', 'a turn nobody can find is appended')

  const untagged = plugin.__test.makeMessage({ kind: 'note', text: '没有归属', turnId: '' })
  assert.equal(untagged.turnId, undefined, 'an empty turn id is stored as no turn at all')
  assert.equal(plugin.__test.makeMessage({ kind: 'note', text: 'x', turnId: 'turn-a' }).turnId, 'turn-a')
})

test('every question carries a turn id and its answer joins that turn', async () => {
  const harness = createHarness()
  let asked = 0
  const browser = installBrowser((request) => {
    if (request.url === '/api/quadnest/status') return jsonResponse(STATUS_PAYLOAD)
    if (request.url !== '/api/quadnest/say') return jsonResponse({})
    asked += 1
    const replies = [{ bot: 'star', text: asked === 1 ? '在的。' : '再说一次也行。' }]
    // The first answer echoes the turn id; the second drops it, as a proxy that
    // strips unknown fields would. Both must still join their own question.
    return asked === 1
      ? jsonResponse({ turnId: request.body.turnId, replies, actions: [], model: MODEL })
      : jsonResponse({ replies, actions: [], model: MODEL })
  })
  try {
    const unmount = mountPage(harness)
    await harness.flush()

    const ask = async (text) => {
      const field = byClass(harness.tree, 'qn-input')[0]
      assert.ok(field !== undefined, 'the composer is rendered')
      field.props.onChange({ target: { value: text } })
      await harness.flush()
      byClass(harness.tree, 'qn-send')[0].props.onClick()
      await harness.flush()
    }

    await ask('星伴，你在吗')
    await ask('星伴，再说一次')

    const says = browser.requests.filter(request => request.url === '/api/quadnest/say')
    assert.equal(says.length, 2)
    for (const say of says) assert.match(say.body.turnId, /^turn-[A-Za-z0-9-]+$/)
    assert.notEqual(says[0].body.turnId, says[1].body.turnId, 'two questions never share a turn')
    assert.equal(says[0].body.target, 'star', 'a leading addressee reaches the host')

    const stored = JSON.parse(browser.store.get(STORE_KEY))
    const tail = stored.messages.slice(-4)
    assert.deepEqual(tail.map(message => message.kind), ['user', 'bot', 'user', 'bot'])
    assert.equal(tail[0].turnId, says[0].body.turnId)
    assert.equal(tail[1].turnId, says[0].body.turnId, 'the echoed id is used as returned')
    assert.equal(tail[2].turnId, says[1].body.turnId)
    assert.equal(tail[3].turnId, says[1].body.turnId, 'a dropped echo falls back to the request id')
    assert.deepEqual(tail.map(message => message.text), ['星伴，你在吗', '在的。', '星伴，再说一次', '再说一次也行。'])
    assert.ok(bubbleTexts(harness.tree).join(' ').includes('再说一次也行。'))
    unmount()
  } finally {
    browser.restore()
  }
})

// --- memory panel ---------------------------------------------------------

test('the memory panel reads the selected companion and asks for a recall', async () => {
  const harness = createHarness()
  const browser = installBrowser((request) => {
    if (request.url === '/api/quadnest/status') return jsonResponse(STATUS_PAYLOAD)
    if (request.url === '/api/quadnest/memory?target=star') {
      return jsonResponse({
        target: 'star',
        summary: { persona: 1, reflections: 1, facts: 1, recent: 1 },
        layers: {
          persona: [{ text: '说话很轻，喜欢用短句。', at: 10 }],
          reflections: [{ text: '最近在你面前放松了一些。', at: 20 }],
          facts: [{ text: '访客喜欢下雨天。', at: 30 }],
          recent: [{ role: 'visitor', label: '访客', text: '我喜欢下雨天', at: 40 }],
        },
      })
    }
    if (request.url === '/api/quadnest/memory/recall') {
      // A query with nothing behind it answers with no lines at all, which the
      // panel must show as "nothing came back" — not as a companion that has
      // never remembered anything.
      if (request.body?.query === '量子力学') {
        return jsonResponse({ target: 'star', query: '量子力学', lines: [], layers: { persona: [], reflections: [], facts: [], recent: [] } })
      }
      return jsonResponse({
        target: 'star',
        query: '猫',
        lines: ['[记忆·事实] 访客养了一只叫豆豆的猫'],
        layers: { facts: [{ text: '访客养了一只叫豆豆的猫。', at: 50 }] },
      })
    }
    return jsonResponse({})
  })
  try {
    const unmount = mountPage(harness)
    await harness.flush()
    assert.equal(browser.requests.filter(request => request.url.startsWith('/api/quadnest/memory')).length, 0, 'nothing is read until the panel opens')

    byText(harness.tree, t('memory')).props.onClick()
    await harness.flush()
    const read = browser.requests.find(request => request.url === '/api/quadnest/memory?target=star')
    assert.ok(read !== undefined, 'the panel reads the selected companion only')

    const shown = textOf(harness.tree).join(' ')
    for (const key of ['memoryPersona', 'memoryReflections', 'memoryFacts', 'memoryRecent']) {
      assert.ok(shown.includes(t(key)), 'the panel labels ' + key)
    }
    assert.ok(shown.includes('说话很轻，喜欢用短句。'))
    assert.ok(shown.includes('访客：我喜欢下雨天'), 'recent lines keep the speaker label')

    const field = byClass(harness.tree, 'qn-memory-input')[0]
    field.props.onChange({ target: { value: '  猫  ' } })
    await harness.flush()
    byClass(harness.tree, 'qn-memory-ask')[0].props.onClick()
    await harness.flush()

    const recall = browser.requests.find(request => request.url === '/api/quadnest/memory/recall')
    assert.ok(recall !== undefined, 'a recall is a separate, on-demand call')
    assert.equal(recall.method, 'POST')
    assert.deepEqual(recall.body, { target: 'star', query: '猫' }, 'the query is trimmed before it is sent')

    const recalled = textOf(harness.tree).join(' ')
    assert.ok(recalled.includes('访客养了一只叫豆豆的猫。'), 'the recalled lines replace the stored view')
    assert.equal(recalled.includes('说话很轻，喜欢用短句。'), false, 'a recall shows only what it recalled')

    const missField = byClass(harness.tree, 'qn-memory-input')[0]
    missField.props.onChange({ target: { value: '量子力学' } })
    await harness.flush()
    byClass(harness.tree, 'qn-memory-ask')[0].props.onClick()
    await harness.flush()
    const missed = textOf(harness.tree).join(' ')
    assert.ok(missed.includes(t('memorySearchEmpty')), 'nothing recalled is said out loud')
    assert.equal(missed.includes(t('memoryEmpty')), false, 'an empty recall is not reported as a companion that remembers nothing')
    unmount()
  } finally {
    browser.restore()
  }
})

// --- idle conversation ----------------------------------------------------

test('a quiet page lets a companion speak first and keeps the bubble', async () => {
  const harness = createHarness()
  const browser = installBrowser((request) => {
    if (request.url === '/api/quadnest/status') return jsonResponse(STATUS_PAYLOAD)
    return jsonResponse({ replies: [{ bot: 'star', text: '我先开口啦。' }], actions: [], model: MODEL })
  })
  try {
    const unmount = mountPage(harness)
    await harness.flush()
    assert.ok(browser.requests.some(request => request.url === '/api/quadnest/status'), 'the page reads readiness')
    assert.equal(browser.intervals.length, 1, 'one idle poll starts once readiness is known')

    browser.advance(59_000)
    browser.tick()
    await harness.flush()
    assert.equal(browser.requests.filter(request => request.url === '/api/quadnest/idle').length, 0, 'a quiet minute has not passed')

    browser.advance(2_000)
    browser.tick()
    await harness.flush()
    const idle = browser.requests.find(request => request.url === '/api/quadnest/idle')
    assert.ok(idle !== undefined, 'the idle poll posts once the visitor is quiet')
    assert.equal(idle.body.target, 'star', 'the first companion takes the first turn')
    assert.ok(idle.body.quietMs >= 60_000, 'the host is told how long the visitor has actually been quiet')
    assert.match(idle.body.turnId, /^turn-[A-Za-z0-9-]+$/, 'an unsolicited turn carries its own id')
    assert.ok(browser.store.get(STORE_KEY).includes('我先开口啦。'), 'the unsolicited bubble persists')
    assert.ok(bubbleTexts(harness.tree).join(' ').includes('我先开口啦。'), 'the unsolicited bubble renders')
    unmount()
  } finally {
    browser.restore()
  }
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
