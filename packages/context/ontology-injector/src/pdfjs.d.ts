/**
 * Minimal ambient types for the pdfjs Node build used by {@link extractDocumentText}.
 *
 * pdfjs ships type declarations for its main entry only; the Host imports the
 * worker-free legacy build so text extraction runs without a browser worker.
 */
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  /** One positioned text run. */
  interface PdfTextItem {
    readonly str?: string
  }

  /** Text content of one page. */
  interface PdfTextContent {
    readonly items: readonly PdfTextItem[]
  }

  /** One page handle. */
  interface PdfPage {
    getTextContent(): Promise<PdfTextContent>
  }

  /** One opened document. */
  interface PdfDocument {
    readonly numPages: number
    getPage(pageNumber: number): Promise<PdfPage>
    destroy(): Promise<void>
  }

  /** Pending document load. */
  interface PdfLoadingTask {
    readonly promise: Promise<PdfDocument>
  }

  /** Open a document from in-memory bytes. */
  export function getDocument(source: {
    readonly data: Uint8Array
    readonly useSystemFonts?: boolean
    readonly isEvalSupported?: boolean
    readonly disableFontFace?: boolean
  }): PdfLoadingTask
}
