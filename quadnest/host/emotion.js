/**
 * QuadNest emotion: two readings that must never share a channel.
 *
 * The visitor reading answers "how is the person on the other side right now",
 * and it only ever feeds two things: whether a companion may start talking
 * (through the signed distress value) and a short mood line in the next prompt.
 * It never paints a companion's face.
 *
 * The reply reading answers "what did this companion just feel", and it only
 * ever paints that companion's face. It never decides whether to talk.
 *
 * Keeping the two apart is the whole point: a sad visitor must not make four
 * robots look sad, and a happy companion must not be read as a happy visitor.
 * See `proactive.js` for the consumer of {@link distressOf}.
 *
 * @module dsh-quadnest/host/emotion
 */

import { createHash } from 'node:crypto'

/** Labels a companion's own reply can carry, aligned with the renderer's faces. */
export const REPLY_MOODS = Object.freeze(['happy', 'sad', 'angry', 'surprised', 'neutral'])

/** Coarse buckets for the visitor's state; deliberately not the reply labels. */
export const VISITOR_MOODS = Object.freeze(['low', 'tense', 'steady', 'bright'])

/** Confidence below which a reading is treated as "no signal" by every consumer. */
export const EMOTION_SIGNAL_FLOOR = 0.3

/** Positive cues, weighted by how strongly they imply a good mood. */
const POSITIVE = new Map([
  ['太好了', 0.9], ['好棒', 0.9], ['好开心', 0.9], ['幸福', 0.8], ['开心', 0.8], ['高兴', 0.8],
  ['期待', 0.6], ['舒服', 0.6], ['放松', 0.6], ['温暖', 0.6], ['安心', 0.6], ['顺利', 0.5],
  ['喜欢', 0.6], ['可爱', 0.5], ['好看', 0.5], ['好听', 0.5], ['有趣', 0.5], ['谢谢', 0.5],
  ['哈哈', 0.5], ['嘻嘻', 0.5], ['嘿嘿', 0.5], ['爱', 0.5], ['爽', 0.6], ['美', 0.3],
])

/** Negative cues, weighted by how strongly they imply distress. */
const NEGATIVE = new Map([
  ['撑不住', 0.9], ['不开心', 0.85], ['想哭', 0.9], ['心累', 0.9], ['烦死', 0.9], ['焦虑', 0.9],
  ['难过', 0.85], ['疲惫', 0.8], ['委屈', 0.8], ['孤单', 0.8], ['寂寞', 0.8], ['孤独', 0.8],
  ['失眠', 0.8], ['害怕', 0.8], ['难受', 0.8], ['郁闷', 0.8], ['糟糕', 0.8], ['压力', 0.75],
  ['生气', 0.75], ['崩', 0.8], ['迷茫', 0.6], ['后悔', 0.7], ['讨厌', 0.6], ['烦', 0.65],
  ['慌', 0.7], ['累', 0.55], ['哭', 0.65], ['痛', 0.6], ['惨', 0.6], ['无聊', 0.4],
])

/** Modal particles and punctuation that raise arousal without changing valence. */
const AROUSAL_PARTICLES = /(哈哈|嘿嘿|呜呜|啊啊|唉|哎|呜)/
/** Intensifiers that scale whatever the sentence already says. */
const INTENSIFIERS = /(太|特别|非常|超级|极了|死了|得要命)/
/** Cues that this message asks for reasoning rather than company. */
const COMPLEXITY_CUES = ['为什么', '怎么', '如何', '是否', '应该', '区别', '对比', '计算', '分析', '步骤', '原理', '公式', '方案', '建议', '帮我看看']
/** Cues that the message wants something done outside the conversation. */
const EXTERNAL_CUES = ['查一下', '查查', '搜索', '天气', '提醒我', '几点', '翻译', '帮我', '打开', '播放', '导航', '订', '买']
/** A negator in the few characters before a cue flips that cue's polarity. */
const NEGATION = /(?:不|没|别|无|非|莫)(?:太|怎么|那么|是|会|用|要)?$/

/**
 * Weight that maps cue weights onto `[-1, 1]`.
 *
 * One explicit feeling word ("太开心了", "好累") should carry the verdict on its
 * own: most messages are one sentence with one cue, and a scale that needs two
 * cues before registering would leave single-sentence mood unread.
 */
const VALENCE_SCALE = 1.8

/** Reply cues per mood; the mood with the most hits wins. */
const REPLY_CUES = new Map([
  ['happy', ['开心', '高兴', '太好了', '喜欢', '可爱', '期待', '笑', '嘿嘿', '哈哈', '好呀', '走呀', '看星星']],
  ['sad', ['舍不得', '有点难过', '想你', '安静一会', '抱歉', '遗憾', '慢慢来']],
  ['angry', ['哼', '讨厌', '不许', '生气了', '别闹']],
  ['surprised', ['咦', '诶', '哇', '竟然', '居然', '真的假的']],
])

