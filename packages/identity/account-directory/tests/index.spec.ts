import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { RemoteAccessBinding, RemoteAccessPolicy, RemoteAccessResourceKind } from '@deepseek-ai/dsh-api-remote-access'
import { brandString } from '@deepseek-ai/dsh-brand'
import AccountDirectory, { AccountDirectoryError } from '../src/index.ts'
import { hashPassword } from '../src/password.ts'
import { sessionCookieName } from '../src/session.ts'
import { grantKey, type StoredGrant, type StoredUser } from '../src/spec.ts'
import type { AccountAclRule, AccountRole, AccountSummary, GlobalRole, UserId } from '../src/types.ts'

const AUTHORITY = '127.0.0.1:3080'
const PASSWORD = 'correct horse battery'

/** The principal shape the directory registers its access policy under. */
type UserPrincipal = { readonly kind: 'user'; readonly userId: UserId }

/** One exact route captured from the web server stub. */
interface CapturedRoute {
  readonly kind: 'exact'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** One recorded response write plus its body. */
interface Recorded {
  readonly status: number
  readonly headers: Record<string, unknown>
  readonly body: string
}

interface PeerRecord {
  readonly principal: unknown
  disposed: boolean
}

interface Harness {
  readonly ctx: Context
  readonly service: AccountDirectory
  readonly routes: Map<string, CapturedRoute>
  readonly policies: Map<string, RemoteAccessPolicy<UserPrincipal>>
  readonly invalidations: (UserPrincipal | undefined)[]
  readonly peers: PeerRecord[]
  readonly webServer: { protocol: 'http:' | 'https:' }
  readonly domainClosed: () => boolean
  readonly tables: {
    readonly users: Map<string, StoredUser>
    readonly grants: Map<string, StoredGrant>
  }
}

// ---------------------------------------------------------------------------
// In-memory service stubs, installed before the plugin loads.
// ---------------------------------------------------------------------------

function credentialStore(): { provider: never } {
  const records = new Map<string, unknown>()
  const provider = {
    async modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown>): Promise<unknown> {
      const current = records.get(key)
      const next = await mutate(current)
      if (next !== undefined) records.set(key, next)
      return next ?? current
    },
  } as never
  return { provider }
}

function mapTable<V>(records: Map<string, V>): never {
  return {
    get: (key: string): V | undefined => records.get(key),
    entries: () => records.entries(),
    keys: () => records.keys(),
    put: async (key: string, value: V): Promise<void> => { records.set(key, value) },
    delete: async (key: string): Promise<boolean> => records.delete(key),
  } as never
}

function storageDomainStub(preload?: {
  readonly users?: readonly (readonly [string, StoredUser])[]
  readonly grants?: readonly (readonly [string, StoredGrant])[]
}): { users: Map<string, StoredUser>; grants: Map<string, StoredGrant>; stub: never; isClosed: () => boolean } {
  const users = new Map<string, StoredUser>(preload?.users)
  const grants = new Map<string, StoredGrant>(preload?.grants)
  let closed = false
  const stub = {
    async open(): Promise<{ table(name: string): never; close(): Promise<void> }> {
      return {
        table: (name: string) => (name === 'users' ? mapTable(users) : mapTable(grants)),
        close: async () => { closed = true },
      }
    },
  } as never
  return { users, grants, stub, isClosed: () => closed }
}

function remoteAccessStub(): {
  policies: Map<string, RemoteAccessPolicy<UserPrincipal>>
  invalidations: (UserPrincipal | undefined)[]
  stub: never
} {
  const policies = new Map<string, RemoteAccessPolicy<UserPrincipal>>()
  const invalidations: (UserPrincipal | undefined)[] = []
  const stub = {
    registerPolicy(kind: string, policy: RemoteAccessPolicy<UserPrincipal>): () => void {
      policies.set(kind, policy)
      return () => { policies.delete(kind) }
    },
    invalidate(principal?: UserPrincipal): void {
      invalidations.push(principal)
    },
  } as never
  return { policies, invalidations, stub }
}

function connectionStub(): { peers: PeerRecord[]; stub: never } {
  const peers: PeerRecord[] = []
  const stub = {
    createPeer(options: { readonly principal: unknown }): never {
      const record: PeerRecord = { principal: options.principal, disposed: false }
      peers.push(record)
      return {
        dispose: async (): Promise<void> => { record.disposed = true },
      } as never
    },
  } as never
  return { peers, stub }
}

function settingsStub(): { stub: never } {
  const stub = {
    describe(): unknown[] { return [] },
  } as never
  return { stub }
}

function webServerStub(): { routes: Map<string, CapturedRoute>; state: { protocol: 'http:' | 'https:' }; stub: never } {
  const routes = new Map<string, CapturedRoute>()
  const state: { protocol: 'http:' | 'https:' } = { protocol: 'http:' }
  const stub = {
    get protocol(): 'http:' | 'https:' { return state.protocol },
    register(route: CapturedRoute): () => void {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
  } as never
  return { routes, state, stub }
}

// ---------------------------------------------------------------------------
// Harness assembly and request helpers.
// ---------------------------------------------------------------------------

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(options?: {
  readonly allowRegistration?: boolean
  readonly devHint?: { readonly username: string; readonly password: string }
  readonly preload?: {
    readonly users?: readonly (readonly [string, StoredUser])[]
    readonly grants?: readonly (readonly [string, StoredGrant])[]
  }
}): Promise<Harness> {
  const ctx = new Context()
  roots.push(ctx)
  const domain = storageDomainStub(options?.preload)
  const remote = remoteAccessStub()
  const web = webServerStub()
  const connection = connectionStub()
  const settings = settingsStub()
  ctx.provide('credentials', credentialStore().provider)
  ctx.provide('storageDomain', domain.stub)
  ctx.provide('remoteAccess', remote.stub)
  ctx.provide('webServer', web.stub)
  ctx.provide('connection', connection.stub)
  ctx.provide('settings', settings.stub)
  await ctx.plugin(AccountDirectory, {
    ...(options?.allowRegistration === undefined ? {} : { allowRegistration: options.allowRegistration }),
    ...(options?.devHint === undefined ? {} : { devHint: options.devHint }),
  })
  return {
    ctx,
    service: ctx.accountDirectory,
    routes: web.routes,
    policies: remote.policies,
    invalidations: remote.invalidations,
    peers: connection.peers,
    webServer: web.state,
    domainClosed: domain.isClosed,
    tables: { users: domain.users, grants: domain.grants },
  }
}

function recordingResponse(): { calls: Recorded[]; res: ServerResponse; done: Promise<void> } {
  const calls: Recorded[] = []
  let finish = (): void => {}
  const done = new Promise<void>((resolve) => { finish = resolve })
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>): void {
      calls.push({ status, headers: headers ?? {}, body: '' })
    },
    end(body?: string): void {
      const last = calls.at(-1)
      if (last !== undefined) calls[calls.length - 1] = { ...last, body: body ?? '' }
      finish()
    },
  } as never
  return { calls, res, done }
}

function readRequest(url: string, options?: {
  readonly method?: string
  readonly headers?: Record<string, string>
}): IncomingMessage {
  return { method: options?.method ?? 'GET', url, headers: options?.headers ?? { host: AUTHORITY } } as never
}

/** Headers of an authenticated submission: the default host and origin plus one account cookie. */
function signedIn(cookie: string, extra: Record<string, string> = {}): Record<string, string> {
  return { host: AUTHORITY, origin: `http://${AUTHORITY}`, cookie, ...extra }
}

