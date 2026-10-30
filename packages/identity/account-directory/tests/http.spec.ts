import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { crossesOrigin, escapeHtml, readForm, redirect, sendHtml, sendJson } from '../src/http.ts'

interface Recorded {
  readonly status: number
  readonly headers: Record<string, unknown>
  readonly body: string
}

function recordingResponse(): { readonly calls: Recorded[]; readonly res: ServerResponse } {
  const calls: Recorded[] = []
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>): void {
      calls.push({ status, headers: headers ?? {}, body: '' })
    },
    end(body?: string): void {
      const last = calls.at(-1)
      if (last !== undefined) calls[calls.length - 1] = { ...last, body: body ?? '' }
    },
  } as never
  return { calls, res }
}

function formRequest(contentType: string, body: string): IncomingMessage {
  const chunks = [Buffer.from(body)]
  return {
    headers: { 'content-type': contentType },
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      for (const chunk of chunks) yield chunk
    },
  } as IncomingMessage
}

function chunkedRequest(headers: Record<string, string>, ...chunks: readonly (Buffer | string)[]): IncomingMessage {
  return {
    headers,
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer | string> {
      for (const chunk of chunks) yield chunk
    },
  } as IncomingMessage
}

describe('responses', () => {
  it('writes HTML and JSON with no-store caching', () => {
    const html = recordingResponse()
    sendHtml(html.res, 200, '<p>ok</p>')
    expect(html.calls).toEqual([{
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      body: '<p>ok</p>',
    }])

    const json = recordingResponse()
    sendJson(json.res, 200, { signedIn: true })
    expect(json.calls[0]?.body).toBe('{"signedIn":true}')
  })

  it('redirects with 303 and carries the cookies it was given', () => {
    const plain = recordingResponse()
    redirect(plain.res, '/login')
    expect(plain.calls[0]).toEqual({ status: 303, headers: { location: '/login', 'cache-control': 'no-store' }, body: '' })

    const withCookie = recordingResponse()
    redirect(withCookie.res, '/', ['session=abc'])
    expect(withCookie.calls[0]?.headers['set-cookie']).toEqual(['session=abc'])
  })
})

describe('form submissions', () => {
  it('parses repeated fields', async () => {
    const form = await readForm(formRequest('application/x-www-form-urlencoded', 'username=alice&roles=owner&roles=viewer'))
    expect(form.get('username')).toBe('alice')
    expect(form.getAll('roles')).toEqual(['owner', 'viewer'])
  })

  it('refuses a non-form body and an oversized one', async () => {
    await expect(readForm(formRequest('application/json', '{}'))).rejects.toThrow('expected a form submission')
    await expect(readForm(formRequest('application/x-www-form-urlencoded', 'x'.repeat(64 * 1024 + 1))))
      .rejects.toThrow('form body is too large')
  })

  it('decodes string chunks and refuses a body without a form content type', async () => {
    const form = await readForm(chunkedRequest({ 'content-type': 'application/x-www-form-urlencoded' }, 'a=1&', 'b=2'))
    expect(form.get('a')).toBe('1')
    expect(form.get('b')).toBe('2')
    await expect(readForm(chunkedRequest({}, 'a=1'))).rejects.toThrow('expected a form submission')
  })
})

function headersOnly(headers: Record<string, string>): IncomingMessage {
  return { headers } as never
}

describe('origin checks', () => {
  it('accepts a same-origin submission and refuses a foreign one', () => {
    expect(crossesOrigin(headersOnly({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }), false)).toBe(false)
    expect(crossesOrigin(headersOnly({ host: '127.0.0.1:3080', origin: 'http://example.com' }), false)).toBe(true)
    expect(crossesOrigin(headersOnly({ origin: 'http://example.com' }), false)).toBe(true)
  })

  it('ignores requests without an Origin and honors HTTPS', () => {
    expect(crossesOrigin(headersOnly({ host: '127.0.0.1:3080' }), false)).toBe(false)
    expect(crossesOrigin(headersOnly({ host: '127.0.0.1:3080', origin: 'https://127.0.0.1:3080' }), true)).toBe(false)
  })
})

describe('escapeHtml', () => {
  it('escapes markup and both quote characters', () => {
    expect(escapeHtml('<img src="x" onerror=\'y\'>&'))
      .toBe('&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;')
  })
})
