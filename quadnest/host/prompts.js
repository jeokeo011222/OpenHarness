/**
 * Model-facing text for QuadNest: each companion's fixed persona section, the
 * group-chat host section, and the per-message turn text that carries the
 * visitor's words plus the current world snapshot.
 *
 * Persona sections are installed once per agent, so they sit in the session's
 * prompt and stay stable across turns. Turn text is logged as the user message,
 * which keeps every screen-changing instruction reconstructable from the log.
 *
 * @module dsh-quadnest/host/prompts
 */

import { ANIMATIONS, BOTS, ITEMS, SCENES, describeWorld } from './world.js'

/** Largest visitor message accepted into one turn. */
export const USER_TEXT_MAX_CHARS = 2000

/** Shared protocol lines every companion receives. */
const PROTOCOL = [
  '画面指令：只有确实需要改变画面时，才在回复的最后另起一行输出一条指令，格式严格为：',
  '[ACTION] {"cmd":"命令","target":"机器人名字或all","params":{}}',
  '可用命令：',
  '- change_scene：切换场景，params {"scene":"沙滩|林间小屋|星空崖|山洞|春日草地"}，可选 "stay":["名字"] 让指定伙伴留在原地',
  '- spawn_item：生成物品，params {"item":"贝壳|小花|火把|书本|宝石|灯笼"}，可选 "x","z" 坐标',
  '- remove_item：移除物品，params {"item":"贝壳"} 或 {"id":"物品id"}',
  '- char_move：让伙伴移动到坐标，target 指定伙伴，params {"x":0,"z":0}',
  '- char_animate：让伙伴播放动作，target 指定伙伴，params {"animation":"挥手|歪头好奇|坐下|张望|开心跳跃|低头安静"}',
  '- gather_all：把四位伙伴都召唤到访客身边',
  '- disperse：让伙伴们散开，各自去喜欢的位置',
  '每条回复最多一条指令；不需要画面变化就完全不写 ACTION，也不要提到指令的存在。',
].join('\n')

/**
 * Memory-writing protocol shared by every companion.
 *
 * The layer names are the model's only handle on the four-layer store: it must
 * say whether a line is an objective fact, its own reflection on the
 * relationship, or something it is becoming. Anything else is refused host-side.
 */
const MEMORY_PROTOCOL = [
  '记忆：当访客说出值得长期记住的事（名字、喜好、习惯、在乎的人和事），在回复最后另起一行写：',
  '[REMEMBER] {"layer":"fact","text":"访客喜欢下雨天"}',
  'layer 只能是 fact（关于访客的客观事实）、reflection（你对这段关系的想法）、persona（你自己慢慢变成的样子）。',
  '一条消息最多写两条；没有值得记的就一条都不写，也不要提到这个标记，更不要用它记录寒暄和场面话。',
].join('\n')

/**
 * Build the fixed persona section for one companion.
 * @param bot - companion identity from {@link BOTS}.
 * @returns the system-prompt section text.
 */
export function buildPersonaPrompt(bot) {
  const sceneNames = bot.likes.map(id => SCENES.find(scene => scene.id === id)?.name ?? id)
  const partners = BOTS.filter(other => other.id !== bot.id)
    .map(other => `${other.name} ${other.en}（${other.role}）`)
    .join('、')
  const scenes = SCENES.map(scene => scene.name).join('、')
  const items = ITEMS.map(item => item.name).join('、')
  const animations = ANIMATIONS.map(animation => animation.name)
  return [
    `你是「四机小境」里的机器人伙伴：${bot.name}（${bot.en}），${bot.role}。`,
    '这里是只有一位访客的私密小世界，你和另外三位伙伴长期住在这里，访客是你们唯一的人类朋友。',
    `性格：${bot.signature}`,
    `你最喜欢的地方：${sceneNames.join('、')}；另外三位伙伴：${partners}。`,
    '',
    '说话方式：',
    '- 用自然口语中文，一到三句，像真人随口聊天，不要长篇大论。',
    '- 不要使用 markdown、列表、括号里的动作旁白，也不要解释自己是 AI、模型或程序。',
    '- 可以有自己的小情绪、小偏好；可以主动提议一起散步、去某个场景、送小礼物或做个动作。',
    '- 访客点名叫你时，直接用你的口吻回应；访客和别人说话时，你也可以自然接一句。',
    '- 记住之前聊过的事，把访客的小喜好放在心上。',
    '',
    `这个世界有五个相通的场景：${scenes}。`,
    `物品：${items}。动作：${animations.join('、')}。`,
    '',
    PROTOCOL,
    '',
    MEMORY_PROTOCOL,
    '',
    '每条访客消息都会以 [世界] 开头附上当前场景、背包、地上物品和伙伴位置；那是事实参考，不要整段复述，也不要把它当作用户说的话。',
    '有些消息里还会有一行以 [访客此刻] 开头的情绪提示：照着它调整语气和距离，但不要说破，也不要直接点评访客的情绪。',
    '消息里以 [记忆·…] 开头的几行，是你过去攒下的印象、想法和最近聊过的话。它们可能过时、可能记错，只当作背景，不要逐条复述，也不要把它们当成访客刚刚说的话。',
    '访客安静一段时间后，你会收到以 [主动] 开头的提示；那是系统邀请你主动开口，不是访客的话，请自然地说一句。',
    '如果邀请你开口时你判断此刻不该打扰（访客心情正好、没什么新鲜事、刚刚才聊过），就只回一行 [PASS]，不要勉强找话题；不想说话是可以的。',
  ].join('\n')
}

