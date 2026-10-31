// @vitest-environment jsdom
/** Admin workbench: tabbed user list with pages of 15, modal actions, and roles. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AdminWorkbench, type AdminWorkbenchProps } from '../src/client/AdminWorkbench.tsx'
import { AdminIcon } from '../src/client/AdminIcon.tsx'
// The namespace declaration `AdminWorkbenchProps['t']` resolves against.
import type {} from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const adminState = {
  account: { username: 'admin', displayName: 'Admin', roles: ['admin'] },
  accounts: [
    { id: 'u1', username: 'admin', displayName: 'Admin', roles: ['admin'] },
    { id: 'u2', username: 'ada', displayName: 'Ada', roles: [] },
  ],
  grants: [
    { userId: 'u2', resourceKind: 'workspace', resourceId: 'w1', roles: ['owner', 'viewer'] },
    { userId: 'ghost', resourceKind: 'session', resourceId: 's1', roles: ['viewer'] },
  ],
}

/** Form posts recorded by {@link stubFetch} and the paths it answers with 200. */
interface FetchStub {
  readonly posts: { path: string; body: URLSearchParams }[]
  readonly okPaths: Set<string>
}

/** Fetch router answering /admin/state with `state` and recording form posts. */
function stubFetch(state: unknown): FetchStub {
  const posts: { path: string; body: URLSearchParams }[] = []
  const okPaths = new Set<string>()
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: { method?: string; body?: string }): Promise<Response> => {
    if (init?.method === 'POST') {
      posts.push({ path: input, body: new URLSearchParams(init.body ?? '') })
      return new Response('', { status: okPaths.has(input) ? 200 : 500 })
    }
    return new Response(JSON.stringify(state), { status: 200 })
  }))
  return { posts, okPaths }
}

/** Translate through the English dictionary, filling `{name}` params. */
const dictionary: Readonly<Record<string, string>> = en
const t: AdminWorkbenchProps['t'] = (key, params) => {
  const copy = dictionary[key] ?? key
  if (params === undefined) return copy
  return copy.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = params[name]
    return typeof value === 'string' ? value : typeof value === 'number' ? value.toString() : ''
  })
}

/** Renders the workbench and waits for the ready state. */
async function renderReady(state: unknown = adminState): Promise<FetchStub> {
  const stub = stubFetch(state)
  render(<AdminWorkbench t={t} />)
  await screen.findAllByText(en.adminTabUsers)
  return stub
}

/** Builds `count` accounts, named `user1` upward. */
function manyAccounts(count: number): unknown {
  return {
    ...adminState,
    accounts: Array.from({ length: count }, (_unused, index) => ({
      id: `u-${index + 1}`, username: `user${index + 1}`, displayName: `User ${index + 1}`, roles: [],
    })),
    grants: [],
  }
}

it('renders loading first, then the tabs and the first page of accounts', async () => {
  stubFetch(adminState)
  render(<AdminWorkbench t={t} />)
  expect(screen.getByText(en.adminLoading)).toBeDefined()
  await screen.findAllByText(en.adminTabUsers)
  expect(screen.getByRole('tab', { name: en.adminTabUsers }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('tab', { name: en.adminTabRoles }).getAttribute('aria-selected')).toBe('false')
  expect(screen.getByText(t('adminAccountCount', { count: 2 }))).toBeDefined()
  expect(screen.getByText('ada')).toBeDefined()
  expect(screen.getByText('Ada')).toBeDefined()
  expect(screen.getByText(en.adminNotAdministrator)).toBeDefined()
  expect(screen.getByText(t('adminPage', { page: 1, total: 1 }))).toBeDefined()
  // Nothing from the roles tab is on screen yet.
  expect(screen.queryByText(en.adminGrants)).toBeNull()
})

it('paginates the account list fifteen rows at a time', async () => {
  await renderReady(manyAccounts(20))
  expect(screen.getByText('user15')).toBeDefined()
  expect(screen.queryByText('user16')).toBeNull()
  expect(screen.getByText(t('adminPage', { page: 1, total: 2 }))).toBeDefined()
  expect(screen.getByRole('button', { name: en.adminPrevious }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.adminNext }))
  expect(screen.getByText('user16')).toBeDefined()
  expect(screen.queryByText('user1')).toBeNull()
  expect(screen.getByRole('button', { name: en.adminNext }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.adminPrevious }))
  expect(screen.getByText('user1')).toBeDefined()
  expect(screen.queryByText('user16')).toBeNull()
})

