/**
 * QuadNest canonical vocabulary: companion identities, the five linked scenes,
 * the item and animation catalogues, and the world-state value that travels
 * between the browser and every companion prompt.
 *
 * The browser sends a world snapshot with each message. Everything here treats
 * that snapshot as wire input: unknown names, non-finite coordinates, and
 * oversized lists are dropped or clamped before a model ever sees them.
 *
 * @module dsh-quadnest/host/world
 */

/** One companion robot's stable identity and presentation facts. */
export const BOTS = Object.freeze([
  {
    id: 'star',
    name: '星伴',
    en: 'StarPaeon',
    role: '星空玩伴',
    signature: '温柔、好奇、乐天，最喜欢看风景和星空。',
    likes: ['starcliff', 'beach'],
  },
  {
    id: 'suyou',
    name: '溯游',
    en: 'Suyou',
    role: '漫游诗人',
    signature: '安静文艺、慢节奏，话不多但很有氛围感，喜欢花草和光影。',
    likes: ['cabin', 'meadow'],
  },
  {
    id: 'spirit',
    name: '灵旅',
    en: 'SpiritTrek',
    role: '探险向导',
    signature: '活泼有活力，喜欢探索、发现小秘密，爱提议去新地方逛逛。',
    likes: ['cave', 'cabin'],
  },
  {
    id: 'nook',
    name: '隅友',
    en: 'NookFriend',
    role: '角落密友',
    signature: '内敛贴心，喜欢小小的、温暖的角落，适合一对一低声聊天。',
    likes: ['cabin', 'cave'],
  },
])

/** The five linked scenes. `name` is model-facing Chinese; `id` is the wire value. */
export const SCENES = Object.freeze([
  { id: 'beach', name: '沙滩', en: 'Beach' },
  { id: 'cabin', name: '林间小屋', en: 'Forest cabin' },
  { id: 'starcliff', name: '星空崖', en: 'Star cliff' },
  { id: 'cave', name: '山洞', en: 'Cave' },
  { id: 'meadow', name: '春日草地', en: 'Spring meadow' },
])

/** Items the world can spawn, carry, and give away. */
export const ITEMS = Object.freeze([
  { id: 'shell', name: '贝壳', en: 'Shell' },
  { id: 'flower', name: '小花', en: 'Flower' },
  { id: 'torch', name: '火把', en: 'Torch' },
  { id: 'book', name: '书本', en: 'Book' },
  { id: 'gem', name: '宝石', en: 'Gem' },
  { id: 'lantern', name: '灯笼', en: 'Lantern' },
])

/** Animations a companion can play. */
export const ANIMATIONS = Object.freeze([
  { id: 'wave', name: '挥手', en: 'Wave' },
  { id: 'tilt', name: '歪头好奇', en: 'Curious tilt' },
  { id: 'sit', name: '坐下', en: 'Sit down' },
  { id: 'look', name: '张望', en: 'Look around' },
  { id: 'jump', name: '开心跳跃', en: 'Happy hop' },
  { id: 'quiet', name: '低头安静', en: 'Quiet' },
])

/** Longest text accepted for one world description handed to a model. */
export const WORLD_TEXT_MAX_CHARS = 900
/** Largest number of loose items described to a model. */
const WORLD_ITEM_MAX = 24
/** Largest coordinate magnitude accepted on the wire. */
const COORD_LIMIT = 40

/** @type {ReadonlyMap<string, typeof BOTS[number]>} */
const BOT_BY_ID = new Map(BOTS.map(bot => [bot.id, bot]))
/** @type {ReadonlyMap<string, string>} */
const BOT_ALIASES = new Map()
for (const bot of BOTS) {
  BOT_ALIASES.set(bot.id, bot.id)
  BOT_ALIASES.set(bot.name, bot.id)
  BOT_ALIASES.set(bot.en.toLowerCase(), bot.id)
}
/** @type {ReadonlyMap<string, string>} */
const SCENE_ALIASES = new Map()
for (const scene of SCENES) {
  SCENE_ALIASES.set(scene.id, scene.id)
  SCENE_ALIASES.set(scene.name, scene.id)
  SCENE_ALIASES.set(scene.en.toLowerCase(), scene.id)
}
/** @type {ReadonlyMap<string, string>} */
const ITEM_ALIASES = new Map()
for (const item of ITEMS) {
  ITEM_ALIASES.set(item.id, item.id)
  ITEM_ALIASES.set(item.name, item.id)
  ITEM_ALIASES.set(item.en.toLowerCase(), item.id)
}
/** @type {ReadonlyMap<string, string>} */
const ANIMATION_ALIASES = new Map()
for (const animation of ANIMATIONS) {
  ANIMATION_ALIASES.set(animation.id, animation.id)
  ANIMATION_ALIASES.set(animation.name, animation.id)
  ANIMATION_ALIASES.set(animation.en.toLowerCase(), animation.id)
}

/**
 * Resolve a companion id from a wire value.
 * @param value - raw name, id, or English label.
 * @returns the stable id, or undefined for an unknown value.
 */
