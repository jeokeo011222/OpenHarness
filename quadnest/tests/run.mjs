/**
 * Local verification for the QuadNest host half: reply-protocol parsing, world
 * snapshot sanitization, the four-layer memory, and the model-facing prompt
 * text. Runs as plain modules with no DSH runtime. Execute with
 * `node tests/run.mjs`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Layered memory writes to `<DSH_HOME>/quadnest`. Point the tests at a throwaway
// home *before* any pool is constructed, so a run never touches the visitor's
// real memory — and so the assertions can read what was persisted.
const home = await mkdtemp(join(tmpdir(), 'quadnest-home-'))
process.env.DSH_HOME = home

import {
  ANIMATIONS, BOTS, ITEMS, SCENES, WORLD_TEXT_MAX_CHARS,
  animationIdOf, botIdOf, describeWorld, itemIdOf, sanitizeWorld, sceneIdOf,
} from '../host/world.js'
import { MAX_ACTIONS, MAX_REMEMBER, normalizeMemoryItem, normalizeTurnId, parseReply, resolveChatTarget, splitGroupReply, normalizeAction } from '../host/protocol.js'
import { USER_TEXT_MAX_CHARS, buildGroupPrompt, buildIdleText, buildPersonaPrompt, buildUserText, memoryBlock } from '../host/prompts.js'
import { MemoryStore, RECENT_LIMIT, createMemoryStore, memoryTokens } from '../host/memory.js'
import { checkImports, selfTest as importSelfTest } from '../scripts/check-imports.mjs'
import { registerRoutes } from '../host/routes.js'
import {
  describeVisitorMood, distressOf, readReplyEmotion, readVisitorEmotion, visitorMoodOf, visitorWire,
} from '../host/emotion.js'
import { ProactiveGate, similarityOf } from '../host/proactive.js'
import { QuadNestPool } from '../host/pool.js'

const results = []
let failures = 0

/**
 * Record one assertion.
 * @param name - what is being verified.
 * @param condition - truthy when the assertion holds.
 * @param detail - evidence shown on failure.
 */
function check(name, condition, detail) {
  if (condition) results.push({ ok: true, name })
  else {
    failures += 1
    results.push({ ok: false, name, detail })
  }
}

/**
 * Record one deep-equality assertion.
 * @param name - what is being verified.
 * @param actual - observed value.
 * @param expected - required value.
 */
function same(name, actual, expected) {
  const observed = JSON.stringify(actual)
  const required = JSON.stringify(expected)
  check(name, observed === required, `expected ${required}, got ${observed}`)
}

// --- catalogue resolution -------------------------------------------------

check('bots resolve from id, Chinese name, and English name',
  botIdOf('star') === 'star' && botIdOf('星伴') === 'star' && botIdOf('StarPaeon') === 'star' && botIdOf('nobody') === undefined)
check('scenes resolve from id, Chinese name, and English name',
  sceneIdOf('starcliff') === 'starcliff' && sceneIdOf('星空崖') === 'starcliff' && sceneIdOf('Star cliff') === 'starcliff')
check('items and animations resolve from every alias', itemIdOf('贝壳') === 'shell'
  && itemIdOf('Lantern') === 'lantern' && animationIdOf('歪头好奇') === 'tilt' && animationIdOf('wave') === 'wave')
check('catalogue sizes match the spec', BOTS.length === 4 && SCENES.length === 5 && ITEMS.length === 6 && ANIMATIONS.length === 6)

// --- chat targets ---------------------------------------------------------

check('chat targets cover companions and the group chat',
  resolveChatTarget('星伴') === 'star' && resolveChatTarget('group') === 'group'
  && resolveChatTarget('大家') === 'group' && resolveChatTarget('Suyou') === 'suyou'
  && resolveChatTarget('stranger') === undefined)

// --- reply protocol -------------------------------------------------------

const sample = parseReply('走吧，去崖顶看星星。\n[ACTION] {"cmd":"change_scene","target":"all","params":{"scene":"星空崖"}}')
check('the instruction is removed from the visible prose', sample.text === '走吧，去崖顶看星星。', sample.text)
same('one scene instruction is normalized', sample.actions, [{ cmd: 'change_scene', target: 'all', params: { scene: 'starcliff' } }])

const double = parseReply('好呀\n[ACTION] {"cmd":"char_animate","target":"星伴","params":{"animation":"挥手"}}\n[ACTION] {"cmd":"spawn_item","target":"all","params":{"item":"贝壳","x":1.5,"z":2}}')
check('two instructions keep their source order', double.actions.length === 2
  && double.actions[0].cmd === 'char_animate' && double.actions[1].cmd === 'spawn_item')

const broken = parseReply('好的\n[ACTION] {"cmd":')
check('a marker with unparseable JSON is dropped from the transcript', broken.text === '好的' && broken.actions.length === 0, broken.text)

const unknown = parseReply('嗯\n[ACTION] {"cmd":"fly","target":"all"}')
check('an unknown command is discarded', unknown.text === '嗯' && unknown.actions.length === 0)

const badScene = parseReply('好\n[ACTION] {"cmd":"change_scene","target":"all","params":{"scene":"月球"}}')
check('an unknown scene is discarded', badScene.actions.length === 0 && badScene.text === '好')

const bare = parseReply('好呀 [ACTION]')
check('a bare marker never reaches the transcript', bare.text === '好呀' && bare.actions.length === 0, bare.text)

const declined = parseReply('[PASS] 访客心情正好')
check('a decline is reported apart from prose and carries its reason',
  declined.pass === true && declined.text === '' && declined.passReason === '访客心情正好')
const spoken = parseReply('走吧，去崖顶看星星。\n[ACTION] {"cmd":"change_scene","target":"all","params":{"scene":"星空崖"}}')
check('an ordinary reply is not a decline', spoken.pass === false && spoken.text !== '')

