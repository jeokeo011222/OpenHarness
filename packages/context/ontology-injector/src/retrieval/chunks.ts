/**
 * Clause-level evidence library: document text in, tagged chunks out.
 *
 * Two decisions worth stating up front:
 *
 * 1. **Chunks are clause-aligned, never fixed-width.** A 512-token window cuts
 *    "第三条" in half and then the answer quotes half a rule. Clause markers are
 *    the natural unit; fixed windows are the fallback for unmarked prose.
 * 2. **Tags come from the ontology, not from the model.** Each chunk is labelled
 *    with the classes and properties its text mentions, using the same lexicon
 *    the query side uses. That symmetry is what makes the compatibility filter
 *    meaningful: query and evidence are described in one vocabulary.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { domainDirOf } from '../store.ts'
import { findIdentifiers, matchTerms, type Lexicon } from './lexicon.ts'
import type { ChunkLibraryStats, DocType, EvidenceChunk, IngestRequest } from './types.ts'

/** Clause markers: 第X条/章/节 plus section signs. */
const CLAUSE_MARKER = /(第[一二三四五六七八九十百千万零\d]+[章节条款部分卷编篇])|(§\s*\d+)/g
/** Fallback markers for numbered prose. */
const NUMBERED_MARKER = /(^|\n)\s*(\d+(?:\.\d+)*)[.、)]\s+/g
/** Hard ceiling per chunk; longer clauses are split at sentence boundaries. */
const MAX_CHUNK_CHARS = 1200

/** One slice of a document. */
interface Slice {
  readonly clause: string
  readonly text: string
}

/**
 * Split text into clause slices.
 *
 * @param text - extracted document text.
 * @returns slices in document order; never empty for non-blank input.
 */
export function sliceClauses(text: string): Slice[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (normalized.length === 0) return []

  const markers = collectMarkers(normalized)
  if (markers.length === 0) {
    return splitOversized('正文', normalized)
  }

  const slices: Slice[] = []
  for (let index = 0; index < markers.length; index += 1) {
    const current = markers[index]!
    const next = markers[index + 1]
    const body = normalized.slice(current.index, next?.index ?? normalized.length).trim()
    if (body.length === 0) continue
    slices.push(...splitOversized(current.label, body))
  }
  return slices
}

/** One clause boundary found in the text. */
interface Marker {
  readonly index: number
  readonly label: string
}

/** Clause markers and which capture group holds the label. */
const MARKER_PATTERNS: readonly { pattern: RegExp; group: number }[] = [
  { pattern: CLAUSE_MARKER, group: 1 },
  { pattern: NUMBERED_MARKER, group: 2 },
]

/**
 * Find clause boundaries with the first marker family that matches.
 *
 * The label group differs between patterns because the numbered one captures a
 * leading newline. Reading `match[1] ?? match[2]` looks equivalent but is not:
 * for numbered text `match[1]` is the empty `^` alternative, which is not
 * nullish, so the label would be empty and every marker would be discarded.
 *
 * @param text - normalised document text.
 * @returns markers in document order.
 */
function collectMarkers(text: string): Marker[] {
  for (const { pattern, group } of MARKER_PATTERNS) {
    const found: Marker[] = []
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    for (const match of text.matchAll(regex)) {
      const label = (match[group] ?? '').trim()
      if (label.length === 0) continue
      const raw = match.index ?? 0
      // The numbered pattern captures a leading newline, so the marker does not
      // start at `match.index`. Offset to the label itself; otherwise the
      // boundary check below looks at the newline as if it were content and
      // discards every marker but the first.
      const index = raw + Math.max(0, match[0].indexOf(label))
      // A marker must start a line or follow punctuation; otherwise "第3条"
      // inside a sentence would split the clause that references it.
      const before = index === 0 ? '\n' : text.slice(Math.max(0, index - 2), index)
      if (index !== 0 && !/[\n。；;：:]\s*$/u.test(before)) continue
      found.push({ index, label })
    }
    if (found.length >= 2) return found
  }
  return []
}

/**
 * Split an oversized clause at sentence boundaries.
 *
 * @param clause - clause label.
 * @param body - clause text.
 * @returns one or more slices, each within the character ceiling.
 */
function splitOversized(clause: string, body: string): Slice[] {
  if (body.length <= MAX_CHUNK_CHARS) return [{ clause, text: body }]
  const sentences = body.split(/(?<=[。！？!?])/u).filter(part => part.trim().length > 0)
  const slices: Slice[] = []
  let buffer = ''
  let part = 1
  for (const sentence of sentences) {
    if (buffer.length + sentence.length > MAX_CHUNK_CHARS && buffer.length > 0) {
      slices.push({ clause: `${clause}（续${part}）`, text: buffer.trim() })
      part += 1
      buffer = ''
    }
    buffer += sentence
  }
  if (buffer.trim().length > 0) slices.push({ clause: part === 1 ? clause : `${clause}（续${part}）`, text: buffer.trim() })
  return slices
}

/** Absolute path of a domain's chunk library. */
export function chunkLibraryPath(root: string, domain: string): string {
  return join(domainDirOf(root, domain), 'chunks.jsonl')
}

