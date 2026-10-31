/**
 * QuadNest reply protocol: separating a companion's prose from its trailing
 * `[ACTION]` and `[REMEMBER]` instructions, normalizing instructions into the
 * browser's command vocabulary, and attributing group-chat lines to the
 * companion who said them.
 *
 * Replies arrive from a model, so every field is treated as wire input: unknown
 * commands, unknown scene or item names, non-finite coordinates, unknown memory
 * layers, and oversized memory lines are discarded instead of forwarded.
 *
 * @module dsh-quadnest/host/protocol
 */

import { randomUUID } from 'node:crypto'
import { WRITABLE_LAYERS, normalizeMemoryText } from './memory.js'
import { animationIdOf, botIdOf, itemIdOf, sceneIdOf } from './world.js'

/** Marker that opens one picture instruction line. */
const ACTION_MARKER = '[ACTION]'
/** Marker that opens one memory write line. */
const REMEMBER_MARKER = '[REMEMBER]'
/** Marker a companion returns instead of speaking when now is the wrong moment. */
const PASS_MARKER = /[[【]\s*PASS\s*[\]】]/i
/** Largest number of instructions accepted from one reply. */
export const MAX_ACTIONS = 4
/** Largest number of memory writes accepted from one reply. */
export const MAX_REMEMBER = 3
/** Largest number of group-chat bubbles accepted from one reply. */
export const MAX_GROUP_SEGMENTS = 6
/** Bound on one group-chat bubble's text. */
const SEGMENT_TEXT_MAX = 600

/** Group-chat addressees that mean "everyone". */
const GROUP_ALIASES = new Set(['group', '群聊', '大家', '所有人', '全员', 'all'])

/**
 * Resolve a chat target: a companion id, the `group` chat, or undefined.
 * @param value - raw target name.
 * @returns the stable target, or undefined when unknown.
 */
export function resolveChatTarget(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (GROUP_ALIASES.has(text) || GROUP_ALIASES.has(text.toLowerCase())) return 'group'
  return botIdOf(text)
}

/**
 * Resolve an instruction target: a companion id, `all`, or undefined.
 * @param value - raw target name.
 * @returns the stable target, or undefined when unknown.
 */
export function resolveActionTarget(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text === 'all' || text === '全部' || text === '所有人' || text === '全员' || text === '大家') return 'all'
  return botIdOf(text)
}

/**
 * Read one balanced JSON object starting at the first non-space character.
 * @param text - candidate text.
 * @returns the parsed value and the exclusive end offset, or undefined when no
 * complete object parses.
 */
function readJsonObject(text) {
  let start = 0
  while (start < text.length && /\s/.test(text[start])) start += 1
  if (text[start] !== '{') return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return { value: JSON.parse(text.slice(start, index + 1)), end: index + 1 }
        } catch {
          // The span is balanced but not valid JSON, so there is nothing to execute.
          return undefined
        }
      }
    }
  }
  return undefined
}

/**
 * Read one finite coordinate.
 * @param value - raw coordinate.
 * @returns the number, or undefined when not finite.
 */
