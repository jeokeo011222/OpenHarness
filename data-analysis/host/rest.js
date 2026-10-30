/** REST sources: allowlisted hosts, bounded retries, three pagination styles, and JSON flattening. */
import { AnalysisError } from './util.js'

/** Refuse responses larger than this unless the caller asks for more. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
/** Absolute ceiling for one logical response. */
const HARD_MAX_BYTES = 20 * 1024 * 1024
/** Default page size for paginated reads. */
const DEFAULT_PAGE_SIZE = 100
/** Default page cap per request. */
const DEFAULT_MAX_PAGES = 20

/**
 * Resolve a configured API source.
 * @param sources - Configured source list.
 * @param id - Source id from the tool call.
 * @returns The matching source descriptor.
 */
export function findSource(sources, id) {
  const source = (sources ?? []).find(candidate => candidate.id === id)
  if (source === undefined) {
    const known = (sources ?? []).map(candidate => candidate.id).join(', ') || '(none configured)'
    throw new AnalysisError(
      `Unknown API source "${id}". Configured sources: ${known}. Add one under the plugin's config.sources.`,
      'unknown_source',
    )
  }
  return source
}

/**
 * Hosts this source may contact.
 * @param source - Source descriptor.
 * @returns A set of lower-case hostnames.
 */
function allowedHosts(source) {
  const base = new URL(source.baseUrl)
  return new Set([base.host, ...(source.allowedHosts ?? []).map(host => host.toLowerCase())])
}

/**
 * Prove the URL targets an allowed host and scheme.
 * @param source - Source descriptor.
 * @param target - Candidate URL.
 * @returns The parsed URL.
 */
function assertAllowed(source, target) {
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new AnalysisError(`Only http and https URLs are supported; got "${target.protocol}".`, 'bad_url')
  }
  const hosts = allowedHosts(source)
  if (!hosts.has(target.host.toLowerCase()) && !hosts.has(target.hostname.toLowerCase())) {
    throw new AnalysisError(
      `Request blocked: "${target.host}" is not in this source's allowedHosts (${[...hosts].join(', ')}).`,
      'host_not_allowed',
    )
  }
  return target
}

/**
 * Read a bearer token from the environment when configured.
 * @param source - Source descriptor.
 * @returns Extra request headers.
 */
function authHeaders(source) {
  const headers = { ...(source.headers ?? {}) }
  if (typeof source.authEnv === 'string' && source.authEnv.length > 0) {
    const token = process.env[source.authEnv]
    if (token === undefined || token.length === 0) {
      throw new AnalysisError(`Environment variable "${source.authEnv}" is not set; its token is required for this source.`, 'missing_credentials')
    }
    headers.authorization = `Bearer ${token}`
  }
  return headers
}

/**
 * Parse a body with a byte ceiling.
 * @param response - Fetch response.
 * @param maxBytes - Byte ceiling.
 * @returns `{ parsed, bytes, truncated }`.
 */
async function readJsonBounded(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > maxBytes) {
    throw new AnalysisError(`Response is ${declared} bytes, above maxBytes (${maxBytes}).`, 'response_too_large')
  }
  const reader = response.body?.getReader()
  if (reader === undefined) {
    const text = await response.text()
    return { parsed: JSON.parse(text), bytes: text.length, truncated: false }
  }
  const chunks = []
  let bytes = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > maxBytes) {
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(value)
  }
  const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
  if (truncated) return { bytes, truncated: true }
  try {
    return { parsed: JSON.parse(text), bytes, truncated: false }
  } catch {
    throw new AnalysisError('The response is not valid JSON; add an Accept header or use api_discover to inspect the shape.', 'bad_json')
  }
}

/**
 * Perform one HTTP request with retries and manual redirects.
 * @param source - Source descriptor.
 * @param request - URL, method, headers, and body.
 * @returns Status, headers, parsed JSON, and request count.
 */
export async function httpRequest(source, request) {
  const method = (request.method ?? 'GET').toUpperCase()
  const timeoutMs = Number(request.timeoutMs) > 0 ? Number(request.timeoutMs) : Number(source.timeoutMs) > 0 ? Number(source.timeoutMs) : 15_000
  const maxBytes = Math.min(HARD_MAX_BYTES, Math.max(1024, Number(request.maxBytes) > 0 ? Number(request.maxBytes) : DEFAULT_MAX_BYTES))
  const headers = { accept: 'application/json', ...authHeaders(source), ...(request.headers ?? {}) }
  let url = assertAllowed(source, new URL(request.url))
  let attempts = 0
  let redirects = 0
  for (;;) {
    attempts += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      if (attempts < 3) {
        await new Promise(resolve => setTimeout(resolve, 300 * attempts))
        continue
      }
      throw new AnalysisError(`Request to ${url.host} failed: ${error.message}`, 'request_failed')
    }
    clearTimeout(timer)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (location === null) throw new AnalysisError('Redirect without a Location header.', 'request_failed')
      redirects += 1
      if (redirects > 3) throw new AnalysisError('Too many redirects.', 'request_failed')
      url = assertAllowed(source, new URL(location, url))
      continue
    }
    if ((response.status === 429 || response.status >= 500) && attempts < 3 && method === 'GET') {
      const retryAfter = Number(response.headers.get('retry-after') ?? '0')
      await new Promise(resolve => setTimeout(resolve, retryAfter > 0 ? retryAfter * 1000 : 300 * attempts))
      continue
    }
    const body = await readJsonBounded(response, maxBytes)
    return {
      status: response.status,
      url: url.toString(),
      attempts,
      bytes: body.bytes,
      truncated: body.truncated,
      ...(body.truncated ? {} : { parsed: body.parsed }),
    }
  }
}

