/** Minimal XLSX reader: central-directory unzip, shared strings, styles, and cell values. */
import { readFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import { AnalysisError } from './util.js'

const SIGNATURE_EOCD = 0x06054b50
const SIGNATURE_CENTRAL = 0x02014b50
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])

/**
 * Read every entry of a zip archive into memory.
 * @param buffer - Whole `.xlsx` file.
 * @returns A map from entry name to uncompressed bytes.
 */
function readZipEntries(buffer) {
  let eocd = -1
  const floor = Math.max(0, buffer.length - 65_557)
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === SIGNATURE_EOCD) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new AnalysisError('The .xlsx file is not a zip archive.', 'bad_xlsx')
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  const entries = new Map()
  let cursor = directoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== SIGNATURE_CENTRAL) break
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    if (compressedSize > 0) {
      entries.set(name, method === 8 ? inflateRawSync(raw) : raw)
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Decode the XML entities Excel writes into text nodes.
 * @param text - Raw XML text.
 * @returns Unescaped text.
 */
function unescapeXml(text) {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
}

/**
 * Convert an Excel serial date to an ISO-like string in the workbook's wall clock.
 * @param serial - Days since 1899-12-30.
 * @returns `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss`.
 */
function serialToText(serial) {
  const milliseconds = Math.round((serial - 25_569) * 86_400_000)
  const date = new Date(milliseconds)
  const pad = value => String(value).padStart(2, '0')
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  const secondsOfDay = Math.round(((serial % 1) + 1) % 1 * 86_400)
  if (secondsOfDay === 0) return day
  const hour = Math.floor(secondsOfDay / 3600)
  const minute = Math.floor((secondsOfDay % 3600) / 60)
  return `${day}T${pad(hour)}:${pad(minute)}:${pad(secondsOfDay % 60)}`
}

/**
 * Build the style-index to date-format map from `styles.xml`.
 * @param stylesXml - Styles part, or empty when absent.
 * @returns A predicate over cell style indexes.
 */
function createDateStyleTest(stylesXml) {
  if (stylesXml.length === 0) return () => false
  const customFormats = new Map()
  for (const match of stylesXml.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    customFormats.set(Number(match[1]), match[2])
  }
  const cellFormats = []
  const cellXfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)
  if (cellXfs !== null) {
    for (const match of cellXfs[1].matchAll(/<xf\b[^>]*numFmtId="(\d+)"[^>]*>/g)) {
      cellFormats.push(Number(match[1]))
    }
  }
  const isDateFormat = formatId => {
    if (DATE_FORMAT_IDS.has(formatId)) return true
    const code = customFormats.get(formatId) ?? ''
    return /[ymd]/i.test(code.replace(/"[^"]*"/g, '')) && !/[#0]/.test(code.replace(/"[^"]*"/g, '').replace(/[ymd]/gi, ''))
  }
  return styleIndex => {
    const formatId = cellFormats[styleIndex]
    return formatId !== undefined && isDateFormat(formatId)
  }
}

/**
 * Pull `<si>` entries out of `sharedStrings.xml`.
 * @param xml - Shared strings part, or empty when the workbook has none.
 * @returns Shared strings in order.
 */
function readSharedStrings(xml) {
  if (xml.length === 0) return []
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match =>
    [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(part => unescapeXml(part[1])).join(''),
  )
}

/**
 * Expand a cell reference such as `C12` into a zero-based column index.
 * @param reference - Cell reference attribute.
 * @returns Column index.
 */
function columnIndex(reference) {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? 'A'
  let index = 0
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

/**
 * Read one worksheet into a row-major string table.
 * @param xml - Worksheet XML.
 * @param shared - Shared strings table.
 * @param isDateStyle - Style predicate for numeric date cells.
 * @returns Rows of cell text, padded to the widest row.
 */
function readSheetRows(xml, shared, isDateStyle) {
  const rows = []
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = []
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1]
      const body = cellMatch[2]
      const reference = /r="([A-Z]+\d+)"/.exec(attributes)?.[1]
      const type = /t="([^"]+)"/.exec(attributes)?.[1]
      const style = Number(/s="(\d+)"/.exec(attributes)?.[1] ?? -1)
      let text = ''
      if (type === 'inlineStr') {
        text = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(part => unescapeXml(part[1])).join('')
      } else {
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''
        if (type === 's') text = shared[Number(raw)] ?? ''
        else if (type === 'b') text = raw === '1' ? 'true' : 'false'
        else if (type === 'str' || type === 'e') text = unescapeXml(raw)
        else if (raw.length > 0) {
          const number = Number(raw)
          text = isDateStyle(style) && Number.isFinite(number) ? serialToText(number) : raw
        }
      }
      const index = reference === undefined ? cells.length : columnIndex(reference)
      while (cells.length < index) cells.push('')
      cells[index] = text
    }
    rows.push(cells)
  }
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  for (const row of rows) while (row.length < width) row.push('')
  return rows
}

/**
 * Read an `.xlsx` workbook.
 * @param filePath - Absolute path to the workbook.
 * @returns Worksheets in workbook order, each with a name and a string table.
 */
export async function readXlsx(filePath) {
  let buffer
  try {
    buffer = await readFile(filePath)
  } catch {
    throw new AnalysisError(`Cannot read "${filePath}".`, 'read_failed')
  }
  const entries = readZipEntries(buffer)
  const text = name => entries.get(name)?.toString('utf8') ?? ''
  const workbook = text('xl/workbook.xml')
  if (workbook.length === 0) throw new AnalysisError('The .xlsx file has no workbook part.', 'bad_xlsx')
  const relationships = new Map()
  for (const match of text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /Id="([^"]+)"/.exec(match[1])?.[1]
    const target = /Target="([^"]+)"/.exec(match[1])?.[1]
    if (id !== undefined && target !== undefined) {
      relationships.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`)
    }
  }
  const shared = readSharedStrings(text('xl/sharedStrings.xml'))
  const isDateStyle = createDateStyleTest(text('xl/styles.xml'))
  const sheets = []
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = unescapeXml(/name="([^"]*)"/.exec(match[1])?.[1] ?? '')
    const relId = /r:id="([^"]+)"/.exec(match[1])?.[1]
    const target = relId === undefined ? undefined : relationships.get(relId)
    if (target === undefined) continue
    const xml = text(target)
    if (xml.length === 0) continue
    sheets.push({ name, rows: readSheetRows(xml, shared, isDateStyle) })
  }
  if (sheets.length === 0) throw new AnalysisError('The .xlsx file contains no readable worksheet.', 'empty_xlsx')
  return sheets
}
