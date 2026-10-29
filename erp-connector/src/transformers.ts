/**
 * Value-level transformers applied by the router before handing params
 * to the adapter. All transforms are pure (safe, no scripts).
 */

import type { TransformerSpec } from './types.js'

export function applyTransform(value: unknown, spec: TransformerSpec | undefined): unknown {
  if (!spec || spec.kind === 'identity') return value

  switch (spec.kind) {
    case 'date_format': {
      if (value == null) return value
      const fmt = spec.format ?? 'YYYYMMDD'
      const d = value instanceof Date ? value : new Date(String(value))
      if (Number.isNaN(d.getTime())) return value
      const y = d.getFullYear().toString()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      return fmt
        .replace('YYYY', y).replace('MM', m).replace('DD', day)
        .replace('HH', String(d.getHours()).padStart(2, '0'))
        .replace('mm', String(d.getMinutes()).padStart(2, '0'))
    }

    case 'enum_map': {
      if (value == null) return value
      if (!spec.map) throw new Error('enum_map transformer missing `map` field')
      const key = String(value)
      return spec.map[key] ?? value
    }

    default: {
      // Exhaustive guard — TS ensures no other kind exists.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const unknownKind = (spec as any).kind
      throw new Error(`Unknown transformer kind: ${unknownKind}`)
    }
  }
}

export function transformParams(
  source: Record<string, unknown>,
  mappings: Array<{ from: string; to: string; transform?: TransformerSpec }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const m of mappings) {
    if (!(m.from in source)) continue
    out[m.to] = applyTransform(source[m.from], m.transform)
  }
  return out
}
