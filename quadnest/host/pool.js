/**
 * Companion lifecycle for QuadNest: four separate Agents (one per persona) plus
 * one group-chat Agent, each with its own durable Session and its own memory.
 *
 * Agents start lazily on first use, run one turn at a time per chat target, and
 * are disposed together when the visitor resets the world. Every turn's text
 * comes from the Agent's own committed session events, so what a companion says
 * is exactly what its session log records.
 *
 * Layers of memory sit beside the session, not inside it: every turn recalls a
 * few lines from `host/memory.js` into the prompt, and every turn writes back
 * what it learned. The session is still the verbatim history — which is why the
 * layers have to exist, because a session eventually stops fitting.
 *
 * @module dsh-quadnest/host/pool
 */

import { randomUUID } from 'node:crypto'
import { describeVisitorMood, readReplyEmotion, readVisitorEmotion, visitorWire } from './emotion.js'
import { createMemoryStore } from './memory.js'
import { ProactiveGate } from './proactive.js'
import { buildGroupPrompt, buildIdleText, buildPersonaPrompt, buildUserText } from './prompts.js'
import { normalizeTurnId, parseReply, resolveChatTarget, splitGroupReply } from './protocol.js'
import { BOTS, describeWorld, sanitizeWorld } from './world.js'

/** A routed failure with a stable code and HTTP status for the browser. */
export class QuadNestError extends Error {
  /**
   * @param code - stable machine-readable reason.
   * @param message - human-readable explanation.
   * @param status - HTTP status the route should answer with.
   */
  constructor(code, message, status) {
    super(message)
    this.name = 'QuadNestError'
    this.code = code
    this.status = status
  }
}

/** Largest visitor message accepted into one turn. */
const MAX_TEXT_CHARS = 2000

