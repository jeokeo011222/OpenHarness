import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INJECTION_MODE,
  domainIndexLine,
  resolveInjectorConfig,
  selectTurnDomains,
  wrapInjection,
} from '../src/injector.ts'
import {
  findLabelConflict,
  latestUserText,
  mentionSpans,
  mentionTokenFor,
  mentionTokens,
  normalizeLabel,
  planMentions,
} from '../src/mention.ts'
import type { MentionCandidate } from '../src/mention.ts'

const PAYMENT: MentionCandidate = { id: 'payment', label: '合同付款风控', disabled: false }
const CARBON: MentionCandidate = { id: 'carbon', label: '碳排放核算', disabled: false }
const RETIRED: MentionCandidate = { id: 'legacy', label: '旧版合同', disabled: true }
const DOMAINS: readonly MentionCandidate[] = [PAYMENT, CARBON, RETIRED]

describe('mentionSpans', () => {
  it('finds a token at the start, after a space, and before punctuation', () => {
    expect(mentionSpans('@合同付款风控，这笔超付吗').map(span => span.body)).toEqual(['合同付款风控'])
    expect(mentionSpans('这笔 @合同付款风控 是否超付').map(span => span.body)).toEqual(['合同付款风控'])
    expect(mentionSpans('问一下（@payment）').map(span => span.body)).toEqual(['payment'])
  })

  it('keeps a path in one piece and trims only trailing dots', () => {
    expect(mentionTokens('看下 @src/app.ts 这个文件')).toEqual(['@src/app.ts'])
    expect(mentionTokens('@payment.')).toEqual(['@payment'])
  })

  it('reads a quoted token with spaces', () => {
    expect(mentionTokens('@"合同 付款" 呢')).toEqual(['@合同 付款'])
  })

  it('ignores an email address', () => {
    expect(mentionTokens('发到 a@b.com')).toEqual([])
  })
})

describe('planMentions', () => {
  it('resolves a label token to the domain id', () => {
    expect(planMentions('@合同付款风控 这笔超付吗', DOMAINS)).toEqual([
      { domain: 'payment', token: '@合同付款风控' },
    ])
  })

  it('resolves an id token', () => {
    expect(planMentions('@carbon 的核算边界', DOMAINS)).toEqual([{ domain: 'carbon', token: '@carbon' }])
  })

  it('claims several domains in message order without duplicates', () => {
    expect(planMentions('@carbon 与 @合同付款风控，再看 @carbon', DOMAINS)).toEqual([
      { domain: 'carbon', token: '@carbon' },
      { domain: 'payment', token: '@合同付款风控' },
    ])
  })

  it('leaves a file path to the file-reference prompt', () => {
    // The `@` syntax is shared; claiming an unknown token would break the file.
    expect(planMentions('看下 @README.md', DOMAINS)).toEqual([])
  })

  it('refuses a disabled domain even though it resolves', () => {
    expect(planMentions('@旧版合同 还在吗', DOMAINS)).toEqual([])
  })

  it('ignores case and inner whitespace differences in a label', () => {
    expect(normalizeLabel('  Payment  ')).toBe('payment')
    expect(planMentions('@  合同付款风控', DOMAINS)).toEqual([])
  })
})

describe('findLabelConflict', () => {
  it('refuses a label another domain already answers to', () => {
    expect(findLabelConflict(' 合同付款风控 ', DOMAINS)).toBe('payment')
  })

  it('refuses a label that would shadow another domain id', () => {
    // A token matching a domain id would always win over a label, so a label
    // equal to some other domain's id can never be reached.
    expect(findLabelConflict('carbon', [PAYMENT, CARBON])).toBe('carbon')
  })

  it('lets a domain keep its own label and lets blank labels through', () => {
    expect(findLabelConflict('合同付款风控', DOMAINS, 'payment')).toBeNull()
    expect(findLabelConflict('   ', DOMAINS)).toBeNull()
  })
})