/** Headers of an authenticated read: the default host plus one account cookie. */
function signedInRead(cookie: string, extra: Record<string, string> = {}): Record<string, string> {
  return { host: AUTHORITY, cookie, ...extra }
}

/** A request without a `url`, the way a bare target arrives. */
function bareRequest(headers: Record<string, string>, method = 'GET'): IncomingMessage {
  return { method, headers } as never
}

function formPost(path: string, fields: Record<string, string | string[]>, headers: Record<string, string> = {
  host: AUTHORITY,
  origin: `http://${AUTHORITY}`,
}): IncomingMessage {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item)
  }
  return {
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      yield Buffer.from(params.toString())
    },
  } as IncomingMessage
}

/** A form submission whose body stream rejects with a caller-chosen value. */
function throwingPost(
  path: string,
  thrown: unknown,
  headers: Record<string, string> = {},
): IncomingMessage {
  return {
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      host: AUTHORITY,
      origin: `http://${AUTHORITY}`,
      ...headers,
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      throw thrown
    },
  } as IncomingMessage
}

/** Dispatch one request through a captured route and return its single response. */
async function callRoute(harness: Harness, path: string, req: IncomingMessage): Promise<Recorded> {
  const route = harness.routes.get(path)
  if (route === undefined) throw new Error(`route ${path} was not registered`)
  const { calls, res, done } = recordingResponse()
  await route.handler(req, res)
  await done
  const reply = calls[0]
  if (reply === undefined) throw new Error(`route ${path} wrote no response`)
  return reply
}

/** The `name=value` pair of one `Set-Cookie` value, ready for a Cookie header. */
function cookiePair(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf(';'))
}

/** Register one account (the first one becomes the administrator) and mint its session cookie. */
async function memberOf(harness: Harness, username: string): Promise<{
  readonly account: AccountSummary
  readonly cookie: string
}> {
  const account = await harness.service.register({ username, password: PASSWORD })
  return { account, cookie: cookiePair(harness.service.sessionCookieFor(account.id, AUTHORITY, false)) }
}

function userPrincipal(userId: UserId): UserPrincipal {
  return { kind: 'user', userId }
}

function userPolicy(harness: Harness): RemoteAccessPolicy<UserPrincipal> {
  const policy = harness.policies.get('user')
  if (policy === undefined) throw new Error('the user policy was not registered')
  return policy
}

async function storedUser(username: string, roles: readonly GlobalRole[]): Promise<StoredUser> {
  const now = new Date().toISOString()
  return {
    username,
    displayName: username,
    roles: [...roles],
    password: await hashPassword(PASSWORD),
    createdAt: now,
    updatedAt: now,
  }
}

function storedGrant(userId: string, resourceKind: string, resourceId: string, roles: readonly AccountRole[]): StoredGrant {
  return {
    userId: brandString<UserId>(userId),
    resourceKind,
    resourceId,
    roles: [...roles],
    updatedAt: new Date().toISOString(),
  }
}

describe('plugin boot', () => {
  it('registers every account route, the user policy, and the connection identity', async () => {
    const harness = await setup()
    expect([...harness.routes.keys()]).toEqual([
      '/login', '/admin', '/admin/state', '/auth/login', '/auth/register', '/auth/logout', '/auth/state',
      '/admin/user/create', '/admin/user/update', '/admin/user/delete', '/admin/grant/set', '/admin/grant/delete',
    ])
    expect(harness.policies.has('user')).toBe(true)
    expect(harness.ctx.connectionIdentity?.loginPath).toBe('/login')
  })

  it('loads preloaded account and grant records into the directory', async () => {
    const harness = await setup({
      preload: {
        users: [['account-1', await storedUser('keeper', ['admin'])]],
        grants: [['doc-grant', storedGrant('account-1', 'doc', 'd-1', ['owner'])]],
      },
    })
    const accounts = harness.service.listAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.id).toBe('account-1')
    expect(accounts[0]?.roles).toEqual(['admin'])
    const grants = harness.service.listGrants()
    expect(grants).toHaveLength(1)
    expect(grants[0]?.userId).toBe('account-1')
    expect(grants[0]?.resourceId).toBe('d-1')
  })

  it('releases routes, the policy, the domain, and account peers when the fiber unloads', async () => {
    const harness = await setup()
    const { account, cookie } = await memberOf(harness, 'root')
    harness.ctx.connectionIdentity?.peerFor({ headers: { host: AUTHORITY, cookie } })
    expect(harness.peers[0]?.disposed).toBe(false)
    await harness.ctx.fiber.dispose()
    expect(harness.peers[0]?.disposed).toBe(true)
    expect(harness.routes.size).toBe(0)
    expect(harness.policies.has('user')).toBe(false)
    expect(harness.domainClosed()).toBe(true)
    expect(account.roles).toEqual(['admin'])
  })

  it('answers no session and refuses audits before the domain opens', async () => {
    const ctx = new Context()
    roots.push(ctx)
    const service = new AccountDirectory(ctx, { sessionDays: 30, allowRegistration: true, minPasswordLength: 8 })
    expect(service.sessionAccount(readRequest('/admin'))).toBeUndefined()
    expect(() => service.sessionCookieFor(brandString<UserId>('user-1'), AUTHORITY, false))
      .toThrow('session secret is not loaded')
    await expect(service.register({ username: 'root', password: PASSWORD }))
      .rejects.toThrow('account domain is not open')
    await expect(service.revokeGrant({
      userId: brandString<UserId>('user-1'), resourceKind: 'doc', resourceId: 'd-1',
    })).rejects.toThrow('account domain is not open')
  })
})

