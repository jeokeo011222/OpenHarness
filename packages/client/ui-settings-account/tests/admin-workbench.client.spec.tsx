// @vitest-environment jsdom
/** Admin workbench page over the Host's /admin/state JSON and form routes. */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AdminWorkbench } from '../src/client/AdminWorkbench.tsx'
import { AdminIcon } from '../src/client/AdminIcon.tsx'
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

/** Renders the workbench and waits for the ready state. */
async function renderReady(state: unknown = adminState): Promise<FetchStub> {
  const stub = stubFetch(state)
  render(<AdminWorkbench t={key => en[key as keyof typeof en]} />)
  await screen.findByText(en.adminAccounts)
  return stub
}

it('renders loading first, then both cards with the account and grant tables', async () => {
  stubFetch(adminState)
  render(<AdminWorkbench t={key => en[key as keyof typeof en]} />)
  expect(screen.getByText(en.adminLoading)).toBeDefined()
  await screen.findByText(en.adminAccounts)
  expect(screen.getByText(en.adminDescription)).toBeDefined()
  expect(screen.getByText(en.adminGrants)).toBeDefined()
  expect(screen.getByText('workspace')).toBeDefined()
  expect(screen.getByText('owner, viewer')).toBeDefined()
  // A grant resolves its account by id; unknown ids stay raw.
  expect(screen.getByText('ghost')).toBeDefined()
  // Twice in the tables (account row + grant name) and once in the grant form's account select.
  expect(screen.getAllByText('ada')).toHaveLength(3)
})

it('reports the forbidden state when the directory refuses the read', async () => {
  stubFetch(undefined)
  render(<AdminWorkbench t={key => en[key as keyof typeof en]} />)
  await screen.findByText(en.adminForbidden)
})

it('creates an account through the form and clears the fields', async () => {
  const { posts, okPaths } = await renderReady()
  okPaths.add('admin/user/create')
  // The create form renders first; the account rows repeat the same labels.
  fireEvent.change(screen.getByLabelText(en.adminUsername), { target: { value: 'lee' } })
  fireEvent.change(screen.getAllByLabelText(en.adminDisplayName)[0]!, { target: { value: 'Lee' } })
  fireEvent.change(screen.getByLabelText(en.adminPassword), { target: { value: 'secret' } })
  fireEvent.click(screen.getAllByLabelText(en.adminAdministrator)[0]!)
  fireEvent.click(screen.getByText(en.adminCreate))
  await vi.waitFor(() => { expect(posts.some(post => post.path === 'admin/user/create')).toBe(true) })
  const create = posts.find(post => post.path === 'admin/user/create')!
  expect(create.body.get('username')).toBe('lee')
  expect(create.body.get('displayName')).toBe('Lee')
  expect(create.body.get('password')).toBe('secret')
  expect(create.body.get('admin')).toBe('1')
  expect(screen.getByLabelText<HTMLInputElement>(en.adminUsername).value).toBe('')
  expect(screen.queryByText(en.adminError)).toBeNull()
})

it('blocks the create form while username or password is empty', async () => {
  const { posts } = await renderReady()
  // Submitting programmatically bypasses the inputs' constraint validation,
  // reaching the form's own guard for the empty-field refusals.
  const form = screen.getByText(en.adminCreate).closest('form')!
  fireEvent.submit(form)
  fireEvent.change(screen.getByLabelText(en.adminUsername), { target: { value: 'lee' } })
  fireEvent.submit(form)
  expect(posts).toEqual([])
})

it('reports a failed action as an error notice', async () => {
  await renderReady() // okPaths stays empty, so the create post is refused
  fireEvent.change(screen.getByLabelText(en.adminUsername), { target: { value: 'lee' } })
  fireEvent.change(screen.getByLabelText(en.adminPassword), { target: { value: 'secret' } })
  fireEvent.click(screen.getByText(en.adminCreate))
  await screen.findByText(en.adminError)
})

