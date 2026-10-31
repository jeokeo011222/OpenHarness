// @vitest-environment jsdom
/** Admin workbench: tabbed user/role/permission tables with modal account actions. */
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
  // The Host's resource dictionary: the permission form picks kinds and ids
  // from it instead of asking the operator to retype an id.
  resources: {
    kinds: [{ kind: 'ontology-domain', label: 'Ontology domain', count: 2 }],
    resources: {
      'ontology-domain': [{ id: 'sales', label: 'Sales' }, { id: 'ops', label: 'Ops' }],
    },
  },
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

it('renders loading first, then the three tabs and the first page of accounts', async () => {
  stubFetch(adminState)
  render(<AdminWorkbench t={t} />)
  expect(screen.getByText(en.adminLoading)).toBeDefined()
  await screen.findAllByText(en.adminTabUsers)
  expect(screen.getByRole('tab', { name: en.adminTabUsers }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('tab', { name: en.adminTabRoles }).getAttribute('aria-selected')).toBe('false')
  expect(screen.getByRole('tab', { name: en.adminTabPermissions }).getAttribute('aria-selected')).toBe('false')
  expect(screen.getByText(t('adminAccountCount', { count: 2 }))).toBeDefined()
  expect(screen.getByText('ada')).toBeDefined()
  expect(screen.getByText('Ada')).toBeDefined()
  expect(screen.getByText(en.adminNotAdministrator)).toBeDefined()
  expect(screen.getByText(t('adminPage', { page: 1, total: 1 }))).toBeDefined()
  // Neither the permissions grant form nor the role table content is on screen yet.
  expect(screen.queryByText(en.adminSetGrant)).toBeNull()
  expect(screen.queryByText(en.adminRoleScopeGlobal)).toBeNull()
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

it('shows the permissions button with grant count per user row', async () => {
  await renderReady()
  // ada (u2) has 1 grant → button shows "(1)"
  const permissionsButtons = screen.getAllByRole('button', { name: new RegExp(`^${en.adminPermissions}`) })
  expect(permissionsButtons).toHaveLength(2)
  // ada's row button has the count
  expect(screen.getByRole('button', { name: `${en.adminPermissions} (1)` })).toBeDefined()
  // admin has no grants → no count suffix
  const adminRowButtons = screen.getAllByRole('button', { name: new RegExp(`^${en.adminPermissions}$`) })
  expect(adminRowButtons).toHaveLength(1)
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

it('opens the per-user permissions dialog from the users row', async () => {
  const { posts, okPaths } = await renderReady()
  okPaths.add('admin/grant/delete')
  // ada's permissions button shows "(1)" — click it.
  fireEvent.click(screen.getByRole('button', { name: `${en.adminPermissions} (1)` }))
  const dialog = screen.getByRole('dialog', { name: t('adminUserPermissions', { name: 'ada' }) })
  expect(within(dialog).getByText(en.adminNotAdministrator)).toBeDefined()
  // Existing grants are listed.
  expect(within(dialog).getByText('workspace', { selector: 'td' })).toBeDefined()
  expect(within(dialog).getByText('owner, viewer')).toBeDefined()
  // Revoke one grant from inside the dialog.
  fireEvent.click(within(dialog).getAllByRole('button', { name: en.adminDelete })[0]!)
  await vi.waitFor(() => { expect(posts.some(post => post.path === 'admin/grant/delete')).toBe(true) })
  expect(posts.find(post => post.path === 'admin/grant/delete')!.body.get('userId')).toBe('u2')
})

it('switches to roles and counts holders by scope', async () => {
  await renderReady()
  fireEvent.click(screen.getByRole('tab', { name: en.adminTabRoles }))
  expect(screen.getByRole('tab', { name: en.adminTabRoles }).getAttribute('aria-selected')).toBe('true')
  // The admin flag and both grant roles resolve their holder counts.
  expect(screen.getAllByText(t('adminAccountCount', { count: 1 }))).toHaveLength(2)
  expect(screen.getByText(t('adminAccountCount', { count: 2 }))).toBeDefined()
  expect(screen.getAllByText(t('adminAccountCount', { count: 0 }))).toHaveLength(3)
  expect(screen.getByText(en.adminRoleScopeGlobal)).toBeDefined()
  expect(screen.getAllByText(en.adminRoleScopeResource)).toHaveLength(5)
  // Grant form and table stay on the permissions tab, not here.
  expect(screen.queryByText(en.adminSetGrant)).toBeNull()
  expect(screen.queryByText('workspace')).toBeNull()
})

it('switches to permissions: sets a grant, revokes it, and shows the empty state', async () => {
  const { posts, okPaths } = await renderReady()
  okPaths.add('admin/grant/set')
  okPaths.add('admin/grant/delete')
  fireEvent.click(screen.getByRole('tab', { name: en.adminTabPermissions }))
  expect(screen.getByRole('tab', { name: en.adminTabPermissions }).getAttribute('aria-selected')).toBe('true')
  // The existing grants are rendered; the kind select repeats the same names,
  // so the assertion reads the table cell rather than any option label.
  expect(screen.getByText('workspace', { selector: 'td' })).toBeDefined()
  expect(screen.getByText('owner, viewer')).toBeDefined()
  // A grant resolves its account by id; unknown ids stay raw.
  expect(screen.getByText('ghost')).toBeDefined()

  const setGrant = (): void => { fireEvent.click(screen.getByRole('button', { name: en.adminSetGrant })) }
  const accountSelect = screen.getByLabelText<HTMLSelectElement>(en.adminGrantTo)
  const kindSelect = screen.getByLabelText<HTMLSelectElement>(en.adminResourceKind)
  // The kind select is a dictionary: declared kinds first, grant-only kinds kept
  // so an existing grant stays revocable, and an explicit custom escape.
  const kindOptions = Array.from(kindSelect.options, option => option.value)
  expect(kindOptions).toContain('ontology-domain')
  expect(kindOptions).toContain('workspace')
  expect(kindOptions).toContain('session')
  // Each incomplete field blocks the submission in turn.
  setGrant()
  fireEvent.change(accountSelect, { target: { value: 'u1' } })
  setGrant()
  fireEvent.change(kindSelect, { target: { value: 'ontology-domain' } })
  setGrant()
  const idSelect = screen.getByLabelText<HTMLSelectElement>(en.adminResourceId)
  // A kind the Host enumerates offers its ids, labelled, plus the escape hatch.
  expect(Array.from(idSelect.options, option => option.value)).toEqual(['', 'sales', 'ops', '__custom__'])
  fireEvent.change(idSelect, { target: { value: 'ops' } })
  setGrant()
  expect(posts).toEqual([])
  fireEvent.click(screen.getByLabelText<HTMLInputElement>('author'))
  fireEvent.click(screen.getByLabelText<HTMLInputElement>('viewer'))
  setGrant()
  await vi.waitFor(() => { expect(posts.some(post => post.path === 'admin/grant/set')).toBe(true) })
  const set = posts.find(post => post.path === 'admin/grant/set')!
  expect(set.body.get('userId')).toBe('u1')
  expect(set.body.get('resourceKind')).toBe('ontology-domain')
  expect(set.body.get('resourceId')).toBe('ops')
  expect(set.body.getAll('roles')).toEqual(['author', 'viewer'])
  expect(kindSelect.value).toBe('')
  expect(screen.getByLabelText(en.adminResourceId).value).toBe('')
  expect(accountSelect.value).toBe('u1')

  fireEvent.click(screen.getAllByText(en.adminDelete, { selector: 'td > button' })[0]!)
  await vi.waitFor(() => { expect(posts.some(post => post.path === 'admin/grant/delete')).toBe(true) })
  const revoke = posts.find(post => post.path === 'admin/grant/delete')!
  expect(revoke.body.get('userId')).toBe('u2')
  expect(revoke.body.get('resourceKind')).toBe('workspace')
  expect(revoke.body.get('resourceId')).toBe('w1')

  cleanup()
  await renderReady({ ...adminState, grants: [] })
  fireEvent.click(screen.getByRole('tab', { name: en.adminTabPermissions }))
  expect(screen.getByText(en.adminEmpty)).toBeDefined()
})

it('keeps a typed resource possible through the custom option', async () => {
  const { posts, okPaths } = await renderReady()
  okPaths.add('admin/grant/set')
  fireEvent.click(screen.getByRole('tab', { name: en.adminTabPermissions }))
  fireEvent.change(screen.getByLabelText<HTMLSelectElement>(en.adminGrantTo), { target: { value: 'u2' } })
  // `workspace` is only known from an existing grant, so its ids are the ones
  // that grant names plus the custom escape.
  fireEvent.change(screen.getByLabelText<HTMLSelectElement>(en.adminResourceKind), { target: { value: 'workspace' } })
  const idSelect = screen.getByLabelText<HTMLSelectElement>(en.adminResourceId)
  expect(Array.from(idSelect.options, option => option.value)).toEqual(['', 'w1', '__custom__'])
  fireEvent.change(idSelect, { target: { value: '__custom__' } })
  const idInput = screen.getByLabelText<HTMLInputElement>(en.adminResourceId)
  fireEvent.change(idInput, { target: { value: 'w9' } })
  fireEvent.click(screen.getByLabelText<HTMLInputElement>('viewer'))
  fireEvent.click(screen.getByRole('button', { name: en.adminSetGrant }))
  await vi.waitFor(() => { expect(posts.some(post => post.path === 'admin/grant/set')).toBe(true) })
  const set = posts.find(post => post.path === 'admin/grant/set')!
  expect(set.body.get('resourceKind')).toBe('workspace')
  expect(set.body.get('resourceId')).toBe('w9')
})

it('offers the dictionary inside the per-user permissions dialog too', async () => {
  await renderReady()
  fireEvent.click(screen.getByRole('button', { name: `${en.adminPermissions} (1)` }))
  const dialog = screen.getByRole('dialog', { name: t('adminUserPermissions', { name: 'ada' }) })
  const kindSelect = within(dialog).getByLabelText<HTMLSelectElement>(en.adminResourceKind)
  fireEvent.change(kindSelect, { target: { value: 'ontology-domain' } })
  const idSelect = within(dialog).getByLabelText<HTMLSelectElement>(en.adminResourceId)
  expect(Array.from(idSelect.options, option => option.label)).toEqual([
    en.adminResourcePickId, 'Sales', 'Ops', en.adminResourceCustom,
  ])
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
