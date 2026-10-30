/** Sidebar panel icon for the admin workbench — a simple shield placeholder. */

import type { ReactNode } from 'react'

interface AdminIconProps {
  /** Icon size passed by the Sidebar row (16 wide / 18 rail). */
  size: number
}

/** Compact shield-shaped panel launcher icon for the user-management page. */
export function AdminIcon({ size }: AdminIconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.5 13.5 3.6v4.1c0 3.4-2.3 5.9-5.5 6.8-3.2-.9-5.5-3.4-5.5-6.8V3.6L8 1.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M5.6 7.9l1.8 1.8 3-3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