describe('account lifecycle', () => {
  it('makes the first registered account the administrator and later ones plain members', async () => {
    const harness = await setup()
    const root = await harness.service.register({ username: 'root', password: PASSWORD })
    expect(root.roles).toEqual(['admin'])
    expect(root.displayName).toBe('root')
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD, displayName: 'Bob' })
    expect(bob.roles).toEqual([])
    expect(bob.displayName).toBe('Bob')
    expect(harness.service.listAccounts().map(account => account.username)).toEqual(['bob', 'root'])
  })

  it('refuses usernames that are taken or malformed and passwords that are too short', async () => {
    const harness = await setup()
    await harness.service.register({ username: 'root', password: PASSWORD })
    await expect(harness.service.register({ username: 'root', password: PASSWORD }))
      .rejects.toMatchObject({ code: 'duplicate-username' })
    await expect(harness.service.register({ username: 'Has Space', password: PASSWORD }))
      .rejects.toMatchObject({ code: 'invalid-username' })
    await expect(harness.service.register({ username: 'ok-name', password: 'short' }))
      .rejects.toMatchObject({ code: 'password-too-short' })
  })

  it('falls back to the username when the display name is blank', async () => {
    const harness = await setup()
    const account = await harness.service.register({ username: 'bob', password: PASSWORD, displayName: '   ' })
    expect(account.displayName).toBe('bob')
  })

  it('closes self-registration on demand and reports it', async () => {
    const harness = await setup({ allowRegistration: false })
    await harness.service.register({ username: 'root', password: PASSWORD })
    const refusal = harness.service.register({ username: 'bob', password: PASSWORD })
    await expect(refusal).rejects.toBeInstanceOf(AccountDirectoryError)
    await expect(refusal).rejects.toMatchObject({ code: 'registration-closed' })
  })

  it('verifies submitted credentials, ignoring case and padding on the username', async () => {
    const harness = await setup()
    await harness.service.register({ username: 'root', password: PASSWORD })
    expect(await harness.service.authenticate('  ROOT  ', PASSWORD)).toBeDefined()
    expect(await harness.service.authenticate('root', 'wrong-password')).toBeUndefined()
    expect(await harness.service.authenticate('ghost', PASSWORD)).toBeUndefined()
  })

  it('creates administrative accounts from the directory API', async () => {
    const harness = await setup()
    await harness.service.register({ username: 'root', password: PASSWORD })
    const created = await harness.service.createAccount({ username: 'Deputy', password: PASSWORD, admin: true })
    expect(created.username).toBe('deputy')
    expect(created.roles).toEqual(['admin'])
    await expect(harness.service.createAccount({ username: 'deputy', password: PASSWORD, admin: false }))
      .rejects.toMatchObject({ code: 'duplicate-username' })
  })

  it('updates display names, roles, and passwords on the directory API', async () => {
    const harness = await setup()
    const root = await harness.service.register({ username: 'root', password: PASSWORD })
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    // An update without an administrator flag keeps the stored roles.
    const renamed = await harness.service.updateAccount(bob.id, { displayName: ' Bob B. ' })
    expect(renamed.displayName).toBe('Bob B.')
    expect(renamed.roles).toEqual([])
    // A blank or absent display name keeps the stored one.
    expect((await harness.service.updateAccount(bob.id, { displayName: '   ' })).displayName).toBe('Bob B.')
    expect((await harness.service.updateAccount(bob.id, {})).displayName).toBe('Bob B.')
    expect((await harness.service.updateAccount(bob.id, { admin: true })).roles).toEqual(['admin'])
    // With two administrators, one can step down.
    expect((await harness.service.updateAccount(bob.id, { admin: false })).roles).toEqual([])
    // Demoting the last administrator is refused.
    await expect(harness.service.updateAccount(root.id, { admin: false }))
      .rejects.toMatchObject({ code: 'last-admin' })
    // Re-asserting a member's non-administrator role is a harmless no-op.
    expect((await harness.service.updateAccount(bob.id, { admin: false })).roles).toEqual([])
    // Rotating the password retires the old one.
    await harness.service.updateAccount(bob.id, { password: 'rotated-password' })
    expect(await harness.service.authenticate('bob', PASSWORD)).toBeUndefined()
    expect(await harness.service.authenticate('bob', 'rotated-password')).toBeDefined()
    await expect(harness.service.updateAccount(bob.id, { password: 'tiny' }))
      .rejects.toMatchObject({ code: 'password-too-short' })
    await expect(harness.service.updateAccount(brandString<UserId>('ghost'), { displayName: 'x' }))
      .rejects.toMatchObject({ code: 'not-found' })
  })

  it('deletes an account together with its grants and its live peer', async () => {
    const harness = await setup()
    await harness.service.register({ username: 'root', password: PASSWORD })
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    await harness.service.setGrant({ userId: bob.id, resourceKind: 'doc', resourceId: 'd-1', roles: ['owner'] })
    harness.ctx.connectionIdentity?.peerFor({
      headers: { host: AUTHORITY, cookie: cookiePair(harness.service.sessionCookieFor(bob.id, AUTHORITY, false)) },
    })
    await harness.service.deleteAccount(bob.id)
    expect(harness.service.account(bob.id)).toBeUndefined()
    expect(harness.service.listAccounts().map(account => account.username)).toEqual(['root'])
    expect(harness.service.listGrants()).toEqual([])
    expect(harness.tables.users.has(bob.id)).toBe(false)
    expect(harness.tables.grants.size).toBe(0)
    expect(harness.peers[0]?.disposed).toBe(true)
    expect(harness.invalidations).toContainEqual({ kind: 'user', userId: bob.id })
    await expect(harness.service.deleteAccount(bob.id)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('refuses to delete the last administrator and lets a second one go', async () => {
    const harness = await setup()
    const root = await harness.service.register({ username: 'root', password: PASSWORD })
    await expect(harness.service.deleteAccount(root.id)).rejects.toMatchObject({ code: 'last-admin' })
    const deputy = await harness.service.createAccount({ username: 'deputy', password: PASSWORD, admin: true })
    await harness.service.setGrant({ userId: deputy.id, resourceKind: 'doc', resourceId: 'd-1', roles: ['viewer'] })
    await harness.service.deleteAccount(deputy.id)
    expect(harness.service.listGrants()).toEqual([])
    expect(harness.service.account(deputy.id)).toBeUndefined()
    await expect(harness.service.deleteAccount(root.id)).rejects.toMatchObject({ code: 'last-admin' })
  })
})

describe('grants', () => {
  it('stores grants with deduplicated roles and replaces previous roles on the same resource', async () => {
    const harness = await setup()
    const root = await harness.service.register({ username: 'root', password: PASSWORD })
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    const grant = await harness.service.setGrant({
      userId: bob.id, resourceKind: 'doc', resourceId: 'd-1', roles: ['owner', 'viewer', 'owner'],
    })
    expect(grant.roles).toEqual(['owner', 'viewer'])
    expect(harness.tables.grants.get(grantKey(bob.id, 'doc', 'd-1'))).toEqual(grant)
    expect(harness.invalidations).toContainEqual({ kind: 'user', userId: bob.id })
    expect((await harness.service.setGrant({
      userId: bob.id, resourceKind: 'doc', resourceId: 'd-1', roles: ['viewer'],
    })).roles).toEqual(['viewer'])
    // A second grant for the same account lands beside the first.
    await harness.service.setGrant({ userId: bob.id, resourceKind: 'doc', resourceId: 'd-2', roles: ['author'] })
    expect(harness.service.listGrants()).toHaveLength(2)
    // Grants list in account and resource order.
    await harness.service.setGrant({ userId: root.id, resourceKind: 'doc', resourceId: 'a-1', roles: ['viewer'] })
    expect(harness.service.listGrants().filter(item => item.userId === bob.id).map(item => item.resourceId))
      .toEqual(['d-1', 'd-2'])
    expect(harness.service.listGrants().filter(item => item.userId === root.id).map(item => item.resourceId))
      .toEqual(['a-1'])
  })

  it('refuses grants for unknown accounts, unknown roles, and empty resources', async () => {
    const harness = await setup()
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    await expect(harness.service.setGrant({
      userId: brandString<UserId>('ghost'), resourceKind: 'doc', resourceId: 'd-1', roles: ['viewer'],
    })).rejects.toMatchObject({ code: 'not-found' })
    await expect(harness.service.setGrant({
      userId: bob.id, resourceKind: 'doc', resourceId: 'd-1', roles: ['chief'],
    })).rejects.toMatchObject({ code: 'invalid-role' })
    await expect(harness.service.setGrant({
      userId: bob.id, resourceKind: 'doc', resourceId: 'd-1', roles: [],
    })).rejects.toMatchObject({ code: 'invalid-role' })
    await expect(harness.service.setGrant({
      userId: bob.id, resourceKind: '  ', resourceId: 'd-1', roles: ['viewer'],
    })).rejects.toMatchObject({ code: 'not-found' })
    await expect(harness.service.setGrant({
      userId: bob.id, resourceKind: 'doc', resourceId: '  ', roles: ['viewer'],
    })).rejects.toMatchObject({ code: 'not-found' })
    expect(harness.service.listGrants()).toEqual([])
  })

  it('revokes grants and answers revocations of unknown grants quietly', async () => {
    const harness = await setup()
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    await harness.service.setGrant({ userId: bob.id, resourceKind: 'doc', resourceId: 'd-1', roles: ['owner'] })
    await harness.service.setGrant({ userId: bob.id, resourceKind: 'doc', resourceId: 'd-2', roles: ['viewer'] })
    await harness.service.revokeGrant({ userId: bob.id, resourceKind: 'doc', resourceId: 'd-1' })
    expect(harness.service.listGrants().map(item => item.resourceId)).toEqual(['d-2'])
    expect(harness.tables.grants.size).toBe(1)
    // Revoking again, or a grant that never existed, changes nothing and does not throw.
    await harness.service.revokeGrant({ userId: bob.id, resourceKind: 'doc', resourceId: 'd-1' })
    await harness.service.revokeGrant({ userId: bob.id, resourceKind: 'doc', resourceId: 'd-x' })
    expect(harness.service.listGrants()).toHaveLength(1)
    await harness.service.revokeGrant({ userId: bob.id, resourceKind: 'doc', resourceId: 'd-2' })
    expect(harness.service.listGrants()).toEqual([])
    expect(harness.tables.grants.size).toBe(0)
  })
})

describe('resource dictionary', () => {
  it('merges declared kinds, catalog labels, and kinds an existing grant names', async () => {
    const harness = await setup()
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    // A kind with an ACL rule but no catalog: it must still be offered, so the
    // administrator can at least see the kind exists.
    harness.service.acl.register({ kind: 'declared-only' as RemoteAccessResourceKind, bind: () => [] })
    harness.service.catalog.register({
      kind: 'ontology-domain',
      label: '本体域',
      list: async () => [{ id: 'sales', label: '销售域' }, { id: 'ops' }],
    })
    await harness.service.setGrant({ userId: bob.id, resourceKind: 'legacy', resourceId: 'old-1', roles: ['viewer'] })

    const dictionary = await harness.service.resourceDictionary()
    expect(dictionary.kinds.map(entry => entry.kind)).toEqual(['declared-only', 'legacy', 'ontology-domain'])
    expect(dictionary.kinds.find(entry => entry.kind === 'ontology-domain')?.label).toBe('本体域')
    expect(dictionary.kinds.find(entry => entry.kind === 'legacy')?.label).toBe('legacy')
    expect(dictionary.resources['ontology-domain']).toEqual([{ id: 'sales', label: '销售域' }, { id: 'ops' }])
    // A grant whose kind has no provider still contributes its id, so revoking
    // it never requires typing the id back in.
    expect(dictionary.resources.legacy).toEqual([{ id: 'old-1' }])
    expect(dictionary.resources['declared-only']).toBeUndefined()
  })

  it('keeps the kind selectable when its provider fails', async () => {
    const harness = await setup()
    harness.service.catalog.register({
      kind: 'broken',
      list: async () => { throw new Error('store offline') },
    })
    const dictionary = await harness.service.resourceDictionary()
    expect(dictionary.kinds.map(entry => entry.kind)).toEqual(['broken'])
    expect(dictionary.resources.broken).toEqual([])
  })

  it('refuses a second dictionary for the same kind', async () => {
    const harness = await setup()
    harness.service.catalog.register({ kind: 'doc', list: async () => [] })
    expect(() => harness.service.catalog.register({ kind: 'doc', list: async () => [] }))
      .toThrow('already registered')
  })
})

describe('ACL registry', () => {
  const READER: RemoteAccessBinding = {
    role: { name: 'test:reader', resource: 'global', actions: ['doc/read'] },
    resource: { kind: 'global' },
  }

  it('turns stored grants into bindings through the kind rule and skips kinds without one', async () => {
    const harness = await setup()
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    const bind = vi.fn((): readonly RemoteAccessBinding[] => [READER])
    harness.service.acl.register({ kind: 'global', bind })
    await harness.service.setGrant({ userId: bob.id, resourceKind: 'global', resourceId: 'shelf-1', roles: ['viewer'] })
    await harness.service.setGrant({ userId: bob.id, resourceKind: 'doc', resourceId: 'd-1', roles: ['owner'] })
    const bindings = userPolicy(harness).bindings(userPrincipal(bob.id))
    expect(bind).toHaveBeenCalledWith('shelf-1', ['viewer'])
    expect(bindings).toEqual([READER])
  })

  it('removes a rule with its disposer and refuses a duplicate kind', async () => {
    const harness = await setup()
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    const rule: AccountAclRule = { kind: 'global', bind: () => [READER] }
    const dispose = harness.service.acl.register(rule)
    await harness.service.setGrant({ userId: bob.id, resourceKind: 'global', resourceId: 'shelf-1', roles: ['viewer'] })
    const policy = userPolicy(harness)
    expect(policy.bindings(userPrincipal(bob.id))).toEqual([READER])
    expect(() => harness.service.acl.register(rule)).toThrow('already registered')
    dispose()
    expect(policy.bindings(userPrincipal(bob.id))).toEqual([])
  })

  it('contributes baseline bindings to every account and removes them with its disposer', async () => {
    const harness = await setup()
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    const policy = userPolicy(harness)
    expect(policy.bindings(userPrincipal(bob.id))).toEqual([])
    const dispose = harness.service.acl.registerBaseline(() => [READER])
    expect(policy.bindings(userPrincipal(bob.id))).toEqual([READER])
    expect(policy.bindings(userPrincipal(brandString<UserId>('ghost')))).toEqual([])
    dispose()
    expect(policy.bindings(userPrincipal(bob.id))).toEqual([])
  })

  it('answers the user policy for administrators, members, and unknown accounts', async () => {
    const harness = await setup()
    const root = await harness.service.register({ username: 'root', password: PASSWORD })
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    const policy = userPolicy(harness)
    expect(policy.unrestricted?.(userPrincipal(root.id))).toBe(true)
    expect(policy.unrestricted?.(userPrincipal(bob.id))).toBe(false)
    expect(policy.unrestricted?.(userPrincipal(brandString<UserId>('ghost')))).toBe(false)
    expect(policy.explain?.({ principal: userPrincipal(bob.id), action: 'doc/read', resources: [{ kind: 'global' }] }))
      .toBe('doc/read is not granted to this account')
    expect(policy.explain?.({
      principal: userPrincipal(brandString<UserId>('ghost')), action: 'doc/read', resources: [{ kind: 'global' }],
    })).toBeUndefined()
  })
})

describe('sessions', () => {
  it('names the account a valid cookie carries and refuses absent, malformed, and foreign ones', async () => {
    const harness = await setup()
    const { cookie } = await memberOf(harness, 'root')
    expect(harness.service.sessionAccount({ headers: { host: AUTHORITY, cookie } })?.username).toBe('root')
    expect(harness.service.sessionAccount({ headers: { host: AUTHORITY } })).toBeUndefined()
    expect(harness.service.sessionAccount({
      headers: { host: AUTHORITY, cookie: `${sessionCookieName(AUTHORITY)}=broken` },
    })).toBeUndefined()
    expect(harness.service.sessionAccount({ headers: { host: 'localhost:4000', cookie } })).toBeUndefined()
    expect(harness.service.sessionAccount({ headers: {} })).toBeUndefined()
  })

  it('stops recognizing a cookie once its account is gone', async () => {
    const harness = await setup()
    await harness.service.register({ username: 'root', password: PASSWORD })
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    const cookie = cookiePair(harness.service.sessionCookieFor(bob.id, AUTHORITY, false))
    expect(harness.service.sessionAccount({ headers: { host: AUTHORITY, cookie } })?.username).toBe('bob')
    await harness.service.deleteAccount(bob.id)
    expect(harness.service.sessionAccount({ headers: { host: AUTHORITY, cookie } })).toBeUndefined()
  })

  it('admits one peer per account, reuses it, and refuses cookie-less requests', async () => {
    const harness = await setup()
    const { account, cookie } = await memberOf(harness, 'root')
    const identity = harness.ctx.connectionIdentity
    if (identity === undefined) throw new Error('connectionIdentity was not provided')
    const first = identity.peerFor({ headers: { host: AUTHORITY, cookie } })
    expect(first).toBeDefined()
    expect(identity.peerFor({ headers: { host: AUTHORITY, cookie } })).toBe(first)
    expect(harness.peers).toHaveLength(1)
    expect(harness.peers[0]?.principal).toEqual({ kind: 'user', userId: account.id })
    expect(identity.peerFor({ headers: { host: AUTHORITY } })).toBeUndefined()
    expect(identity.peerFor({
      headers: { host: AUTHORITY, cookie: `${sessionCookieName(AUTHORITY)}=broken` },
    })).toBeUndefined()
  })

  it('builds session and clearing cookies for the configured audience', async () => {
    const harness = await setup()
    const { account } = await memberOf(harness, 'root')
    const minted = harness.service.sessionCookieFor(account.id, AUTHORITY, false)
    expect(minted.startsWith(`${sessionCookieName(AUTHORITY)}=`)).toBe(true)
    expect(minted).toContain('HttpOnly')
    expect(minted).toContain('Max-Age=2592000')
    expect(minted).not.toContain('Secure')
    expect(harness.service.clearedSessionCookie(AUTHORITY, false)).toContain('Max-Age=0')
    expect(harness.service.authority({ headers: { host: AUTHORITY } }, false)).toBe(AUTHORITY)
    expect(harness.service.authority({ headers: {} }, false)).toBeUndefined()
    // Serving HTTPS turns the secure flag on.
    harness.webServer.protocol = 'https:'
    expect(harness.service.secure).toBe(true)
    expect(harness.service.sessionCookieFor(account.id, AUTHORITY, true)).toContain('Secure')
    expect(harness.service.authority({ headers: { host: AUTHORITY } }, true)).toBe(`https://${AUTHORITY}`)
    harness.webServer.protocol = 'http:'
    expect(harness.service.secure).toBe(false)
  })
})

describe('the login page', () => {
  it('renders the login form with a submitted message and the registration pane', async () => {
    const harness = await setup()
    const page = await callRoute(harness, '/login', readRequest('/login?message=try-again'))
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(page.body).toContain('action="/auth/login"')
    expect(page.body).toContain('try-again')
    expect(page.body).toContain('pane-register')
  })

  it('renders the root page when the request carries no URL', async () => {
    const harness = await setup()
    const page = await callRoute(harness, '/login', bareRequest({ host: AUTHORITY }))
    expect(page.status).toBe(200)
    expect(page.body).not.toContain('role="alert"')
  })

  it('prefills development credentials when configured', async () => {
    const harness = await setup({ devHint: { username: 'root', password: 'dev-pass' } })
    const page = await callRoute(harness, '/login', readRequest('/login'))
    expect(page.body).toContain('value="root"')
    expect(page.body).toContain('开发测试账号')
  })

  it('hides the registration pane once self-registration is closed', async () => {
    const harness = await setup({ allowRegistration: false })
    await harness.service.register({ username: 'root', password: PASSWORD })
    const page = await callRoute(harness, '/login', readRequest('/login'))
    expect(page.body).not.toContain('id="pane-register"')
    expect(page.body).not.toContain('action="/auth/register"')
  })

  it('answers HEAD like a GET and refuses POST submissions', async () => {
    const harness = await setup()
    expect((await callRoute(harness, '/login', readRequest('/login', { method: 'HEAD' }))).status).toBe(200)
    expect((await callRoute(harness, '/login', readRequest('/login', { method: 'POST' }))).status).toBe(405)
  })
})

describe('the administration page', () => {
  it('redirects anonymous visitors and turns members away', async () => {
    const harness = await setup()
    const anonymous = await callRoute(harness, '/admin', readRequest('/admin'))
    expect(anonymous.status).toBe(303)
    expect(anonymous.headers.location).toBe('/login')
    await harness.service.register({ username: 'root', password: PASSWORD })
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    const member = await callRoute(harness, '/admin', readRequest('/admin', {
      headers: signedInRead(cookiePair(harness.service.sessionCookieFor(bob.id, AUTHORITY, false))),
    }))
    expect(member.status).toBe(403)
    expect(member.body).toContain('该账号不是管理员')
  })

  it('renders the console for a signed-in administrator', async () => {
    const harness = await setup()
    const { cookie } = await memberOf(harness, 'root')
    await harness.service.register({ username: 'bob', password: PASSWORD })
    const page = await callRoute(harness, '/admin', readRequest('/admin?message=saved', { headers: signedInRead(cookie) }))
    expect(page.status).toBe(200)
    expect(page.body).toContain('账号管理')
    expect(page.body).toContain('saved')
    expect(page.body).toContain('bob')
    const plain = await callRoute(harness, '/admin', bareRequest({ host: AUTHORITY, cookie }))
    expect(plain.status).toBe(200)
    expect(plain.body).not.toContain('class="msg"')
  })

  it('refuses POST submissions with 405', async () => {
    const harness = await setup()
    const { cookie } = await memberOf(harness, 'root')
    const reply = await callRoute(harness, '/admin', readRequest('/admin', { method: 'POST', headers: signedInRead(cookie) }))
    expect(reply.status).toBe(405)
  })

  it('offers the resource dictionary as pickers, keeping a typed fallback', async () => {
    const harness = await setup()
    const { cookie } = await memberOf(harness, 'root')
    harness.service.catalog.register({
      kind: 'ontology-domain',
      label: '本体域',
      list: async () => [{ id: 'sales', label: '销售域' }, { id: 'ops' }],
    })
    // A kind registered without a provider has no entries; its id must still be
    // typeable, which is what the text field beside the list is for.
    harness.service.acl.register({ kind: 'workspace', bind: () => [] })

    const page = await callRoute(harness, '/admin', readRequest('/admin', { headers: signedInRead(cookie) }))
    expect(page.status).toBe(200)
    // The kind is a select; the ids are a checkbox list, because one submission
    // may grant the same roles on several resources at once.
    expect(page.body).toContain('data-pick="kind"')
    expect(page.body).toContain('data-pick-list="id"')
    expect(page.body).toContain('name="resourceId" value="sales"')
    expect(page.body).toContain('name="resourceId" value="ops"')
    expect(page.body).toContain('name="resourceIdText"')
    expect(page.body).toContain('可多选')
    expect(page.body).not.toContain('<datalist')
    expect(page.body).not.toContain('list="grant-kinds"')
    // Kinds carry their label and how many resources they can offer.
    expect(page.body).toContain('<option value="ontology-domain">本体域（2）</option>')
    expect(page.body).toContain('<option value="workspace">workspace（0）</option>')
    // The dictionary reaches the script that repopulates ids when the kind changes.
    expect(page.body).toContain('var RESOURCE_INDEX =')
    expect(page.body).toContain('"ontology-domain":[{"id":"sales","label":"销售域"},{"id":"ops"}]')
    // Every form using it is wired, including the one the dialog clones in.
    expect(page.body).toContain('data-grant-form')
    expect(page.body).toContain('wireGrantForm(overlay)')
  })

  it('wires the create-account button inside the page script, not beside it', async () => {
    const harness = await setup()
    const { cookie } = await memberOf(harness, 'root')
    const page = await callRoute(harness, '/admin', readRequest('/admin', { headers: signedInRead(cookie) }))
    // `showDialog` lives in the page script's closure. A handler registered from
    // a second inline script cannot see it, so the click threw and the button
    // looked dead; both the template and its handler must be inside one script.
    expect(page.body).toContain('var DIALOG_CREATE=')
    expect(page.body).toContain("if(createButton) createButton.addEventListener('click', function(){ showDialog(DIALOG_CREATE); });")
    expect(page.body).not.toContain("document.querySelector('[data-open-create]').addEventListener")
    expect(page.body.match(/<script>/gu)?.length).toBe(2)
  })

  it('grants every checked resource id in one submission', async () => {
    const harness = await setup()
    const { cookie } = await memberOf(harness, 'root')
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    const reply = await callRoute(harness, '/admin/grant/set', formPost('/admin/grant/set', {
      userId: bob.id,
      resourceKind: 'ontology-domain',
      // A checkbox list repeats the field; a duplicate id is granted once.
      resourceId: ['sales', 'ops', 'sales'],
      resourceIdText: 'archived，  ops、future',
      roles: ['viewer'],
    }, { host: AUTHORITY, origin: `http://${AUTHORITY}`, cookie }))
    expect(reply.status).toBe(303)
    expect(harness.service.listGrants()
      .filter(grant => grant.userId === bob.id)
      .map(grant => grant.resourceId).sort()).toEqual(['archived', 'future', 'ops', 'sales'])
  })

  it('refuses a grant submission that names no resource id', async () => {
    const harness = await setup()
    const { cookie } = await memberOf(harness, 'root')
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    const reply = await callRoute(harness, '/admin/grant/set', formPost('/admin/grant/set', {
      userId: bob.id,
      resourceKind: 'ontology-domain',
      resourceIdText: ' , ， ',
      roles: ['viewer'],
    }, { host: AUTHORITY, origin: `http://${AUTHORITY}`, cookie }))
    expect(reply.status).toBe(400)
    expect(reply.body).toContain('至少要选择一个资源 ID')
    expect(harness.service.listGrants()).toEqual([])
  })
})

describe('authentication routes', () => {
  it('signs a valid account in and redirects home with the session cookie', async () => {
    const harness = await setup()
    await harness.service.register({ username: 'root', password: PASSWORD })
    const reply = await callRoute(harness, '/auth/login', formPost('/auth/login', { username: 'root', password: PASSWORD }))
    expect(reply.status).toBe(303)
    expect(reply.headers.location).toBe('/')
    const setCookie = reply.headers['set-cookie'] as string[] | undefined
    expect(setCookie?.[0]?.startsWith(sessionCookieName(AUTHORITY))).toBe(true)
  })

  it('refuses wrong and missing credentials with the login page', async () => {
    const harness = await setup()
    await harness.service.register({ username: 'root', password: PASSWORD })
    const wrong = await callRoute(harness, '/auth/login', formPost('/auth/login', { username: 'root', password: 'nope' }))
    expect(wrong.status).toBe(400)
    expect(wrong.body).toContain('用户名或密码错误')
    const empty = await callRoute(harness, '/auth/login', formPost('/auth/login', {}))
    expect(empty.status).toBe(400)
    expect(empty.body).toContain('用户名或密码错误')
  })

  it('refuses a foreign origin with 403', async () => {
    const harness = await setup()
    await harness.service.register({ username: 'root', password: PASSWORD })
    const reply = await callRoute(harness, '/auth/login', formPost('/auth/login', {
      username: 'root', password: PASSWORD,
    }, { origin: 'http://evil.example' }))
    expect(reply.status).toBe(403)
    expect(reply.body).toContain('跨站请求被拒绝')
  })

  it('reports an address it cannot resolve instead of minting a cookie', async () => {
    const harness = await setup()
    await harness.service.register({ username: 'root', password: PASSWORD })
    const reply = await callRoute(harness, '/auth/login', formPost('/auth/login', {
      username: 'root', password: PASSWORD,
    }, {}))
    expect(reply.status).toBe(400)
    expect(reply.body).toContain('无法解析请求地址')
    expect(reply.headers['set-cookie']).toBeUndefined()
  })

  it('refuses read methods on the login submission with 405', async () => {
    const harness = await setup()
    const reply = await callRoute(harness, '/auth/login', readRequest('/auth/login'))
    expect(reply.status).toBe(405)
  })

  it('registers a new account and signs it in', async () => {
    const harness = await setup()
    const reply = await callRoute(harness, '/auth/register', formPost('/auth/register', {
      username: 'alice', password: PASSWORD, displayName: 'Alice',
    }))
    expect(reply.status).toBe(303)
    expect(reply.headers.location).toBe('/')
    expect(reply.headers['set-cookie']).toBeDefined()
    const accounts = harness.service.listAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.username).toBe('alice')
    expect(accounts[0]?.displayName).toBe('Alice')
    expect(accounts[0]?.roles).toEqual(['admin'])
  })

  it('reports registration refusals on the login page', async () => {
    const harness = await setup()
    await harness.service.register({ username: 'root', password: PASSWORD })
    const blankName = await callRoute(harness, '/auth/register', formPost('/auth/register', {
      username: 'bob', password: PASSWORD, displayName: '  ',
    }))
    expect(blankName.status).toBe(303)
    expect(harness.service.listAccounts().find(account => account.username === 'bob')?.displayName).toBe('bob')
    const duplicate = await callRoute(harness, '/auth/register', formPost('/auth/register', {
      username: 'root', password: PASSWORD,
    }))
    expect(duplicate.status).toBe(400)
    expect(duplicate.body).toContain('is taken')
    const malformed = await callRoute(harness, '/auth/register', formPost('/auth/register', {
      username: 'Has Space', password: PASSWORD,
    }))
    expect(malformed.status).toBe(400)
    expect(malformed.body).toContain('username must be')
    const shortPassword = await callRoute(harness, '/auth/register', formPost('/auth/register', {
      username: 'carol', password: '123',
    }))
    expect(shortPassword.status).toBe(400)
    expect(shortPassword.body).toContain('password must be at least 8 characters')
    const empty = await callRoute(harness, '/auth/register', formPost('/auth/register', {}))
    expect(empty.status).toBe(400)
    expect(empty.body).toContain('username must be')
  })

  it('reports an unknown public failure instead of a thrown non-Error', async () => {
    const harness = await setup()
    const reply = await callRoute(harness, '/auth/login', throwingPost('/auth/login', 'boom'))
    expect(reply.status).toBe(400)
    expect(reply.body).toContain('操作失败')
  })

  it('closes self-registration on the route as well', async () => {
    const harness = await setup({ allowRegistration: false })
    await harness.service.register({ username: 'root', password: PASSWORD })
    const reply = await callRoute(harness, '/auth/register', formPost('/auth/register', {
      username: 'bob', password: PASSWORD,
    }))
    expect(reply.status).toBe(400)
    expect(reply.body).toContain('self-registration is closed')
  })

  it('reports an unresolvable address after a successful registration', async () => {
    const harness = await setup()
    const reply = await callRoute(harness, '/auth/register', formPost('/auth/register', {
      username: 'alice', password: PASSWORD,
    }, {}))
    expect(reply.status).toBe(400)
    expect(reply.body).toContain('无法解析请求地址')
  })

  it('refuses read methods on the registration submission with 405', async () => {
    const harness = await setup()
    const reply = await callRoute(harness, '/auth/register', readRequest('/auth/register'))
    expect(reply.status).toBe(405)
  })

  it('clears the session cookie on logout and redirects to the login page', async () => {
    const harness = await setup()
    const reply = await callRoute(harness, '/auth/logout', formPost('/auth/logout', {}))
    expect(reply.status).toBe(303)
    expect(reply.headers.location).toBe('/login')
    const setCookie = reply.headers['set-cookie'] as string[] | undefined
    expect(setCookie?.[0]).toContain('Max-Age=0')
  })

  it('logs a host-less request out without touching cookies', async () => {
    const harness = await setup()
    const reply = await callRoute(harness, '/auth/logout', formPost('/auth/logout', {}, {}))
    expect(reply.status).toBe(303)
    expect(reply.headers.location).toBe('/login')
    expect(reply.headers['set-cookie']).toBeUndefined()
  })

  it('refuses read methods on the logout submission with 405', async () => {
    const harness = await setup()
    const reply = await callRoute(harness, '/auth/logout', readRequest('/auth/logout'))
    expect(reply.status).toBe(405)
  })
})

