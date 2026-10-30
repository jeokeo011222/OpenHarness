/** Small shared helpers for the data analysis host: hashing, stable JSON, and compact errors. */
import { createHash } from 'node:crypto'

/**
 * A failure whose message is safe to show to the model and the user as-is.
 * Anything thrown that is not an AnalysisError is reported with a generic prefix.
 */
export class AnalysisError extends Error {
  /**
   * @param message - Actionable text naming what failed and how to fix it.
   * @param code - Stable machine code for programmatic branching.
   */
  constructor(message, code = 'analysis_error') {
    super(message)
    this.name = 'AnalysisError'
    this.code = code
  }
}

/**
 * Serialize a value with sorted object keys so equal inputs hash equally.
 * @param value - JSON-compatible value.
 * @returns A deterministic JSON string.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

/**
 * Hash a string with sha256.
 * @param text - Text to hash.
 * @returns Lowercase hex digest.
 */
export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** A rolling sha256 over text fragments, used for content-addressed dataset ids. */
export function createContentHasher() {
  const hash = createHash('sha256')
  return {
    /** @param text - Fragment to absorb. */
    update(text) {
      hash.update(text)
    },
    /** @returns The hex digest accumulated so far. */
    digest() {
      return hash.digest('hex')
    },
  }
}

/**
 * Clamp an integer argument into an inclusive range.
 * @param value - Candidate number or undefined.
 * @param min - Smallest accepted value.
 * @param max - Largest accepted value.
 * @param fallback - Used when the candidate is absent or not finite.
 * @returns The clamped integer.
 */
export function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Parse a JSON line, reporting the line number when it is corrupt.
 * @param line - One `data.ndjson` line.
 * @param lineNumber - 1-based position, for the error report.
 * @returns The parsed record.
 */
export function parseNdjsonLine(line, lineNumber) {
  try {
    return JSON.parse(line)
  } catch {
    throw new AnalysisError(`Dataset row ${lineNumber} is not valid JSON; the dataset file is corrupt.`, 'corrupt_dataset')
  }
}