/** Read the text blocks of one message. */
function messageText(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return ''
  return message.content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/** Read a turn failure's human-readable message. */
function failureMessage(reason) {
  const error = reason?.error
  if (error !== null && typeof error === 'object') {
    if (typeof error.message === 'string' && error.message !== '') return error.message
    const nested = error.info
    if (nested !== null && typeof nested === 'object' && typeof nested.message === 'string' && nested.message !== '') return nested.message
  }
  return 'The companion could not finish its reply.'
}

/**
 * Mint the session identity for one companion in one world generation.
 *
 * The id must be unique per lifecycle rather than fixed. Session history is
 * persisted per host, so a fixed id collides with the session the previous boot
 * left on disk — `agents.create` then fails with `session already exists` and
 * every turn answers 502 until the world is reset. Resuming the stored session
 * instead is not the answer either: it would replay the whole old transcript
 * into the prompt, which is exactly what the layered memory exists to replace.
 * Continuity across boots belongs to `host/memory.js`; the Agent session only
 * carries the conversation that is actually running.
 * @param key - companion id or `'group'`.
 * @param generation - world generation, bumped by every reset.
 * @returns a session id no earlier lifecycle of this host can have used.
 */
function sessionIdFor(key, generation) {
  return `quadnest-${key}-g${generation}-${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

/** One lazily created Agent and the chat target it serves. */
const createEntry = (key, handle, sessionId, model) => ({ key, handle, sessionId, model })

/** Four personae plus one group chat, each a separate Agent and Session. */
export class QuadNestPool {
  /** @type {import('@deepseek-ai/cordis').Context} */
  #ctx
  #options
  #entries = new Map()
  #creating = new Map()
  #queues = new Map()
  #generation = 0
  #disposed = false
  #gate
  /** Targets with an unsolicited turn in flight, so two tabs cannot both open. */
  #idleInFlight = new Set()
  /** Latest visitor reading, so an unsolicited turn can read the visitor's mood. */
  #lastReading
  /** Bumped by every visitor message, so an unsolicited turn knows it was preempted. */
  #visitorGeneration = 0
  /** Four-layer memory, shared by every target but kept in separate buckets. */
  #memory
  /** Resolves once the on-disk memory has been read; reads after that are in-memory. */
  #memoryReady

  /**
   * @param ctx - Host context carrying agents, the default model, and sessions.
   * @param options - resolved plugin settings, optionally a prepared memory store.
   */
  constructor(ctx, options) {
    this.#ctx = ctx
    this.#options = options
    this.#gate = new ProactiveGate({ idleMs: options.idleMs })
    this.#memory = options.memory ?? createMemoryStore()
    this.#memoryReady = this.#memory.load()
  }

  /**
   * Report whether the world can start a turn and which model it would use.
   * @returns the readiness flag, the default provider/model when configured, the idle interval, and how much each companion remembers.
   */
  status() {
    const model = this.#currentModel()
    return {
      ready: !this.#disposed,
      model: model === undefined ? null : { provider: model.provider, model: model.model },
      bots: BOTS.map(bot => bot.id),
      idleMs: this.#options.idleMs,
      memory: this.#memory.summary(),
    }
  }

  /**
   * Read one target's stored layers.
   * @param target - companion id or `group`.
   * @returns persona, facts, reflections, and the recent window.
   */
  memoryOf(target) {
    return this.#memory.layers(target)
  }

  /**
   * Count what every target remembers.
   * @returns One entry per target with a count per layer.
   */
  memorySummary() {
    return this.#memory.summary()
  }

  /**
   * Answer "what do you remember about this?" for one target.
   * @param target - companion id or `group`.
   * @param query - what to look for; empty returns the newest lines.
   * @returns the recalled lines, grouped by layer, plus the rendered prompt block.
   */
  recall(target, query) {
    const lines = this.#memory.compose(target, typeof query === 'string' ? query : '')
    return { lines, layers: this.#memory.recall(target, typeof query === 'string' ? query : '') }
  }

  /**
   * Run one visitor message against one companion or the group chat.
   * @param input - chat target, visitor text, world snapshot, caller turn id, and request signal.
   * @returns the reply bubbles, picture instructions, the turn id it answers, and the model that answered.
   */
  async say(input) {
    if (this.#disposed) throw new QuadNestError('disposed', 'The world is shutting down.', 503)
    const target = resolveChatTarget(input.target)
    if (target === undefined) throw new QuadNestError('invalid-target', 'Choose a companion or the group chat.', 400)
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (text === '') throw new QuadNestError('empty-text', 'The message is empty.', 400)
    if (text.length > MAX_TEXT_CHARS) throw new QuadNestError('text-too-long', `Messages are limited to ${MAX_TEXT_CHARS} characters.`, 413)
    const turnId = normalizeTurnId(input.turnId)
    const world = sanitizeWorld(input.world)
    const generation = this.#generation
    this.#visitorGeneration += 1
    const reading = readVisitorEmotion(text)
    this.#lastReading = reading
    await this.#memoryReady
    // Recall happens before the turn so the prompt carries what this companion
    // already knows about what the visitor just said.
    const memory = this.#memory.compose(target, text)
    const entry = await this.#ensure(target)
    const reply = await this.#enqueue(target, async () => {
      if (this.#disposed || generation !== this.#generation) {
        throw new QuadNestError('world-reset', 'The world was reset before the reply finished.', 503)
      }
      return this.#runTurn(entry, buildUserText({ target, text, world, memory, mood: describeVisitorMood(reading) }), input.signal, generation)
    })
    const { payload, parsed } = this.#shape(target, reply, entry)
    this.#absorb(target, parsed, turnId, payload.replies, text)
    return { turnId, ...payload, visitor: visitorWire(reading) }
  }

  /**
   * Run one unsolicited turn after the visitor has been quiet, so companions
   * can start a conversation instead of waiting to be spoken to.
   *
   * The gate runs before any Agent is woken: most invitations end in a refusal,
   * and a refusal must cost neither a model call nor a session write. The model
   * gets its own veto afterwards through `[PASS]`, which is a success path.
   * @param input - chat target, world snapshot, quiet interval, entry flags, and request signal.
   * @returns a delivered reply, or a decision describing why nobody spoke.
   */
  async idle(input) {
    if (this.#disposed) throw new QuadNestError('disposed', 'The world is shutting down.', 503)
    const target = resolveChatTarget(input.target)
    if (target === undefined) throw new QuadNestError('invalid-target', 'Choose a companion or the group chat.', 400)
    const turnId = normalizeTurnId(input.turnId)
    const world = sanitizeWorld(input.world)
    const generation = this.#generation
    const worldKey = describeWorld(world)
    const decision = this.#gate.evaluate({
      target,
      now: Date.now(),
      quietMs: input.quietMs,
      enabled: input.enabled,
      busy: input.busy,
      drafting: input.drafting,
      reading: this.#lastReading,
      worldKey,
    })
    if (decision.action !== 'chat') return { ...decision, turnId }
    // Two tabs (or a reload racing its predecessor) must not both wake a
    // companion: the gate has no history for a turn that has not finished yet.
    if (this.#idleInFlight.has(target)) {
      return { action: 'pass', stage: 'entry_guard', reasonCode: 'PASS_BUSY', retryAfterMs: 30_000, turnId }
    }
    this.#idleInFlight.add(target)
    const visitorMark = this.#visitorGeneration
    try {
      await this.#memoryReady
      // No visitor text this turn: recall falls back to the newest lines, which
      // is what "提起之前聊过的内容" needs.
      const memory = this.#memory.compose(target, '')
      return await this.#runIdle({ target, world, worldKey, generation, visitorMark, turnId, memory, signal: input.signal })
    } finally {
      this.#idleInFlight.delete(target)
    }
  }

  /**
   * Run the model half of one invitation the gate already allowed.
   * @param input - target, normalized world, its fingerprint, world generation,
   * visitor mark, turn id, recalled memory lines, and the browser request signal.
   * @returns the delivered reply or the decision that replaced it.
   */
  async #runIdle(input) {
    const { target, world, worldKey, generation, visitorMark, turnId, memory } = input
    const entry = await this.#ensure(target)
    const outcome = await this.#enqueue(target, async () => {
      if (this.#disposed || generation !== this.#generation) {
        throw new QuadNestError('world-reset', 'The world was reset before the reply finished.', 503)
      }
      try {
        const reply = await this.#runTurn(entry, buildIdleText({ target, world, memory, mood: describeVisitorMood(this.#lastReading) }), input.signal, generation)
        const parsed = parseReply(reply)
        if (parsed.pass && parsed.text === '') {
          return { decision: this.#gate.settle({ target, passed: true, now: Date.now(), worldKey }) }
        }
        const shaped = this.#shape(target, reply, entry)
        const settled = this.#gate.settle({
          target,
          text: shaped.payload.replies.map(row => row.text).join('\n'),
          now: Date.now(),
          worldKey,
          preempted: visitorMark !== this.#visitorGeneration,
        })
        if (settled.action !== 'chat') return { decision: settled }
        this.#absorb(target, shaped.parsed, turnId, shaped.payload.replies, '')
        return {
          delivered: {
            turnId,
            ...shaped.payload,
            action: 'chat',
            stage: settled.stage,
            reasonCode: settled.reasonCode,
            retryAfterMs: 0,
          },
        }
      } catch (error) {
        if (error instanceof QuadNestError && error.code === 'turn-timeout') {
          return { decision: this.#gate.fail('ERROR_TIMEOUT', this.#options.idleMs) }
        }
        if (error instanceof QuadNestError && (error.code === 'empty-reply' || error.code === 'turn-cancelled')) {
          return {
            decision: this.#gate.settle({
              target,
              text: '',
              now: Date.now(),
              worldKey,
              preempted: visitorMark !== this.#visitorGeneration,
            }),
          }
        }
        throw error
      }
    })
    if (outcome.decision !== undefined) {
      return { ...outcome.decision, turnId, replies: [], actions: [], model: null }
    }
    return outcome.delivered
  }

  /**
   * Dispose every companion Agent, which clears their live conversation for a
   * fresh world. The next message starts new Agents under a new generation, so
   * they get session identities that no earlier lifecycle has written.
   * @param options - `forget: false` keeps the layered memory on disk for a host
   * restart, which tears the Agents down but must not cost the visitor their history.
   * @returns fulfillment after every companion is quiescent and disposed.
   */
  async reset(options = {}) {
    this.#generation += 1
    this.#gate.reset()
    this.#idleInFlight.clear()
    this.#lastReading = undefined
    if (options.forget !== false) await this.#memory.clear()
    const entries = Array.from(this.#entries.values())
    this.#entries.clear()
    this.#creating.clear()
    this.#queues.clear()
    for (const entry of entries) {
      try {
        entry.handle.agent.cancel({ kind: 'user' })
      } catch {
        // The agent may already be idle or disposed; reset must still proceed.
      }
    }
    await Promise.all(entries.map(async (entry) => {
      try {
        await entry.handle.agent.whenIdle()
      } catch {
        // Quiescence failure must not block disposal of the remaining companions.
      }
      const sessions = this.#ctx.get('sessions')
      if (sessions !== undefined && typeof sessions.flush === 'function') {
        try {
          await sessions.flush(entry.handle.agent.session)
        } catch {
          // A failed flush leaves the committed log in place; disposal continues.
        }
      }
      try {
        await entry.handle.dispose()
      } catch {
        // A companion that fails to unregister must not strand the other four.
      }
    }))
  }

  /**
   * Dispose the pool with the plugin fiber.
   * @returns fulfillment after all companions are disposed.
   */
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    // Unloading the plugin is not a reset: the visitor's history outlives a
    // restart, so the layers stay and only the live Agents go away.
    await this.reset({ forget: false })
    await this.#memory.flush()
  }

  /** Read the configured default model, or undefined when none is set. */
  #currentModel() {
    let selection
    try {
      selection = this.#ctx.agentDefaultModel.currentSelection()
    } catch {
      return undefined
    }
    if (selection === null || typeof selection !== 'object') return undefined
    if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') return undefined
    return selection
  }

  /** Resolve the default model or fail with a routable error. */
  #model() {
    const model = this.#currentModel()
    if (model === undefined) throw new QuadNestError('no-default-model', 'No default model is configured for this profile.', 503)
    return model
  }

  /** Serialize work per chat target so one companion never runs two turns at once. */
  #enqueue(key, task) {
    const previous = this.#queues.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.#queues.set(key, next.then(() => undefined, () => undefined))
    return next
  }

  /** Return the live Agent for one target, creating it on first use. */
  async #ensure(key) {
    const entry = this.#entries.get(key)
    if (entry !== undefined) return entry
    const pending = this.#creating.get(key)
    if (pending !== undefined) return pending
    const generation = this.#generation
    const task = (async () => {
      const model = this.#model()
      const bot = BOTS.find(row => row.id === key)
      const prompt = key === 'group' ? buildGroupPrompt() : buildPersonaPrompt(bot)
      const sessionId = sessionIdFor(key, generation)
      const handle = await this.#ctx.agents.create({
        sessionId,
        agentOptions: { provider: model.provider, model: model.model, ...model.reasoningEffort !== undefined ? { reasoningEffort: model.reasoningEffort } : {} },
        setup: (agentCtx) => {
          const systemPrompt = agentCtx.get('systemPrompt')
          if (systemPrompt === undefined) throw new Error('quadnest requires the system-prompt service to compose a companion')
          systemPrompt.section({ name: 'quadnest-persona', order: 100, text: prompt })
          const tools = agentCtx.get('tools')
          if (tools !== undefined) tools.restrict({ allow: [] })
        },
      })
      if (this.#disposed || generation !== this.#generation) {
        try {
          await handle.dispose()
        } catch {
          // The abandoned companion was already torn down by the reset.
        }
        throw new QuadNestError('world-reset', 'The world was reset while a companion was starting.', 503)
      }
      const created = createEntry(key, handle, sessionId, { provider: model.provider, model: model.model })
      this.#entries.set(key, created)
      return created
    })()
    this.#creating.set(key, task)
    try {
      return await task
    } finally {
      this.#creating.delete(key)
    }
  }

  /**
   * Turn one raw reply into the bubbles, instructions, and model the browser reads.
   * @param target - chat target that produced the reply.
   * @param reply - raw assistant prose, instructions included.
   * @param entry - the Agent that answered, carrying its model.
   * @returns the reply payload for the browser and the parsed reply the host keeps.
   */
  #shape(target, reply, entry) {
    const parsed = parseReply(reply)
    if (target === 'group') {
      const replies = splitGroupReply(parsed.text)
      if (replies.length === 0) throw new QuadNestError('empty-reply', 'The companions stayed silent.', 502)
      return {
        parsed,
        payload: {
          replies: replies.map(row => ({ ...row, mood: readReplyEmotion(row.text).mood })),
          actions: parsed.actions,
          model: entry.model,
        },
      }
    }
    if (parsed.text === '') throw new QuadNestError('empty-reply', 'The companion stayed silent.', 502)
    return {
      parsed,
      payload: {
        replies: [{ bot: target, text: parsed.text, mood: readReplyEmotion(parsed.text).mood }],
        actions: parsed.actions,
        model: entry.model,
      },
    }
  }

  /**
   * Fold one finished turn into the layered memory.
   *
   * Everything spoken is recorded (the recent window and the journal); only what
   * the companion explicitly asked to remember reaches the durable layers. The
   * group chat records but never writes layers: a line in the group belongs to
   * whoever said it, and nobody should find the group's notes in their own head.
   * @param target - companion id or `group`.
   * @param parsed - parsed reply, carrying the memory writes it asked for.
   * @param turnId - turn the words belong to, so a memory can be traced back.
   * @param replies - bubbles that will be shown to the visitor.
   * @param visitorText - what the visitor said this turn; empty for an idle turn.
   * @returns Nothing.
   */
  #absorb(target, parsed, turnId, replies, visitorText) {
    const at = Date.now()
    const nameOf = (id) => BOTS.find(bot => bot.id === id)?.name ?? id
    const labelOf = (bot) => {
      if (bot !== undefined && bot !== null) return nameOf(bot)
      // A group line with no speaker prefix belongs to nobody in particular.
      return target === 'group' ? '伙伴' : nameOf(target)
    }
    if (typeof visitorText === 'string' && visitorText !== '') {
      this.#memory.record(target, { role: 'visitor', text: visitorText, turnId, at })
    }
    for (const bubble of replies) {
      this.#memory.record(target, { role: 'companion', text: bubble.text, label: labelOf(bubble.bot), turnId, at })
    }
    if (target === 'group' || parsed.remember.length === 0) return
    this.#memory.remember(target, parsed.remember.map(item => ({ ...item, turnId })))
  }

  /**
   * Wake one companion for one turn and read its committed reply.
   * @param entry - the live Agent serving this target.
   * @param userText - world snapshot plus the visitor's words.
   * @param signal - browser request cancellation.
   * @param generation - world generation captured before the turn began.
   * @returns the raw assistant prose, instructions included.
   */
  async #runTurn(entry, userText, signal, generation) {
    const agent = entry.handle.agent
    const session = agent.session
    const start = session.snapshotEvents().length
    let turn
    let listener
    let timer
    const completion = new Promise((resolve, reject) => {
      listener = this.#ctx.on('session/event', (subject, event) => {
        if (subject.id !== session.id) return
        if (event.type === 'turn/start') {
          if (turn === undefined) turn = event.data.turn
          return
        }
        if (event.type !== 'turn/end') return
        if (turn !== undefined && event.data.turn !== turn) return
        resolve({ turn: event.data.turn, reason: event.data.reason })
      })
      timer = setTimeout(() => {
        try {
          agent.cancel({ kind: 'user' })
        } catch {
          // A settled agent has nothing to cancel; the timeout still fails the turn.
        }
        reject(new QuadNestError('turn-timeout', 'The companion took too long to answer.', 504))
      }, this.#options.timeoutMs)
    })
    const onAbort = () => {
      try {
        agent.cancel({ kind: 'user' })
      } catch {
        // The browser already left; cancellation is best-effort.
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    let outcome
    try {
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: userText }],
        source: { kind: 'user' },
      })
      outcome = await completion
    } finally {
      clearTimeout(timer)
      if (typeof listener === 'function') listener()
      signal?.removeEventListener('abort', onAbort)
    }
    if (this.#disposed || generation !== this.#generation) {
      throw new QuadNestError('world-reset', 'The world was reset before the reply finished.', 503)
    }
    const events = session.snapshotEvents().slice(start)
    const texts = events
      .filter(event => event.type === 'assistant/message' && event.data.turn === outcome.turn)
      .map(event => messageText(event.data.message))
      .filter(text => text !== '')
    const reply = texts.at(-1) ?? ''
    const kind = outcome.reason?.kind
    if (kind === 'error') throw new QuadNestError('turn-failed', failureMessage(outcome.reason), 502)
    if (kind === 'aborted') throw new QuadNestError('turn-cancelled', 'The reply was cancelled.', 503)
    if (reply === '') throw new QuadNestError('empty-reply', 'The companion stayed silent.', 502)
    return reply
  }
}
