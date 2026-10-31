/**
 * `@` token grammar shared by the Host resolver and the composer selector.
 *
 * The same syntax belongs to file references (`@src/app.ts`), so nothing here
 * decides what a token *means*: it only finds spans. Interpretation happens in
 * {@link planMentions}, which claims a token only when it names a registered
 * domain — every other token stays a path for the file-reference prompt.
 *
 * This module imports nothing from Node: the browser bundle reuses the exact
 * same parser, so the chip the user clicks and the token the Host resolves can
 * never disagree about where a token ends.
 *
 * @module @deepseek-ai/dsh-ontology-injector/mention
 */

/** One registered domain as the mention resolver sees it. */
export interface MentionCandidate {
  readonly id: string
  readonly label: string
  readonly disabled: boolean
}

/** One resolved `@` selection from a user message. */
export interface MentionPick {
  /** Registered domain id. */
  readonly domain: string
  /** The token exactly as the user wrote it, `@` included. */
  readonly token: string
}

/** One `@` occurrence in a text, in UTF-16 offsets. */
export interface MentionSpan {
  /** Offset of the `@`. */
  readonly start: number
  /** Offset just past the token body (quotes excluded). */
  readonly end: number
  /** Text between `@` and `end`, quotes removed. */
  readonly body: string
}

/**
 * Characters that end a mention token.
 *
 * Whitespace and sentence punctuation both terminate it, so `@合同风控，这笔`
 * resolves without a space while `@src/app.ts` stays whole: a path may contain
 * dots and slashes, which is why only trailing dots are trimmed below.
 */
const TOKEN_BREAK = /[\s，。！？；：、,!?;:()（）[\]【】<>《》"'“”‘’]/u

/** Characters that may sit immediately before a token. */
const TOKEN_LEAD = /[\s（(【[{“‘"'，。；：、,;:]/u

/**
 * Find every `@` token in one text.
 *
 * @param text - raw message or draft text.
 * @returns spans in document order.
 */
export function mentionSpans(text: string): MentionSpan[] {
  const found: MentionSpan[] = []
  let cursor = 0
  while (cursor < text.length) {
    const at = text.indexOf('@', cursor)
    if (at < 0) break
    cursor = at + 1
    // `mail@example.com` is an address, not a mention.
    if (at > 0 && !TOKEN_LEAD.test(text.charAt(at - 1))) continue
    if (text[at + 1] === '"') {
      const close = text.indexOf('"', at + 2)
      if (close < 0) continue
      const body = text.slice(at + 2, close).trim()
      if (body.length > 0) found.push({ start: at, end: close + 1, body })
      cursor = close + 1
      continue
    }
    let end = at + 1
    while (end < text.length) {
      const character = text.charAt(end)
      if (character === '' || TOKEN_BREAK.test(character)) break
      end += 1
    }
    const body = text.slice(at + 1, end).replace(/\.+$/u, '')
    if (body.length > 0) found.push({ start: at, end: at + 1 + body.length, body })
    cursor = end
  }
  return found
}

/**
 * Extract every `@` token from one message.
 *
 * @param text - raw user message text.
 * @returns tokens in order, `@` included.
 */
export function mentionTokens(text: string): string[] {
  return mentionSpans(text).map(span => `@${span.body}`)
}

/**
 * The token that selects one domain.
 *
 * A label is used only when it survives the token grammar untouched. Anything
 * with whitespace or punctuation falls back to the id: a token the parser would
 * cut in half is worse than an unfamiliar-looking but exact one.
 *
 * @param domain - domain to select.
 * @returns the token text, `@` included.
 */
export function mentionTokenFor(domain: { readonly id: string; readonly label: string }): string {
  const label = domain.label.trim()
  const usable = label.length > 0 && !TOKEN_BREAK.test(label)
  return `@${usable ? label : domain.id}`
}

/**
 * Normalize a label or id for comparison.
 *
 * Domain labels are display text: trailing whitespace and inner runs of space
 * are user comfort, not identity. Case-folding keeps a Latin label usable from
 * a message typed in any case.
 *
 * @param value - raw label or id.
 * @returns the comparison key.
 */
export function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase()
}

/**
 * Report the domain whose label or id would collide with a proposed label.
 *
 * Ids are accepted as tokens too, so a label equal to another domain's id would
 * shadow that domain: the id match wins in {@link planMentions}. Both cases are
 * refused for the same reason — an ambiguous token has no honest resolution.
 *
 * @param label - proposed display label.
 * @param domains - every registered domain.
 * @param exceptId - domain being renamed, excluded from the comparison.
 * @returns the conflicting domain id, or `null` when the label is free.
 */
export function findLabelConflict(
  label: string,
  domains: readonly MentionCandidate[],
  exceptId?: string,
): string | null {
  const key = normalizeLabel(label)
  if (key.length === 0) return null
  for (const domain of domains) {
    if (domain.id === exceptId) continue
    if (normalizeLabel(domain.label) === key || normalizeLabel(domain.id) === key) return domain.id
  }
  return null
}

/**
 * Find the domain a token body names.
 *
 * @param body - token text without `@`.
 * @param domains - every registered domain.
 * @returns the matching domain, enabled or not; `undefined` when no domain claims it.
 */
export function domainOfToken(
  body: string,
  domains: readonly MentionCandidate[],
): MentionCandidate | undefined {
  const key = normalizeLabel(body)
  return domains.find(domain => normalizeLabel(domain.id) === key || normalizeLabel(domain.label) === key)
}

/**
 * Resolve the domains a message selects.
 *
 * A token counts only when it names a registered, enabled domain by id or by
 * label. Everything else — file paths above all — is left to the file-reference
 * prompt: claiming unknown tokens would turn `@README.md` into a failed domain
 * lookup, and the model would lose the file.
 *
 * @param text - the turn's user message text.
 * @param domains - every registered domain with its enabled state.
 * @returns resolved picks in message order, each domain at most once.
 */
export function planMentions(text: string, domains: readonly MentionCandidate[]): MentionPick[] {
  const picks: MentionPick[] = []
  const taken = new Set<string>()
  for (const span of mentionSpans(text)) {
    const hit = domainOfToken(span.body, domains)
    if (hit === undefined || hit.disabled || taken.has(hit.id)) continue
    taken.add(hit.id)
    picks.push({ domain: hit.id, token: `@${span.body}` })
  }
  return picks
}

/** Structural view of one message the injection hook can read. */
export interface TextBearingMessage {
  readonly source: { readonly kind: string }
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}

/**
 * Text of the newest user message in the step's admitted batch.
 *
 * Only user messages are considered: an injected instruction from an earlier
 * plugin must not select a domain, and a tool result never asks a question.
 *
 * @param messages - the step's admitted messages, oldest first.
 * @returns the joined text parts, or an empty string when no user message is present.
 */
export function latestUserText(messages: readonly TextBearingMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.source.kind !== 'user') continue
    return message.content
      .flatMap(part => part.type === 'text' && part.text !== undefined ? [part.text] : [])
      .join('\n')
  }
  return ''
}
