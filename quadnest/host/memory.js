/**
 * Four-layer memory for QuadNest companions.
 *
 * A companion's Agent keeps a durable Session, and that session's log is what it
 * remembers — until the log outgrows the model's window. Then the oldest turns
 * silently fall out of the prompt and the companion "forgets you" mid-relationship.
 *
 * This module is the substrate that survives that. It keeps four layers, each
 * with a different lifetime:
 *
 * - `persona`    — slow, self-directed impressions ("我喜欢在下雨天待在小屋")
 * - `reflection` — periodic thoughts about the visitor and the relationship
 * - `fact`       — durable statements about the visitor ("访客喜欢下雨天")
 * - `recent`     — the last few turns verbatim, so short-range continuity works
 *                  even when the session is cold
 *
 * The raw transcript is a fifth thing, and deliberately *not* a layer: every turn
 * is appended to `journal.jsonl`, which is never read back into a prompt. It is
 * there to audit what a companion was told, not to be recalled. That split is the
 * whole point — a memory that keeps everything forever is a log, and a log does
 * not fit in a context window.
 *
 * @module dsh-quadnest/host/memory
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** On-disk shape version; a mismatch drops the store instead of guessing. */
export const MEMORY_VERSION = 1
/** Verbatim turns kept per companion, newest last. */
export const RECENT_LIMIT = 16
/** Verbatim turns shown in one prompt. */
export const RECENT_PROMPT_LIMIT = 6
/** Durable facts kept per companion. */
export const FACT_LIMIT = 40
/** Reflections kept per companion. */
export const REFLECTION_LIMIT = 12
/** Persona impressions kept per companion. */
export const PERSONA_LIMIT = 12
/** Longest accepted memory line, in characters. */
export const MEMORY_TEXT_MAX = 160
/** Layers a model may write to through the `[REMEMBER]` marker. */
export const WRITABLE_LAYERS = ['fact', 'reflection', 'persona']

/** Empty layer set for one target. */
const emptyLayers = () => ({ persona: [], facts: [], reflections: [], recent: [] })

/**
 * Read the directory memory lives in: `<DSH_HOME or ~/.dsh>/quadnest`.
 * @returns Absolute directory path.
 */
export function resolveMemoryDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'quadnest')
}

/**
 * Split text into comparable tokens.
 *
 * Chinese has no spaces, so per-word matching would never hit: a sentence is cut
 * into overlapping bigrams instead, which is the same trick the repo's search
 * code uses. ASCII words are kept whole.
 * @param text - text to tokenize.
 * @returns Distinct tokens.
 */
export function memoryTokens(text) {
  const raw = typeof text === 'string' ? text.toLowerCase() : ''
  const tokens = new Set()
  for (const run of raw.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.add(run)
    for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2))
  }
  for (const word of raw.match(/[a-z0-9]{2,}/g) ?? []) tokens.add(word)
  return tokens
}

/**
 * Score one memory line against a query.
 * @param query - distinct query tokens, or an empty set for "no query".
 * @param text - candidate memory text.
 * @returns 0 when nothing matches; otherwise overlap normalized by line length,
 * so a short line that matches one word outranks a long line that also matches it.
 */
export function recallScore(query, text) {
  if (query.size === 0) return 0
  const tokens = memoryTokens(text)
  if (tokens.size === 0) return 0
  let hits = 0
  for (const token of query) if (tokens.has(token)) hits += 1
  return hits === 0 ? 0 : hits / Math.sqrt(tokens.size)
}

/**
 * Normalize one candidate memory line.
 * @param text - raw text from a model or a caller.
 * @returns Trimmed text, or undefined when there is nothing worth storing.
 */
export function normalizeMemoryText(text) {
  if (typeof text !== 'string') return undefined
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed === '') return undefined
  return trimmed.length <= MEMORY_TEXT_MAX ? trimmed : `${trimmed.slice(0, MEMORY_TEXT_MAX - 1)}…`
}

