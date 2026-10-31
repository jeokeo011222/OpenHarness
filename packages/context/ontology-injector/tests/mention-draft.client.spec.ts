import { describe, expect, it } from 'vitest'
import type { MentionCandidate } from '../src/mention.ts'
import {
  appendDomainMention,
  selectedDomainId,
  stripDomainMentions,
  swapDomainMention,
} from '../src/client/mention-draft.ts'

const PAYMENT: MentionCandidate = { id: 'payment', label: '合同付款风控', disabled: false }
const CARBON: MentionCandidate = { id: 'carbon', label: '碳排放核算', disabled: false }
const RETIRED: MentionCandidate = { id: 'legacy', label: '旧版合同', disabled: true }
const DOMAINS: readonly MentionCandidate[] = [PAYMENT, CARBON, RETIRED]

describe('composer draft', () => {
  it('reports the selected domain from the draft text', () => {
    expect(selectedDomainId('', DOMAINS)).toBeNull()
    expect(selectedDomainId('@合同付款风控 超付了吗', DOMAINS)).toBe('payment')
    expect(selectedDomainId('看下 @README.md', DOMAINS)).toBeNull()
    // A token for a disabled domain cannot steer the Host, so the chip stays off.
    expect(selectedDomainId('@旧版合同 还在吗', DOMAINS)).toBeNull()
  })

  it('removes every domain token and tidies the gap it leaves', () => {
    expect(stripDomainMentions('问 @payment 这句', DOMAINS)).toBe('问 这句')
    expect(stripDomainMentions('@payment 这是什么', DOMAINS)).toBe('这是什么')
    expect(stripDomainMentions('@payment @carbon 两个', DOMAINS)).toBe('两个')
  })

  it('leaves a file token untouched and keeps the sentence around it', () => {
    expect(stripDomainMentions('看 @README.md 和 @payment', DOMAINS)).toBe('看 @README.md 和')
  })

  it('swaps a token in place instead of appending a second one', () => {
    expect(swapDomainMention('@合同付款风控 这笔呢', CARBON, DOMAINS)).toBe('@碳排放核算 这笔呢')
    expect(swapDomainMention('这笔呢', CARBON, DOMAINS)).toBeNull()
  })

  it('appends with exactly one separating space', () => {
    expect(appendDomainMention('', PAYMENT)).toBe('@合同付款风控 ')
    expect(appendDomainMention('这笔呢', PAYMENT)).toBe('这笔呢 @合同付款风控 ')
    expect(appendDomainMention('这笔呢 ', PAYMENT)).toBe('这笔呢 @合同付款风控 ')
  })
})
