import { useEffect, useState, type ReactNode } from 'react'
import type { OntologyEdit, OntologyGraph, OntologyVersionDiff, OntologyVersionSummary, OntologyDomainSummary, GenerationStep, GenerateRequest } from '../types.ts'
import type { OntologyStoreFace } from './face.ts'
import { messageOf, unwrap } from './face.ts'
import { GraphCanvas } from './GraphCanvas.tsx'
import { Inspector, type Translate } from './Inspector.tsx'
import { VersionsPanel } from './VersionsPanel.tsx'
import styles from './workbench.module.css'

/** Largest document the browser forwards to the Host. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/** Props of the ontology workbench page. */
export interface WorkbenchProps {
  readonly store: OntologyStoreFace
  readonly t: Translate
}

/** Read one file as base64 without spreading megabytes into one call. */
async function readBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192))
  }
  return btoa(binary)
}

/** Status glyph for one generation stage. */
function stepGlyph(status: GenerationStep['status']): string {
  if (status === 'done') return '✓'
  if (status === 'failed') return '✗'
  return '–'
}

/**
 * Two-tab ontology center: the domain list with create/rename/disable actions,
 * and the graph workbench with upload-and-generate, the canvas, the inspector,
 * and the version timeline.
 *
 * @param props - Remote face and copy.
 */