/**
 * Read a dotted path such as `data.items` out of a JSON value.
 * @param value - Parsed JSON.
 * @param path - Dotted path.
 * @returns The value at that path, or undefined.
 */
export function pickPath(value, path) {
  if (typeof path !== 'string' || path.length === 0) return value
  return path.split('.').reduce((current, key) => (current === null || current === undefined ? undefined : current[key]), value)
}

/**
 * Flatten nested objects into dotted keys, keeping arrays as JSON strings.
 * @param value - Row object.
 * @param prefix - Key prefix during recursion.
 * @param depth - Remaining nesting depth.
 * @returns A flat record.
 */
export function flattenRecord(value, prefix = '', depth = 2) {
  const record = {}
  for (const [key, child] of Object.entries(value ?? {})) {
    const name = prefix.length === 0 ? key : `${prefix}.${key}`
    if (child !== null && typeof child === 'object' && !Array.isArray(child) && depth > 0) {
      Object.assign(record, flattenRecord(child, name, depth - 1))
    } else if (child !== null && typeof child === 'object') {
      record[name] = JSON.stringify(child)
    } else {
      record[name] = child
    }
  }
  return record
}

/**
 * Normalize an arbitrary JSON payload into row objects.
 * @param parsed - Parsed response body.
 * @param recordsPath - Optional dotted path to the record array.
 * @returns Row objects.
 */
export function toRecords(parsed, recordsPath) {
  const candidate = pickPath(parsed, recordsPath)
  const array = Array.isArray(candidate) ? candidate : Array.isArray(parsed) ? parsed : candidate === undefined ? [] : [candidate]
  return array.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)).map(item => flattenRecord(item))
}

/**
 * Fetch one page set with the requested pagination strategy.
 * @param source - Source descriptor.
 * @param request - Tool arguments.
 * @returns Records, page count, and request count.
 */
export async function fetchRecords(source, request) {
  const pagination = request.pagination ?? { style: 'none' }
  const pageSize = Math.min(1000, Math.max(1, Math.trunc(Number(pagination.pageSize) ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE))
  const maxPages = Math.min(50, Math.max(1, Math.trunc(Number(pagination.maxPages) ?? DEFAULT_MAX_PAGES) || DEFAULT_MAX_PAGES))
  const base = new URL(request.path ?? '', source.baseUrl)
  for (const [key, value] of Object.entries(request.query ?? {})) base.searchParams.set(key, String(value))
  const records = []
  let pages = 0
  let requests = 0
  let cursor
  let lastStatus = 0
  for (let page = 0; page < maxPages; page += 1) {
    if (pagination.style === 'page') base.searchParams.set(pagination.param ?? 'page', String((pagination.startPage ?? 1) + page))
    if (pagination.style === 'offset') base.searchParams.set(pagination.param ?? 'offset', String(page * pageSize))
    if (pagination.style === 'cursor' && cursor !== undefined) base.searchParams.set(pagination.param ?? 'cursor', String(cursor))
    if (pagination.style !== 'none') {
      base.searchParams.set(pagination.sizeParam ?? (pagination.style === 'offset' ? 'limit' : 'pageSize'), String(pageSize))
    }
    const response = await httpRequest(source, { ...request, url: base.toString() })
    requests += response.attempts
    lastStatus = response.status
    if (response.status >= 400) {
      throw new AnalysisError(`HTTP ${response.status} from ${response.url}: ${JSON.stringify(response.parsed)?.slice(0, 200)}`, 'http_error')
    }
    const batch = toRecords(response.parsed, request.recordsPath)
    pages += 1
    records.push(...batch)
    if (pagination.style === 'cursor') {
      const next = pickPath(response.parsed, pagination.nextPath ?? 'next')
      if (next === undefined || next === null) break
      cursor = next
    }
    if (pagination.style === 'none') break
    if (batch.length === 0) break
    if (pagination.hasMorePath !== undefined && pickPath(response.parsed, pagination.hasMorePath) !== true) break
    if (records.length >= 100_000) break
  }
  return { records, pages, requests, status: lastStatus }
}

/**
 * Describe the shape of a JSON API response to help configure a source.
 * @param source - Source descriptor.
 * @param request - URL and query.
 * @returns Paths that look like record arrays plus one sample record.
 */
export async function discoverShape(source, request) {
  const response = await httpRequest(source, { ...request, url: new URL(request.path ?? '', source.baseUrl).toString() })
  const parsed = response.parsed
  const candidates = []
  const visit = (value, path, depth) => {
    if (depth > 3) return
    if (Array.isArray(value)) {
      if (value.some(item => item !== null && typeof item === 'object')) candidates.push(path)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) visit(child, path === '' ? key : `${path}.${key}`, depth + 1)
    }
  }
  visit(parsed, '', 0)
  const first = candidates[0]
  const records = toRecords(parsed, first)
  return {
    status: response.status,
    bytes: response.bytes,
    topLevelKeys: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [],
    recordPaths: candidates,
    suggestedRecordsPath: first,
    sampleRecords: records.slice(0, 2),
    detectedColumns: records.length > 0 ? Object.keys(records[0]) : [],
  }
}