/** Key used to detect a line already stored in a layer. */
function memoryKey(text) {
  return text.replace(/[\s，。！？、；：,.!?;:'"“”‘’()（）【】\[\]]+/g, '')
}

/**
 * One companion's (or the group chat's) layered memory, persisted as JSON.
 *
 * Reads are synchronous over an in-memory snapshot so routes and prompts never
 * wait on disk; writes are serialized in the background so two turns cannot
 * interleave their file writes.
 */
export class MemoryStore {
  #dir
  #now
  #targets = new Map()
  #loaded = false
  #writing = Promise.resolve()
  #failures = 0

  /**
   * @param options - storage directory and clock.
   */
  constructor(options = {}) {
    this.#dir = options.dir ?? resolveMemoryDir()
    this.#now = typeof options.now === 'function' ? options.now : () => Date.now()
  }

  /** Directory holding `memory.json` and `journal.jsonl`. */
  get dir() {
    return this.#dir
  }

  /** Path of the append-only raw journal. */
  get journalPath() {
    return join(this.#dir, 'journal.jsonl')
  }

  /** Path of the layered store. */
  get storePath() {
    return join(this.#dir, 'memory.json')
  }

  /** How many background writes have failed so far; surfaced in health output. */
  get writeFailures() {
    return this.#failures
  }

  /**
   * Read the store from disk once. A missing file is an empty memory; a corrupt
   * or version-mismatched file is dropped rather than half-trusted, because a
   * malformed memory would be injected straight into a prompt.
   * @returns Fulfillment once the snapshot is in memory.
   */
  async load() {
    if (this.#loaded) return
    this.#loaded = true
    let raw
    try {
      raw = JSON.parse(await readFile(this.storePath, 'utf8'))
    } catch {
      return
    }
    if (raw === null || typeof raw !== 'object' || raw.version !== MEMORY_VERSION) return
    const targets = raw.targets
    if (targets === null || typeof targets !== 'object') return
    for (const [target, layers] of Object.entries(targets)) {
      if (layers === null || typeof layers !== 'object') continue
      this.#targets.set(target, {
        persona: this.#validItems(layers.persona, PERSONA_LIMIT),
        facts: this.#validItems(layers.facts, FACT_LIMIT),
        reflections: this.#validItems(layers.reflections, REFLECTION_LIMIT),
        recent: this.#validItems(layers.recent, RECENT_LIMIT),
      })
    }
  }

  /**
   * Keep only well-formed items from a stored layer.
   * @param value - stored array.
   * @param limit - cap for the layer.
   * @returns Sanitized items, newest last.
   */
  #validItems(value, limit) {
    if (!Array.isArray(value)) return []
    const items = []
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object') continue
      const text = normalizeMemoryText(entry.text)
      if (text === undefined) continue
      items.push({
        text,
        at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0,
        turnId: typeof entry.turnId === 'string' ? entry.turnId : '',
        ...(typeof entry.label === 'string' && entry.label !== '' ? { label: entry.label } : {}),
      })
    }
    return items.slice(-limit)
  }

  /**
   * Read one target's layers as plain arrays.
   * @param target - companion id or `group`.
   * @returns A shallow copy of every layer.
   */
  layers(target) {
    const entry = this.#targets.get(target)
    if (entry === undefined) return emptyLayers()
    return {
      persona: entry.persona.slice(),
      facts: entry.facts.slice(),
      reflections: entry.reflections.slice(),
      recent: entry.recent.slice(),
    }
  }

  /** Read the mutable layer record for one target, creating it on demand. */
  #ensure(target) {
    let entry = this.#targets.get(target)
    if (entry === undefined) {
      entry = emptyLayers()
      this.#targets.set(target, entry)
    }
    return entry
  }

  /**
   * Record one spoken line: append it to the journal, and push it onto the
   * recent window. The journal is written even when the recent window drops the
   * line, so an audit still sees the whole conversation.
   * @param target - companion id or `group`.
   * @param entry - who spoke, what they said, and which turn it belonged to.
   * @returns Nothing; persistence happens in the background.
   */
  record(target, entry) {
    const text = normalizeMemoryText(entry?.text)
    if (text === undefined) return
    const role = entry.role === 'visitor' ? 'visitor' : 'companion'
    const label = typeof entry.label === 'string' && entry.label !== '' ? entry.label : role === 'visitor' ? '访客' : target
    const item = { text, at: typeof entry.at === 'number' ? entry.at : this.#now(), turnId: typeof entry.turnId === 'string' ? entry.turnId : '', label }
    const layers = this.#ensure(target)
    layers.recent = layers.recent.concat([{ text, at: item.at, turnId: item.turnId, label }]).slice(-RECENT_LIMIT)
    this.#journal(target, item, role)
    this.#persist()
  }

  /**
   * Store lines a companion said it wants to remember.
   * @param target - companion id or `group`.
   * @param items - `[{ layer, text }]` from the reply protocol.
   * @returns The items actually stored, so a caller can report the difference.
   */
  remember(target, items) {
    const layers = this.#ensure(target)
    const stored = []
    for (const item of Array.isArray(items) ? items : []) {
      const layer = WRITABLE_LAYERS.includes(item?.layer) ? item.layer : 'fact'
      const text = normalizeMemoryText(item?.text)
      if (text === undefined) continue
      const bucket = layer === 'persona' ? layers.persona : layer === 'reflection' ? layers.reflections : layers.facts
      const limit = layer === 'persona' ? PERSONA_LIMIT : layer === 'reflection' ? REFLECTION_LIMIT : FACT_LIMIT
      const key = memoryKey(text)
      // A companion repeating itself must not fill the layer; the stored line
      // keeps its original timestamp so "long known" stays true.
      if (bucket.some(entry => memoryKey(entry.text) === key)) continue
      bucket.push({ text, at: this.#now(), turnId: typeof item?.turnId === 'string' ? item.turnId : '' })
      if (bucket.length > limit) bucket.splice(0, bucket.length - limit)
      stored.push({ layer, text })
    }
    if (stored.length > 0) this.#persist()
    return stored
  }

  /**
   * Pick the lines worth putting in front of a companion right now.
   *
   * Persona is always included — it is who they are. Reflections and facts are
   * ranked against the visitor's current words, so a question about the rain
   * surfaces the rain, not the fact stored five turns ago. With no query (an
   * unsolicited opening), the newest lines stand in.
   * @param target - companion id or `group`.
   * @param query - the visitor's text for this turn; empty for an idle turn.
   * @param options - per-layer caps.
   * @returns The recalled items per layer, newest last.
   */
  recall(target, query, options = {}) {
    const layers = this.layers(target)
    const factLimit = Number.isInteger(options.facts) ? options.facts : 4
    const reflectionLimit = Number.isInteger(options.reflections) ? options.reflections : 2
    const personaLimit = Number.isInteger(options.persona) ? options.persona : 4
    const recentLimit = Number.isInteger(options.recent) ? options.recent : RECENT_PROMPT_LIMIT
    const tokens = memoryTokens(query)

    const rank = (items, limit) => {
      if (items.length === 0 || limit <= 0) return []
      if (tokens.size === 0) return items.slice(-limit)
      const scored = items.map((item, index) => ({ item, index, score: recallScore(tokens, item.text) }))
      // Matching lines come first, best first. The remaining slots are filled with
      // the newest lines anyway: a companion that only recalls what literally
      // matches the last sentence would seem to have forgotten everything else.
      const matched = scored.filter(row => row.score > 0).sort((left, right) => right.score - left.score || right.index - left.index)
      const rest = scored.filter(row => row.score === 0).sort((left, right) => right.index - left.index)
      return matched.concat(rest)
        .slice(0, limit)
        // Rendered chronologically: memory should read as a history, not a ranking.
        .sort((left, right) => left.index - right.index)
        .map(row => row.item)
    }

    return {
      persona: layers.persona.slice(-personaLimit),
      reflections: rank(layers.reflections, reflectionLimit),
      facts: rank(layers.facts, factLimit),
      recent: layers.recent.slice(-recentLimit),
    }
  }

  /**
   * Render the recalled layers as the lines injected into a turn.
   *
   * The shape is deliberately flat and prefixed: the model gets told what each
   * line is (an impression, a fact, something said recently), and the raw
   * journal never appears here at all.
   * @param target - companion id or `group`.
   * @param query - the visitor's text for this turn; empty for an idle turn.
   * @param options - per-layer caps passed through to {@link recall}.
   * @returns Lines to append after the world snapshot; empty when nothing is known yet.
   */
  compose(target, query, options = {}) {
    const recalled = this.recall(target, query, options)
    const lines = []
    for (const item of recalled.persona) lines.push(`[记忆·印象] ${item.text}`)
    for (const item of recalled.reflections) lines.push(`[记忆·反思] ${item.text}`)
    for (const item of recalled.facts) lines.push(`[记忆·事实] ${item.text}`)
    for (const item of recalled.recent) lines.push(`[记忆·最近] ${item.label ?? '访客'}：${item.text}`)
    return lines
  }

  /**
   * Count what is stored, for the status route and for tests.
   * @returns One entry per target with a count per layer.
   */
  summary() {
    const summary = {}
    for (const [target, layers] of this.#targets) {
      summary[target] = {
        persona: layers.persona.length,
        facts: layers.facts.length,
        reflections: layers.reflections.length,
        recent: layers.recent.length,
      }
    }
    return summary
  }

  /**
   * Forget everything, including the journal. Called when the world is reset:
   * the product promises the companions start over, and a surviving journal with
   * surviving layers would be a half-reset nobody can reason about.
   * @returns Fulfillment once the empty store is on disk.
   */
  async clear() {
    this.#targets.clear()
    this.#loaded = true
    await this.#enqueue(async () => {
      await mkdir(this.#dir, { recursive: true })
      await writeFile(this.storePath, JSON.stringify({ version: MEMORY_VERSION, targets: {} }), 'utf8')
      await writeFile(this.journalPath, '', 'utf8')
    })
  }

  /**
   * Wait for every queued write to land.
   * @returns Fulfillment when the on-disk store matches memory.
   */
  async flush() {
    await this.#writing
  }

  /** Queue one write behind the previous one so ordering is preserved. */
  #enqueue(task) {
    this.#writing = this.#writing.then(task, task).then(
      () => undefined,
      (error) => {
        // A failed write must not break a conversation, but it must not be silent
        // either: the counter reaches the status route.
        this.#failures += 1
        if (typeof process.emitWarning === 'function') {
          process.emitWarning(`quadnest memory write failed: ${String(error?.message ?? error)}`)
        }
      },
    )
    return this.#writing
  }

  /** Persist the layered store. */
  #persist() {
    const targets = {}
    for (const [target, layers] of this.#targets) {
      targets[target] = {
        persona: layers.persona,
        facts: layers.facts,
        reflections: layers.reflections,
        recent: layers.recent,
      }
    }
    const payload = JSON.stringify({ version: MEMORY_VERSION, targets })
    void this.#enqueue(async () => {
      await mkdir(this.#dir, { recursive: true })
      // Write-then-rename: a crash mid-write must not leave a truncated memory
      // that the next boot would drop or, worse, half-read.
      const temporary = `${this.storePath}.tmp`
      await writeFile(temporary, payload, 'utf8')
      await rename(temporary, this.storePath)
    })
  }

  /** Append one journal line. */
  #journal(target, item, role) {
    const line = `${JSON.stringify({ at: item.at, target, role, label: item.label, turnId: item.turnId, text: item.text })}\n`
    void this.#enqueue(async () => {
      await mkdir(this.#dir, { recursive: true })
      await appendFile(this.journalPath, line, 'utf8')
    })
  }
}

/**
 * Build a memory store for one plugin instance.
 * @param options - storage directory and clock; both optional.
 * @returns A store that has not read from disk yet.
 */
export function createMemoryStore(options = {}) {
  return new MemoryStore(options)
}
