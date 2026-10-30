import { useEffect, type ReactNode } from 'react'
import styles from './workbench.module.css'

/** Props of a two-action confirmation dialog. */
export interface ConfirmDialogProps {
  /** Heading of the dialog. */
  readonly title: string
  /** Consequence text shown under the heading. */
  readonly message: string
  readonly confirmLabel: string
  readonly cancelLabel: string
  /** Disables both actions and ignores Escape while true. */
  readonly busy: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

/**
 * Modal confirmation with a masked backdrop.
 *
 * Escape and a backdrop click cancel, matching the workbench's other dialogs.
 *
 * @param props - copy, busy flag, and the two outcomes.
 * @returns the overlay, or nothing once the caller clears its pending state.
 */
export function ConfirmDialog({ title, message, confirmLabel, cancelLabel, busy, onConfirm, onCancel }: ConfirmDialogProps): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [busy, onCancel])

  return (
    <div className={styles.overlay} role="presentation">
      <div className={styles.mask} aria-hidden="true" onClick={() => { if (!busy) onCancel() }} />
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className={styles.dialogTitle}>{title}</h2>
        <p className={styles.hint}>{message}</p>
        <div className={styles.dialogActions}>
          <button type="button" className={styles.button} disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className={styles.buttonPrimary} disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