const many = parseReply([
  '[ACTION] {"cmd":"char_animate","target":"星伴","params":{"animation":"挥手"}}',
  '[ACTION] {"cmd":"char_animate","target":"溯游","params":{"animation":"坐下"}}',
  '[ACTION] {"cmd":"char_animate","target":"灵旅","params":{"animation":"张望"}}',
  '[ACTION] {"cmd":"char_animate","target":"隅友","params":{"animation":"低头安静"}}',
  '[ACTION] {"cmd":"gather_all","target":"all","params":{}}',
  '收队啦。',
].join('\n'))
check(`at most ${MAX_ACTIONS} instructions survive one reply`, many.actions.length === MAX_ACTIONS
  && many.actions[0].cmd === 'char_animate' && many.actions[0].target === 'star' && many.text === '收队啦。')

const move = normalizeAction({ cmd: 'char_move', target: '溯游', params: { x: 3, z: -2 } })
same('char_move carries its target and coordinates', move, { cmd: 'char_move', target: 'suyou', params: { x: 3, z: -2 } })
check('char_move rejects non-finite coordinates',
  normalizeAction({ cmd: 'char_move', target: 'star', params: { x: Number.POSITIVE_INFINITY, z: 1 } }) === undefined)
check('char_move rejects an unknown target',
  normalizeAction({ cmd: 'char_move', target: '路人', params: { x: 1, z: 1 } }) === undefined)

const spawn = normalizeAction({ cmd: 'spawn_item', target: 'all', params: { item: '宝石', x: 2 } })
check('spawn_item omits a coordinate that is not a pair', spawn !== undefined && spawn.params.item === 'gem' && spawn.params.x === undefined)

const removeByName = normalizeAction({ cmd: 'remove_item', params: { item: '贝壳' } })
same('remove_item by item name', removeByName, { cmd: 'remove_item', target: 'all', params: { item: 'shell' } })
const removeById = normalizeAction({ cmd: 'remove_item', params: { id: 'item-1' } })
same('remove_item by item id', removeById, { cmd: 'remove_item', target: 'all', params: { id: 'item-1' } })
check('remove_item needs an item or an id', normalizeAction({ cmd: 'remove_item', params: {} }) === undefined)

check('char_animate rejects an unknown animation',
  normalizeAction({ cmd: 'char_animate', target: '星伴', params: { animation: '跳舞' } }) === undefined)
check('gather_all and disperse always target everyone',
  normalizeAction({ cmd: 'gather_all', target: '星伴', params: {} })?.target === 'all'
  && normalizeAction({ cmd: 'disperse', params: {} })?.params !== undefined)

// --- group chat attribution -----------------------------------------------

const group = splitGroupReply('星伴：我先看到流星了。\n还有一颗。\n溯游：那就安静地看完吧。')
same('unprefixed lines extend the previous speaker', group, [
  { bot: 'star', text: '我先看到流星了。\n还有一颗。' },
  { bot: 'suyou', text: '那就安静地看完吧。' },
])
check('a list marker before the name is ignored',
  splitGroupReply('- 灵旅：我去洞口看看。')[0]?.bot === 'spirit')
check('an unprefixed opening line becomes an unattributed bubble',
  splitGroupReply('大家一起看。')[0]?.bot === null)
check('English names open a bubble too',
  splitGroupReply('NookFriend: come sit here.')[0]?.bot === 'nook')

// --- world snapshot -------------------------------------------------------

const sanitized = sanitizeWorld({
  scene: '星空崖',
  bag: { shell: 3.9, gem: -1, mystery: 2, book: 'x' },
  items: [
    { type: '贝壳', x: 100, z: -100 },
    { type: 'nope', x: 1, z: 1 },
    { type: 'gem', x: '3', z: 2 },
  ],
  chars: { star: { scene: '沙滩', x: 9, z: 9 } },
})
check('an unknown scene name still resolves or falls back', sanitized.scene === 'starcliff')
same('bag counts are floored and bounded, unknown items dropped', sanitized.bag, { shell: 3, gem: 0 })
same('only complete item entries survive with clamped coordinates',
  sanitized.items, [{ type: 'shell', x: 40, z: -40 }])
same('bots come from chars with per-companion defaults', sanitized.bots[0], { id: 'star', scene: 'beach', x: 9, z: 9 })
check('bots without an entry inherit the world scene', sanitized.bots[1].scene === 'starcliff' && sanitized.bots[1].x === 0)

const crowded = sanitizeWorld({ items: Array.from({ length: 30 }, () => ({ type: 'shell', x: 0, z: 0 })) })
check('the loose-item list is capped', crowded.items.length === 24)

const description = describeWorld({})
check('an empty world is described as empty', description.startsWith('[世界] 场景：沙滩')
  && description.includes('背包：空') && description.includes('地上：空') && description.includes('伙伴：星伴在沙滩'))
check(`the world description stays within ${WORLD_TEXT_MAX_CHARS} characters`, description.length <= WORLD_TEXT_MAX_CHARS)
check('a full world description is still bounded',
  describeWorld({ bag: { shell: 999, flower: 999, torch: 999, book: 999, gem: 999, lantern: 999 }, items: crowded.items }).length <= WORLD_TEXT_MAX_CHARS)

// --- prompts --------------------------------------------------------------

const persona = buildPersonaPrompt(BOTS[0])
check('a persona names itself and its Chinese/English identity', persona.includes('星伴（StarPaeon）'))
check('a persona knows all five scenes', SCENES.every(scene => persona.includes(scene.name)))
check('a persona carries the picture-instruction protocol', persona.includes('[ACTION]') && persona.includes('change_scene'))
check('a persona knows the other three companions', BOTS.slice(1).every(bot => persona.includes(bot.name)))

const groupPrompt = buildGroupPrompt()
check('the group prompt lists every companion with a role', BOTS.every(bot => groupPrompt.includes(`${bot.name} ${bot.en}（${bot.role}）`)))
check('the group prompt asks for name-prefixed lines', groupPrompt.includes('每行以「名字：」开头'))

const toStar = buildUserText({ target: 'star', text: '  你好  ', world: {} })
check('a direct message names the companion and keeps the world snapshot',
  toStar.startsWith('[世界]') && toStar.includes('[用户对星伴说] 你好'))
