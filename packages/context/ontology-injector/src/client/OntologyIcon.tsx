/** Sidebar panel icon for the ontology catalog — a simple 2×2 grid placeholder. */

import type { ReactNode } from 'react'

interface OntologyIconProps {
  /** Icon size passed by the Sidebar row (16 wide / 18 rail). */
  size: number
}

/**
 * Compact 2×2 grid-shaped panel launcher icon representing classes + properties.
 */
export function OntologyIcon({ size }: OntologyIconProps): ReactNode {
  const unit = size / 2.6
  const gap = unit / 3
  const half = size / 2 - gap / 2
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'grid',
        gridTemplateColumns: `${half}px ${half}px`,
        gridTemplateRows: `${half}px ${half}px`,
        gap: `${gap}px`,
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span style={{ background: 'currentColor', borderRadius: 2, width: half, height: half }} />
      <span style={{ background: 'currentColor', borderRadius: 2, width: half, height: half, opacity: 0.6 }} />
      <span style={{ background: 'currentColor', borderRadius: 2, width: half, height: half, opacity: 0.6 }} />
      <span style={{ background: 'currentColor', borderRadius: 2, width: half, height: half }} />
    </span>
  )
}

