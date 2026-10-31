/**
 * Minimal RFC 4180 CSV reader.
 *
 * The object layer accepts CSV so an operator can bind an object type to an
 * exported ERP table without installing a parser. Quoted fields, doubled
 * quotes, embedded newlines, and CRLF line endings are handled; a UTF-8 BOM is
 * stripped. Nothing else is inferred — no delimiter guessing, no type coercion.
 */

/** One parsed table: the header row plus one record per data row. */
export interface CsvTable {
  readonly header: readonly string[]
  readonly rows: readonly Readonly<Record<string, string>>[]
}

/**
 * Split CSV text into fields, honouring quoted sections.
 * @param text - the whole document.
 * @returns one field array per record, blank trailing records dropped.
 */
function splitRecords(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  let index = 0

  while (index < text.length) {
    const char = text[index] as string
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
        index += 1
        continue
      }
      field += char
      index += 1
      continue
    }
    if (char === '"') {
      quoted = true
      index += 1
      continue
    }
    if (char === ',') {
      record.push(field)
      field = ''
      index += 1
      continue
    }
    if (char === '\r') {
      index += 1
      continue
    }
    if (char === '\n') {
      record.push(field)
      records.push(record)
      record = []
      field = ''
      index += 1
      continue
    }
    field += char
    index += 1
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  return records.filter(item => item.length > 1 || (item[0] ?? '') !== '')
}

/**
 * Parse CSV text into a header plus named records.
 *
 * A column that appears twice keeps its last value, so a duplicated header
 * degrades predictably instead of shifting every later field.
 * @param text - the whole document, with or without a BOM.
 * @returns the header and one record per data row.
 */
export function parseCsv(text: string): CsvTable {
  const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
  const records = splitRecords(clean)
  const headerRow = records.shift()
  if (headerRow === undefined) return { header: [], rows: [] }
  const header = headerRow.map(name => name.trim())
  const rows = records.map((cells) => {
    const row: Record<string, string> = {}
    header.forEach((name, column) => {
      if (name.length === 0) return
      row[name] = cells[column] ?? ''
    })
    return row
  })
  return { header, rows }
}
