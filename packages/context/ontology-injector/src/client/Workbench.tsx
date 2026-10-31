import { useEffect, useState, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AuditEntry,
  OntologyDomainSummary,
  OntologyEdit,
  OntologyGraph,
  OntologyHealth,
  OntologyPatch,
  OntologyVersionDiff,
  OntologyVersionSummary,
  QualityReport,
  SparqlResult,
  ValidationReport,
} from '../types.ts'
import type { OntologyStoreFace } from './face.ts'
import { messageOf, unwrap, StoreCallError } from './face.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { GraphCanvas } from './GraphCanvas.tsx'
import { Inspector, type Translate } from './Inspector.tsx'
import { OntologyIcon } from './OntologyIcon.tsx'
import { domainRowDescription } from './domain-copy.ts'
import { AuditPanel, HealthLine, PatchDialog, QualityPanel, SparqlConsole, ValidationPanel } from './panels.tsx'
import { AnalyticsPanel } from './AnalyticsPanel.tsx'
import { RetrievalPanel } from './RetrievalPanel.tsx'
import { VersionsPanel } from './VersionsPanel.tsx'
import seatCss from './domain-seat.module.css'
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

/** Save one text file through a temporary object URL. */
function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/turtle' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/**
 * Five-tab ontology center: the domain list with create/rename/disable actions,
 * the graph workbench with the canvas, inspector and version timeline, the
 * metric analysis board, the retrieval verification panel, and the audit trail.
 * Upload-and-generate lives in the create dialog.
 *
 * @param props - Remote face and copy.
 */
