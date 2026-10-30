/**
 * Minimal HTTP helpers for the account pages: response writers, form parsing,
 * and same-origin checks for state-changing requests.
 * @module @deepseek-ai/dsh-account-directory/src/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Largest accepted form body. */
const MAX_FORM_BYTES = 64 * 1024

/**
 * Write one HTML response.
 * @param res - Response owner.
 * @param status - HTTP status code.
 * @param body - Complete HTML document.
 */
export function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * Write one JSON response.
 * @param res - Response owner.
 * @param status - HTTP status code.
 * @param value - JSON-serializable body.
 */
export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/**
 * Redirect the browser and end the response.
 * @param res - Response owner.
 * @param location - Absolute path or URL.
 * @param cookies - `Set-Cookie` values to send with the redirect.
 */
export function redirect(res: ServerResponse, location: string, cookies: readonly string[] = []): void {
  const headers: Record<string, string | string[]> = { location, 'cache-control': 'no-store' }
  if (cookies.length > 0) headers['set-cookie'] = [...cookies]
  res.writeHead(303, headers)
  res.end()
}

/**
 * Read one `application/x-www-form-urlencoded` body.
 * @param req - Request whose body is the form.
 * @returns the parsed fields.
 * @throws Error when the body exceeds {@link MAX_FORM_BYTES} or is not form data.
 */
export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, 'utf8')
    total += buffer.byteLength
    if (total > MAX_FORM_BYTES) throw new Error('account-directory: form body is too large')
    chunks.push(buffer)
  }
  const type = req.headers['content-type'] ?? ''
  if (!type.startsWith('application/x-www-form-urlencoded')) {
    throw new Error('account-directory: expected a form submission')
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Whether a state-changing request carries a foreign `Origin`.
 * @param req - Request under consideration.
 * @param secure - Whether the Host serves HTTPS.
 * @returns `true` when an `Origin` header names a different origin.
 */
export function crossesOrigin(req: IncomingMessage, secure: boolean): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string') return false
  const host = req.headers.host
  if (host === undefined) return true
  return origin !== `${secure ? 'https' : 'http'}://${host}`
}

/**
 * Escape text for HTML element content and attribute values.
 * @param value - Untrusted text.
 * @returns the escaped text.
 */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