export function Workbench({ store, t }: WorkbenchProps): ReactNode {
  const [tab, setTab] = useState<'ontologies' | 'graph'>('ontologies')
  const [domains, setDomains] = useState<OntologyDomainSummary[]>([])
  const [activeDomain, setActiveDomain] = useState<string | null>(null)
  const [graph, setGraph] = useState<OntologyGraph | null>(null)
  const [versions, setVersions] = useState<OntologyVersionSummary[]>([])
  const [diff, setDiff] = useState<OntologyVersionDiff | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [contentBase64, setContentBase64] = useState('')
  const [steps, setSteps] = useState<GenerationStep[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [draftId, setDraftId] = useState('')
  const [draftLabel, setDraftLabel] = useState('')
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')

  const activeSummary = domains.find(item => item.id === activeDomain) ?? null

  const refreshDomains = async (): Promise<OntologyDomainSummary[]> => {
    const list = unwrap(await store.listDomains())
    setDomains(list)
    return list
  }

  useEffect(() => {
    const live = { value: true }
    void (async () => {
      try {
        const list = unwrap(await store.listDomains())
        if (!live.value) return
        setDomains(list)
        setActiveDomain(current => current ?? list.at(0)?.id ?? null)
      } catch (failure) {
        if (live.value) setError(messageOf(failure))
      }
    })()
    return () => { live.value = false }
  }, [store])

  useEffect(() => {
    if (activeDomain === null) {
      setGraph(null)
      setVersions([])
      return
    }
    const live = { value: true }
    void (async () => {
      try {
        const [loadedGraph, loadedVersions] = await Promise.all([
          store.graph(activeDomain),
          store.listVersions(activeDomain),
        ])
        if (!live.value) return
        setGraph(unwrap(loadedGraph))
        setVersions(unwrap(loadedVersions))
        setSelectedId(null)
        setDiff(null)
      } catch (failure) {
        if (live.value) setError(messageOf(failure))
      }
    })()
    return () => { live.value = false }
  }, [store, activeDomain])

  const report = (failure: unknown): void => {
    setError(messageOf(failure))
  }

  const reloadGraph = async (domain: string): Promise<void> => {
    setGraph(unwrap(await store.graph(domain)))
    setVersions(unwrap(await store.listVersions(domain)))
  }

  const createDomain = async (): Promise<void> => {
    const id = draftId.trim()
    if (id.length === 0) return
    setCreating(true)
    setBusy('create')
    setError(null)
    try {
      unwrap(await store.createDomain(id, draftLabel.trim() || id))
      await refreshDomains()
      setActiveDomain(id)
      setDraftId('')
      setDraftLabel('')
      setCreating(false)
      setTab('graph')
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(null)
    }
  }

  const beginEdit = (domain: OntologyDomainSummary): void => {
    setEditingId(domain.id)
    setEditLabel(domain.label)
  }

  const submitEdit = async (): Promise<void> => {
    if (editingId === null) return
    const label = editLabel.trim()
    if (label.length === 0) return
    setBusy(`update:${editingId}`)
    setError(null)
    try {
      await store.updateDomain(editingId, { label })
      await refreshDomains()
      if (activeDomain === editingId) await reloadGraph(editingId)
      setEditingId(null)
      setEditLabel('')
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(null)
    }
  }

  const toggleDisabled = async (domain: OntologyDomainSummary): Promise<void> => {
    setBusy(`update:${domain.id}`)
    setError(null)
    try {
      await store.updateDomain(domain.id, { disabled: !domain.disabled })
      await refreshDomains()
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(null)
    }
  }

  const viewDomain = (domain: OntologyDomainSummary): void => {
    setActiveDomain(domain.id)
    setTab('graph')
  }

  const pickFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`${file.name}: ${file.size} > ${MAX_UPLOAD_BYTES}`)
      return
    }
    setFileName(file.name)
    setContentBase64(await readBase64(file))
  }

  const generate = async (): Promise<void> => {
    if (activeDomain === null || contentBase64.length === 0) return
    setBusy('generate')
    setError(null)
    setSteps([])
    setWarnings([])
    try {
      const request: GenerateRequest = {
        domain: activeDomain,
        label: activeSummary?.label ?? activeDomain,
        fileName,
        contentBase64,
      }
      const result = unwrap(await store.generate(request))
      setGraph(result.graph)
      setSteps([...result.steps])
      setWarnings([...result.warnings])
      setSelectedId(null)
      const loadedVersions = unwrap(await store.listVersions(activeDomain))
      setVersions(loadedVersions)
      await refreshDomains()
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(null)
    }
  }

  const applyEdits = async (edits: OntologyEdit[]): Promise<void> => {
    if (activeDomain === null) return
    setBusy('edit')
    setError(null)
    try {
      const result = unwrap(await store.applyEdits(activeDomain, edits))
      setGraph(result.graph)
      if (result.warnings.length > 0) setWarnings([...result.warnings])
      if (result.graph.nodes.every(node => node.id !== selectedId)) setSelectedId(null)
      setVersions(unwrap(await store.listVersions(activeDomain)))
      await refreshDomains()
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(null)
    }
  }

  const activate = async (version: string): Promise<void> => {
    if (activeDomain === null) return
    setBusy(`activate:${version}`)
    setError(null)
    try {
      setGraph(unwrap(await store.activateVersion(activeDomain, version)))
      setVersions(unwrap(await store.listVersions(activeDomain)))
      setDiff(null)
      await refreshDomains()
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(null)
    }
  }

  const compare = async (from: string, to: string): Promise<void> => {
    if (activeDomain === null) return
    setError(null)
    try {
      setDiff(unwrap(await store.diffVersions(activeDomain, from, to)))
    } catch (failure) {
      report(failure)
    }
  }

  const graphSignature = graph === null ? '' : `${graph.domain}:${graph.version ?? ''}:${graph.nodes.length}:${graph.edges.length}`
  const versionsSignature = versions.map(item => item.version).join(',')

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{t('title')}</h1>
          <p className={styles.subtitle}>{t('subtitle')}</p>
        </div>
        <button type="button" className={styles.button} onClick={() => { void refreshDomains() }}>
          {t('reload')}
        </button>
      </header>

      {error !== null && (
        <div className={styles.errorBanner} role="alert">
          <span>{t('errorPrefix')}{error}</span>
          <button type="button" className={styles.button} onClick={() => { setError(null) }}>{t('dismiss')}</button>
        </div>
      )}

      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'ontologies'}
          className={`${styles.tab}${tab === 'ontologies' ? ` ${styles.tabActive}` : ''}`}
          onClick={() => { setTab('ontologies') }}
        >
          {t('tabOntologies')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'graph'}
          className={`${styles.tab}${tab === 'graph' ? ` ${styles.tabActive}` : ''}`}
          onClick={() => { setTab('graph') }}
        >
          {t('tabGraph')}
        </button>
      </div>

      {tab === 'ontologies' && (
        <section className={styles.listBody}>
          {domains.length === 0
            ? <p className={styles.hint}>{t('noDomains')}</p>
            : (
              <ul className={styles.domainList}>
                {domains.map(domain => (
                  <li key={domain.id} className={styles.domainRow}>
                    <div className={styles.domainRowMain}>
                      {editingId === domain.id
                        ? (
                          <input
                            className={styles.input}
                            value={editLabel}
                            onChange={(event) => { setEditLabel(event.target.value) }}
                          />
                        )
                        : (
                          <span className={styles.domainName}>
                            {domain.label}
                            {domain.disabled && <span className={styles.statusDisabled}>{t('statusDisabled')}</span>}
                          </span>
                        )}
                      <span className={styles.domainMeta}>
                        {domain.id}
                        {' · '}
                        {domain.version === null ? '' : `${t('versionPrefix')}${domain.version} · `}
                        {domain.nodeCount} {t('nodeCount')} · {domain.edgeCount} {t('edgeCount')} · {domain.versionCount} {t('versionCount')}
                      </span>
                    </div>
                    <div className={styles.domainActions}>
                      {editingId === domain.id
                        ? (
                          <>
                            <button
                              type="button"
                              className={styles.buttonPrimary}
                              disabled={busy !== null || editLabel.trim().length === 0}
                              onClick={() => { void submitEdit() }}
                            >
                              {busy === `update:${domain.id}` ? t('saving') : t('save')}
                            </button>
                            <button type="button" className={styles.button} onClick={() => { setEditingId(null) }}>{t('cancel')}</button>
                          </>
                        )
                        : (
                          <>
                            <button type="button" className={styles.button} onClick={() => { viewDomain(domain) }}>
                              {t('view')}
                            </button>
                            <button type="button" className={styles.button} onClick={() => { beginEdit(domain) }}>
                              {t('edit')}
                            </button>
                            <button
                              type="button"
                              className={styles.button}
                              disabled={busy !== null}
                              onClick={() => { void toggleDisabled(domain) }}
                            >
                              {busy === `update:${domain.id}`
                                ? t('saving')
                                : domain.disabled ? t('enable') : t('disable')}
                            </button>
                          </>
                        )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          <p className={styles.hint}>{t('disableHint')}</p>

          <div className={styles.addSection}>
            {creating
              ? (
                <div className={styles.form}>
                  <h4 className={styles.sectionTitle}>{t('newDomain')}</h4>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>{t('domainId')}</span>
                    <input className={styles.input} value={draftId} onChange={(event) => { setDraftId(event.target.value) }} />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>{t('domainLabel')}</span>
                    <input className={styles.input} value={draftLabel} onChange={(event) => { setDraftLabel(event.target.value) }} />
                  </label>
                  <div className={styles.actions}>
                    <button type="button" className={styles.buttonPrimary} disabled={busy !== null} onClick={() => { void createDomain() }}>
                      {busy === 'create' ? t('creating') : t('create')}
                    </button>
                    <button type="button" className={styles.button} onClick={() => { setCreating(false) }}>{t('cancel')}</button>
                  </div>
                </div>
              )
              : (
                <button type="button" className={styles.buttonPrimary} onClick={() => { setCreating(true) }}>{t('newDomain')}</button>
              )}
          </div>
        </section>
      )}

      {tab === 'graph' && (
        <section className={styles.panel}>
          {activeDomain === null || activeSummary === null
            ? <p className={styles.hint}>{t('selectDomain')}</p>
            : (
              <>
                <div className={styles.toolbar}>
                  <div className={styles.toolbarMain}>
                    <h3 className={styles.sectionTitle}>
                      {activeSummary.label}
                      {activeSummary.disabled && <span className={styles.statusDisabled}>{t('statusDisabled')}</span>}
                    </h3>
                    <span className={styles.domainMeta}>
                      {activeSummary.version === null ? '' : `${t('versionPrefix')}${activeSummary.version} · `}
                      {activeSummary.nodeCount} {t('nodeCount')} · {activeSummary.edgeCount} {t('edgeCount')}
                    </span>
                  </div>
                  <div className={styles.toolbarActions}>
                    <input
                      className={styles.fileInput}
                      type="file"
                      accept=".docx,.pdf,.md,.markdown,.txt"
                      onChange={(event) => { void pickFile(event.target.files?.[0]) }}
                    />
                    <button
                      type="button"
                      className={styles.buttonPrimary}
                      disabled={busy !== null || contentBase64.length === 0}
                      onClick={() => { void generate() }}
                    >
                      {busy === 'generate' ? t('generating') : t('generate')}
                    </button>
                    <button type="button" className={styles.button} onClick={() => { setTab('ontologies') }}>
                      {t('tabOntologies')}
                    </button>
                  </div>
                </div>
                {fileName.length > 0 && <p className={styles.fileName}>{fileName}</p>}
                <p className={styles.hint}>{t('uploadHint')}</p>
                <p className={styles.hint}>{t('graphHint')}</p>

                <div className={styles.graphBody}>
                  <main className={styles.main}>
                    {graph === null || graph.nodes.length === 0
                      ? <p className={styles.hint}>{t('graphEmpty')}</p>
                      : (
                        <div className={styles.graphWrap}>
                          <GraphCanvas
                            key={graphSignature}
                            graph={graph}
                            selectedId={selectedId}
                            onSelect={setSelectedId}
                          />
                        </div>
                      )}

                    {(steps.length > 0 || warnings.length > 0) && (
                      <div className={styles.log}>
                        {steps.length > 0 && (
                          <>
                            <h4 className={styles.sectionTitle}>{t('steps')}</h4>
                            <ul className={styles.stepList}>
                              {steps.map((step, index) => (
                                <li key={`${step.stage}-${index}`} className={styles.step}>
                                  <span className={styles.stepGlyph}>{stepGlyph(step.status)}</span>
                                  <span>{step.message}</span>
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                        {warnings.length > 0 && (
                          <>
                            <h4 className={styles.sectionTitle}>{t('warnings')}</h4>
                            <ul className={styles.stepList}>
                              {warnings.map((warning, index) => (
                                <li key={`warn-${index}`} className={styles.step}>{warning}</li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                    )}
                  </main>

                  <div className={styles.side}>
                    <Inspector
                      key={`inspector:${selectedId ?? 'none'}`}
                      graph={graph ?? { domain: '', label: '', namespace: '', version: null, nodes: [], edges: [], turtle: '' }}
                      selectedId={selectedId}
                      busy={busy !== null}
                      t={t}
                      onApply={(edits) => { void applyEdits(edits) }}
                    />
                    <VersionsPanel
                      key={`versions:${versionsSignature}`}
                      versions={versions}
                      diff={diff}
                      busyVersion={busy !== null && busy.startsWith('activate:') ? busy.slice('activate:'.length) : null}
                      t={t}
                      onActivate={(version) => { void activate(version) }}
                      onCompare={(from, to) => { void compare(from, to) }}
                    />
                  </div>
                </div>
              </>
            )}
        </section>
      )}
    </div>
  )
}
