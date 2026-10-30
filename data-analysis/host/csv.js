/** Streaming delimited-text reading: RFC 4180 quoting, CRLF/LF, UTF-8 rejection, and delimiter sniffing. */
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { AnalysisError } from './util.js'

/** Delimiters considered by automatic detection. */
export const DELIMITERS = [',', ';', '\t', '|']

/**
 * Count delimiter occurrences outside double quotes.
 * @param line - A single physical line of text.
 * @param delimiter - Delimiter character to count.
 * @returns Field separators seen on this line.
 */
function countOutsideQuotes(line, delimiter) {
  let count = 0
  let inQuotes = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') index += 1
      else inQuotes = !inQuotes
    } else if (char === delimiter && !inQuotes) count += 1
  }
  return count
}

/**
 * Guess the delimiter with the flattest per-line field count over the first 20 lines.
 * @param text - File head as decoded text.
 * @returns The best delimiter, defaulting to a comma.
 */
export function sniffDelimiter(text) {
  const lines = text.split(/\r\n|\n|\r/).filter(line => line.length > 0).slice(0, 20)
  if (lines.length === 0) return ','
  let best
  for (const delimiter of DELIMITERS) {
    const counts = lines.map(line => countOutsideQuotes(line, delimiter))
    const mean = counts.reduce((sum, value) => sum + value, 0) / counts.length
    if (mean < 1) continue
    const variance = counts.reduce((sum, value) => sum + (value - mean) ** 2, 0) / counts.length
    if (best === undefined || variance < best.variance || (variance === best.variance && mean > best.mean)) {
      best = { delimiter, variance, mean }
    }
  }
  return best?.delimiter ?? ','
}

/**
 * Incremental CSV reader. Feeding chunks preserves quoting state across chunk boundaries.
 * @param delimiter - Field separator.
 * @returns A parser exposing `push`, `take`, and `end`.
 */
export function createCsvParser(delimiter = ',') {
  let field = ''
  let row = []
  let inQuotes = false
  let fieldStart = true
  let rows = []

  const endField = () => {
    row.push(field)
    field = ''
    fieldStart = true
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }

  return {
    /**
     * Absorb a chunk of decoded text.
     * @param text - Fragment that may end mid-quote.
     */
    push(text) {
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]
        if (inQuotes) {
          if (char === '"') {
            if (text[index + 1] === '"') {
              field += '"'
              index += 1
            } else inQuotes = false
          } else field += char
          continue
        }
        if (char === '"' && fieldStart) {
          inQuotes = true
          fieldStart = false
          continue
        }
        if (char === delimiter) {
          endField()
          continue
        }
        if (char === '\r' || char === '\n') {
          endRow()
          if (char === '\r' && text[index + 1] === '\n') index += 1
          continue
        }
        field += char
        fieldStart = false
      }
    },
    /**
     * Drain rows completed so far.
     * @returns Completed rows since the previous call.
     */
    take() {
      const done = rows
      rows = []
      return done
    },
    /**
     * Finish the stream, flushing a final unterminated row.
     * @returns Remaining rows.
     */
    end() {
      if (field.length > 0 || row.length > 0) endRow()
      return this.take()
    },
  }
}

/**
 * Create a strict UTF-8 decoder that fails loud on non-UTF-8 bytes.
 * @returns A decoder with the streaming `decode` signature used by read streams.
 */
export function createUtf8Decoder() {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  return {
    /**
     * @param chunk - Byte chunk; incomplete multi-byte sequences are carried over.
     * @param options - `{ stream: true }` while more bytes are coming.
     * @returns Decoded text.
     */
    decode(chunk, options) {
      try {
        return decoder.decode(chunk, options)
      } catch {
        throw new AnalysisError(
          'The file is not valid UTF-8, so its text cannot be trusted. Re-save it as UTF-8 and import again '
          + '（文件不是 UTF-8 编码，请另存为 UTF-8 后重试）。',
          'not_utf8',
        )
      }
    },
  }
}

/**
 * Read the head of a file as text for delimiter sniffing and format checks.
 * @param filePath - Absolute file path.
 * @param bytes - Maximum bytes to read.
 * @returns Decoded head text with any BOM removed.
 */
export async function readFileHead(filePath, bytes = 8192) {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    const text = createUtf8Decoder().decode(new Uint8Array(buffer.subarray(0, bytesRead)), { stream: false })
    return text.replace(/^\uFEFF/, '')
  } finally {
    await handle.close()
  }
}

/**
 * Stream row arrays from a delimited file.
 * @param filePath - Absolute file path.
 * @param delimiter - Field separator.
 * @returns An async iterable of raw field arrays.
 */
export async function* readCsvRows(filePath, delimiter) {
  const parser = createCsvParser(delimiter)
  const decoder = createUtf8Decoder()
  for await (const chunk of createReadStream(filePath)) {
    parser.push(decoder.decode(chunk, { stream: true }))
    for (const row of parser.take()) yield row
  }
  const tail = decoder.decode()
  if (tail.length > 0) parser.push(tail)
  for (const row of parser.end()) yield row
}