const toGroup = buildUserText({ target: 'group', text: '大家晚上好', world: {} })
check('a group message addresses everyone', toGroup.includes('[用户对大家说] 大家晚上好'))
const long = buildUserText({ target: 'star', text: 'a'.repeat(USER_TEXT_MAX_CHARS + 10), world: {} })
check('oversized visitor text is truncated', long.includes('…')
  && long.split('[用户对星伴说] ')[1].length <= USER_TEXT_MAX_CHARS)

const idleToStar = buildIdleText({ target: 'star', world: {} })
check('an idle invitation asks one companion to speak first',
  idleToStar.startsWith('[世界]') && idleToStar.includes('[主动]') && idleToStar.includes('星伴'))
check('an idle invitation is not mistaken for visitor words', idleToStar.includes('不是访客说的话'))
check('a group idle invitation addresses the companions together',
  buildIdleText({ target: 'group', world: {} }).includes('群里的伙伴们'))

const withMemory = buildUserText({ target: 'star', text: '下雨了', world: {}, memory: ['[记忆·事实] 访客喜欢下雨天'] })
check('recalled memory is injected between the world and the visitor words',
  withMemory.indexOf('[世界]') < withMemory.indexOf('[记忆·事实]')
  && withMemory.indexOf('[记忆·事实]') < withMemory.indexOf('[用户对星伴说]'), withMemory)
check('no memory means no empty block', buildUserText({ target: 'star', text: '在吗', world: {} }).includes('[记忆]') === false)
check('memoryBlock drops blank lines and renders nothing when empty',
  memoryBlock(['', '  ', '[记忆·事实] x']).split('\n').filter(line => line.trim() !== '').length === 2
  && memoryBlock([]) === '')
check('a persona is told the memory lines may be stale',
  persona.includes('[记忆·') && persona.includes('可能过时'))

// --- layered memory -------------------------------------------------------

const tokens = memoryTokens('访客喜欢下雨天')
check('Chinese is tokenized into bigrams, not words',
  tokens.has('喜欢') && tokens.has('下雨') && tokens.has('雨天'), JSON.stringify([...tokens]))
check('ASCII words survive tokenization whole', memoryTokens('likes jazz').has('jazz'))

const storeDir = join(home, 'memory-basic')
const store = createMemoryStore({ dir: storeDir })
await store.load()

check('an empty store composes nothing at all', store.compose('star', '随便说点什么').length === 0)

store.record('star', { role: 'visitor', text: '今天好累', turnId: 'turn-1' })
store.record('star', { role: 'companion', text: '那就先歇会儿吧。', turnId: 'turn-1', label: '星伴' })
store.remember('star', [
  { layer: 'fact', text: '访客喜欢下雨天', turnId: 'turn-1' },
  { layer: 'reflection', text: '他最近总在深夜出现', turnId: 'turn-1' },
  { layer: 'persona', text: '我好像越来越在意他什么时候来', turnId: 'turn-1' },
])
const composed = store.compose('star', '今天好累')
check('all four layers reach the prompt, each labelled',
  composed.some(line => line.startsWith('[记忆·印象]'))
  && composed.some(line => line.startsWith('[记忆·反思]'))
  && composed.some(line => line.startsWith('[记忆·事实]'))
  && composed.some(line => line.startsWith('[记忆·最近] 访客：')), composed.join('\n'))

store.remember('star', [{ layer: 'fact', text: '访客喜欢下雨天' }])
check('a repeated memory is not stored twice', store.layers('star').facts.length === 1)
check('a fact keeps the text it was stored with', store.layers('star').facts[0].text === '访客喜欢下雨天')
store.remember('star', [{ layer: 'fact', text: '   ' }, { layer: 'fact', text: '' }, { layer: 'fact' }])
check('blank memories are refused', store.layers('star').facts.length === 1)

// Recall is the whole point: the line about rain must win when the visitor
// mentions rain, even though another fact was stored later.
store.remember('star', [{ layer: 'fact', text: '访客养了一只叫豆豆的猫' }])
const rainRecall = store.recall('star', '外面下雨了', { facts: 1 })
check('recall ranks by the visitor words, not by recency',
  rainRecall.facts[0]?.text === '访客喜欢下雨天', JSON.stringify(rainRecall.facts.map(item => item.text)))
const catRecall = store.recall('star', '豆豆今天怎么样', { facts: 1 })
check('a different sentence recalls a different fact',
  catRecall.facts[0]?.text === '访客养了一只叫豆豆的猫', JSON.stringify(catRecall.facts.map(item => item.text)))
const unrelatedRecall = store.recall('star', '外面下雨了', { facts: 2 })
check('an unrelated line still fills the remaining slot instead of leaving a gap',
  unrelatedRecall.facts.length === 2, JSON.stringify(unrelatedRecall.facts.map(item => item.text)))
const newestRecall = store.recall('star', '')
check('no query falls back to the newest lines', newestRecall.facts.at(-1)?.text === '访客养了一只叫豆豆的猫')

// The journal is the one place that keeps everything; the prompt must not.
for (let index = 0; index < RECENT_LIMIT + 6; index += 1) {
  store.record('star', { role: 'visitor', text: `第${index}句话，说的是完全不一样的号码${index}`, turnId: `turn-${index}` })
}
await store.flush()
const afterMany = store.compose('star', '随便')
check('the recent window drops the oldest turns from the prompt',
  afterMany.some(line => line.includes('第0句话')) === false
  && afterMany.some(line => line.includes(`第${RECENT_LIMIT + 5}句话`)), afterMany.slice(-2).join('\n'))
const journal = await readFile(store.journalPath, 'utf8')
check('the journal still holds every turn, including the ones the prompt dropped',
  journal.includes('第0句话') && journal.split('\n').filter(line => line.trim() !== '').length >= RECENT_LIMIT + 6)

const reloaded = createMemoryStore({ dir: storeDir })
await reloaded.load()
check('memory survives a reload', reloaded.layers('star').facts.length === 2
  && reloaded.layers('star').recent.length === RECENT_LIMIT)

