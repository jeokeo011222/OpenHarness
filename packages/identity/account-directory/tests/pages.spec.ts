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
  it('renders three tabs, accounts, grants, and role checkboxes', () => {
    const grant: GrantRecord = {
      userId: brandString<UserId>('account-2'),
      resourceKind: 'ontology-domain',
      resourceId: 'd1',
      roles: ['reviewer'],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const viewer = { ...admin, id: brandString<UserId>('account-3'), username: 'bob', roles: [] }
    const html = adminPage(admin, [admin, viewer], [grant], '未授权')
    // Three-tab shell
    expect(html).toContain('data-pane="users"')
    expect(html).toContain('data-pane="roles"')
    expect(html).toContain('data-pane="permissions"')
    // Account list
    expect(html).toContain('alice')
    expect(html).toContain('bob')
    expect(html).toContain('ontology-domain')
    // Per-user action buttons
    expect(html).toContain('data-action="permissions"')
    expect(html).toContain('data-action="edit"')
    expect(html).toContain('data-action="delete"')
    // Notice and grant roles
    expect(html).toContain('未授权')
    expect(html).toContain('name="roles" value="publisher"')
    expect(html).toContain('name="roles" value="reviewer"')
    // Role table includes admin badge and resource role badges
    expect(html).toContain('role-badge admin')
    expect(html).toContain('<span class="role-badge">owner</span>')
  })

  it('renders the empty grant list and escapes stored text', () => {
    const evil = { ...admin, displayName: '<evil>' }
    const html = adminPage(evil, [evil], [], undefined)
    expect(html).toContain('暂无授权')
    expect(html).toContain('&lt;evil&gt;')
    // Role table still renders global/admin row
    expect(html).toContain('>全局<')
  })
})