/**
 * Read a domain's chunk library.
 *
 * A malformed line is skipped rather than thrown: one bad chunk must not make
 * the whole demo unopenable.
 *
 * @param root - ontology store root.
 * @param domain - domain id.
 * @returns chunks in file order.
 */
export async function readChunks(root: string, domain: string): Promise<EvidenceChunk[]> {
  const path = chunkLibraryPath(root, domain)
  if (!existsSync(path)) return []
  const raw = await readFile(path, 'utf8')
  const chunks: EvidenceChunk[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null) chunks.push(parsed as EvidenceChunk)
    } catch {
      // Skip the damaged line; the rest of the library is still usable.
    }
  }
  return chunks
}

/**
 * Replace a domain's chunk library atomically.
 *
 * @param root - ontology store root.
 * @param domain - domain id.
 * @param chunks - the full library.
 */
export async function writeChunks(root: string, domain: string, chunks: readonly EvidenceChunk[]): Promise<void> {
  const path = chunkLibraryPath(root, domain)
  await mkdir(domainDirOf(root, domain), { recursive: true })
  const body = chunks.map(chunk => JSON.stringify(chunk)).join('\n')
  const temporary = `${path}.tmp`
  await writeFile(temporary, body.length > 0 ? `${body}\n` : '', 'utf8')
  await rename(temporary, path)
}

/**
 * Turn one document into tagged chunks and append them to the library.
 *
 * Re-importing the same title replaces that document's chunks instead of
 * duplicating them — otherwise a demo that imports the same policy twice ranks
 * the duplicate clauses above everything else.
 *
 * @param root - ontology store root.
 * @param domain - domain id.
 * @param request - document payload.
 * @param lexicon - domain vocabulary used for tagging.
 * @returns the number of chunks written and the resulting library size.
 */
export async function ingestDocument(
  root: string,
  domain: string,
  request: IngestRequest,
  lexicon: Lexicon,
): Promise<{ docId: string; added: number; total: number }> {
  const slices = sliceClauses(request.text)
  if (slices.length === 0) return { docId: '', added: 0, total: (await readChunks(root, domain)).length }

  const docId = slugOf(request.title)
  const existing = (await readChunks(root, domain)).filter(chunk => chunk.docId !== docId)
  const priority = clampPriority(request.priority ?? defaultPriority(request.docType))
  const created: EvidenceChunk[] = slices.map((slice, index) => {
    const tags = matchTerms(lexicon, slice.text)
    return {
      chunkId: `${docId}#${index + 1}`,
      docId,
      docTitle: request.title.trim(),
      docType: request.docType,
      clauseNo: slice.clause,
      text: slice.text,
      classes: tags.classes,
      properties: tags.properties,
      identifiers: findIdentifiers(slice.text),
      priority,
      effectiveFrom: emptyToNull(request.effectiveFrom),
      effectiveTo: emptyToNull(request.effectiveTo),
      deprecated: false,
    }
  })

  const merged = [...existing, ...created]
  await writeChunks(root, domain, merged)
  return { docId, added: created.length, total: merged.length }
}

/**
 * Library statistics for the panel header.
 *
 * @param root - ontology store root.
 * @param domain - domain id.
 * @returns counts plus the union of tagged classes.
 */
export async function chunkStats(root: string, domain: string): Promise<ChunkLibraryStats> {
  const chunks = await readChunks(root, domain)
  const classes = new Set<string>()
  const documents = new Set<string>()
  for (const chunk of chunks) {
    documents.add(chunk.docId)
    for (const name of chunk.classes) classes.add(name)
  }
  const path = chunkLibraryPath(root, domain)
  const updatedAt = existsSync(path) ? new Date().toISOString() : ''
  return {
    domain,
    documents: documents.size,
    chunks: chunks.length,
    classes: [...classes].sort(),
    updatedAt,
  }
}

/**
 * Priority defaults by document role: current rules outrank contracts, which
 * outrank archival material.
 *
 * @param docType - document role.
 * @returns the default priority.
 */
export function defaultPriority(docType: DocType): number {
  switch (docType) {
    case 'regulation': return 40
    case 'standard': return 38
    case 'contract': return 34
    case 'ledger': return 32
    case 'archive': return 20
    default: return 30
  }
}

/**
 * Turn a title into a stable document id.
 *
 * @param title - document title.
 * @returns a slug usable in ids and file names.
 */
function slugOf(title: string): string {
  const ascii = title.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '-').replace(/^-+|-+$/g, '')
  return ascii.length > 0 ? ascii.slice(0, 60) : `doc-${Date.now().toString(36)}`
}

/**
 * Clamp a priority into the supported range.
 *
 * @param value - raw priority.
 * @returns `10..50`.
 */
function clampPriority(value: number): number {
  if (!Number.isFinite(value)) return 30
  return Math.min(50, Math.max(10, Math.round(value)))
}

/**
 * Map an empty string to `null` so unbounded windows stay unbounded.
 *
 * @param value - optional date string.
 * @returns the value or `null`.
 */
function emptyToNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length === 0 ? null : trimmed
}