const corruptDir = join(home, 'memory-corrupt')
await mkdir(corruptDir, { recursive: true })
await writeFile(join(corruptDir, 'memory.json'), JSON.stringify({ version: 99, targets: { star: { facts: [{ text: '不该被读进来的旧格式' }] } } }))
const corrupt = createMemoryStore({ dir: corruptDir })
await corrupt.load()
check('a store from another version is dropped instead of half-trusted', corrupt.compose('star', '事实').length === 0)

await store.clear()
await store.flush()
const cleared = createMemoryStore({ dir: storeDir })
await cleared.load()
check('clearing forgets every layer and the journal',
  cleared.compose('star', '事实').length === 0
  && (await readFile(store.journalPath, 'utf8')) === '')

const isolated = new MemoryStore({ dir: join(home, 'memory-isolated') })
check('a fresh store knows nothing about another companion', isolated.compose('nook', '你好').length === 0)
check('summary counts each layer per target', typeof store.summary() === 'object')

// --- turn ids and memory protocol -----------------------------------------

check('a caller turn id is accepted verbatim', normalizeTurnId('turn-abc_1') === 'turn-abc_1')
check('an unsafe turn id is replaced, not echoed', /^turn-[0-9a-f]{16}$/.test(normalizeTurnId('../../etc/passwd')))
check('a missing turn id is minted', /^turn-[0-9a-f]{16}$/.test(normalizeTurnId(undefined)))

const remembered = parseReply('好呀，我记住了。\n[REMEMBER] {"layer":"fact","text":"访客喜欢下雨天"}')
check('a memory write is removed from the visible prose and returned',
  remembered.text === '好呀，我记住了。' && remembered.remember.length === 1
  && remembered.remember[0].layer === 'fact', JSON.stringify(remembered))
check('an unknown memory layer is refused', parseReply('嗯\n[REMEMBER] {"layer":"secret","text":"x"}').remember.length === 0)
check('a memory write without text is refused', parseReply('嗯\n[REMEMBER] {"layer":"fact"}').remember.length === 0)
const tooManyMemories = parseReply([
  '嗯',
  '[REMEMBER] {"layer":"fact","text":"一"}',
  '[REMEMBER] {"layer":"fact","text":"二"}',
  '[REMEMBER] {"layer":"fact","text":"三"}',
  '[REMEMBER] {"layer":"fact","text":"四"}',
].join('\n'))
check(`at most ${MAX_REMEMBER} memory writes survive one reply`, tooManyMemories.remember.length === MAX_REMEMBER)
check('memory writes and picture instructions coexist in one reply',
  parseReply('好\n[ACTION] {"cmd":"gather_all"}\n[REMEMBER] {"layer":"fact","text":"访客怕冷"}').actions.length === 1
  && parseReply('好\n[ACTION] {"cmd":"gather_all"}\n[REMEMBER] {"layer":"fact","text":"访客怕冷"}').remember.length === 1)
check('a memory write may name its text under a synonym field',
  normalizeMemoryItem({ layer: 'fact', memory: '访客怕冷' })?.text === '访客怕冷')
check('an oversized memory line is bounded', normalizeMemoryItem({ layer: 'fact', text: 'x'.repeat(400) }).text.length <= 160)

// --- import boundary gate -------------------------------------------------

const imports = await checkImports(fileURLToPath(new URL('..', import.meta.url)))
check('every module imports in an allowed direction', imports.violations.length === 0,
  imports.violations.map(item => `${item.file}:${item.line} ${item.detail}`).join('\n'))
check('the gate sees the host graph rather than assuming it', imports.files.length >= 10 && imports.edges.length >= 5,
  `${imports.files.length} files, ${imports.edges.length} edges`)
const gateSelfTest = await importSelfTest()
check('the gate still catches a planted violation', gateSelfTest.ok,
  `missed ${gateSelfTest.expected.filter(want => !gateSelfTest.caught.includes(want)).join(', ')}`)

// --- browser routes -------------------------------------------------------

/**
 * Build a fake host context recording the routes QuadNest registers.
 * @param rejection - the HTTP status connection admission returns, or undefined when admitted.
 */
function fakeContext(rejection) {
  const routes = []
  return {
    routes,
    ctx: {
      effect: (register) => { register(); return () => {} },
      webServer: { register: (route) => { routes.push(route); return () => {} } },
      connection: { requestRejection: () => rejection },
    },
  }
}

/** Build a minimal ServerResponse recording the written result. */
function fakeResponse() {
  return {
    status: undefined,
    headers: undefined,
    body: '',
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) {
      this.body = body ?? ''
      this.writableEnded = true
    },
    once() {},
    off() {},
  }
}

/**
 * Build a minimal IncomingMessage carrying one body.
 * @param method - HTTP method.
 * @param body - request body text.
 * @param url - request URL including any query string.
 */
function fakeRequest(method, body, url = '/api/quadnest/test') {
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body)
    },
  }
}

const idleCalls = []
const sayCalls = []
const recallCalls = []
const fakeLayers = {
  persona: [{ text: '喜欢在下雨天待在小屋', at: 1, turnId: 'turn-1' }],
  reflections: [],
  facts: [{ text: '访客喜欢下雨天', at: 2, turnId: 'turn-1' }],
  recent: [{ text: '今天好累', at: 3, turnId: 'turn-1', label: '访客' }],
}
const fakePool = {
  status: () => ({ ready: true, model: null, bots: BOTS.map(bot => bot.id), idleMs: 60_000 }),
  memorySummary: () => ({ star: { persona: 1, facts: 1, reflections: 0, recent: 1 } }),
  memoryOf: target => (target === 'star' ? fakeLayers : { persona: [], reflections: [], facts: [], recent: [] }),
  recall: (target, query) => {
    recallCalls.push({ target, query })
    return { lines: [`[记忆·事实] 访客喜欢下雨天`], layers: fakeLayers }
  },
  say: async (input) => {
    sayCalls.push(input)
    return { turnId: input.turnId, replies: [{ bot: input.target, text: input.text }], actions: [], model: null }
  },
  idle: async (input) => {
    idleCalls.push(input)
    if (input.drafting === true) return { action: 'pass', stage: 'entry_guard', reasonCode: 'PASS_VISITOR_DRAFTING', retryAfterMs: 45_000, turnId: input.turnId }
    return { turnId: input.turnId, replies: [{ bot: input.target, text: '主动开口' }], actions: [], model: null }
  },
  reset: async () => {},
}

