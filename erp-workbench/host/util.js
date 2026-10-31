/**
 * Failures one ERP workbench request can report.
 *
 * Every refusal carries a stable code so the page can tell "the connector is
 * not built" from "the ERP said no" without parsing prose.
 */
export class ErpError extends Error {
  /**
   * @param code - Stable reason the page maps to its own message.
   * @param message - Operator-facing detail.
   * @param status - HTTP status to answer with.
   */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ErpError'
    this.code = code
    this.status = status
  }
}

/**
 * Read a string field from an untrusted body.
 * @param value - Candidate value.
 * @param fallback - Value used when it is not a string.
 * @returns The trimmed string, or the fallback.
 */
export function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

/**
 * Pick the fields of `source` that `keys` names, dropping empty strings.
 * @param source - Untrusted object.
 * @param keys - Field names to keep.
 * @returns A partial object.
 */
export function pickText(source, keys) {
  const out = {}
  for (const key of keys) {
    const value = text(source?.[key])
    if (value !== '') out[key] = value
  }
  return out
}