function finiteCoordinate(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Normalize one parsed instruction.
 * @param raw - parsed JSON value from a `[ACTION]` line.
 * @returns the browser command, or undefined when the command or its required
 * parameters are unknown or missing.
 */
export function normalizeAction(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const cmd = typeof raw.cmd === 'string' ? raw.cmd.trim() : ''
  const params = raw.params !== null && typeof raw.params === 'object' && !Array.isArray(raw.params) ? raw.params : {}
  const target = resolveActionTarget(raw.target) ?? resolveActionTarget(params.target)
  switch (cmd) {
    case 'change_scene': {
      const scene = sceneIdOf(params.scene) ?? sceneIdOf(params.to) ?? sceneIdOf(params.name) ?? sceneIdOf(raw.target) ?? sceneIdOf(raw.scene)
      if (scene === undefined) return undefined
      const stay = Array.isArray(params.stay)
        ? params.stay.map(botIdOf).filter(Boolean).slice(0, 4)
        : []
      return { cmd, target: 'all', params: stay.length > 0 ? { scene, stay } : { scene } }
    }
    case 'spawn_item': {
      const item = itemIdOf(params.item) ?? itemIdOf(params.name) ?? itemIdOf(params.type)
      if (item === undefined) return undefined
      const x = finiteCoordinate(params.x)
      const z = finiteCoordinate(params.z)
      return { cmd, target: target ?? 'all', params: { item, ...((x !== undefined && z !== undefined) ? { x, z } : {}) } }
    }
    case 'remove_item': {
      const item = itemIdOf(params.item) ?? itemIdOf(params.name) ?? itemIdOf(params.type)
      const id = typeof params.id === 'string' && params.id.trim() !== '' ? params.id.trim() : undefined
      if (item === undefined && id === undefined) return undefined
      return { cmd, target: target ?? 'all', params: { ...item !== undefined ? { item } : {}, ...id !== undefined ? { id } : {} } }
    }
    case 'char_move': {
      if (target === undefined) return undefined
      const x = finiteCoordinate(params.x)
      const z = finiteCoordinate(params.z)
      if (x === undefined || z === undefined) return undefined
      return { cmd, target, params: { x, z } }
    }
    case 'char_animate': {
      if (target === undefined) return undefined
      const animation = animationIdOf(params.animation) ?? animationIdOf(params.anim) ?? animationIdOf(params.name)
      if (animation === undefined) return undefined
      return { cmd, target, params: { animation } }
    }
    case 'gather_all':
    case 'disperse':
      return { cmd, target: 'all', params: {} }
    default:
      return undefined
  }
}

/**
 * Normalize one memory write a companion asked for.
 * @param raw - parsed JSON value from a `[REMEMBER]` line.
 * @returns `{ layer, text }`, or undefined when the layer or text is unusable.
 */
export function normalizeMemoryItem(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const layer = typeof raw.layer === 'string' ? raw.layer.trim().toLowerCase() : 'fact'
  if (!WRITABLE_LAYERS.includes(layer)) return undefined
  // Models pick their own field name; accept the obvious variants instead of
  // dropping a memory over a key that means the same thing.
  const text = normalizeMemoryText(raw.text ?? raw.memory ?? raw.content)
  if (text === undefined) return undefined
  return { layer, text }
}

/**
 * Accept a turn identifier from a caller, or mint one.
 *
 * The browser mints the id so an answer can be matched to the question that
 * caused it even when several companions answer out of order; the host only
 * checks the shape and never trusts it for anything but attribution.
 * @param value - candidate id from a request body.
 * @returns A bounded, URL-safe id.
 */
export function normalizeTurnId(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) return trimmed
  }
  return `turn-${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

/**
 * Remove every occurrence of one marker and its JSON object from a reply.
 *
 * Markers are read from the end backwards, which is why collected values are
 * unshifted: the caller gets them in the order the companion wrote them. A
 * marker whose JSON does not parse is protocol noise and is dropped with the
 * rest of its line, so a half-written instruction never reaches the transcript.
 * @param text - reply text with earlier markers already removed.
 * @param marker - marker to strip, e.g. `[ACTION]`.
 * @returns The remaining text and the parsed JSON values in source order.
 */
function extractMarker(text, marker) {
  let remaining = text
  const values = []
  while (remaining !== '') {
    const index = remaining.toUpperCase().lastIndexOf(marker)
    if (index < 0) break
    const after = remaining.slice(index + marker.length)
    const parsed = readJsonObject(after)
    if (parsed === undefined) {
      const lineEnd = remaining.indexOf('\n', index)
      remaining = `${remaining.slice(0, index)}${lineEnd < 0 ? '' : remaining.slice(lineEnd)}`.trimEnd()
      continue
    }
    values.unshift(parsed.value)
    remaining = `${remaining.slice(0, index)}${after.slice(parsed.end)}`.trimEnd()
  }
  return { text: remaining, values }
}

/**
 * Separate prose from the `[ACTION]` and `[REMEMBER]` instructions in one reply.
 *
 * A reply may instead carry `[PASS]`, optionally with a short reason on the same
 * line. That is the companion declining to speak first; it is a success, not an
 * empty or failed answer, so it is reported separately rather than folded into
 * an empty text.
 * @param text - raw assistant text.
 * @returns the visible prose, the normalized instructions found in order, the
 * memory writes the companion asked for, and whether it declined to speak.
 */
export function parseReply(text) {
  let remaining = typeof text === 'string' ? text.trim() : ''
  let pass = false
  let passReason = ''
  const decline = PASS_MARKER.exec(remaining)
  if (decline !== null) {
    pass = true
    const lineEnd = remaining.indexOf('\n', decline.index)
    const tail = remaining.slice(decline.index + decline[0].length, lineEnd < 0 ? remaining.length : lineEnd)
    passReason = tail.trim().slice(0, 200)
    remaining = `${remaining.slice(0, decline.index)}${lineEnd < 0 ? '' : remaining.slice(lineEnd)}`.trim()
  }
  const instructions = extractMarker(remaining, ACTION_MARKER)
  const memories = extractMarker(instructions.text, REMEMBER_MARKER)
  const actions = instructions.values.map(normalizeAction).filter(action => action !== undefined)
  const remember = memories.values.map(normalizeMemoryItem).filter(item => item !== undefined)
  return {
    text: memories.text.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim() !== '').join('\n').trim(),
    actions: actions.slice(0, MAX_ACTIONS),
    remember: remember.slice(0, MAX_REMEMBER),
    pass,
    passReason,
  }
}

/** Localized or English companion name at the head of one group-chat line. */
const SPEAKER_PREFIX = /^(星伴|StarPaeon|溯游|Suyou|灵旅|SpiritTrek|隅友|NookFriend)\s*[：:]\s*/i
/** List markers and emphasis a model may put before a name. */
const LINE_MARKER = /^[\s*_`>-]+/

/**
 * Read the companion named by one group-chat line prefix.
 * @param line - raw line, possibly starting with a list marker or bold name.
 * @returns the companion id, or undefined without a recognized prefix.
 */
function prefixSpeaker(line) {
  const stripped = line.replace(LINE_MARKER, '')
  const match = SPEAKER_PREFIX.exec(stripped)
  if (match === null) return undefined
  return botIdOf(match[1])
}

/**
 * Attribute one group-chat reply to the companions who spoke.
 * @param text - visible reply prose with instructions already removed.
 * @returns one bubble per speaker; unprefixed lines extend the previous bubble.
 */
export function splitGroupReply(text) {
  const source = typeof text === 'string' ? text : ''
  const segments = []
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line.trim() === '') continue
    const speaker = prefixSpeaker(line)
    if (speaker !== undefined) {
      const spoken = line.replace(LINE_MARKER, '').replace(SPEAKER_PREFIX, '')
      if (segments.length < MAX_GROUP_SEGMENTS) segments.push({ bot: speaker, text: spoken.trim() })
      continue
    }
    if (segments.length === 0) {
      segments.push({ bot: null, text: line.trim() })
      continue
    }
    const last = segments[segments.length - 1]
    last.text = `${last.text}\n${line.trim()}`.trim()
  }
  return segments
    .map(segment => ({
      bot: segment.bot,
      text: segment.text.length <= SEGMENT_TEXT_MAX ? segment.text : `${segment.text.slice(0, SEGMENT_TEXT_MAX - 1)}…`,
    }))
    .filter(segment => segment.text !== '')
}