describe('session state routes', () => {
  it('answers the signed-out state for anonymous visitors', async () => {
    const harness = await setup()
    const reply = await callRoute(harness, '/auth/state', readRequest('/auth/state'))
    expect(reply.status).toBe(200)
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(reply.body).toBe('{"signedIn":false}')
  })

  it('answers the signed-in state with the account and its own grants', async () => {
    const harness = await setup()
    const { account, cookie } = await memberOf(harness, 'root')
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    await harness.service.setGrant({ userId: account.id, resourceKind: 'doc', resourceId: 'd-1', roles: ['owner'] })
    await harness.service.setGrant({ userId: bob.id, resourceKind: 'doc', resourceId: 'd-2', roles: ['viewer'] })
    const reply = await callRoute(harness, '/auth/state', readRequest('/auth/state', { headers: signedInRead(cookie) }))
    expect(reply.status).toBe(200)
    expect(reply.body).toContain('"signedIn":true')
    expect(reply.body).toContain('"resourceId":"d-1"')
    expect(reply.body).not.toContain('"resourceId":"d-2"')
  })

  it('refuses POST submissions on the state route with 405', async () => {
    const harness = await setup()
    const reply = await callRoute(harness, '/auth/state', readRequest('/auth/state', { method: 'POST' }))
    expect(reply.status).toBe(405)
  })
})