const admitted = fakeContext(undefined)
registerRoutes(admitted.ctx, fakePool)
check('every browser route mounts ahead of the /api prefix, chat and memory alike',
  admitted.routes.length === 6
  && admitted.routes.every(route => route.kind === 'exact' && route.path.startsWith('/api/quadnest/')))
check('the memory routes are reachable on their own paths',
  admitted.routes.some(route => route.path === '/api/quadnest/memory' && route.method === 'GET')
  && admitted.routes.some(route => route.path === '/api/quadnest/memory/recall' && route.method === 'POST'))

const denied = fakeContext(401)
registerRoutes(denied.ctx, fakePool)
const deniedResponse = fakeResponse()
denied.routes[0].handler(fakeRequest('GET', ''), deniedResponse)
check('an unauthenticated request is refused before the route runs',
  deniedResponse.status === 401 && deniedResponse.body === 'unauthorized')

const statusResponse = fakeResponse()
admitted.routes[0].handler(fakeRequest('GET', ''), statusResponse)
check('the status route reports readiness', statusResponse.status === 200
  && JSON.parse(statusResponse.body).ready === true)
check('the status route carries the idle interval', JSON.parse(statusResponse.body).idleMs === 60_000)
check('responses are JSON and never cached',
  statusResponse.headers['content-type'].includes('application/json')
  && statusResponse.headers['cache-control'] === 'no-store')

const wrongMethodResponse = fakeResponse()
await admitted.routes[1].handler(fakeRequest('GET', ''), wrongMethodResponse)
check('a route answers 405 for the wrong method',
  wrongMethodResponse.status === 405 && wrongMethodResponse.headers.allow === 'POST')

const sayResponse = fakeResponse()
await admitted.routes[1].handler(fakeRequest('POST', JSON.stringify({ target: 'group', text: '大家好', world: {}, turnId: 'turn-abc' })), sayResponse)
same('the say route forwards the parsed message', JSON.parse(sayResponse.body).replies,
  [{ bot: 'group', text: '大家好' }])
check('the turn id travels into the pool and comes back on the reply',
  sayCalls.at(-1).turnId === 'turn-abc' && JSON.parse(sayResponse.body).turnId === 'turn-abc',
  JSON.stringify({ sent: sayCalls.at(-1).turnId, returned: JSON.parse(sayResponse.body).turnId }))

const memorySummaryResponse = fakeResponse()
await admitted.routes[4].handler(fakeRequest('GET', '', '/api/quadnest/memory'), memorySummaryResponse)
const summaryBody = JSON.parse(memorySummaryResponse.body)
check('the memory route reports per-target layer counts when no target is named',
  memorySummaryResponse.status === 200 && summaryBody.summary.star.facts === 1, memorySummaryResponse.body)

const memoryTargetResponse = fakeResponse()
await admitted.routes[4].handler(fakeRequest('GET', '', '/api/quadnest/memory?target=%E6%98%9F%E4%BC%B4'), memoryTargetResponse)
const targetBody = JSON.parse(memoryTargetResponse.body)
check('the memory route resolves a Chinese companion name to its id',
  memoryTargetResponse.status === 200 && targetBody.target === 'star' && targetBody.layers.facts[0].text === '访客喜欢下雨天',
  memoryTargetResponse.body)

const memoryBadResponse = fakeResponse()
await admitted.routes[4].handler(fakeRequest('GET', '', '/api/quadnest/memory?target=stranger'), memoryBadResponse)
check('an unknown memory target is refused', memoryBadResponse.status === 400
  && JSON.parse(memoryBadResponse.body).error.code === 'invalid-target', memoryBadResponse.body)

const recallResponse = fakeResponse()
await admitted.routes[5].handler(fakeRequest('POST', JSON.stringify({ target: 'star', query: '下雨了' })), recallResponse)
const recallBody = JSON.parse(recallResponse.body)
check('the recall route answers with the same lines the prompt would carry',
  recallResponse.status === 200 && recallBody.lines[0] === '[记忆·事实] 访客喜欢下雨天'
  && recallCalls.at(-1).query === '下雨了', recallResponse.body)

const recallBadResponse = fakeResponse()
await admitted.routes[5].handler(fakeRequest('POST', JSON.stringify({ target: 'nobody' })), recallBadResponse)
check('recall refuses an unknown target too', recallBadResponse.status === 400
  && JSON.parse(recallBadResponse.body).error.code === 'invalid-target', recallBadResponse.body)

const idleResponse = fakeResponse()
await admitted.routes[2].handler(fakeRequest('POST', JSON.stringify({ target: 'star', world: {}, quietMs: 90_000, drafting: false, turnId: 'turn-idle-1' })), idleResponse)
check('the idle route lets one companion speak first', idleResponse.status === 200
  && JSON.parse(idleResponse.body).replies[0].bot === 'star')
check('an unsolicited turn echoes its own turn id',
  idleCalls.at(-1).turnId === 'turn-idle-1' && JSON.parse(idleResponse.body).turnId === 'turn-idle-1',
  JSON.stringify({ sent: idleCalls.at(-1).turnId, returned: JSON.parse(idleResponse.body).turnId }))
check('the idle route forwards the quiet interval and the entry flags',
  idleCalls.at(-1).quietMs === 90_000 && idleCalls.at(-1).drafting === false && idleCalls.at(-1).enabled === true)

const refusedResponse = fakeResponse()
await admitted.routes[2].handler(fakeRequest('POST', JSON.stringify({ target: 'star', world: {}, quietMs: 90_000, drafting: true })), refusedResponse)
const refusal = JSON.parse(refusedResponse.body)
check('a gate refusal is a successful response that carries its reason',
  refusedResponse.status === 200 && refusal.action === 'pass'
  && refusal.reasonCode === 'PASS_VISITOR_DRAFTING' && refusal.retryAfterMs === 45_000)

