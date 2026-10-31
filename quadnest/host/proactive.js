/**
 * QuadNest proactive gate: the answer to "may a companion speak first, right
 * now, about this?" — separate from "can it speak at all".
 *
 * A model that can always answer is not the same as a companion worth living
 * with. The gate therefore walks the same stages on every invitation and always
 * reports why it stopped: entry guards (off, already busy, visitor is typing),
 * activity guards (not quiet enough, cooling down, visitor is in a good mood and
 * does not need checking on), source selection (nothing new in the world), the
 * model's own veto, and finally delivery. A refusal is a normal outcome, not an
 * error: the browser backs off for `retryAfterMs` and asks again later.
 *
 * @module dsh-quadnest/host/proactive
 */

import { distressOf } from './emotion.js'

/** Stable stage names, mirroring the order one invitation moves through. */
export const PROACTIVE_STAGES = Object.freeze({
  entry: 'entry_guard',
  activity: 'activity_gate',
  source: 'source_selection',
  model: 'model_decision',
  generation: 'generation',
  dedup: 'dedup',
  delivery: 'delivery',
  runtime: 'runtime_error',
})

/** Shortest gap between two delivered unsolicited turns, per target. */
const DEFAULT_MIN_GAP_MS = 180_000
/** Window in which a repeated opening line counts as a duplicate. */
const DEFAULT_DEDUPE_WINDOW_MS = 900_000
/** Bigram overlap above which two openings are the same opening. */
const DUPLICATE_SIMILARITY = 0.62
/** Quiet interval owed to a visitor whose last message showed distress. */
const DISTRESS_QUIET_SCALE = 0.6
/** Distress at or below which a visitor is clearly fine and should be left alone. */
const GOOD_MOOD_CEILING = -0.15

/**
 * Build one refusal decision.
 * @param stage - stage that stopped the invitation.
 * @param reasonCode - stable snake-case reason.
 * @param retryAfterMs - how long the browser should wait before asking again.
 * @returns the decision payload.
 */
function refuse(stage, reasonCode, retryAfterMs = 0) {
  return { action: 'pass', stage, reasonCode, retryAfterMs }
}

/**
 * Normalize text for duplicate comparison.
 * @param text - reply prose.
 * @returns lowercase text with punctuation and spacing removed.
 */
function comparable(text) {
  return typeof text === 'string'
    ? text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
    : ''
}

/**
 * Measure how much two openings overlap.
 * @param left - first text.
 * @param right - second text.
 * @returns Jaccard similarity over character bigrams, in [0, 1].
 */
export function similarityOf(left, right) {
  const a = comparable(left)
  const b = comparable(right)
  if (a === '' || b === '') return 0
  if (a === b) return 1
  const gramsOf = (text) => {
    const grams = new Set()
    for (let index = 0; index + 1 < text.length; index += 1) grams.add(text.slice(index, index + 2))
    return grams
  }
  const leftGrams = gramsOf(a)
  const rightGrams = gramsOf(b)
  if (leftGrams.size === 0 || rightGrams.size === 0) return 0
  let shared = 0
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) shared += 1
  }
  return shared / (leftGrams.size + rightGrams.size - shared)
}

/**
 * Per-target history of unsolicited turns, and the gates that read it.
 */
export class ProactiveGate {
  /** @type {Map<string, { lastAt: number, lastText: string, lastWorldKey: string }>} */
  #entries = new Map()
  #options