describe('the administrative state route', () => {
  it('requires a signed-in administrator for the workbench state', async () => {
    const harness = await setup()
    const anonymous = await callRoute(harness, '/admin/state', readRequest('/admin/state'))
    expect(anonymous.status).toBe(401)
    expect(anonymous.body).toBe('{"error":"sign-in required"}')
    const { cookie } = await memberOf(harness, 'root')
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    const member = await callRoute(harness, '/admin/state', readRequest('/admin/state', {
      headers: signedInRead(cookiePair(harness.service.sessionCookieFor(bob.id, AUTHORITY, false))),
    }))
    expect(member.status).toBe(403)
    expect(member.body).toBe('{"error":"该接口仅管理员可用"}')
    const admin = await callRoute(harness, '/admin/state', readRequest('/admin/state', { headers: signedInRead(cookie) }))
    expect(admin.status).toBe(200)
    expect(admin.body).toContain('"accounts":[')
    expect(admin.body).toContain('"grants":[')
    // The grant form picks resource kinds and ids from this dictionary, so the
    // state response has to carry it or the form falls back to typed ids.
    expect(admin.body).toContain('"resources":{"kinds":[')
    expect(admin.body).toContain('"username":"root"')
  })

  it('refuses POST submissions with 405', async () => {
    const harness = await setup()
    const reply = await callRoute(harness, '/admin/state', readRequest('/admin/state', { method: 'POST' }))
    expect(reply.status).toBe(405)
  })
})