/**
 * Normalize text for matching and for the source fingerprint.
 * @param text - any visitor or reply text.
 * @returns the case-folded text with collapsed whitespace.
 */
function normalizeText(text) {
  if (typeof text !== 'string') return ''
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Clamp one number into an inclusive range.
 * @param value - raw number.
 * @param min - lower bound.
 * @param max - upper bound.
 * @returns the clamped value.
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/**
 * Test whether a cue at one offset is negated by the characters just before it.
 * @param text - normalized text being scanned.
 * @param index - offset where the cue starts.
 * @returns true when a negator precedes the cue.
 */
function negatedAt(text, index) {
  const window = text.slice(Math.max(0, index - 4), index)
  return NEGATION.test(window)
}

/**
 * Find every non-overlapping cue from one lexicon.
 *
 * Longer cues are matched first and their characters are consumed, so `不开心`
 * counts as one negative cue instead of a positive `开心` with a stray `不`.
 * @param text - normalized text.
 * @param lexicon - cue to weight map.
 * @returns the hits with their offset, weight, and negation state.
 */
function scan(text, lexicon) {
  const hits = []
  const consumed = new Set()
  const words = Array.from(lexicon.keys()).sort((left, right) => right.length - left.length)
  for (const word of words) {
    let from = 0
    for (;;) {
      const index = text.indexOf(word, from)
      if (index < 0) break
      let free = true
      for (let offset = index; offset < index + word.length; offset += 1) {
        if (consumed.has(offset)) {
          free = false
          break
        }
      }
      if (free) {
        for (let offset = index; offset < index + word.length; offset += 1) consumed.add(offset)
        hits.push({ weight: lexicon.get(word), negated: negatedAt(text, index) })
      }
      from = index + word.length
    }
  }
  return hits
}

/**
 * Read how the visitor feels right now.
 *
 * Deterministic and synchronous on purpose: the reading sits in front of every
 * request, so a model round trip here would either add latency to the visitor's
 * own message or make the proactive gate non-reproducible in tests. The shape
 * mirrors an LLM verdict so a model-backed reader can replace this one later
 * without touching a single consumer.
 * @param text - the visitor's message.
 * @param options - optional clock reading for `updatedAt`.
 * @returns the reading: valence, arousal, confidence, the two orthogonal
 * dimensions, the source fingerprint, and a diagnostic excerpt.
 */
export function readVisitorEmotion(text, options) {
  const normalized = normalizeText(text)
  const positives = scan(normalized, POSITIVE)
  const negatives = scan(normalized, NEGATIVE)
  let score = 0
  for (const hit of positives) score += hit.negated ? -hit.weight * 0.6 : hit.weight
  for (const hit of negatives) score += hit.negated ? hit.weight * 0.6 : -hit.weight
  const evidence = positives.length + negatives.length
  const valence = clamp(score / VALENCE_SCALE, -1, 1)

  let arousal = 0.34
  if (/[!！]/.test(normalized)) arousal += 0.18
  if (/[?？]{2,}|[!！]{2,}/.test(normalized)) arousal += 0.1
  if (AROUSAL_PARTICLES.test(normalized)) arousal += 0.12
  if (INTENSIFIERS.test(normalized)) arousal += 0.08
  if (normalized.length >= 60) arousal -= 0.08

  let complexity = 0
  if (normalized.length >= 30) complexity += 0.3
  else if (normalized.length >= 15) complexity += 0.15
  if (/[?？]/.test(normalized)) complexity += 0.2
  if (COMPLEXITY_CUES.some(cue => normalized.includes(cue))) complexity += 0.3
  if (/\d/.test(normalized)) complexity += 0.1
  if (/[a-z]{3,}/.test(normalized)) complexity += 0.1

  const externalCues = EXTERNAL_CUES.filter(cue => normalized.includes(cue)).length
  return {
    valence,
    arousal: clamp(arousal, 0, 1),
    confidence: evidence === 0 ? 0.12 : clamp(0.34 + evidence * 0.12, 0, 1),
    complexity: clamp(complexity, 0, 1),
    // `null` means "no signal", never "certainly not needed": a consumer that
    // wants an answer must fail open, not read absence as a negative.
    externalIntent: externalCues === 0 ? null : clamp(0.5 + externalCues * 0.15, 0, 1),
    sourceHash: createHash('sha1').update(normalized).digest('hex').slice(0, 16),
    sourceExcerpt: normalized.slice(0, 48),
    updatedAt: options !== undefined && Number.isFinite(options.now) ? options.now : Date.now(),
  }
}

/**
 * Bucket one visitor reading for the browser and for coarse decisions.
 * @param reading - reading from {@link readVisitorEmotion}.
 * @returns the bucket, or undefined when there is no reading at all.
 */
export function visitorMoodOf(reading) {
  if (reading === null || typeof reading !== 'object') return undefined
  if (reading.confidence < EMOTION_SIGNAL_FLOOR) return 'steady'
  if (reading.valence <= -0.25 && reading.arousal >= 0.55) return 'tense'
  if (reading.valence <= -0.2) return 'low'
  if (reading.valence >= 0.25 && reading.arousal >= 0.55) return 'bright'
  return 'steady'
}

/**
 * Convert one visitor reading into a signed "should a companion approach" value.
 *
 * Negative valence pulls a companion closer (up to `1`); positive valence pushes
 * it away (down to `-0.5`), because a visitor in a good mood does not need to be
 * checked on. Arousal amplifies whichever sign applies.
 * @param reading - reading from {@link readVisitorEmotion}.
 * @returns the signed distress value, or undefined when the reading carries no
 * usable signal — callers must treat undefined as "no contribution", never as 0.
 */
export function distressOf(reading) {
  if (reading === null || typeof reading !== 'object') return undefined
  if (!(reading.confidence >= EMOTION_SIGNAL_FLOOR)) return undefined
  const magnitude = Math.min(1, Math.abs(reading.valence)) * (0.5 + 0.5 * reading.arousal)
  return reading.valence < 0 ? magnitude : -0.5 * magnitude
}

/**
 * Render one short mood line for a companion's next prompt.
 *
 * Only the coarse direction is exposed, never the axes or the fingerprint: the
 * model needs to know how to hold the conversation, not that it is being scored.
 * @param reading - reading from {@link readVisitorEmotion}.
 * @returns the prompt line, or an empty string when the reading has no signal.
 */
export function describeVisitorMood(reading) {
  if (reading === null || typeof reading !== 'object') return ''
  if (!(reading.confidence >= EMOTION_SIGNAL_FLOOR)) return ''
  const lines = []
  if (reading.valence <= -0.35) {
    lines.push('[访客此刻] 情绪偏低落、有点累。先陪着，不要讲道理、不要追问细节，也不要急着给建议。')
  } else if (reading.valence <= -0.12) {
    lines.push('[访客此刻] 心情有点沉。语气放轻，顺着对方的话说，别急着转移话题。')
  } else if (reading.valence >= 0.3) {
    lines.push('[访客此刻] 心情不错。可以轻快一点，顺势提议一起做点小事。')
  } else {
    lines.push('[访客此刻] 情绪平稳。')
  }
  if (reading.externalIntent !== null && reading.externalIntent >= 0.6) {
    lines.push('访客可能在问需要外部信息的事；你不知道就说不知道，不要编造具体数字或事实。')
  }
  if (reading.complexity >= 0.6) {
    lines.push('这句话更像一个认真问题，可以答得具体一点，但仍保持口语，不要列清单。')
  }
  return lines.join('\n')
}

/**
 * Read the mood carried by one companion's own reply.
 *
 * This is the only input to a companion's face. It never touches the visitor
 * reading, and nothing outside the renderer should consume it.
 * @param text - visible reply prose.
 * @returns the mood label and how much evidence supported it.
 */
export function readReplyEmotion(text) {
  const normalized = normalizeText(text)
  let best = 'neutral'
  let bestHits = 0
  for (const [mood, cues] of REPLY_CUES) {
    let hits = 0
    for (const cue of cues) {
      const index = normalized.indexOf(cue)
      if (index < 0) continue
      hits += negatedAt(normalized, index) ? -1 : 1
    }
    if (hits > bestHits) {
      best = mood
      bestHits = hits
    }
  }
  if (bestHits <= 0 && /[!！]/.test(normalized) && /(怎么|什么|真的)/.test(normalized)) {
    return { mood: 'surprised', confidence: 0.4 }
  }
  return { mood: best, confidence: bestHits === 0 ? 0.4 : clamp(0.5 + bestHits * 0.1, 0, 0.9) }
}

/**
 * Project one visitor reading onto the browser wire.
 * @param reading - reading from {@link readVisitorEmotion}, or undefined.
 * @returns the compact payload, or null when there is no reading.
 */
export function visitorWire(reading) {
  if (reading === null || typeof reading !== 'object') return null
  const round = value => Math.round(value * 100) / 100
  return {
    mood: visitorMoodOf(reading),
    valence: round(reading.valence),
    arousal: round(reading.arousal),
    confidence: round(reading.confidence),
  }
}