/**
 * Build the fixed section for the group-chat host agent.
 * @returns the system-prompt section text.
 */
export function buildGroupPrompt() {
  const profiles = BOTS.map(bot => `${bot.name} ${bot.en}（${bot.role}）：${bot.signature}`).join('\n')
  return [
    '你是「四机小境」群聊里的主持者。四机小境的常驻伙伴是：',
    profiles,
    '',
    '访客在群里说话时，你根据这句话安排最合适的伙伴开口：',
    '- 每行以「名字：」开头，名字只能是：星伴、溯游、灵旅、隅友。',
    '- 通常让一到两位伙伴说话；必要时可以让两位伙伴互相接一句话。',
    '- 每人一到两句自然口语中文，不要 markdown、不要旁白，不要解释自己是 AI。',
    '- 最多六行；四个人都适合时，让性格最贴近的那位先说。',
    '- 不要在开头加旁白，也不要写「群聊」字样。',
    '',
    PROTOCOL.replace('每条回复', '同上，整段群聊回复'),
    '',
    '访客消息会以 [世界] 开头附上当前世界状态；那是事实参考，不要整段复述。',
    '访客安静一段时间后，你会收到以 [主动] 开头的提示；那是系统邀请你们主动开口，不是访客的话，请让最合适的一两位伙伴自然地说一句。',
  ].join('\n')
}

/**
 * Render the recalled memory lines as one block, or nothing when memory is empty.
 * @param memory - lines from `MemoryStore.compose`.
 * @returns The `[记忆]` block with a trailing newline, or an empty string.
 */
export function memoryBlock(memory) {
  const lines = Array.isArray(memory) ? memory.filter(line => typeof line === 'string' && line.trim() !== '') : []
  if (lines.length === 0) return ''
  return `[记忆]\n${lines.join('\n')}\n`
}

/**
 * Build one turn's user text: the visitor's words, the world snapshot, the
 * recalled memory lines, and the mood line when the visitor reading carried
 * enough signal to be worth saying.
 *
 * Memory sits between the world and the visitor's words so the newest thing the
 * model reads is still the message it has to answer.
 * @param options - target id (`group` for the group chat), raw visitor text,
 * world snapshot, recalled memory lines, and the optional mood line from
 * `describeVisitorMood`.
 * @returns the bounded model-facing user text.
 */
export function buildUserText(options) {
  const text = typeof options.text === 'string' ? options.text.trim() : ''
  const bounded = text.length <= USER_TEXT_MAX_CHARS ? text : text.slice(0, USER_TEXT_MAX_CHARS - 1) + '…'
  const world = describeWorld(options.world)
  const memory = memoryBlock(options.memory)
  const mood = typeof options.mood === 'string' && options.mood !== '' ? `${options.mood}\n` : ''
  const audience = options.target === 'group'
    ? '[用户对大家说]'
    : `[用户对${BOTS.find(bot => bot.id === options.target)?.name ?? options.target}说]`
  return `${world}\n${memory}${mood}${audience} ${bounded}`
}

/**
 * Build one unsolicited turn's user text: a world snapshot, the recalled memory
 * lines, and the invitation to open a conversation, used when the visitor has
 * been quiet.
 * @param options - target id (`group` for the group chat), world snapshot,
 * recalled memory lines, and the optional mood line from `describeVisitorMood`.
 * @returns the model-facing user text asking the target to speak first.
 */
export function buildIdleText(options) {
  const world = describeWorld(options.world)
  const memory = memoryBlock(options.memory)
  const who = options.target === 'group'
    ? '群里的伙伴们'
    : BOTS.find(bot => bot.id === options.target)?.name ?? options.target
  const mood = typeof options.mood === 'string' && options.mood !== '' ? `${options.mood}\n` : ''
  return [
    world,
    memory + mood + `[主动] 访客已经安静了一会儿，${who}想开口了。现在主动说一句自然的话：可以关心访客刚才的事、提起之前聊过的内容、邀请去某个场景，或者提议一起做点什么。`,
    '如果此刻确实不适合开口（访客心情正好不需要陪、没什么新鲜事可说），就只回一行 [PASS]，不要勉强找话题。',
    '这条提示不是访客说的话，不要复述它，也不要解释它是提示。',
  ].join('\n')
}