it('creates an account from the dialog and closes it on success', async () => {
  const { posts, okPaths } = await renderReady()
  okPaths.add('admin/user/create')
  fireEvent.click(screen.getByRole('button', { name: en.adminAddUser }))
  const dialog = screen.getByRole('dialog', { name: en.adminAddUser })
  fireEvent.change(within(dialog).getByLabelText(en.adminUsername), { target: { value: 'lee' } })
  fireEvent.change(within(dialog).getByLabelText(en.adminDisplayName), { target: { value: 'Lee' } })
  fireEvent.change(within(dialog).getByLabelText(en.adminPassword), { target: { value: 'secret' } })
  fireEvent.click(within(dialog).getByLabelText(en.adminAdministrator))
  fireEvent.click(within(dialog).getByRole('button', { name: en.adminCreate }))
  await vi.waitFor(() => { expect(posts.some(post => post.path === 'admin/user/create')).toBe(true) })
  const create = posts.find(post => post.path === 'admin/user/create')!
  expect(create.body.get('username')).toBe('lee')
  expect(create.body.get('displayName')).toBe('Lee')
  expect(create.body.get('password')).toBe('secret')
  expect(create.body.get('admin')).toBe('1')
  await vi.waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
})

it('blocks the dialog submit until username and password are present', async () => {
  const { posts } = await renderReady()
  fireEvent.click(screen.getByRole('button', { name: en.adminAddUser }))
  const dialog = screen.getByRole('dialog', { name: en.adminAddUser })
  const form = dialog.querySelector('form')!
  // Submitting programmatically bypasses the disabled button, reaching the guard.
  fireEvent.submit(form)
  fireEvent.change(within(dialog).getByLabelText(en.adminUsername), { target: { value: 'lee' } })
  fireEvent.submit(form)
  expect(posts).toEqual([])
  expect(within(dialog).getByRole('button', { name: en.adminCreate }).hasAttribute('disabled')).toBe(true)
})

it('keeps the dialog open and reports a failed action', async () => {
  await renderReady() // okPaths stays empty, so the create post is refused
  fireEvent.click(screen.getByRole('button', { name: en.adminAddUser }))
  const dialog = screen.getByRole('dialog', { name: en.adminAddUser })
  fireEvent.change(within(dialog).getByLabelText(en.adminUsername), { target: { value: 'lee' } })
  fireEvent.change(within(dialog).getByLabelText(en.adminPassword), { target: { value: 'secret' } })
  fireEvent.click(within(dialog).getByRole('button', { name: en.adminCreate }))
  await screen.findByText(en.adminError)
  expect(screen.getByRole('dialog', { name: en.adminAddUser })).toBeDefined()
})

it('edits an account: rename without a password, then with a reset and the admin flag', async () => {
  const { posts, okPaths } = await renderReady()
  okPaths.add('admin/user/update')
  // Row order is state order: u1 (admin) first.
  fireEvent.click(screen.getAllByRole('button', { name: en.adminEdit })[0]!)
  const dialog = screen.getByRole('dialog', { name: en.adminEditUser })
  expect(within(dialog).getByText('admin')).toBeDefined()
  fireEvent.change(within(dialog).getByLabelText(en.adminDisplayName), { target: { value: 'Root' } })
  fireEvent.click(within(dialog).getByRole('button', { name: en.adminSave }))
  await vi.waitFor(() => { expect(posts.some(post => post.path === 'admin/user/update')).toBe(true) })
  const rename = posts.find(post => post.path === 'admin/user/update')!
  expect(rename.body.get('userId')).toBe('u1')
  expect(rename.body.get('admin')).toBe('1')
  expect(rename.body.get('displayName')).toBe('Root')
  expect(rename.body.has('password')).toBe(false)
  // Reopen the second row, reset its password, and promote it.
  await vi.waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  fireEvent.click(screen.getAllByRole('button', { name: en.adminEdit })[1]!)
  const second = screen.getByRole('dialog', { name: en.adminEditUser })
  fireEvent.change(within(second).getByLabelText(en.adminNewPassword), { target: { value: 'next' } })
  fireEvent.click(within(second).getByLabelText(en.adminAdministrator))
  fireEvent.click(within(second).getByRole('button', { name: en.adminSave }))
  await vi.waitFor(() => { expect(posts.filter(post => post.path === 'admin/user/update')).toHaveLength(2) })
  const reset = posts.filter(post => post.path === 'admin/user/update')[1]!
  expect(reset.body.get('userId')).toBe('u2')
  expect(reset.body.get('admin')).toBe('1')
  expect(reset.body.get('password')).toBe('next')
})

