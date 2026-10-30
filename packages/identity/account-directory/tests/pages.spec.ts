import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { adminPage, loginPage } from '../src/pages.ts'
import type { AccountSummary, GrantRecord, UserId } from '../src/types.ts'

const admin: AccountSummary = {
  id: brandString<UserId>('account-1'),
  username: 'alice',
  displayName: 'Alice',
  roles: ['admin'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('login page', () => {
  it('offers self-registration only when the directory allows it', () => {
    expect(loginPage(undefined, true)).toContain('action="/auth/register"')
    expect(loginPage(undefined, false)).not.toContain('action="/auth/register"')
  })

  it('escapes the message it was given', () => {
    expect(loginPage('<script>alert(1)</script>', false)).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('prefills and displays development credentials only when configured', () => {
    const page = loginPage(undefined, true, { username: 'admin', password: 'dsh-admin-2026' })
    expect(page).toContain('value="admin"')
    expect(page).toContain('value="dsh-admin-2026"')
    expect(page).toContain('开发测试账号')
    expect(page).toContain('<a href="/admin">管理控制台</a>')
    expect(loginPage(undefined, true)).not.toContain('开发测试账号')
    expect(loginPage(undefined, true)).not.toContain('value="admin"')
  })

  it('escapes the development credentials it was given', () => {
    const page = loginPage(undefined, true, { username: '<x>', password: '"y"' })
    expect(page).toContain('value="&lt;x&gt;"')
    expect(page).toContain('value="&quot;y&quot;"')
  })
})

describe('administration page', () => {
  it('lists accounts, grants, and every grantable role', () => {
    const grant: GrantRecord = {
      userId: brandString<UserId>('account-2'),
      resourceKind: 'ontology-domain',
      resourceId: 'd1',
      roles: ['reviewer'],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const html = adminPage(admin, [admin], [grant], '未授权')
    expect(html).toContain('alice')
    expect(html).toContain('ontology-domain')
    expect(html).toContain('未授权')
    expect(html).toContain('name="roles" value="publisher"')
  })

  it('renders the empty grant list and escapes stored text', () => {
    const evil = { ...admin, displayName: '<evil>' }
    const html = adminPage(evil, [evil], [], undefined)
    expect(html).toContain('暂无授权')
    expect(html).toContain('&lt;evil&gt;')
  })
})