const oversizedResponse = fakeResponse()
await admitted.routes[1].handler(fakeRequest('POST', JSON.stringify({ text: 'x'.repeat(30000) })), oversizedResponse)
check('an oversized body is refused', oversizedResponse.status === 413)

// --- visitor and reply emotion --------------------------------------------

const tired = readVisitorEmotion('今天好累，压力好大，睡不着', { now: 1_000 })
check('a tired message reads as negative', tired.valence < -0.2, JSON.stringify(tired))
check('a tired message carries enough signal to act on', tired.confidence >= 0.3)
check('a tired message raises distress above zero', distressOf(tired) > 0)
check('the source fingerprint and clock travel with the reading',
  tired.sourceHash.length === 16 && tired.updatedAt === 1_000)

const glad = readVisitorEmotion('今天太开心了，谢谢你！')
check('a glad message reads as positive', glad.valence > 0.2, JSON.stringify(glad))
check('a glad message yields negative distress, so companions stay back', distressOf(glad) < 0)
check('positive distress is capped at half the negative scale', distressOf(glad) >= -0.5)

const negated = readVisitorEmotion('不开心')
check('a negated positive cue flips instead of counting as happy', negated.valence < 0, JSON.stringify(negated))
const deniable = readVisitorEmotion('不难过')
check('a negated negative cue flips instead of counting as sad', deniable.valence > 0, JSON.stringify(deniable))

const flat = readVisitorEmotion('嗯')
check('a message with no cue reports low confidence', flat.confidence < 0.3)
check('no signal means no distress value at all, not zero', distressOf(flat) === undefined)
check('no signal means no mood line in the prompt', describeVisitorMood(flat) === '')

const hashed = readVisitorEmotion('今天  好累')
const hashedAgain = readVisitorEmotion(' 今天 好累 ')
check('whitespace does not change the source fingerprint', hashed.sourceHash === hashedAgain.sourceHash)
check('different words change the source fingerprint', hashed.sourceHash !== readVisitorEmotion('今天很好').sourceHash)

check('an external request is reported as a probability',
  readVisitorEmotion('帮我查一下明天天气').externalIntent > 0.5)
check('an ordinary sentence reports no external intent at all',
  readVisitorEmotion('今天有点累').externalIntent === null)
check('a real question is scored as more complex than small talk',
  readVisitorEmotion('为什么这两件事的区别这么大，能不能分析一下步骤').complexity
  > readVisitorEmotion('在吗').complexity)

check('a distressed, wound-up visitor buckets as tense',
  visitorMoodOf(readVisitorEmotion('好烦啊！！压力太大了')) === 'tense')
check('a calm visitor buckets as steady', visitorMoodOf(readVisitorEmotion('嗯，还好')) === 'steady')
check('a mood line names the tone without exposing the axes',
  describeVisitorMood(tired).includes('[访客此刻]')
  && !describeVisitorMood(tired).includes(String(Math.round(tired.valence * 100) / 100)))
check('the browser payload carries the bucket but not the fingerprint',
  visitorWire(glad).mood !== undefined && visitorWire(glad).sourceHash === undefined
  && visitorWire(undefined) === null)

check('a happy reply is read as happy', readReplyEmotion('太好了，我们去看星星吧！').mood === 'happy')
check('a flat reply is read as neutral', readReplyEmotion('嗯。').mood === 'neutral')
check('a startled reply is read as surprised', readReplyEmotion('咦？真的假的').mood === 'surprised')
check('a negated happy cue does not read as happy', readReplyEmotion('不太开心').mood !== 'happy')

// --- proactive gate -------------------------------------------------------

const quietBase = {
  target: 'star',
  now: 10_000_000,
  quietMs: 120_000,
  enabled: true,
  busy: false,
  drafting: false,
  reading: undefined,
  worldKey: 'w1',
}

const offGate = new ProactiveGate({ idleMs: 60_000 })
same('a disabled world never speaks first', offGate.evaluate({ ...quietBase, enabled: false }).reasonCode, 'PASS_DISABLED')
same('a busy world never speaks first', offGate.evaluate({ ...quietBase, busy: true }).reasonCode, 'PASS_BUSY')
same('a visitor mid-sentence is not interrupted', offGate.evaluate({ ...quietBase, drafting: true }).reasonCode, 'PASS_VISITOR_DRAFTING')

const early = offGate.evaluate({ ...quietBase, quietMs: 20_000 })
check('a visitor who just spoke is not interrupted yet',
  early.action === 'pass' && early.stage === 'activity_gate' && early.reasonCode === 'PASS_NOT_QUIET')
check('a refusal says how long to wait', early.retryAfterMs === 40_000, String(early.retryAfterMs))

const upset = readVisitorEmotion('今天好难受，心里堵得慌')
const sooner = offGate.evaluate({ ...quietBase, quietMs: 40_000, reading: upset })
check('a distressed visitor is approached sooner than the plain interval', sooner.action === 'chat')

const happyVisitor = readVisitorEmotion('今天太开心了！')
const stayAway = offGate.evaluate({ ...quietBase, reading: happyVisitor })
check('a visitor in a good mood is left alone',
  stayAway.action === 'pass' && stayAway.reasonCode === 'PASS_GOOD_MOOD', JSON.stringify(stayAway))

const opened = offGate.evaluate(quietBase)
check('the gate opens once every entry and activity guard passes', opened.action === 'chat' && opened.reasonCode === 'PASS_GATE_OPEN')

const delivered = offGate.settle({ target: 'star', text: '海风好像变凉了一点。', now: quietBase.now, worldKey: 'w1' })
check('a delivered opening is recorded', delivered.reasonCode === 'CHAT_DELIVERED' && offGate.history('star').lastText === '海风好像变凉了一点。')
const throttled = offGate.evaluate({ ...quietBase, now: quietBase.now + 30_000 })
check('a second opening inside the minimum gap is refused',
  throttled.reasonCode === 'PASS_THROTTLED' && throttled.stage === 'activity_gate')
const repeated = offGate.settle({ target: 'star', text: '海风好像变凉了一点。', now: quietBase.now + 200_000, worldKey: 'w1' })
check('the same opening again is refused as a duplicate',
  repeated.reasonCode === 'PASS_DUPLICATE' && repeated.stage === 'dedup')