export function Workbench({ store, t }: WorkbenchProps): ReactNode {
  const [tab, setTab] = useState<'ontologies' | 'graph' | 'analysis' | 'retrieval' | 'audit'>('ontologies')
  const [domains, setDomains] = useState<OntologyDomainSummary[]>([])
  const [activeDomain, setActiveDomain] = useState<string | null>(null)
  const [graph, setGraph] = useState<OntologyGraph | null>(null)
  const [versions, setVersions] = useState<OntologyVersionSummary[]>([])
  const [diff, setDiff] = useState<OntologyVersionDiff | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [draftId, setDraftId] = useState('')
  const [draftLabel, setDraftLabel] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createFileName, setCreateFileName] = useState('')
  const [createContentBase64, setCreateContentBase64] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [health, setHealth] = useState<OntologyHealth | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [pendingDelete, setPendingDelete] = useState<OntologyDomainSummary | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importDomain, setImportDomain] = useState('')
  const [importNote, setImportNote] = useState('')
  const [importFileName, setImportFileName] = useState('')
  const [importText, setImportText] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const [validation, setValidation] = useState<ValidationReport | null>(null)
  const [validationOpen, setValidationOpen] = useState(false)
  const [sparqlOpen, setSparqlOpen] = useState(false)
  const [patchOpen, setPatchOpen] = useState(false)
  const [qualityOpen, setQualityOpen] = useState(false)
  /** Side column holds the inspector and version list; collapsing it gives the graph the whole width. */
  const [sideOpen, setSideOpen] = useState(true)
  /** Scope dropdown in the header, open state only. */
  const [scopeOpen, setScopeOpen] = useState(false)

  const activeSummary = domains.find(item => item.id === activeDomain) ?? null

  const refreshDomains = async (): Promise<OntologyDomainSummary[]> => {
    const [listed, snapshot] = await Promise.all([store.listDomains(), store.health()])
    const list = unwrap(listed)
    setDomains(list)
    setHealth(unwrap(snapshot))
    return list
  }

  const refreshAudit = async (): Promise<void> => {
    setAudit(unwrap(await store.auditLog(50)))
  }

  useEffect(() => {
    const live = { value: true }
    void (async () => {
      try {
        const [listed, snapshot, entries] = await Promise.all([
          store.listDomains(),
          store.health(),
          store.auditLog(50),
        ])
        if (!live.value) return
        const list = unwrap(listed)
        setDomains(list)
        setHealth(unwrap(snapshot))
        setAudit(unwrap(entries))
        setActiveDomain(current => current ?? list.at(0)?.id ?? null)
      } catch (failure) {
        if (live.value) setError(messageOf(failure))
      }
    })()
    return () => { live.value = false }
  }, [store])

  useEffect(() => {
    if (tab !== 'audit') return undefined
    const live = { value: true }
    void refreshAudit().catch((failure: unknown) => {
      if (live.value) setError(messageOf(failure))
    })
    return () => { live.value = false }
    // Audit entries change after metric runs in the analysis tab.
  }, [tab])

  useEffect(() => {
    if (!importOpen) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && busy === null) setImportOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [importOpen, busy])

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
        setValidation(null)
        setValidationOpen(false)
        setSparqlOpen(false)
        setPatchOpen(false)
        setQualityOpen(false)
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

  const openCreate = (): void => {
    setDraftId('')
    setDraftLabel('')
    setCreateFileName('')
    setCreateContentBase64('')
    setCreateError(null)
    setCreatedId(null)
    setCreateOpen(true)
  }

  const closeCreate = (): void => {
    if (busy !== null) return
    setCreateOpen(false)
  }

  const pickCreateFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    if (file.size > MAX_UPLOAD_BYTES) {
      setCreateError(`${file.name}: ${file.size} > ${MAX_UPLOAD_BYTES}`)
      return
    }
    setCreateError(null)
    setCreateFileName(file.name)
    setCreateContentBase64(await readBase64(file))
  }

  /**
   * Create the drafted domain and, when a document is attached, generate its
   * first ontology in the same dialog. A domain already created by a failed
   * generate attempt is reused so a retry only repeats the generation.
   *
   * @param withDocument - also upload the attached document and generate.
   */
  const submitCreate = async (withDocument: boolean): Promise<void> => {
    const id = draftId.trim()
    if (id.length === 0) return
    setCreateError(null)
    setBusy(withDocument ? 'create-generate' : 'create')
    try {
      if (createdId !== id) {
        unwrap(await store.createDomain(id, draftLabel.trim() || id))
        setCreatedId(id)
        await refreshDomains()
      }
      if (withDocument) {
        const result = unwrap(await store.generate({
          domain: id,
          label: draftLabel.trim() || id,
          fileName: createFileName,
          contentBase64: createContentBase64,
        }))
        setActiveDomain(id)
        setWarnings([...result.warnings])
        await refreshDomains()
        setCreateOpen(false)
        setTab('graph')
      } else {
        setCreateOpen(false)
      }
      await refreshAudit()
    } catch (failure) {
      setCreateError(messageOf(failure))
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
      await refreshAudit()
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
      await refreshAudit()
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

  const analyzeDomain = (domain: OntologyDomainSummary): void => {
    setActiveDomain(domain.id)
    setTab('analysis')
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
      await refreshAudit()
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(null)
    }
  }

  const applyPatch = async (patch: OntologyPatch): Promise<void> => {
    if (activeDomain === null) return
    setBusy('patch')
    setError(null)
    try {
      const result = unwrap(await store.applyPatch(activeDomain, patch))
      setGraph(result.graph)
      if (result.warnings.length > 0) setWarnings([...result.warnings])
      if (result.graph.nodes.every(node => node.id !== selectedId)) setSelectedId(null)
      setVersions(unwrap(await store.listVersions(activeDomain)))
      setPatchOpen(false)
      await refreshDomains()
      await refreshAudit()
    } finally {
      setBusy(null)
    }
  }

  const evaluate = async (goldTurtle: string, baselineName: string): Promise<QualityReport> => {
    const domain = activeDomain
    if (domain === null) throw new StoreCallError('ontology/not-found', t('selectDomain'))
    const outcome = unwrap(await store.evaluateQuality(domain, goldTurtle, baselineName))
    await refreshAudit()
    return outcome
  }

  const submitReview = async (version: string): Promise<void> => {
    if (activeDomain === null) return
    setBusy(`submit-review:${version}`)
    setError(null)
    try {
      setVersions(unwrap(await store.submitReview(activeDomain, version)))
      await refreshDomains()
      await refreshAudit()
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(null)
    }
  }

  const publish = async (version: string): Promise<void> => {
    if (activeDomain === null) return
    setBusy(`publish:${version}`)
    setError(null)
    try {
      setVersions(unwrap(await store.publishVersion(activeDomain, version)))
      setGraph(unwrap(await store.graph(activeDomain)))
      setDiff(null)
      await refreshDomains()
      await refreshAudit()
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

  const reloadAll = async (): Promise<void> => {
    setError(null)
    try {
      await refreshDomains()
      await refreshAudit()
    } catch (failure) {
      report(failure)
    }
  }

  const downloadDomain = async (domain: OntologyDomainSummary): Promise<void> => {
    setBusy(`export:${domain.id}`)
    setError(null)
    try {
      const turtle = unwrap(await store.exportDomain(domain.id, 'text/turtle'))
      downloadText(`${domain.id}.ttl`, turtle)
      await refreshAudit()
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(null)
    }
  }

  const openImport = (): void => {
    setImportDomain(activeDomain ?? domains.at(0)?.id ?? '')
    setImportNote('')
    setImportFileName('')
    setImportText('')
    setImportError(null)
    setImportOpen(true)
  }

  const closeImport = (): void => {
    if (busy !== null) return
    setImportOpen(false)
  }

  const pickImportFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    try {
      setImportError(null)
      setImportFileName(file.name)
      setImportText(await file.text())
    } catch (failure) {
      setImportError(messageOf(failure))
    }
  }

  const submitImport = async (): Promise<void> => {
    const id = importDomain.trim()
    if (id.length === 0 || importText.length === 0 || importNote.trim().length === 0) return
    setImportError(null)
    setBusy('import')
    try {
      const imported = unwrap(await store.importOntology(id, importText, importNote.trim()))
      setActiveDomain(id)
      setGraph(imported)
      setSelectedId(null)
      setVersions(unwrap(await store.listVersions(id)))
      setDiff(null)
      setImportOpen(false)
      setTab('graph')
      await refreshDomains()
      await refreshAudit()
    } catch (failure) {
      setImportError(messageOf(failure))
    } finally {
      setBusy(null)
    }
  }

  const confirmDeleteDomain = async (): Promise<void> => {
    const target = pendingDelete
    if (target === null) return
    setBusy(`delete:${target.id}`)
    setError(null)
    try {
      unwrap(await store.deleteDomain(target.id))
      setPendingDelete(null)
      const list = await refreshDomains()
      await refreshAudit()
      if (activeDomain === target.id) {
        setActiveDomain(list.at(0)?.id ?? null)
        setGraph(null)
        setVersions([])
        setSelectedId(null)
      }
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(null)
    }
  }

  const removeVersion = async (version: string, force: boolean): Promise<void> => {
    if (activeDomain === null) return
    setBusy(`delete-version:${version}`)
    setError(null)
    try {
      setVersions(unwrap(await store.deleteVersion(activeDomain, version, force)))
      setGraph(unwrap(await store.graph(activeDomain)))
      setDiff(null)
      setSelectedId(null)
      await refreshDomains()
      await refreshAudit()
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(null)
    }
  }

  const runValidation = async (): Promise<void> => {
    if (activeDomain === null) return
    setBusy('validate')
    setError(null)
    try {
      const outcome = unwrap(await store.validateDomain(activeDomain))
      setValidation(outcome)
      setValidationOpen(true)
      await refreshAudit()
    } catch (failure) {
      report(failure)
    } finally {
      setBusy(null)
    }
  }

  const runSparql = async (sparql: string): Promise<SparqlResult> => {
    const domain = activeDomain
    if (domain === null) throw new StoreCallError('ontology/not-found', t('selectDomain'))
    return unwrap(await store.queryDomain(domain, sparql))
  }

  const graphSignature = graph === null ? '' : `${graph.domain}:${graph.version ?? ''}:${graph.nodes.length}:${graph.edges.length}`
  const versionsSignature = versions.map(item => item.version).join(',')

  // Every tab is scoped to one domain, so the scope is chosen from the header
  // rather than from the list tab: leaving the current view to change the
  // domain and coming back is how a page hides its own scope control.
  const scopeItems: MenuEntry[] = domains.map((domain): MenuEntry => ({
    id: domain.id,
    disabled: domain.disabled,
    label: (
      <span className={seatCss.item}>
        <span className={seatCss.itemName}>{domain.label}</span>
        <span className={seatCss.itemDesc}>
          {domain.disabled ? t('selectorDisabled') : domainRowDescription(domain, t)}
        </span>
      </span>
    ),
  }))

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>{t('title')}</h1>
          <p className={styles.subtitle}>{t('subtitle')}</p>
        </div>
        <div className={styles.headerActions}>
          {domains.length > 0 && (
            <Menu
              open={scopeOpen}
              onClose={() => { setScopeOpen(false) }}
              items={scopeItems}
              selectedId={activeDomain ?? undefined}
              onSelect={(id) => { setScopeOpen(false); setActiveDomain(id) }}
              align="end"
              portal
              minWidthFromAnchor
              className={seatCss.anchor}
              anchor={(
                <button
                  type="button"
                  className={seatCss.seat}
                  aria-haspopup="menu"
                  aria-expanded={scopeOpen}
                  title={activeSummary === null ? t('selectDomain') : domainRowDescription(activeSummary, t)}
                  onClick={() => { setScopeOpen(value => !value) }}
                >
                  <span className={seatCss.seatIcon}><OntologyIcon size={16} /></span>
                  <span className={seatCss.seatLabel}>{activeSummary?.label ?? t('selectDomain')}</span>
                  <IconChevronDownOutlineRegular className={seatCss.chevron} />
                </button>
              )}
            />
          )}
          <button type="button" className={styles.button} onClick={() => { void reloadAll() }}>
            {t('reload')}
          </button>
        </div>
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
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'analysis'}
          className={`${styles.tab}${tab === 'analysis' ? ` ${styles.tabActive}` : ''}`}
          onClick={() => { setTab('analysis') }}
        >
          {t('tabAnalysis')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'retrieval'}
          className={`${styles.tab}${tab === 'retrieval' ? ` ${styles.tabActive}` : ''}`}
          onClick={() => { setTab('retrieval') }}
        >
          {t('tabRetrieval')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'audit'}
          className={`${styles.tab}${tab === 'audit' ? ` ${styles.tabActive}` : ''}`}
          onClick={() => { setTab('audit') }}
        >
          {t('tabAudit')}
        </button>
      </div>

      {tab === 'retrieval' && (
        <RetrievalPanel
          store={store}
          t={t}
          domain={activeDomain}
          onNeedDomain={() => { setTab('ontologies') }}
        />
      )}

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
                            <button type="button" className={styles.button} onClick={() => { analyzeDomain(domain) }}>
                              {t('analyze')}
                            </button>
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
                            <button
                              type="button"
                              className={styles.button}
                              disabled={busy !== null}
                              onClick={() => { void downloadDomain(domain) }}
                            >
                              {busy === `export:${domain.id}` ? t('exporting') : t('export')}
                            </button>
                            <button
                              type="button"
                              className={styles.button}
                              disabled={busy !== null}
                              onClick={() => { setPendingDelete(domain) }}
                            >
                              {t('remove')}
                            </button>
                          </>
                        )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          <p className={styles.hint}>{t('disableHint')}</p>

          <HealthLine health={health} t={t} />

          <div className={styles.addSection}>
            <div className={styles.actions}>
              <button type="button" className={styles.buttonPrimary} onClick={openCreate}>{t('newDomain')}</button>
              <button type="button" className={styles.button} disabled={busy !== null} onClick={openImport}>
                {t('importLabel')}
              </button>
            </div>
          </div>
        </section>
      )}

      {tab === 'analysis' && (
        <AnalyticsPanel
          store={store}
          domain={activeDomain}
          label={activeSummary?.label ?? activeDomain ?? ''}
          t={t}
        />
      )}

      {tab === 'audit' && (
        <section className={styles.listBody}>
          <AuditPanel entries={audit} t={t} />
        </section>
      )}

      {createOpen && (
        <div className={styles.overlay} role="presentation">
          <div className={styles.mask} aria-hidden="true" onClick={closeCreate} />
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={t('newDomain')}>
            <h2 className={styles.dialogTitle}>{t('newDomain')}</h2>
            {createError !== null && (
              <div className={styles.errorBanner} role="alert">
                <span>{t('errorPrefix')}{createError}</span>
              </div>
            )}
            <div className={styles.form}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('domainId')}</span>
                <input className={styles.input} value={draftId} onChange={(event) => { setDraftId(event.target.value) }} />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('domainLabel')}</span>
                <input className={styles.input} value={draftLabel} onChange={(event) => { setDraftLabel(event.target.value) }} />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('upload')}</span>
                <input
                  className={styles.fileInput}
                  type="file"
                  accept=".docx,.pdf,.md,.markdown,.txt"
                  onChange={(event) => { void pickCreateFile(event.target.files?.[0]) }}
                />
              </label>
              {createFileName.length > 0 && <p className={styles.fileName}>{createFileName}</p>}
              <p className={styles.hint}>{t('uploadHint')}</p>
              <p className={styles.hint}>{t('generateHint')}</p>
            </div>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.button} disabled={busy !== null} onClick={closeCreate}>
                {t('cancel')}
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={busy !== null || draftId.trim().length === 0}
                onClick={() => { void submitCreate(false) }}
              >
                {busy === 'create' ? t('creating') : t('create')}
              </button>
              <button
                type="button"
                className={styles.buttonPrimary}
                disabled={busy !== null || draftId.trim().length === 0 || createContentBase64.length === 0}
                onClick={() => { void submitCreate(true) }}
              >
                {busy === 'create-generate' ? t('generating') : t('generate')}
              </button>
            </div>
          </div>
        </div>
      )}

      {importOpen && (
        <div className={styles.overlay} role="presentation">
          <div className={styles.mask} aria-hidden="true" onClick={closeImport} />
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={t('importLabel')}>
            <h2 className={styles.dialogTitle}>{t('importLabel')}</h2>
            {importError !== null && (
              <div className={styles.errorBanner} role="alert">
                <span>{t('errorPrefix')}{importError}</span>
              </div>
            )}
            <div className={styles.form}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('domainId')}</span>
                <input
                  className={styles.input}
                  value={importDomain}
                  onChange={(event) => { setImportDomain(event.target.value) }}
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('importFile')}</span>
                <input
                  className={styles.fileInput}
                  type="file"
                  accept=".ttl,text/turtle"
                  onChange={(event) => { void pickImportFile(event.target.files?.[0]) }}
                />
              </label>
              {importFileName.length > 0 && <p className={styles.fileName}>{importFileName}</p>}
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('importNote')}</span>
                <input
                  className={styles.input}
                  value={importNote}
                  onChange={(event) => { setImportNote(event.target.value) }}
                />
              </label>
              <p className={styles.hint}>{t('importHint')}</p>
            </div>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.button} disabled={busy !== null} onClick={closeImport}>
                {t('cancel')}
              </button>
              <button
                type="button"
                className={styles.buttonPrimary}
                disabled={busy !== null
                  || importDomain.trim().length === 0
                  || importNote.trim().length === 0
                  || importText.length === 0}
                onClick={() => { void submitImport() }}
              >
                {busy === 'import' ? t('importing') : t('importLabel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDelete !== null && (
        <ConfirmDialog
          title={t('deleteDomainTitle')}
          message={`${pendingDelete.id} · ${t('deleteDomainHint')}`}
          confirmLabel={t('confirmDelete')}
          cancelLabel={t('cancel')}
          busy={busy !== null}
          onConfirm={() => { void confirmDeleteDomain() }}
          onCancel={() => { if (busy === null) setPendingDelete(null) }}
        />
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
                    <button type="button" className={styles.button} disabled={busy !== null} onClick={() => { void runValidation() }}>
                      {busy === 'validate' ? t('validating') : t('validate')}
                    </button>
                    <button
                      type="button"
                      className={styles.button}
                      aria-expanded={patchOpen}
                      onClick={() => { setPatchOpen(open => !open) }}
                    >
                      {t('patchLabel')}
                    </button>
                    <button
                      type="button"
                      className={styles.button}
                      aria-expanded={qualityOpen}
                      onClick={() => { setQualityOpen(open => !open) }}
                    >
                      {t('qualityLabel')}
                    </button>
                    <button
                      type="button"
                      className={styles.button}
                      aria-expanded={sparqlOpen}
                      onClick={() => { setSparqlOpen(open => !open) }}
                    >
                      {t('sparqlConsole')}
                    </button>
                    <button type="button" className={styles.button} onClick={() => { setTab('ontologies') }}>
                      {t('tabOntologies')}
                    </button>
                    <button
                      type="button"
                      className={styles.button}
                      aria-expanded={sideOpen}
                      onClick={() => { setSideOpen(open => !open) }}
                    >
                      {sideOpen ? t('hideSidebar') : t('showSidebar')}
                    </button>
                  </div>
                </div>
                <p className={styles.hint}>{t('graphHint')}</p>

                {validation !== null && validationOpen && (
                  <ValidationPanel
                    report={validation}
                    onClose={() => { setValidationOpen(false) }}
                    t={t}
                  />
                )}

                {sparqlOpen && (
                  <SparqlConsole
                    onRun={runSparql}
                    onClose={() => { setSparqlOpen(false) }}
                    t={t}
                  />
                )}

                {patchOpen && (
                  <PatchDialog
                    onApply={applyPatch}
                    onClose={() => { if (busy === null) setPatchOpen(false) }}
                    busy={busy !== null}
                    t={t}
                  />
                )}

                {qualityOpen && (
                  <QualityPanel
                    onEvaluate={evaluate}
                    onClose={() => { setQualityOpen(false) }}
                    t={t}
                  />
                )}

                <div className={`${styles.graphBody}${sideOpen ? '' : ` ${styles.graphBodyCollapsed}`}`}>
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
                            t={t}
                          />
                        </div>
                      )}

                    {warnings.length > 0 && (
                      <div className={styles.log}>
                        <h4 className={styles.sectionTitle}>{t('warnings')}</h4>
                        <ul className={styles.stepList}>
                          {warnings.map((warning, index) => (
                            <li key={`warn-${index}`} className={styles.step}>{warning}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </main>

                  {sideOpen && (
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
                        busyVersion={busy !== null && (busy.startsWith('publish:') || busy.startsWith('submit-review:'))
                          ? busy.slice(busy.indexOf(':') + 1)
                          : null}
                        deletingVersion={busy !== null && busy.startsWith('delete-version:') ? busy.slice('delete-version:'.length) : null}
                        t={t}
                        onPublish={(version) => { void publish(version) }}
                        onSubmitReview={(version) => { void submitReview(version) }}
                        onCompare={(from, to) => { void compare(from, to) }}
                        onDelete={(version, force) => { void removeVersion(version, force) }}
                      />
                    </div>
                  )}
                </div>
              </>
            )}
        </section>
      )}
    </div>
  )
}
