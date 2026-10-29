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
 * Domain rail, upload-and-generate form, graph canvas, inspector, and versions.
 *
 * @param props - Remote face and copy.
 */
export function Workbench({ store, t }: WorkbenchProps): ReactNode {
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
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(null)
    }
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

      <div className={styles.body}>
        <aside className={styles.rail}>
          <h3 className={styles.sectionTitle}>{t('domains')}</h3>
          {domains.length === 0
            ? <p className={styles.hint}>{t('noDomains')}</p>
            : (
              <ul className={styles.domainList}>
                {domains.map(domain => (
                  <li key={domain.id}>
                    <button
                      type="button"
                      className={`${styles.domainItem}${domain.id === activeDomain ? ` ${styles.domainActive}` : ''}`}
                      onClick={() => { setActiveDomain(domain.id) }}
                    >
                      <span className={styles.domainName}>{domain.label}</span>
                      <span className={styles.domainMeta}>
                        {domain.version === null ? '' : `${t('versionPrefix')}${domain.version} · `}
                        {domain.nodeCount} {t('nodeCount')} · {domain.edgeCount} {t('edgeCount')} · {domain.versionCount} {t('versionCount')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

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
                <button type="button" className={styles.button} onClick={() => { setCreating(true) }}>{t('newDomain')}</button>
              )}
          </div>

          {activeDomain !== null && (
            <div className={styles.addSection}>
              <h3 className={styles.sectionTitle}>{t('upload')}</h3>
              <p className={styles.hint}>{t('uploadHint')}</p>
              <input
                className={styles.fileInput}
                type="file"
                accept=".docx,.pdf,.md,.markdown,.txt"
                onChange={(event) => { void pickFile(event.target.files?.[0]) }}
              />
              {fileName.length > 0 && <p className={styles.fileName}>{fileName}</p>}
              <button
                type="button"
                className={styles.buttonPrimary}
                disabled={busy !== null || contentBase64.length === 0}
                onClick={() => { void generate() }}
              >
                {busy === 'generate' ? t('generating') : t('generate')}
              </button>
              <p className={styles.hint}>{t('generateHint')}</p>
            </div>
          )}
        </aside>

        <main className={styles.main}>
          <h3 className={styles.sectionTitle}>{t('graph')}</h3>
          <p className={styles.hint}>{t('graphHint')}</p>
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
    </div>
  )
}