it('confirms deletion, and cancels it without posting', async () => {
  const { posts, okPaths } = await renderReady()
  okPaths.add('admin/user/delete')
  fireEvent.click(screen.getAllByRole('button', { name: en.adminDelete })[0]!)
  const dialog = screen.getByRole('dialog', { name: t('adminDeleteUser', { name: 'admin' }) })
  expect(within(dialog).getByText(en.adminDeleteHint)).toBeDefined()
  fireEvent.click(within(dialog).getByRole('button', { name: en.adminCancel }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(posts).toEqual([])
  fireEvent.click(screen.getAllByRole('button', { name: en.adminDelete })[0]!)
  const confirm = screen.getByRole('dialog', { name: t('adminDeleteUser', { name: 'admin' }) })
  fireEvent.click(within(confirm).getByRole('button', { name: en.adminDelete }))
  await vi.waitFor(() => { expect(posts.some(post => post.path === 'admin/user/delete')).toBe(true) })
  expect(posts.find(post => post.path === 'admin/user/delete')!.body.get('userId')).toBe('u1')
  await vi.waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
})

it('closes the dialog on Escape and ignores other keys', async () => {
  await renderReady()
  fireEvent.click(screen.getByRole('button', { name: en.adminAddUser }))
  const dialog = screen.getByRole('dialog', { name: en.adminAddUser })
  fireEvent.keyDown(dialog, { key: 'Enter' })
  expect(screen.getByRole('dialog', { name: en.adminAddUser })).toBeDefined()
  fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('switches to roles: counts holders, sets a grant, revokes it, and shows the empty state', async () => {
  const { posts, okPaths } = await renderReady()
  okPaths.add('admin/grant/set')
  okPaths.add('admin/grant/delete')
  fireEvent.click(screen.getByRole('tab', { name: en.adminTabRoles }))
  expect(screen.getByRole('tab', { name: en.adminTabRoles }).getAttribute('aria-selected')).toBe('true')
  // The admin flag and both grant roles resolve their holder counts.
  expect(screen.getAllByText(t('adminAccountCount', { count: 1 }))).toHaveLength(2)
  expect(screen.getByText(t('adminAccountCount', { count: 2 }))).toBeDefined()
  expect(screen.getAllByText(t('adminAccountCount', { count: 0 }))).toHaveLength(3)
  expect(screen.getByText(`${en.adminRoleScope}: ${en.adminRoleScopeGlobal}`)).toBeDefined()
  expect(screen.getAllByText(`${en.adminRoleScope}: ${en.adminRoleScopeResource}`)).toHaveLength(5)
  expect(screen.getByText('workspace')).toBeDefined()
  expect(screen.getByText('owner, viewer')).toBeDefined()
  // A grant resolves its account by id; unknown ids stay raw.
  expect(screen.getByText('ghost')).toBeDefined()

  const setGrant = (): void => { fireEvent.click(screen.getByRole('button', { name: en.adminSetGrant })) }
  const accountSelect = screen.getByLabelText<HTMLSelectElement>(en.adminGrantTo)
  const kindInput = screen.getByLabelText<HTMLInputElement>(en.adminResourceKind)
  const idInput = screen.getByLabelText<HTMLInputElement>(en.adminResourceId)
  // Each incomplete field blocks the submission in turn.
  setGrant()
  fireEvent.change(accountSelect, { target: { value: 'u1' } })
  setGrant()
  fireEvent.change(kindInput, { target: { value: 'workspace' } })
  setGrant()
  fireEvent.change(idInput, { target: { value: 'w2' } })
  setGrant()
  expect(posts).toEqual([])
  fireEvent.click(screen.getByLabelText<HTMLInputElement>('author'))
  fireEvent.click(screen.getByLabelText<HTMLInputElement>('viewer'))
  setGrant()
  await vi.waitFor(() => { expect(posts.some(post => post.path === 'admin/grant/set')).toBe(true) })
  const set = posts.find(post => post.path === 'admin/grant/set')!
  expect(set.body.get('userId')).toBe('u1')
  expect(set.body.getAll('roles')).toEqual(['author', 'viewer'])
  expect(kindInput.value).toBe('')
  expect(idInput.value).toBe('')
  expect(accountSelect.value).toBe('u1')

  fireEvent.click(screen.getAllByText(en.adminDelete, { selector: 'td > button' })[0]!)
  await vi.waitFor(() => { expect(posts.some(post => post.path === 'admin/grant/delete')).toBe(true) })
  const revoke = posts.find(post => post.path === 'admin/grant/delete')!
  expect(revoke.body.get('userId')).toBe('u2')
  expect(revoke.body.get('resourceKind')).toBe('workspace')
  expect(revoke.body.get('resourceId')).toBe('w1')

  cleanup()
  await renderReady({ ...adminState, grants: [] })
  fireEvent.click(screen.getByRole('tab', { name: en.adminTabRoles }))
  expect(screen.getByText(en.adminEmpty)).toBeDefined()
})

it('reports the forbidden state when the directory refuses the read', async () => {
  stubFetch(undefined)
  render(<AdminWorkbench t={t} />)
  await screen.findByText(en.adminForbidden)
})

it('renders the sidebar shield icon', () => {
  const { container } = render(<AdminIcon size={16} />)
  expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
})
