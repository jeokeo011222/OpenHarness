import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_SUMMARY_CHARS, DEFAULT_STORE_PATH, domainIndexLine, resolveInjectorConfig, truncateSummary, wrapInjection } from '../src/injector.ts'

describe('resolveInjectorConfig', () => {
  it('defaults the store path and the summary budget', () => {
    const resolved = resolveInjectorConfig({})
    expect(resolved.storePath).toBe(DEFAULT_STORE_PATH)
    expect(resolved.defaultDomains).toEqual([])
    expect(resolved.maxSummaryChars).toBe(DEFAULT_MAX_SUMMARY_CHARS)
  })

  it('trims, deduplicates, and drops blank domains', () => {
    const resolved = resolveInjectorConfig({ defaultDomains: [' contract ', 'contract', '', '   ', 'procurement'] })
    expect(resolved.defaultDomains).toEqual(['contract', 'procurement'])
  })

  it('resolves a relative store path and keeps a custom budget', () => {
    const resolved = resolveInjectorConfig({ storePath: './ontology-store', maxSummaryChars: 120 })
    expect(resolved.storePath).toBe(resolve('./ontology-store'))
    expect(resolved.maxSummaryChars).toBe(120)
  })
})

describe('truncateSummary', () => {
  it('leaves text that fits the budget intact', () => {
    expect(truncateSummary('short text', 20)).toBe('short text')
  })

  it('cuts long text on a line boundary and appends the suffix', () => {
    const text = '## 标题\n- 合同（Contract）\n- 签约方（Party）'
    expect(truncateSummary(text, 8)).toBe('## 标题\n…（摘要已截断，超出字符预算）')
  })

  it('cuts inside a single long line when no line boundary fits', () => {
    expect(truncateSummary('abcdefghij', 5)).toBe('abcde\n…（摘要已截断，超出字符预算）')
  })
})

describe('domainIndexLine', () => {
  const SUMMARY = '## 当前业务域：contract\n\n### 对象类\n- 合同（Contract）\n- 签约方（Party）\n\n### 关键关系\n- 合同 → 签约方 → Party\n\n### 数据属性\n- 合同 → 生效日期（date）'

  it('counts classes, relations, and data properties from the rendered summary', () => {
    expect(domainIndexLine('合同域', 'contract', SUMMARY))
      .toBe('合同域（contract）：2 个类、1 条对象关系、1 个数据属性。需要完整词汇时调用 domain_summary 工具（domain="contract"）。')
  })

  it('reports zeroes for a summary without entity lists', () => {
    expect(domainIndexLine('空域', 'empty', '## 当前业务域：empty'))
      .toBe('空域（empty）：0 个类、0 条对象关系、0 个数据属性。需要完整词汇时调用 domain_summary 工具（domain="empty"）。')
  })
})

describe('wrapInjection', () => {
  it('wraps a trimmed summary in the system-reminder envelope', () => {
    expect(wrapInjection('  ## 当前业务域：contract\n', 'contract')).toBe(`<system-reminder>
## 业务域本体知识：contract

## 当前业务域：contract
</system-reminder>`)
  })
})
