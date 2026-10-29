import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the official mark as a bitmap image.
 *
 * Previously this rendered FishLogo (hard-coded SVG fish path); the
 * product now ships a brand image from apps/web/public/logo.png.
 * Keeping it an <img> lets design swap assets without touching TSX.
 *
 * @param props - Host-supplied mark presentation (width in px).
 * @returns the brand mark as an img element.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return (
    <img
      src="/logo.png"
      alt="OpenHarness"
      width={size}
      height={size}
      style={{
        objectFit: 'contain',
        display: 'block',
      }}
      draggable={false}
    />
  )
}

/**
 * Render the official brand name as plain text.
 * The previous SVG wordmark was hard-coded path data and could not be
 * product-renamed at reasonable cost; switching to a styled span lets
 * the brand string stay in one place and be changed freely.
 * @returns the official name text.
 */
export function OfficialBrandName() {
  return (
    <span
      style={{
        fontFamily: 'Montserrat, system-ui, sans-serif',
        fontWeight: 700,
        letterSpacing: '-0.02em',
        fontSize: '14px',
        color: 'var(--dsw-text-primary)',
        whiteSpace: 'nowrap',
      }}
    >
      OpenHarness
    </span>
  )
}
