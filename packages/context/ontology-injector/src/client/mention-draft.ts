/**
 * Draft-level token editing for the composer's ontology row.
 *
 * Kept apart from the component and free of React so the toggle rules can be
 * tested as data: which chip is lit, what the draft looks like after removing a
 * selection, and what text replaces another domain's token.
 *
 * @module @deepseek-ai/dsh-ontology-injector/client/mention-draft
 */

import { domainOfToken, mentionSpans, mentionTokenFor } from '../mention.ts'
import type { MentionCandidate } from '../mention.ts'

/**
 * Collapse the holes a removed token leaves behind.
 *
 * Removing `@A ` from `问 @A 这句话` would otherwise leave a double space, and
 * a token at the very start would leave a leading one.
 *
 * @param text - draft text with tokens removed.
 * @returns the tidied draft.
 */
function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/^[ \t]+/u, '')
    .replace(/[ \t]+$/u, '')
}

/**
 * The domain this draft currently selects, if any.
 *
 * Disabled domains are ignored: the Host would refuse the token, so the chip
 * must not claim a selection that will not happen.
 *
 * @param draft - current composer text.
 * @param domains - every registered domain.
 * @returns the selected domain id, or `null`.
 */
export function selectedDomainId(draft: string, domains: readonly MentionCandidate[]): string | null {
  for (const span of mentionSpans(draft)) {
    const hit = domainOfToken(span.body, domains)
    if (hit !== undefined && !hit.disabled) return hit.id
  }
  return null
}

/**
 * Remove every domain token from a draft.
 *
 * File tokens are untouched: they are not ours to edit, and the sentence around
 * them must survive word for word.
 *
 * @param draft - current composer text.
 * @param domains - every registered domain, disabled ones included so a stale
 *   token for a since-disabled domain can still be cleared.
 * @returns the draft without domain tokens.
 */
export function stripDomainMentions(draft: string, domains: readonly MentionCandidate[]): string {
  const spans = mentionSpans(draft).filter(span => domainOfToken(span.body, domains) !== undefined)
  if (spans.length === 0) return draft
  let out = ''
  let cursor = 0
  for (const span of spans) {
    out += draft.slice(cursor, span.start)
    cursor = span.end
  }
  out += draft.slice(cursor)
  return tidy(out)
}

/**
 * Swap the first domain token in place for another domain.
 *
 * Swapping in place keeps the sentence readable when the user picks the wrong
 * ontology after typing the question.
 *
 * @param draft - current composer text.
 * @param domain - domain to select instead.
 * @param domains - every registered domain.
 * @returns the rewritten draft, or `null` when there was no token to swap.
 */
export function swapDomainMention(
  draft: string,
  domain: MentionCandidate,
  domains: readonly MentionCandidate[],
): string | null {
  const span = mentionSpans(draft).find(item => domainOfToken(item.body, domains) !== undefined)
  if (span === undefined) return null
  return `${draft.slice(0, span.start)}${mentionTokenFor(domain)}${draft.slice(span.end)}`
}

/**
 * Append a token, separated from the existing text by one space.
 *
 * @param draft - current composer text.
 * @param domain - domain to select.
 * @returns the draft with the token appended.
 */
export function appendDomainMention(draft: string, domain: MentionCandidate): string {
  const token = `${mentionTokenFor(domain)} `
  if (draft.length === 0) return token
  return draft.endsWith(' ') || draft.endsWith('\n') ? `${draft}${token}` : `${draft} ${token}`
}
