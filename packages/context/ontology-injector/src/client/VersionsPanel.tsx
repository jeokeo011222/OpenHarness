import { useState, type ReactNode } from 'react'
import type { OntologyVersionDiff, OntologyVersionStatus, OntologyVersionSummary } from '../types.ts'
import type { Translate } from './Inspector.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import styles from './workbench.module.css'

/** Props of the version timeline. */
export interface VersionsPanelProps {
  readonly versions: readonly OntologyVersionSummary[]
  readonly diff: OntologyVersionDiff | null
  readonly busyVersion: string | null
  readonly deletingVersion: string | null
  readonly t: Translate
  readonly onPublish: (version: string) => void
  readonly onSubmitReview: (version: string) => void
  readonly onCompare: (from: string, to: string) => void
  readonly onDelete: (version: string, force: boolean) => void
}

/**
 * Localized label of one review state.
 * @param t - locale translator.
 * @param status - review state.
 * @returns the localized status label.
 */
function statusLabel(t: Translate, status: OntologyVersionStatus): string {
  if (status === 'draft') return t('statusDraft')
  return status === 'review' ? t('statusReview') : t('statusPublished')
}

/** Render one difference list. */
function DiffList({ title, entries }: { readonly title: string; readonly entries: readonly string[] }): ReactNode {
  if (entries.length === 0) return null
  return (
    <div className={styles.diffBlock}>
      <div className={styles.diffTitle}>{title} ({entries.length})</div>
      <ul className={styles.diffList}>
        {entries.map(entry => <li key={entry}>{entry}</li>)}
      </ul>
    </div>
  )
}

/**
 * Version timeline: publish a reviewed snapshot, submit a draft for review, or
 * compare two snapshots.
 *
 * @param props - versions, current diff, busy marker, copy, and callbacks.
 */
export function VersionsPanel({
  versions,
  diff,
  busyVersion,
  deletingVersion,
  t,
  onPublish,
  onSubmitReview,
  onCompare,
  onDelete,
}: VersionsPanelProps): ReactNode {
  const [from, setFrom] = useState(versions.at(1)?.version ?? '')
  const [to, setTo] = useState(versions.at(0)?.version ?? '')
  const [confirming, setConfirming] = useState<string | null>(null)

  return (
    <section className={styles.versions}>
      <h3 className={styles.sectionTitle}>{t('versions')}</h3>
      {versions.some(version => version.status !== 'published') && <p className={styles.hint}>{t('publishHint')}</p>}
      {versions.length === 0
        ? <p className={styles.hint}>{t('noVersions')}</p>
        : (
          <ul className={styles.versionList}>
            {versions.map(version => (
              <li key={version.version} className={styles.versionItem}>
                <div className={styles.versionMain}>
                  <span className={styles.versionName}>{`${t('versionPrefix')}${version.version}`}</span>
                  <span className={styles.versionStatus} data-status={version.status}>{statusLabel(t, version.status)}</span>
                  {version.active && <span className={styles.badge}>{t('active')}</span>}
                  <span className={styles.versionMeta}>
                    {version.nodeCount} {t('nodeCount')} · {version.edgeCount} {t('edgeCount')}
                    {version.createdAt.length > 0 ? ` · ${version.createdAt.slice(0, 16).replace('T', ' ')}` : ''}
                  </span>
                </div>
                {version.note.length > 0 && <div className={styles.versionNote}>{version.note}</div>}
                <div className={styles.versionActions}>
                  {version.status === 'draft' && (
                    <button
                      type="button"
                      className={styles.button}
                      disabled={busyVersion !== null || deletingVersion !== null}
                      onClick={() => { onSubmitReview(version.version) }}
                    >
                      {busyVersion === version.version ? t('reviewing') : t('submitReview')}
                    </button>
                  )}
                  {version.status !== 'draft' && !version.active && (
                    <button
                      type="button"
                      className={styles.button}
                      disabled={busyVersion !== null || deletingVersion !== null}
                      onClick={() => { onPublish(version.version) }}
                    >
                      {busyVersion === version.version ? t('publishing') : t('publish')}
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.button}
                    disabled={busyVersion !== null || deletingVersion !== null}
                    onClick={() => {
                      if (version.active) setConfirming(version.version)
                      else onDelete(version.version, false)
                    }}
                  >
                    {deletingVersion === version.version ? t('deleting') : t('remove')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

      {versions.length > 1 && (
        <div className={styles.compareRow}>
          <span className={styles.hint}>{t('compareHint')}</span>
          <select className={styles.input} value={from} onChange={(event) => { setFrom(event.target.value) }}>
            {versions.map(version => <option key={version.version} value={version.version}>{`${t('versionPrefix')}${version.version}`}</option>)}
          </select>
          <select className={styles.input} value={to} onChange={(event) => { setTo(event.target.value) }}>
            {versions.map(version => <option key={version.version} value={version.version}>{`${t('versionPrefix')}${version.version}`}</option>)}
          </select>
          <button
            type="button"
            className={styles.button}
            disabled={from.length === 0 || to.length === 0 || from === to}
            onClick={() => { onCompare(from, to) }}
          >
            {t('compare')}
          </button>
        </div>
      )}

      {diff !== null && (
        <div className={styles.diff}>
          <div className={styles.diffHead}>{`${t('versionPrefix')}${diff.from} → ${t('versionPrefix')}${diff.to}`}</div>
          {diff.addedNodes.length + diff.removedNodes.length + diff.addedEdges.length + diff.removedEdges.length === 0
            ? <p className={styles.hint}>{t('noDiff')}</p>
            : (
              <>
                <DiffList title={t('addedNodes')} entries={diff.addedNodes} />
                <DiffList title={t('removedNodes')} entries={diff.removedNodes} />
                <DiffList title={t('addedEdges')} entries={diff.addedEdges} />
                <DiffList title={t('removedEdges')} entries={diff.removedEdges} />
              </>
            )}
        </div>
      )}

      {confirming !== null && (
        <ConfirmDialog
          title={t('deleteVersionTitle')}
          message={t('deleteVersionActiveHint')}
          confirmLabel={t('confirmDelete')}
          cancelLabel={t('cancel')}
          busy={deletingVersion !== null}
          onConfirm={() => {
            onDelete(confirming, true)
            setConfirming(null)
          }}
          onCancel={() => { setConfirming(null) }}
        />
      )}
    </section>
  )
}
