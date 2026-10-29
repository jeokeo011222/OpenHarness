import { useState, type ReactNode } from 'react'
import type { OntologyVersionDiff, OntologyVersionSummary } from '../types.ts'
import type { Translate } from './Inspector.tsx'
import styles from './workbench.module.css'

/** Props of the version timeline. */
export interface VersionsPanelProps {
  readonly versions: readonly OntologyVersionSummary[]
  readonly diff: OntologyVersionDiff | null
  readonly busyVersion: string | null
  readonly t: Translate
  readonly onActivate: (version: string) => void
  readonly onCompare: (from: string, to: string) => void
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
 * Version timeline: activate a snapshot, or compare two snapshots.
 *
 * @param props - versions, current diff, busy marker, copy, and callbacks.
 */
export function VersionsPanel({ versions, diff, busyVersion, t, onActivate, onCompare }: VersionsPanelProps): ReactNode {
  const [from, setFrom] = useState(versions.at(1)?.version ?? '')
  const [to, setTo] = useState(versions.at(0)?.version ?? '')

  return (
    <section className={styles.versions}>
      <h3 className={styles.sectionTitle}>{t('versions')}</h3>
      {versions.length === 0
        ? <p className={styles.hint}>{t('noVersions')}</p>
        : (
          <ul className={styles.versionList}>
            {versions.map(version => (
              <li key={version.version} className={styles.versionItem}>
                <div className={styles.versionMain}>
                  <span className={styles.versionName}>{`${t('versionPrefix')}${version.version}`}</span>
                  {version.active && <span className={styles.badge}>{t('active')}</span>}
                  <span className={styles.versionMeta}>
                    {version.nodeCount} {t('nodeCount')} · {version.edgeCount} {t('edgeCount')}
                    {version.createdAt.length > 0 ? ` · ${version.createdAt.slice(0, 16).replace('T', ' ')}` : ''}
                  </span>
                </div>
                {version.note.length > 0 && <div className={styles.versionNote}>{version.note}</div>}
                {!version.active && (
                  <button
                    type="button"
                    className={styles.button}
                    disabled={busyVersion !== null}
                    onClick={() => { onActivate(version.version) }}
                  >
                    {busyVersion === version.version ? t('activateBusy') : t('activate')}
                  </button>
                )}
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
    </section>
  )
}