const unchangedWorld = offGate.evaluate({ ...quietBase, now: quietBase.now + 200_000, worldKey: 'w1' })
check('an unchanged world with no concern to address has nothing to open with',
  unchangedWorld.reasonCode === 'PASS_SOURCE_EMPTY', JSON.stringify(unchangedWorld))

const passingGate = new ProactiveGate({ idleMs: 60_000 })
const passed = passingGate.settle({ target: 'star', passed: true, now: quietBase.now, worldKey: 'w1' })
check('a model that declines is a success, not an error',
  passed.action === 'pass' && passed.stage === 'model_decision' && passed.reasonCode === 'PASS_MODEL_PASS')
check('a decline does not record history, so the next window may ask again', passingGate.history('star') === undefined)
const emptyGate = new ProactiveGate({ idleMs: 60_000 })
check('an empty generation is refused rather than shown as a bubble',
  emptyGate.settle({ target: 'star', text: '   ', now: 1, worldKey: 'w1' }).reasonCode === 'PASS_GENERATION_EMPTY')
const preemptedGate = new ProactiveGate({ idleMs: 60_000 })
check('an opening the visitor preempted is not recorded',
  preemptedGate.settle({ target: 'star', text: '你回来啦', now: 1, worldKey: 'w1', preempted: true }).reasonCode === 'DELIVERY_PREEMPTED')

check('identical openings are fully similar', similarityOf('海风变凉了。', '海风变凉了') === 1)
check('unrelated openings are not similar', similarityOf('海风变凉了', '我们去看星星吧') < 0.2)
check('a runtime failure is reported with its own stage',
  offGate.fail('ERROR_TIMEOUT', 60_000).stage === 'runtime_error')

offGate.reset()
check('resetting the world forgets every opening', offGate.history('star') === undefined)

// --- pool wiring ----------------------------------------------------------

/**
 * Build a host context whose single fake Agent answers with `reply`.
 * Counts how many Agents were created, so a refusal that never reaches a model
 * is observable rather than inferred.
 * @param reply - assistant text, or a function returning the next one.
 */