it('updates one account row: rename, an optional password reset, and the admin flag', async () => {
  const { posts, okPaths } = await renderReady()
  okPaths.add('admin/user/update')
  // [0] is the create form's field; rows follow in state order (u1, u2).
  const displayNameInputs = screen.getAllByLabelText(en.adminDisplayName) as HTMLInputElement[]
  const adminChecks = screen.getAllByLabelText(en.adminAdministrator) as HTMLInputElement[]
  const passwords = screen.getAllByLabelText(en.adminNewPassword) as HTMLInputElement[]
  // Row u2 (ada): rename, stay non-admin, and set a new password.
  fireEvent.change(displayNameInputs[2]!, { target: { value: 'Adelheid' } })
  fireEvent.change(passwords[1]!, { target: { value: 'next' } })
  fireEvent.click(screen.getAllByText(en.adminSave)[1]!)
  await vi.waitFor(() => { expect(posts.some(post => post.path === 'admin/user/update')).toBe(true) })
  const update = posts.find(post => post.path === 'admin/user/update')!
  expect(update.body.get('userId')).toBe('u2')
  expect(update.body.get('admin')).toBe('0')
  expect(update.body.get('displayName')).toBe('Adelheid')
  expect(update.body.get('password')).toBe('next')
  expect((passwords[1] as HTMLInputElement).value).toBe('')
  // Toggling u1's admin flag off posts the flag without a password.
  fireEvent.click(adminChecks[1]!)
  fireEvent.click(screen.getAllByText(en.adminSave)[0]!)
  await vi.waitFor(() => { expect(posts.filter(post => post.path === 'admin/user/update')).toHaveLength(2) })
  const demote = posts.filter(post => post.path === 'admin/user/update')[1]!
  expect(demote.body.get('userId')).toBe('u1')
  expect(demote.body.get('admin')).toBe('0')
  expect(demote.body.has('password')).toBe(false)
  // Promoting u2 posts the enabled admin flag.
  fireEvent.click(adminChecks[2]!)
  fireEvent.click(screen.getAllByText(en.adminSave)[1]!)
  await vi.waitFor(() => { expect(posts.filter(post => post.path === 'admin/user/update')).toHaveLength(3) })
  const promote = posts.filter(post => post.path === 'admin/user/update')[2]!
  expect(promote.body.get('userId')).toBe('u2')
  expect(promote.body.get('admin')).toBe('1')
})

it('deletes an account row', async () => {
  const { posts, okPaths } = await renderReady()
  okPaths.add('admin/user/delete')
  fireEvent.click(screen.getAllByText(en.adminDelete)[0]!)
  await vi.waitFor(() => { expect(posts.some(post => post.path === 'admin/user/delete')).toBe(true) })
  expect(posts.find(post => post.path === 'admin/user/delete')!.body.get('userId')).toBe('u1')
})

it('validates the grant form, submits the checked roles, and keeps the selected account', async () => {
  const { posts, okPaths } = await renderReady()
  okPaths.add('admin/grant/set')
  const setGrant = (): void => { fireEvent.click(screen.getByText(en.adminSetGrant)) }
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
  // Toggle the author role on and off, then submit it with the viewer role.
  const author = screen.getByLabelText<HTMLInputElement>('author')
  fireEvent.click(author)
  fireEvent.click(author)
  fireEvent.click(author)
  fireEvent.click(screen.getByLabelText<HTMLInputElement>('viewer'))
  setGrant()
  await vi.waitFor(() => { expect(posts.filter(post => post.path === 'admin/grant/set')).toHaveLength(1) })
  await act(async () => {})
  const first = posts.find(post => post.path === 'admin/grant/set')!
  expect(first.body.get('userId')).toBe('u1')
  expect(first.body.getAll('roles')).toEqual(['author', 'viewer'])
  // The submission clears the resource fields and keeps the selected account.
  expect(kindInput.value).toBe('')
  expect(idInput.value).toBe('')
  expect(accountSelect.value).toBe('u1')
})

it('revokes one grant and renders the empty state without grants', async () => {
  const { posts, okPaths } = await renderReady()
  okPaths.add('admin/grant/delete')
  fireEvent.click(screen.getAllByText(en.adminDelete, { selector: 'td > button' })[0]!)
  await vi.waitFor(() => { expect(posts.some(post => post.path === 'admin/grant/delete')).toBe(true) })
  const revoke = posts.find(post => post.path === 'admin/grant/delete')!
  expect(revoke.body.get('userId')).toBe('u2')
  expect(revoke.body.get('resourceKind')).toBe('workspace')
  expect(revoke.body.get('resourceId')).toBe('w1')
  cleanup()
  stubFetch({ ...adminState, grants: [] })
  render(<AdminWorkbench t={key => en[key as keyof typeof en]} />)
  await screen.findByText(en.adminEmpty)
})

it('renders the sidebar shield icon', () => {
  const { container } = render(<AdminIcon size={16} />)
  expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
})
