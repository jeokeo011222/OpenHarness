/**
 * Plain-text extraction for uploaded ontology sources.
 *
 * Supports DOCX (ZIP entry `word/document.xml`), PDF (pdfjs text content), and
 * UTF-8 text formats. Extraction runs on the Host so the browser upload is a
 * plain byte transfer.
 */

import { inflateRawSync } from 'node:zlib'

/** Formats the extractor accepts. */
export type SourceFormat = 'docx' | 'pdf' | 'text'

/** Plain text plus the format it came from. */
export interface ExtractedText {
  readonly text: string
  readonly format: SourceFormat
}

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'text'])

/** Lowercase extension of a file name without its leading dot. */
function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf('.')
  return index < 0 ? '' : fileName.slice(index + 1).toLowerCase()
}

/** Read one entry out of a ZIP archive without external dependencies. */
function readZipEntry(bytes: Uint8Array, wanted: string): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let endOfCentralDirectory = -1
  for (let offset = bytes.length - 22; offset >= 0 && offset > bytes.length - 66_000; offset -= 1) {
    if (view.getUint32(offset, true) === 0x0605_4b50) {
      endOfCentralDirectory = offset
      break
    }
  }
  if (endOfCentralDirectory < 0) return null

  const entryCount = view.getUint16(endOfCentralDirectory + 10, true)
  let cursor = view.getUint32(endOfCentralDirectory + 16, true)
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== 0x0201_4b50) return null
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const nameStart = cursor + 46
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength))
    if (name === wanted) {
      if (view.getUint32(localOffset, true) !== 0x0403_4b50) return null
      const localNameLength = view.getUint16(localOffset + 26, true)
      const localExtraLength = view.getUint16(localOffset + 28, true)
      const dataStart = localOffset + 30 + localNameLength + localExtraLength
      const raw = bytes.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) return raw
      if (method === 8) return inflateRawSync(raw)
      return null
    }
    cursor = nameStart + nameLength + extraLength + commentLength
  }
  return null
}

/** Decode the XML entities Word writes into document.xml. */
function decodeEntities(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#160;', ' ')
    .replaceAll('&amp;', '&')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

/** Turn WordprocessingML into paragraphs of plain text. */
function documentXmlToText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<w:tab\s*\/>/g, '\t')
      .replace(/<w:br\s*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n')
}

/** Extract document text from a DOCX archive. */
function extractDocx(bytes: Uint8Array): string {
  const document = readZipEntry(bytes, 'word/document.xml')
  if (!document) throw new Error('DOCX archive has no word/document.xml')
  return documentXmlToText(new TextDecoder().decode(document))
}

/** Extract text from a PDF with pdfjs. */
async function extractPdf(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const document = await pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise
  const pages: string[] = []
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber)
    const content = await page.getTextContent()
    pages.push(content.items.map(item => item.str ?? '').join(' ').replace(/\s+/g, ' ').trim())
  }
  await document.destroy()
  return pages.filter(page => page.length > 0).join('\n\n')
}

/**
 * Extract plain text from an uploaded document.
 *
 * @param fileName - client-supplied file name; its extension selects the parser.
 * @param bytes - decoded document bytes.
 * @returns extracted text and the detected format.
 */
export async function extractDocumentText(fileName: string, bytes: Uint8Array): Promise<ExtractedText> {
  const extension = extensionOf(fileName)
  if (extension === 'docx') return { text: extractDocx(bytes), format: 'docx' }
  if (extension === 'pdf') return { text: await extractPdf(bytes), format: 'pdf' }
  if (TEXT_EXTENSIONS.has(extension)) return { text: new TextDecoder().decode(bytes), format: 'text' }
  throw new Error(`Unsupported source format: .${extension || '(none)'}. Use DOCX, PDF, MD, or TXT.`)
}