  /**
   * @param options - `idleMs`, `minGapMs`, `dedupeWindowMs`.
   */
  constructor(options = {}) {
    this.#options = {
      idleMs: Number.isFinite(options.idleMs) ? options.idleMs : 60_000,
      minGapMs: Number.isFinite(options.minGapMs) ? options.minGapMs : DEFAULT_MIN_GAP_MS,
      dedupeWindowMs: Number.isFinite(options.dedupeWindowMs) ? options.dedupeWindowMs : DEFAULT_DEDUPE_WINDOW_MS,
    }
  }

  /**
   * Decide whether one target may open a conversation now.
   * @param input - target, clock reading, quiet interval, entry flags, the
   * visitor's latest reading, and the current world fingerprint.
   * @returns `{ action, stage, reasonCode, retryAfterMs }`; `action` is `chat`
   * when the invitation may proceed to the model.
   */
  evaluate(input) {
    const now = Number.isFinite(input.now) ? input.now : Date.now()
    if (input.enabled === false) return refuse(PROACTIVE_STAGES.entry, 'PASS_DISABLED')
    if (input.busy === true) return refuse(PROACTIVE_STAGES.entry, 'PASS_BUSY')
    if (input.drafting === true) return refuse(PROACTIVE_STAGES.entry, 'PASS_VISITOR_DRAFTING', 45_000)

    const entry = this.#entries.get(input.target) ?? { lastAt: 0, lastText: '', lastWorldKey: '' }
    const quietMs = Number.isFinite(input.quietMs) ? input.quietMs : 0
    const distress = distressOf(input.reading)

    // A visitor who just said something hard gets company sooner; a visitor who
    // just said something good gets left alone. Both are the same sign rule.
    const requiredQuiet = distress !== undefined && distress > 0.25
      ? Math.round(this.#options.idleMs * DISTRESS_QUIET_SCALE)
      : this.#options.idleMs
    if (quietMs < requiredQuiet) {
      return refuse(PROACTIVE_STAGES.activity, 'PASS_NOT_QUIET', requiredQuiet - quietMs)
    }

    const sinceLast = entry.lastAt === 0 ? Number.POSITIVE_INFINITY : now - entry.lastAt
    if (sinceLast < this.#options.minGapMs) {
      return refuse(PROACTIVE_STAGES.activity, 'PASS_THROTTLED', this.#options.minGapMs - sinceLast)
    }

    if (distress !== undefined && distress <= GOOD_MOOD_CEILING) {
      return refuse(PROACTIVE_STAGES.activity, 'PASS_GOOD_MOOD', this.#options.minGapMs)
    }

    // Nothing moved since the last opening, and nobody is unhappy: a companion
    // repeating itself about an unchanged world is noise, not company. The
    // exemption expires with the dedupe window, so a long quiet evening still
    // gets an occasional check-in instead of permanent silence.
    const worldKey = typeof input.worldKey === 'string' ? input.worldKey : ''
    const unchanged = worldKey !== '' && worldKey === entry.lastWorldKey
    const recent = entry.lastAt !== 0 && now - entry.lastAt <= this.#options.dedupeWindowMs
    const noConcern = distress === undefined || distress < 0.2
    if (unchanged && recent && noConcern) {
      return refuse(PROACTIVE_STAGES.source, 'PASS_SOURCE_EMPTY', this.#options.minGapMs)
    }

    return { action: 'chat', stage: PROACTIVE_STAGES.model, reasonCode: 'PASS_GATE_OPEN', retryAfterMs: 0 }
  }

  /**
   * Classify what happened after the model was asked.
   * @param input - target, produced text (empty when the model passed), clock
   * reading, world fingerprint, whether the turn was preempted, and whether the
   * model declined with `[PASS]`.
   * @returns the delivery decision; only `CHAT_DELIVERED` records history.
   */
  settle(input) {
    const now = Number.isFinite(input.now) ? input.now : Date.now()
    if (input.passed === true) {
      // A model that declines is working correctly. Nothing is recorded, so the
      // next quiet window may ask again instead of the gate going silent forever.
      return refuse(PROACTIVE_STAGES.model, 'PASS_MODEL_PASS', this.#options.idleMs)
    }
    if (input.preempted === true) {
      return refuse(PROACTIVE_STAGES.delivery, 'DELIVERY_PREEMPTED', this.#options.idleMs)
    }
    const text = typeof input.text === 'string' ? input.text : ''
    if (text.trim() === '') {
      return refuse(PROACTIVE_STAGES.generation, 'PASS_GENERATION_EMPTY', this.#options.idleMs)
    }
    const entry = this.#entries.get(input.target)
    if (entry !== undefined && now - entry.lastAt <= this.#options.dedupeWindowMs
      && similarityOf(entry.lastText, text) >= DUPLICATE_SIMILARITY) {
      return refuse(PROACTIVE_STAGES.dedup, 'PASS_DUPLICATE', this.#options.minGapMs)
    }
    this.#entries.set(input.target, {
      lastAt: now,
      lastText: text,
      lastWorldKey: typeof input.worldKey === 'string' ? input.worldKey : '',
    })
    return { action: 'chat', stage: PROACTIVE_STAGES.delivery, reasonCode: 'CHAT_DELIVERED', retryAfterMs: 0 }
  }

  /**
   * Build one runtime failure decision.
   * @param reasonCode - `ERROR_TIMEOUT` or `ERROR_INTERNAL`.
   * @param retryAfterMs - backoff for the browser.
   * @returns the decision payload.
   */
  fail(reasonCode, retryAfterMs = 0) {
    return refuse(PROACTIVE_STAGES.runtime, reasonCode, retryAfterMs)
  }

  /** Forget every target, for a world reset. */
  reset() {
    this.#entries.clear()
  }

  /**
   * Read the recorded history for one target, for diagnostics and tests.
   * @param target - companion id or `group`.
   * @returns a copy of the entry, or undefined when the target never spoke first.
   */
  history(target) {
    const entry = this.#entries.get(target)
    return entry === undefined ? undefined : { ...entry }
  }
}