describe('administrative routes', () => {
  /** A console with one administrator (`root`) and one member (`bob`). */
  async function consoleHarness(options?: Parameters<typeof setup>[0]): Promise<{
    harness: Harness
    adminId: UserId
    adminCookie: string
    bobId: UserId
    bobCookie: string
  }> {
    const harness = await setup(options)
    const admin = await harness.service.register({ username: 'root', password: PASSWORD })
    const bob = await harness.service.register({ username: 'bob', password: PASSWORD })
    return {
      harness,
      adminId: admin.id,
      adminCookie: cookiePair(harness.service.sessionCookieFor(admin.id, AUTHORITY, false)),
      bobId: bob.id,
      bobCookie: cookiePair(harness.service.sessionCookieFor(bob.id, AUTHORITY, false)),
    }
  }

  it('gates administrative submissions', async () => {
    const { harness, adminCookie, bobCookie } = await consoleHarness()
    const signedOut = await callRoute(harness, '/admin/user/create', formPost('/admin/user/create', {
      username: 'carol', password: PASSWORD,
    }))
    expect(signedOut.status).toBe(303)
    expect(signedOut.headers.location).toBe('/login')
    const member = await callRoute(harness, '/admin/user/create', formPost('/admin/user/create', {
      username: 'carol', password: PASSWORD,
    }, signedIn(bobCookie)))
    expect(member.status).toBe(403)
    expect(member.body).toContain('该账号不是管理员')
    const foreign = await callRoute(harness, '/admin/user/create', formPost('/admin/user/create', {
      username: 'carol', password: PASSWORD,
    }, signedIn(adminCookie, { origin: 'http://evil.example' })))
    expect(foreign.status).toBe(403)
    expect(foreign.body).toContain('跨站请求被拒绝')
  })

  it('creates accounts from the console form', async () => {
    const { harness, adminCookie } = await consoleHarness()
    const reply = await callRoute(harness, '/admin/user/create', formPost('/admin/user/create', {
      username: 'carol', password: PASSWORD, displayName: 'Carol', admin: '1',
    }, signedIn(adminCookie)))
    expect(reply.status).toBe(303)
    expect(reply.headers.location).toBe('/admin')
    const carol = harness.service.listAccounts().find(account => account.username === 'carol')
    expect(carol?.roles).toEqual(['admin'])
    expect(carol?.displayName).toBe('Carol')
    // A form without the administrator flag or a display name creates a plain member.
    await callRoute(harness, '/admin/user/create', formPost('/admin/user/create', {
      username: 'dave', password: PASSWORD,
    }, signedIn(adminCookie)))
    const dave = harness.service.listAccounts().find(account => account.username === 'dave')
    expect(dave?.roles).toEqual([])
    expect(dave?.displayName).toBe('dave')
  })

  it('reports account-creation refusals on the console page', async () => {
    const { harness, adminCookie } = await consoleHarness()
    const duplicate = await callRoute(harness, '/admin/user/create', formPost('/admin/user/create', {
      username: 'root', password: PASSWORD,
    }, signedIn(adminCookie)))
    expect(duplicate.status).toBe(400)
    expect(duplicate.body).toContain('is taken')
    const missing = await callRoute(harness, '/admin/user/create', formPost('/admin/user/create', {
      password: PASSWORD,
    }, signedIn(adminCookie)))
    expect(missing.status).toBe(400)
    expect(missing.body).toContain('username must be')
    const noPassword = await callRoute(harness, '/admin/user/create', formPost('/admin/user/create', {
      username: 'carol',
    }, signedIn(adminCookie)))
    expect(noPassword.status).toBe(400)
    expect(noPassword.body).toContain('password must be at least')
  })

  it('reports an unknown administrative failure instead of a thrown non-Error', async () => {
    const { harness, adminCookie } = await consoleHarness()
    const reply = await callRoute(harness, '/admin/grant/set', throwingPost('/admin/grant/set', 'boom', {
      cookie: adminCookie,
    }))
    expect(reply.status).toBe(400)
    expect(reply.body).toContain('账号操作失败')
    expect(harness.service.listGrants()).toEqual([])
  })

  it('updates display names, roles, and passwords from the console form', async () => {
    const { harness, adminCookie, bobId } = await consoleHarness()
    const reply = await callRoute(harness, '/admin/user/update', formPost('/admin/user/update', {
      userId: bobId, displayName: 'Bobby', admin: '1',
    }, signedIn(adminCookie)))
    expect(reply.status).toBe(303)
    expect(reply.headers.location).toBe('/admin')
    const bob = harness.service.account(bobId)
    expect(bob?.displayName).toBe('Bobby')
    expect(bob?.roles).toEqual(['admin'])
    // Rotating the password retires the old one.
    await callRoute(harness, '/admin/user/update', formPost('/admin/user/update', {
      userId: bobId, password: 'rotated-password',
    }, signedIn(adminCookie)))
    expect(await harness.service.authenticate('bob', PASSWORD)).toBeUndefined()
    expect(await harness.service.authenticate('bob', 'rotated-password')).toBeDefined()
  })

  it('keeps the display name and password when the form omits them', async () => {
    const { harness, adminCookie, bobId } = await consoleHarness()
    const reply = await callRoute(harness, '/admin/user/update', formPost('/admin/user/update', {
      userId: bobId, password: '',
    }, signedIn(adminCookie)))
    expect(reply.status).toBe(303)
    expect(harness.service.account(bobId)?.displayName).toBe('bob')
    expect(await harness.service.authenticate('bob', PASSWORD)).toBeDefined()
  })

  it('reports update refusals on the console page', async () => {
    const { harness, adminCookie, adminId } = await consoleHarness()
    const missingUser = await callRoute(harness, '/admin/user/update', formPost('/admin/user/update', {
      displayName: 'x',
    }, signedIn(adminCookie)))
    expect(missingUser.status).toBe(400)
    expect(missingUser.body).toContain('does not exist')
    const lastAdmin = await callRoute(harness, '/admin/user/update', formPost('/admin/user/update', {
      userId: adminId,
    }, signedIn(adminCookie)))
    expect(lastAdmin.status).toBe(400)
    expect(lastAdmin.body).toContain('the last administrator cannot lose that role')
  })

  it('deletes accounts and refuses the last administrator', async () => {
    const { harness, adminCookie, adminId, bobId } = await consoleHarness()
    const reply = await callRoute(harness, '/admin/user/delete', formPost('/admin/user/delete', {
      userId: bobId,
    }, signedIn(adminCookie)))
    expect(reply.status).toBe(303)
    expect(reply.headers.location).toBe('/admin')
    expect(harness.service.account(bobId)).toBeUndefined()
    const refused = await callRoute(harness, '/admin/user/delete', formPost('/admin/user/delete', {
      userId: adminId,
    }, signedIn(adminCookie)))
    expect(refused.status).toBe(400)
    expect(refused.body).toContain('the last administrator cannot be deleted')
    const missing = await callRoute(harness, '/admin/user/delete', formPost('/admin/user/delete', {}, signedIn(adminCookie)))
    expect(missing.status).toBe(400)
    expect(missing.body).toContain('does not exist')
  })

  it('sets grants from the console form', async () => {
    const { harness, adminCookie, bobId } = await consoleHarness()
    const reply = await callRoute(harness, '/admin/grant/set', formPost('/admin/grant/set', {
      userId: bobId, resourceKind: 'doc', resourceId: 'd-1', roles: ['owner', 'viewer', 'owner'],
    }, signedIn(adminCookie)))
    expect(reply.status).toBe(303)
    expect(reply.headers.location).toBe('/admin')
    expect(harness.service.listGrants()[0]?.roles).toEqual(['owner', 'viewer'])
  })

  it('reports grant refusals on the console page', async () => {
    const { harness, adminCookie, bobId } = await consoleHarness()
    const refusals: readonly (readonly [Record<string, string | string[]>, string])[] = [
      [{ userId: brandString<UserId>('ghost'), resourceKind: 'doc', resourceId: 'd-1', roles: 'viewer' }, 'does not exist'],
      [{ userId: bobId, resourceKind: 'doc', resourceId: 'd-1', roles: 'chief' }, 'unknown role'],
      [{ userId: bobId, resourceKind: 'doc', resourceId: 'd-1' }, 'a grant needs at least one role'],
      [{ userId: bobId, resourceId: 'd-1', roles: 'viewer' }, 'a grant needs a resource kind and id'],
      [{ userId: bobId, resourceKind: 'doc', roles: 'viewer' }, '至少要选择一个资源 ID'],
      [{ resourceKind: 'doc', resourceId: 'd-1', roles: 'viewer' }, 'does not exist'],
    ]
    for (const [fields, fragment] of refusals) {
      const reply = await callRoute(harness, '/admin/grant/set', formPost('/admin/grant/set', fields, signedIn(adminCookie)))
      expect(reply.status).toBe(400)
      expect(reply.body).toContain(fragment)
    }
    expect(harness.service.listGrants()).toEqual([])
  })

  it('revokes grants and answers a fieldless revocation with an empty redirect', async () => {
    const { harness, adminCookie, bobId } = await consoleHarness()
    await harness.service.setGrant({ userId: bobId, resourceKind: 'doc', resourceId: 'd-1', roles: ['owner'] })
    const reply = await callRoute(harness, '/admin/grant/delete', formPost('/admin/grant/delete', {
      userId: bobId, resourceKind: 'doc', resourceId: 'd-1',
    }, signedIn(adminCookie)))
    expect(reply.status).toBe(303)
    expect(harness.service.listGrants()).toEqual([])
    const empty = await callRoute(harness, '/admin/grant/delete', formPost('/admin/grant/delete', {}, signedIn(adminCookie)))
    expect(empty.status).toBe(303)
  })

  it('refuses read methods on every console submission with 405', async () => {
    const { harness, adminCookie } = await consoleHarness()
    for (const path of ['/admin/user/create', '/admin/user/update', '/admin/user/delete', '/admin/grant/set', '/admin/grant/delete']) {
      const reply = await callRoute(harness, path, readRequest(path, { headers: signedInRead(adminCookie) }))
      expect(reply.status).toBe(405)
    }
  })
})