describe('latestUserText', () => {
  it('reads the newest user message and joins its text parts', () => {
    const messages = [
      { source: { kind: 'ontology-injector' }, content: [{ type: 'text', text: '@payment 来自插件' }] },
      { source: { kind: 'user' }, content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] },
      { source: { kind: 'tool' }, content: [{ type: 'text', text: '工具输出' }] },
    ]
    expect(latestUserText(messages)).toBe('第一段\n第二段')
  })

  it('ignores non-text parts and an absent user message', () => {
    expect(latestUserText([{ source: { kind: 'user' }, content: [{ type: 'image' }] }])).toBe('')
    expect(latestUserText([])).toBe('')
  })
})

describe('resolveInjectorConfig injection mode', () => {
  it('defaults to mention so a plain chat stays plain', () => {
    expect(resolveInjectorConfig({}).injectionMode).toBe(DEFAULT_INJECTION_MODE)
    expect(DEFAULT_INJECTION_MODE).toBe('mention')
  })

  it('keeps the explicit always mode for deployments that pinned a domain', () => {
    expect(resolveInjectorConfig({ injectionMode: 'always', defaultDomains: ['payment'] }).injectionMode)
      .toBe('always')
  })
})

describe('selectTurnDomains', () => {
  it('injects nothing for a plain message, even with configured defaults', () => {
    // The fallback is the whole point of this test: a deployment that pinned a
    // domain must not leak it into a chat the user left unselected.
    const picks = selectTurnDomains({
      mode: 'mention', defaults: ['payment'], text: '这笔款为什么没付？', domains: DOMAINS,
    })
    expect(picks).toEqual([])
  })

  it('injects only the domain the message names', () => {
    const picks = selectTurnDomains({
      mode: 'mention', defaults: [], text: '看看 @碳排放核算 的边界', domains: DOMAINS,
    })
    expect(picks).toEqual([{ domain: 'carbon', token: '@碳排放核算' }])
  })

  it('does not claim a file token', () => {
    const picks = selectTurnDomains({
      mode: 'mention', defaults: [], text: '读一下 @README.md', domains: DOMAINS,
    })
    expect(picks).toEqual([])
  })

  it('keeps the configured list for always mode and asks no message for tokens', () => {
    const picks = selectTurnDomains({
      mode: 'always', defaults: ['payment', 'carbon'], text: '随便聊聊', domains: DOMAINS,
    })
    expect(picks).toEqual([
      { domain: 'payment', token: '' },
      { domain: 'carbon', token: '' },
    ])
  })
})

describe('wrapInjection', () => {
  it('adds the not-a-path note directly under the heading when a token selected the domain', () => {
    const block = wrapInjection('合同域（payment）：1 个类。', 'payment', '用户消息中的 @合同付款风控 指这个本体域，不是文件路径。')
    expect(block).toBe(`<system-reminder>
## 业务域本体知识：payment

用户消息中的 @合同付款风控 指这个本体域，不是文件路径。

合同域（payment）：1 个类。
</system-reminder>`)
  })

  it('omits the note when the domain came from configuration', () => {
    expect(wrapInjection('摘要', 'payment')).toBe(`<system-reminder>
## 业务域本体知识：payment

摘要
</system-reminder>`)
  })
})

describe('mentionTokenFor', () => {
  it('uses the label when the grammar can carry it', () => {
    expect(mentionTokenFor(PAYMENT)).toBe('@合同付款风控')
  })

  it('falls back to the id when the label would be cut in half', () => {
    // A token the parser splits is worse than an exact one the user has to learn.
    expect(mentionTokenFor({ id: 'payment', label: '合同 付款' })).toBe('@payment')
    expect(mentionTokenFor({ id: 'payment', label: '合同，付款' })).toBe('@payment')
    expect(mentionTokenFor({ id: 'payment', label: '  ' })).toBe('@payment')
  })
})

describe('domain index line', () => {
  it('still names the domain and the tool to call', () => {
    expect(domainIndexLine('合同域', 'payment', '## 当前业务域：payment'))
      .toBe('合同域（payment）：0 个类、0 条对象关系、0 个数据属性。需要完整词汇时调用 domain_summary 工具（domain="payment"）。')
  })
})