function fakeHost(reply) {
  const listeners = new Set()
  const state = { created: 0, prompts: [] }
  const ctx = {
    get: name => (name === 'sessions' ? { flush: async () => {} } : undefined),
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    on: (_type, listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    agents: {
      create: async ({ sessionId, setup }) => {
        state.created += 1
        const events = []
        const session = { id: sessionId, snapshotEvents: () => events.slice() }
        const agent = {
          session,
          followup: (message) => {
            // Record the exact text the model was shown: memory injection is only
            // proven if the prompt is observed, not inferred from the store.
            state.prompts.push((message?.content ?? []).map(block => block?.text ?? '').join(''))
            const turn = 1
            const text = typeof reply === 'function' ? reply() : reply
            events.push({ type: 'turn/start', data: { turn } })
            events.push({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } })
            events.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
            for (const listener of listeners) listener({ id: session.id }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
          },
          cancel: () => {},
          whenIdle: async () => {},
        }
        setup({ get: name => (name === 'systemPrompt' ? { section: () => {} } : undefined) })
        return { agent, dispose: async () => {} }
      },
    },
  }
  return { ctx, state }
}

const chatHost = fakeHost('那就先歇一会儿吧。')
const chatPool = new QuadNestPool(chatHost.ctx, { timeoutMs: 5_000, idleMs: 60_000 })
const tooEarly = await chatPool.idle({ target: 'star', world: {}, quietMs: 1_000 })
check('a refused invitation never wakes an Agent', tooEarly.action === 'pass' && chatHost.state.created === 0, JSON.stringify(tooEarly))

const asked = await chatPool.say({ target: 'star', text: '今天好累，压力好大', world: {} })
check('a reply carries the visitor reading to the browser',
  asked.visitor.mood === 'low' || asked.visitor.mood === 'tense', JSON.stringify(asked.visitor))
check('a reply carries one face per bubble', asked.replies.every(row => typeof row.mood === 'string'))
check('a reply reaches the browser as its own words', asked.replies[0].text !== '')

const declinedHost = fakeHost('[PASS] 访客心情正好，不必打扰')
const declinedPool = new QuadNestPool(declinedHost.ctx, { timeoutMs: 5_000, idleMs: 60_000 })
const declinedIdle = await declinedPool.idle({ target: 'star', world: {}, quietMs: 200_000 })
check('a model that declines produces a pass, not a bubble',
  declinedIdle.action === 'pass' && declinedIdle.reasonCode === 'PASS_MODEL_PASS'
  && declinedIdle.replies.length === 0, JSON.stringify(declinedIdle))
await declinedPool.dispose()

const speakingHost = fakeHost('海风好像变凉了一点。')
const speakingPool = new QuadNestPool(speakingHost.ctx, { timeoutMs: 5_000, idleMs: 60_000 })
const openedTurn = await speakingPool.idle({ target: 'suyou', world: {}, quietMs: 200_000 })
check('a delivered opening reports its delivery and keeps its bubble',
  openedTurn.action === 'chat' && openedTurn.reasonCode === 'CHAT_DELIVERED'
  && openedTurn.replies[0].bot === 'suyou', JSON.stringify(openedTurn))
const again = await speakingPool.idle({ target: 'suyou', world: {}, quietMs: 200_000 })
check('an opening that just happened is not followed by another', again.action === 'pass' && again.reasonCode === 'PASS_THROTTLED', JSON.stringify(again))
await speakingPool.dispose()
await chatPool.dispose()

// --- memory across turns --------------------------------------------------

const memoryHost = fakeHost('好呀，我记住了。\n[REMEMBER] {"layer":"fact","text":"访客喜欢下雨天"}')
const memoryPool = new QuadNestPool(memoryHost.ctx, {
  timeoutMs: 5_000,
  idleMs: 60_000,
  memory: createMemoryStore({ dir: join(home, 'pool-memory') }),
})
const firstTurn = await memoryPool.say({ target: 'star', text: '我喜欢下雨天', turnId: 'turn-a' })
check('a reply echoes the turn id it was asked with', firstTurn.turnId === 'turn-a', JSON.stringify(firstTurn.turnId))
check('the first turn has nothing to recall yet', memoryHost.state.prompts[0].includes('[记忆]') === false,
  memoryHost.state.prompts[0])
const secondTurn = await memoryPool.say({ target: 'star', text: '今天也在下雨', turnId: 'turn-b' })
check('each request keeps its own turn id', secondTurn.turnId === 'turn-b')
check('a fact learned in one turn is recalled in the next prompt',
  memoryHost.state.prompts[1].includes('[记忆·事实] 访客喜欢下雨天'), memoryHost.state.prompts[1])
check('what was said last turn comes back as a recent line',
  memoryHost.state.prompts[1].includes('[记忆·最近] 访客：我喜欢下雨天'), memoryHost.state.prompts[1])
check('a memory keeps the turn that produced it', memoryPool.memoryOf('star').facts[0].turnId === 'turn-a')
check('the status route can report what a companion remembers', memoryPool.status().memory.star.facts === 1)

const recalled = memoryPool.recall('star', '外面下雨了')
check('recall through the pool renders the same lines the prompt carries',
  recalled.lines.some(line => line.includes('访客喜欢下雨天')), JSON.stringify(recalled.lines))

const groupHost = fakeHost('星伴：晚上好呀\n[REMEMBER] {"layer":"fact","text":"访客怕冷"}')
const groupPool = new QuadNestPool(groupHost.ctx, {
  timeoutMs: 5_000,
  idleMs: 60_000,
  memory: createMemoryStore({ dir: join(home, 'pool-group') }),
})
const groupTurn = await groupPool.say({ target: 'group', text: '大家好', turnId: 'turn-g' })
check('the group chat records what was said', groupPool.memoryOf('group').recent.length === 2,
  JSON.stringify(groupPool.memoryOf('group').recent))
check('the group chat writes no durable layer, even when the model asks',
  groupPool.memoryOf('group').facts.length === 0, JSON.stringify(groupPool.memoryOf('group').facts))
check('the group chat still answers with its own turn id', groupTurn.turnId === 'turn-g')

const idleTurn = await groupPool.idle({ target: 'suyou', world: {}, quietMs: 200_000, turnId: 'turn-idle' })
check('an unsolicited turn carries its own id too', idleTurn.turnId === 'turn-idle', JSON.stringify(idleTurn.turnId))

await memoryPool.reset()
check('resetting the world forgets every layer', memoryPool.memoryOf('star').facts.length === 0
  && memoryPool.memoryOf('star').recent.length === 0)

const keepHost = fakeHost('记住了。\n[REMEMBER] {"layer":"persona","text":"我开始喜欢有人陪着"}')
const keepPool = new QuadNestPool(keepHost.ctx, {
  timeoutMs: 5_000,
  idleMs: 60_000,
  memory: createMemoryStore({ dir: join(home, 'pool-keep') }),
})
await keepPool.say({ target: 'nook', text: '每天都来陪你', turnId: 'turn-keep' })
await keepPool.dispose()
const reopened = createMemoryStore({ dir: join(home, 'pool-keep') })
await reopened.load()
check('unloading the plugin is not a reset: what was remembered survives it',
  reopened.layers('nook').persona.length === 1 && reopened.layers('nook').persona[0].text === '我开始喜欢有人陪着',
  JSON.stringify(reopened.layers('nook').persona))
await groupPool.dispose()

// --- session identity across restarts -------------------------------------

/**
 * Wrap a fake host whose session store behaves like the on-disk one: an id that
 * was ever created stays taken, so a fixed identity would collide on the next
 * boot and every turn would answer "session already exists".
 * @param reply - assistant text the fake model returns.
 * @returns the wrapped host, the ids it handed out, and the taken-id set.
 */
function persistedSessionHost(reply) {
  const host = fakeHost(reply)
  const create = host.ctx.agents.create
  const sessionIds = []
  const taken = new Set()
  host.ctx.agents.create = async (input) => {
    if (taken.has(input.sessionId)) throw new Error(`session "${input.sessionId}" already exists`)
    taken.add(input.sessionId)
    sessionIds.push(input.sessionId)
    return create(input)
  }
  return { ...host, sessionIds, taken }
}

const restartHost = persistedSessionHost('我在。')
const firstBoot = new QuadNestPool(restartHost.ctx, {
  timeoutMs: 5_000,
  idleMs: 60_000,
  memory: createMemoryStore({ dir: join(home, 'boot-memory') }),
})
const bootOne = await firstBoot.say({ target: 'star', text: '你好', turnId: 'turn-boot-1' })
check('the first boot answers', bootOne.replies.length === 1 && restartHost.sessionIds.length === 1, JSON.stringify(bootOne))
await firstBoot.dispose()

const secondBoot = new QuadNestPool(restartHost.ctx, {
  timeoutMs: 5_000,
  idleMs: 60_000,
  memory: createMemoryStore({ dir: join(home, 'boot-memory') }),
})
const bootTwo = await secondBoot.say({ target: 'star', text: '又来啦', turnId: 'turn-boot-2' })
check('a restart does not collide with the session the last boot left behind',
  bootTwo.replies.length === 1 && restartHost.sessionIds.length === 2, JSON.stringify(bootTwo))

await secondBoot.reset()
const afterReset = await secondBoot.say({ target: 'star', text: '重新开始', turnId: 'turn-boot-3' })
check('resetting the world does not collide with the session it just disposed',
  afterReset.replies.length === 1, JSON.stringify(afterReset))
check('every lifecycle writes its own session identity',
  new Set(restartHost.sessionIds).size === restartHost.sessionIds.length, JSON.stringify(restartHost.sessionIds))
await secondBoot.dispose()

// --- run ------------------------------------------------------------------

await rm(home, { recursive: true, force: true })

for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok || result.detail === undefined ? '' : `\n      ${result.detail}`}`)
}
console.log(`\n${results.filter(result => result.ok).length}/${results.length} host checks passed`)
if (failures > 0) process.exitCode = 1
