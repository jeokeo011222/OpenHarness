/** Behavior of the local account-directory probes and form submissions. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAdminState, fetchLocalAccount, fetchLocalAdmin, isAdminState, submitAdminForm,
} from '../src/client/local-admin.ts'

const respond = (body: unknown, ok = true): Response =>
  new Response(body === undefined ? '' : JSON.stringify(body), { status: ok ? 200 : 500 })

const adminState = {
  account: { username: 'admin', displayName: 'Admin', roles: ['admin'] },
  accounts: [{ id: 'u1', username: 'admin', displayName: 'Admin', roles: ['admin'] }],
  grants: [{ userId: 'u1', resourceKind: 'workspace', resourceId: 'w1', roles: ['owner'] }],
}

afterEach(() => { vi.unstubAllGlobals() })

describe('fetchLocalAccount', () => {
  it('returns the signed-in account', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({
      signedIn: true, account: { username: 'ada', displayName: 'Ada', roles: [] },
    })))
    expect(await fetchLocalAccount()).toEqual({
      signedIn: true, account: { username: 'ada', displayName: 'Ada', roles: [] },
    })
  })

  it('returns a signed-out probe without an account', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ signedIn: false })))
    expect(await fetchLocalAccount()).toEqual({ signedIn: false })
  })

  it('reads no session from a failed response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(undefined, false)))
    expect(await fetchLocalAccount()).toBeUndefined()
  })

  it('reads no session when the endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('unreachable') }))
    expect(await fetchLocalAccount()).toBeUndefined()
  })

  it('reads no session from a malformed body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ signedIn: 'yes' })))
    expect(await fetchLocalAccount()).toBeUndefined()
  })

  it('reads no session when the account record is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ signedIn: true, account: { username: 7 } })))
    expect(await fetchLocalAccount()).toBeUndefined()
  })
})

describe('isAdminState', () => {
  it('accepts a signed-in account holding the admin role', () => {
    expect(isAdminState({ signedIn: true, account: { username: 'a', displayName: 'A', roles: ['admin'] } })).toBe(true)
  })

  it('rejects signed-out probes, non-admin roles, and missing accounts', () => {
    expect(isAdminState({ signedIn: false })).toBe(false)
    expect(isAdminState({ signedIn: true })).toBe(false)
    expect(isAdminState({ signedIn: true, account: { username: 'a', displayName: 'A', roles: ['viewer'] } })).toBe(false)
  })
})

describe('fetchLocalAdmin', () => {
  it('reports true only for a signed-in admin session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({
      signedIn: true, account: { username: 'admin', displayName: 'A', roles: ['admin'] },
    })))
    expect(await fetchLocalAdmin()).toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => respond({ signedIn: false })))
    expect(await fetchLocalAdmin()).toBe(false)
  })
})

describe('fetchAdminState', () => {
  it('returns the parsed workbench state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(adminState)))
    expect(await fetchAdminState()).toEqual(adminState)
  })

  it('reads nothing from a failed response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(undefined, false)))
    expect(await fetchAdminState()).toBeUndefined()
  })

  it('reads nothing when the endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('unreachable') }))
    expect(await fetchAdminState()).toBeUndefined()
  })

  it('reads nothing from a malformed body', async () => {
    for (const body of [
      null,
      { account: { username: 'a', displayName: 'A', roles: [] } },
      { ...adminState, account: null },
      { ...adminState, accounts: 'nope' },
      { ...adminState, accounts: [{ id: 1, username: 'a', displayName: 'A', roles: [] }] },
      { ...adminState, grants: [null] },
      { ...adminState, grants: [{ userId: 'u1' }] },
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => respond(body)))
      expect(await fetchAdminState()).toBeUndefined()
    }
  })
})

describe('submitAdminForm', () => {
  it('posts urlencoded fields and reports acceptance', async () => {
    const fetchMock = vi.fn(async () => respond(undefined))
    vi.stubGlobal('fetch', fetchMock)
    expect(await submitAdminForm('admin/user/create', { username: 'ada', roles: ['admin', 'viewer'] })).toBe(true)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('admin/user/create', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=ada&roles=admin&roles=viewer',
    })
  })

  it('reports refusal and transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(undefined, false)))
    expect(await submitAdminForm('admin/user/delete', { userId: 'u1' })).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('unreachable') }))
    expect(await submitAdminForm('admin/user/delete', { userId: 'u1' })).toBe(false)
  })
})