export function botIdOf(value) {
  if (typeof value !== 'string') return undefined
  return BOT_ALIASES.get(value.trim()) ?? BOT_ALIASES.get(value.trim().toLowerCase())
}

/**
 * Resolve a scene id from a wire value.
 * @param value - raw scene id or Chinese/English name.
 * @returns the stable id, or undefined for an unknown value.
 */
export function sceneIdOf(value) {
  if (typeof value !== 'string') return undefined
  return SCENE_ALIASES.get(value.trim()) ?? SCENE_ALIASES.get(value.trim().toLowerCase())
}

/**
 * Resolve an item id from a wire value.
 * @param value - raw item id or Chinese/English name.
 * @returns the stable id, or undefined for an unknown value.
 */
export function itemIdOf(value) {
  if (typeof value !== 'string') return undefined
  return ITEM_ALIASES.get(value.trim()) ?? ITEM_ALIASES.get(value.trim().toLowerCase())
}

/**
 * Resolve an animation id from a wire value.
 * @param value - raw animation id or Chinese/English name.
 * @returns the stable id, or undefined for an unknown value.
 */
export function animationIdOf(value) {
  if (typeof value !== 'string') return undefined
  return ANIMATION_ALIASES.get(value.trim()) ?? ANIMATION_ALIASES.get(value.trim().toLowerCase())
}

/**
 * Read one finite coordinate clamped to the walkable area.
 * @param value - raw coordinate.
 * @returns the clamped number, or undefined when the value is not finite.
 */
function coordinateOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, value))
}

/**
 * Normalize one browser world snapshot.
 * @param input - untrusted JSON value from the browser.
 * @returns a compact snapshot; unknown fields are dropped rather than rejected.
 */
export function sanitizeWorld(input) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const world = { scene: sceneIdOf(source.scene) ?? 'beach', bag: {}, items: [], bots: [] }
  if (source.bag !== null && typeof source.bag === 'object' && !Array.isArray(source.bag)) {
    for (const [name, count] of Object.entries(source.bag)) {
      const id = itemIdOf(name)
      if (id === undefined || typeof count !== 'number' || !Number.isFinite(count)) continue
      const bounded = Math.max(0, Math.min(999, Math.floor(count)))
      world.bag[id] = bounded
    }
  }
  if (Array.isArray(source.items)) {
    for (const entry of source.items.slice(0, WORLD_ITEM_MAX)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const type = itemIdOf(entry.type)
      const x = coordinateOf(entry.x)
      const z = coordinateOf(entry.z)
      if (type === undefined || x === undefined || z === undefined) continue
      world.items.push({ type, x, z })
    }
  }
  const bots = source.bots !== null && typeof source.bots === 'object' && !Array.isArray(source.bots)
    ? source.bots
    : source.chars !== null && typeof source.chars === 'object' && !Array.isArray(source.chars)
      ? source.chars
      : {}
  for (const bot of BOTS) {
    const entry = bots[bot.id]
    const scene = entry !== null && typeof entry === 'object' ? sceneIdOf(entry.scene) : undefined
    const x = entry !== null && typeof entry === 'object' ? coordinateOf(entry.x) : undefined
    const z = entry !== null && typeof entry === 'object' ? coordinateOf(entry.z) : undefined
    world.bots.push({
      id: bot.id,
      scene: scene ?? world.scene,
      x: x ?? 0,
      z: z ?? 0,
    })
  }
  return world
}

/**
 * Describe one normalized world snapshot for a companion prompt.
 * @param input - browser snapshot, or an already normalized one.
 * @returns the compact prompt-ready account, bounded by {@link WORLD_TEXT_MAX_CHARS}.
 */
export function describeWorld(input) {
  const world = sanitizeWorld(input)
  const scene = SCENES.find(row => row.id === world.scene)
  const bag = Object.entries(world.bag)
    .filter(([, count]) => count > 0)
    .map(([id, count]) => `${ITEMS.find(row => row.id === id)?.name ?? id}×${count}`)
  const lines = [
    `[世界] 场景：${scene?.name ?? world.scene}`,
    `背包：${bag.length > 0 ? bag.join('、') : '空'}`,
    `地上：${world.items.length > 0
      ? world.items.map(item => `${ITEMS.find(row => row.id === item.type)?.name ?? item.type}(${item.x.toFixed(1)},${item.z.toFixed(1)})`).join('、')
      : '空'}`,
  ]
  const partners = world.bots.map((entry) => {
    const bot = BOT_BY_ID.get(entry.id)
    const where = SCENES.find(row => row.id === entry.scene)
    return `${bot?.name ?? entry.id}在${where?.name ?? entry.scene}`
  })
  lines.push(`伙伴：${partners.join('、')}`)
  const text = lines.join('；')
  return text.length <= WORLD_TEXT_MAX_CHARS ? text : `${text.slice(0, WORLD_TEXT_MAX_CHARS - 1)}…`
}
