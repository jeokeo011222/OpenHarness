import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { UserId } from '../src/types.ts'
import {
  decodeSessionToken,
  encodeSessionToken,
  loadSessionSecret,
  requestAuthority,
  sessionCookie,
  sessionCookieName,
  submittedCookie,
} from '../src/session.ts'

const SECRET = Buffer.alloc(32, 7)
const AUTHORITY = '127.0.0.1:3080'
const userId = brandString<UserId>('account-1')

function minted(expiresAt: number, authority = AUTHORITY): string {
  return encodeSessionToken(userId, authority, expiresAt, SECRET)
}

describe('session tokens', () => {
  it('round-trips a token bound to its authority', () => {
    const expiresAt = Date.now() + 60_000
    const token = minted(expiresAt)
    expect(decodeSessionToken(token, AUTHORITY, SECRET, Date.now())).toEqual({
      userId,
      authority: AUTHORITY,
      expiresAt,
    })
  })

  it('refuses a token minted for another authority, secret, or instant', () => {
    const token = minted(Date.now() + 60_000)
    expect(decodeSessionToken(token, 'localhost:3080', SECRET, Date.now())).toBeUndefined()
    expect(decodeSessionToken(token, AUTHORITY, Buffer.alloc(32, 9), Date.now())).toBeUndefined()
    expect(decodeSessionToken(token, AUTHORITY, SECRET, Date.now() + 120_000)).toBeUndefined()
  })

  it('refuses malformed and tampered tokens', () => {
    const token = minted(Date.now() + 60_000)
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`
    expect(decodeSessionToken(tampered, AUTHORITY, SECRET, Date.now())).toBeUndefined()
    expect(decodeSessionToken('v1.only', AUTHORITY, SECRET, Date.now())).toBeUndefined()
    expect(decodeSessionToken('v2.a.b.c', AUTHORITY, SECRET, Date.now())).toBeUndefined()
    expect(decodeSessionToken(`v1.!.${String(Date.now() + 60_000)}.AAAA`, AUTHORITY, SECRET, Date.now())).toBeUndefined()
  })
})

describe('cookie audience', () => {
  it('uses the host over HTTP and the origin over HTTPS', () => {
    expect(requestAuthority({ host: AUTHORITY }, false)).toBe(AUTHORITY)
    expect(requestAuthority({ host: AUTHORITY }, true)).toBe(`https://${AUTHORITY}`)
  })

  it('refuses a request without a usable host', () => {
    expect(requestAuthority({}, false)).toBeUndefined()
    expect(requestAuthority({ host: 'bad host' }, false)).toBeUndefined()
  })

  it('names a distinct cookie per authority', () => {
    expect(sessionCookieName(AUTHORITY)).not.toBe(sessionCookieName('localhost:3080'))
    expect(sessionCookieName(AUTHORITY).startsWith('dsh-user-')).toBe(true)
  })
})

describe('session cookies', () => {
  it('serializes the attributes a session cookie requires', () => {
    const value = sessionCookie(AUTHORITY, minted(Date.now() + 60_000), Date.now() + 60_000, 60, false)
    expect(value).toContain('HttpOnly')
    expect(value).toContain('SameSite=Strict')
    expect(value).toContain('Path=/')
    expect(value).not.toContain('Secure')
    expect(sessionCookie(AUTHORITY, 'token', Date.now(), 0, true)).toContain('Secure')
  })

  it('reads one submitted cookie out of a Cookie header', () => {
    const name = sessionCookieName(AUTHORITY)
    expect(submittedCookie({ headers: { cookie: `a=1; ${name}=value` } }, name)).toBe('value')
    expect(submittedCookie({ headers: new Headers({ cookie: `${name}=value` }) }, name)).toBe('value')
    expect(submittedCookie({ headers: {} }, name)).toBeUndefined()
    expect(submittedCookie({ headers: { cookie: 'a=1' } }, name)).toBeUndefined()
  })
})

function credentialStore(): { records: Map<string, unknown>; provider: CredentialProvider } {
  const records = new Map<string, unknown>()
  const provider = {
    async modifyRecord(key: string, mutate: (current: unknown) => Promise<unknown>): Promise<unknown> {
      const current = records.get(key)
      const next = await mutate(current)
      if (next !== undefined) records.set(key, next)
      return next ?? current
    },
  } as never
  return { records, provider }
}

describe('session secret', () => {
  it('mints a secret once and reuses the stored one', async () => {
    const { records, provider } = credentialStore()
    const first = await loadSessionSecret(provider)
    const second = await loadSessionSecret(provider)
    expect(first.byteLength).toBe(32)
    expect(Buffer.from(second).equals(first)).toBe(true)
    expect(records.size).toBe(1)
  })

  it('fails loud on a stored record this build cannot read', async () => {
    const { records, provider } = credentialStore()
    await loadSessionSecret(provider)
    const key = records.keys().next().value
    expect(key).toBeDefined()
    records.set(key as string, { kind: 'grant', payload: { version: 2, secret: 'abc' } })
    await expect(loadSessionSecret(provider)).rejects.toThrow('unsupported version')
  })
})
