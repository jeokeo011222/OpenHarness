/** Behavior of the local account-directory admin probe. */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetchLocalAdmin } from '../src/client/local-admin.ts'

const stateResponse = (body: unknown, ok = true): Response =>
  new Response(body === undefined ? '' : JSON.stringify(body), { status: ok ? 200 : 500 })

afterEach(() => { vi.unstubAllGlobals() })

describe('fetchLocalAdmin', () => {
  it('reports true for a signed-in admin account', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stateResponse({
      signedIn: true, account: { username: 'admin', roles: ['admin'] },
    })))
    expect(await fetchLocalAdmin()).toBe(true)
  })

  it('reports false for a signed-in non-admin account', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stateResponse({
      signedIn: true, account: { username: 'viewer', roles: [] },
    })))
    expect(await fetchLocalAdmin()).toBe(false)
  })

  it('reports false when no local session exists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stateResponse({ signedIn: false })))
    expect(await fetchLocalAdmin()).toBe(false)
  })

  it('reports false on a failed response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stateResponse(undefined, false)))
    expect(await fetchLocalAdmin()).toBe(false)
  })

  it('reports false when the endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('unreachable') }))
    expect(await fetchLocalAdmin()).toBe(false)
  })

  it('reports false on a malformed response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stateResponse({ account: 'nope' })))
    expect(await fetchLocalAdmin()).toBe(false)
  })
})
