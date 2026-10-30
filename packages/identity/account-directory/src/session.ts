/**
 * Signed browser-session tokens for local accounts. The token names the
 * account and its expiry; the Host derives the request audience from the
 * `Host` header, so one signing secret can serve every local authority.
 * @module @deepseek-ai/dsh-account-directory/src/session
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type { UserId } from './types.ts'

const RECORD_KEY = credentialKey('account-directory', 'session')
const RECORD_VERSION = 1
const TOKEN_VERSION = 'v1'
const COOKIE_PREFIX = 'dsh-user-'
const SECRET_BYTES = 32
const BASE64URL = /^[A-Za-z0-9_-]+$/

/** Cookie path every account route shares. */
export const LOGIN_PATH = '/login'

/** One verified account session. */
export interface UserSession {
  readonly userId: UserId
  readonly authority: string
  readonly expiresAt: number
}

interface StoredSecretPayload {
  readonly version: typeof RECORD_VERSION
  readonly secret: string
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function headerValue(headers: ConnectionTrustRequest['headers'], name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Cookie audience of one request: the origin on HTTPS, the host otherwise.
 * @param headers - Request headers carrying `Host`.
 * @param secure - Whether the Host serves HTTPS.
 * @returns the audience, or `undefined` when the request names no valid host.
 */
export function requestAuthority(headers: ConnectionTrustRequest['headers'], secure: boolean): string | undefined {
  const host = headerValue(headers, 'host')
  if (host === undefined) return undefined
  try {
    const url = new URL(`${secure ? 'https:' : 'http:'}//${host}`)
    return secure ? url.origin : url.host
  } catch {
    return undefined
  }
}

/**
 * Cookie name for one audience; the account cookie never collides with the owner cookie.
 * @param authority - audience the cookie is scoped to.
 * @returns the hashed cookie name.
 */
export function sessionCookieName(authority: string): string {
  return COOKIE_PREFIX + createHash('sha256').update(authority).digest('base64url')
}

function signature(secret: Buffer, body: string, authority: string): Buffer {
  return createHmac('sha256', secret).update(`${body}\n${authority}`).digest()
}

/**
 * Serialize one signed session token.
 * @param userId - Account the token names.
 * @param authority - Cookie audience the token is bound to.
 * @param expiresAt - Absolute expiry in epoch milliseconds.
 * @param secret - Host signing secret.
 * @returns the cookie value.
 */
export function encodeSessionToken(userId: UserId, authority: string, expiresAt: number, secret: Buffer): string {
  const body = `${TOKEN_VERSION}.${encodeBase64Url(Buffer.from(userId, 'utf8'))}.${String(expiresAt)}`
  return `${body}.${encodeBase64Url(signature(secret, body, authority))}`
}

function cookieValue(cookieHeader: string, name: string): string | undefined {
  for (const segment of cookieHeader.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/**
 * Read one submitted cookie from a `Cookie` header, if present.
 * @param request - Request whose headers carry `Cookie`.
 * @param name - Cookie name.
 * @returns the raw cookie value, or `undefined` when absent.
 */
export function submittedCookie(request: ConnectionTrustRequest, name: string): string | undefined {
  const cookie = headerValue(request.headers, 'cookie')
  return cookie === undefined ? undefined : cookieValue(cookie, name)
}

/**
 * Verify one session token and its expiry.
 * @param token - Cookie value supplied by the browser.
 * @param authority - Audience expected for this request.
 * @param secret - Host signing secret.
 * @param now - Comparison instant in epoch milliseconds.
 * @returns the verified session, or `undefined` when the token is malformed, foreign, or expired.
 */
export function decodeSessionToken(
  token: string,
  authority: string,
  secret: Buffer,
  now: number,
): UserSession | undefined {
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return undefined
  const [version, userIdText, expiresText, encodedSignature] = parts as [string, string, string, string]
  const body = `${version}.${userIdText}.${expiresText}`
  const actual = decodeBase64Url(encodedSignature)
  if (actual === undefined) return undefined
  const expected = signature(secret, body, authority)
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return undefined
  const expiresAt = Number(expiresText)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return undefined
  const decodedId = decodeBase64Url(userIdText)
  if (decodedId === undefined) return undefined
  return { userId: decodedId.toString('utf8') as UserId, authority, expiresAt }
}

/**
 * Serialize one `Set-Cookie` value for the account session.
 * @param authority - Cookie audience.
 * @param token - Signed token, or empty to clear.
 * @param expiresAt - Absolute expiry; ignored when clearing.
 * @param maxAgeSeconds - Cookie lifetime, or `0` to clear.
 * @param secure - Whether the Host serves HTTPS.
 * @returns the `Set-Cookie` value.
 */
export function sessionCookie(
  authority: string,
  token: string,
  expiresAt: number,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const attributes = `${sessionCookieName(authority)}=${token}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`
  return secure ? `${attributes}; Secure` : attributes
}

/**
 * Load the Host signing secret, generating it on first use.
 * @param credentials - Credential provider owning the durable record.
 * @returns the signing secret.
 * @throws Error when the stored record has a format this build cannot read.
 */
export async function loadSessionSecret(credentials: CredentialProvider): Promise<Buffer> {
  const generated: StoredSecretPayload = { version: RECORD_VERSION, secret: encodeBase64Url(randomBytes(SECRET_BYTES)) }
  const record = await credentials.modifyRecord(RECORD_KEY, (current) => {
    if (current === undefined) return Promise.resolve({ kind: 'grant', payload: generated })
    return Promise.resolve(undefined)
  })
  return readStoredSecret(record)
}

function readStoredSecret(record: CredentialRecord | undefined): Buffer {
  if (record === undefined || record.kind !== 'grant') {
    throw new Error('account-directory: session credential record is missing')
  }
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('account-directory: session credential record has an unsupported payload')
  }
  const fields = payload as Record<string, unknown>
  if (fields['version'] !== RECORD_VERSION) {
    throw new Error('account-directory: session credential record has an unsupported version')
  }
  const text = fields['secret']
  const secret = typeof text === 'string' ? decodeBase64Url(text) : undefined
  if (secret === undefined || secret.byteLength !== SECRET_BYTES) {
    throw new Error('account-directory: session credential record has an invalid secret')
  }
  return secret
}
