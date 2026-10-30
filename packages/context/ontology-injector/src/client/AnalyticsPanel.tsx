/**
 * Analytics tab: the metric catalog, shared filters, metric cards, the
 * drilldown table, and the instance-batch import controls.
 *
 * Reads run through the ontology Store face, so the account grants and audit
 * trail that guard the workbench guard these numbers too.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { MetricDetail, MetricFilters, MetricRun, MetricSummary } from '../analytics-types.ts'
import type { InstanceBatch, OntologyGraphNode } from '../types.ts'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import type { OntologyStoreFace } from './face.ts'
import { messageOf, unwrap } from './face.ts'
import type { Translate } from './Inspector.tsx'
import styles from './workbench.module.css'

/** Props of the analytics tab. */
export interface AnalyticsPanelProps {
  readonly store: OntologyStoreFace
  /** Active domain, or null before one is selected. */
  readonly domain: string | null
  /** Human-readable active domain label. */
  readonly label: string
  readonly t: Translate
}

/** Filter inputs the panel owns, all as ids so a blank field means unset. */
interface FilterDraft {
  class: string
  property: string
}

const EMPTY_FILTERS: FilterDraft = { class: '', property: '' }

/** Turn the draft into wire filters, omitting blank fields. */
function wireFilters(draft: FilterDraft): MetricFilters {
  return {
    ...(draft.class.trim() === '' ? {} : { class: draft.class.trim() }),
    ...(draft.property.trim() === '' ? {} : { property: draft.property.trim() }),
  }
}

/** Option text of one ontology node. */
function nodeLabel(node: OntologyGraphNode): string {
  return node.label.length === 0 ? node.id : node.label
}

/** Numeric value of one result cell. */
function numeric(value: string | undefined): number {
  if (value === undefined || value === '') return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Widest bar driver of one result, so each card scales to its own rows. */
function barScale(run: MetricRun): number {
  const pick = run.variables.includes('count') ? 'count' : run.variables.find(name => name === 'amount') ?? 'count'
  return Math.max(1, ...run.rows.map(row => numeric(row[pick])))
}

/** Bar width for one row, as a CSS percentage. */
function barWidth(run: MetricRun, row: Record<string, string>): string {
  const pick = run.variables.includes('count') ? 'count' : run.variables.find(name => name === 'amount') ?? 'count'
  return `${String(Math.max(2, Math.round(numeric(row[pick]) / barScale(run) * 100)))}%`
}

/**
 * Render the analytics tab.
 *
 * @param props - Remote face, active domain, and copy.
 * @returns the tab body.
 */
export function AnalyticsPanel({ store, domain, label, t }: AnalyticsPanelProps): ReactNode {
  const [metrics, setMetrics] = useState<MetricSummary[]>([])
  const [classes, setClasses] = useState<readonly OntologyGraphNode[]>([])
  const [properties, setProperties] = useState<readonly OntologyGraphNode[]>([])
  const [batches, setBatches] = useState<InstanceBatch[]>([])
  const [runs, setRuns] = useState<Record<string, MetricRun>>({})
  const [detail, setDetail] = useState<MetricDetail | null>(null)
  const [detailOf, setDetailOf] = useState<string | null>(null)
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_FILTERS)
  const [batchName, setBatchName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [fileEpoch, setFileEpoch] = useState(0)
  const [pendingBatch, setPendingBatch] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (domain === null) {
      setMetrics([])
      setBatches([])
      setClasses([])
      setProperties([])
      setRuns({})
      return undefined
    }
    const live = { value: true }
    void (async () => {
      try {
        const [catalog, loaded, vocabulary] = await Promise.all([
          store.listMetrics(domain),
          store.listMetricBatches(domain),
          store.graph(domain),
        ])
        if (!live.value) return
        setMetrics(unwrap(catalog))
        setBatches(unwrap(loaded))
        const graph = unwrap(vocabulary)
        setClasses(graph.nodes.filter(node => node.kind === 'class'))
        setProperties(graph.nodes.filter(node => node.kind === 'datatype-property' || node.kind === 'object-property'))
        setDraft(EMPTY_FILTERS)
        setRuns({})
        setDetail(null)
        setDetailOf(null)
      } catch (failure) {
        if (live.value) setError(messageOf(failure))
      }
    })()
    return () => { live.value = false }
  }, [store, domain])

  if (domain === null) {
    return <section className={styles.listBody}><p className={styles.hint}>{t('analysisNoDomain')}</p></section>
  }

  const runOne = async (metricId: string): Promise<void> => {
    setBusy(metricId)
    setError(null)
    try {
      const run = unwrap(await store.runMetric(domain, metricId, wireFilters(draft)))
      setRuns(current => ({ ...current, [run.metricId]: run }))
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(null)
    }
  }

  const refreshBatches = async (): Promise<void> => {
    try {
      setBatches(unwrap(await store.listMetricBatches(domain)))
    } catch (failure) {
      setError(messageOf(failure))
    }
  }

  const runAll = async (): Promise<void> => {
    setBusy('run-all')
    setError(null)
    try {
      const filters = wireFilters(draft)
      const outcomes = await Promise.all(metrics.map(
        async metric => unwrap(await store.runMetric(domain, metric.id, filters)),
      ))
      const next: Record<string, MetricRun> = {}
      for (const outcome of outcomes) next[outcome.metricId] = outcome
      setRuns(next)
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(null)
    }
  }

  const importBatch = async (): Promise<void> => {
    if (file === null) return
    setBusy('import')
    setError(null)
    try {
      const turtle = await file.text()
      unwrap(await store.importInstances(domain, turtle, batchName.trim()))
      setBatchName('')
      setFile(null)
      setFileEpoch(epoch => epoch + 1)
      await Promise.all([refreshBatches(), runAll()])
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(null)
    }
  }

  const deleteBatch = async (): Promise<void> => {
    const batch = pendingBatch
    if (batch === null) return
    setBusy('delete-batch')
    setError(null)
    try {
      setBatches(unwrap(await store.deleteInstanceBatch(domain, batch)))
      setRuns({})
      setDetail(null)
      setDetailOf(null)
      setPendingBatch(null)
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(null)
    }
  }

  const openDetail = async (metricId: string): Promise<void> => {
    setBusy(`detail:${metricId}`)
    setError(null)
    try {
      const found = unwrap(await store.drilldownMetric(domain, metricId, wireFilters(draft), 100))
      setDetail(found)
      setDetailOf(metricId)
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(null)
    }
  }

  const selector = (
    key: keyof FilterDraft,
    labelKey: Parameters<Translate>[0],
    allKey: Parameters<Translate>[0],
    options: readonly OntologyGraphNode[],
  ): ReactNode => (
    <label className={styles.filterField} key={key}>
      <span>{t(labelKey)}</span>
      <select
        className={styles.filterInput}
        value={draft[key]}
        onChange={(event) => { setDraft(current => ({ ...current, [key]: event.target.value })) }}
      >
        <option value="">{t(allKey)}</option>
        {options.map(option => <option key={option.id} value={option.id}>{nodeLabel(option)}</option>)}
      </select>
    </label>
  )

  return (
    <section className={styles.listBody}>
      <div className={styles.analysisBar}>
        <div>
          <h3 className={styles.sectionTitle}>{`${t('analysisTitle')} · ${label}`}</h3>
          <p className={styles.hint}>
            {batches.length === 0
              ? t('analysisNoBatches')
              : `${t('analysisBatches')}：${String(batches.length)}（${batches.map(batch => `${batch.batch}·${String(batch.triples)}`).join('，')}）`}
          </p>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.button} disabled={busy !== null} onClick={() => { void runAll() }}>
            {t('analysisRunAll')}
          </button>
          <button type="button" className={styles.button} disabled={busy !== null} onClick={() => { void refreshBatches() }}>
            {t('reload')}
          </button>
        </div>
      </div>

      <div className={styles.filterRow}>
        {selector('class', 'analysisClass', 'analysisAllClasses', classes)}
        {selector('property', 'analysisProperty', 'analysisAllProperties', properties)}
        <button
          type="button"
          className={styles.button}
          onClick={() => { setDraft(EMPTY_FILTERS); setRuns({}) }}
        >
          {t('analysisClearFilters')}
        </button>
      </div>

      <div className={styles.filterRow}>
        <label className={styles.filterField}>
          <span>{t('analysisBatchName')}</span>
          <input
            className={styles.filterInput}
            value={batchName}
            placeholder={t('analysisBatchHint')}
            onChange={(event) => { setBatchName(event.target.value) }}
          />
        </label>
        <label className={styles.filterField}>
          <span>{t('analysisInstanceFile')}</span>
          <input
            key={String(fileEpoch)}
            type="file"
            accept=".ttl,text/turtle"
            className={styles.filterInput}
            onChange={(event) => { setFile(event.target.files?.[0] ?? null) }}
          />
        </label>
        <button
          type="button"
          className={styles.buttonPrimary}
          disabled={busy !== null || file === null || batchName.trim() === ''}
          onClick={() => { void importBatch() }}
        >
          {busy === 'import' ? t('analysisRunning') : t('analysisImport')}
        </button>
      </div>

      {batches.length > 0 && (
        <ul className={styles.batchList}>
          {batches.map(batch => (
            <li className={styles.batchItem} key={batch.batch}>
              <code>{batch.batch}</code>
              <span className={styles.hint}>{String(batch.triples)}</span>
              <button
                type="button"
                className={styles.button}
                disabled={busy !== null}
                onClick={() => { setPendingBatch(batch.batch) }}
              >
                {t('analysisDeleteBatch')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {pendingBatch !== null && (
        <ConfirmDialog
          title={`${t('analysisDeleteBatch')} · ${pendingBatch}`}
          message={t('analysisDeleteBatchHint')}
          confirmLabel={t('analysisDeleteBatch')}
          cancelLabel={t('cancel')}
          busy={busy === 'delete-batch'}
          onConfirm={() => { void deleteBatch() }}
          onCancel={() => { setPendingBatch(null) }}
        />
      )}

      {error !== null && <p className={styles.errorLine} role="alert">{error}</p>}

      <div className={styles.metricGrid}>
        {metrics.map((metric) => {
          const run = runs[metric.id]
          return (
            <article className={styles.metricCard} key={metric.id}>
              <header className={styles.panelHead}>
                <div>
                  <h4 className={styles.metricTitle}>{metric.title}</h4>
                  <p className={styles.hint}>{metric.description}</p>
                </div>
                <button
                  type="button"
                  className={styles.button}
                  disabled={busy !== null}
                  onClick={() => { void runOne(metric.id) }}
                >
                  {busy === metric.id ? t('analysisRunning') : t('analysisRun')}
                </button>
              </header>

              {run === undefined
                ? <p className={styles.hint}>{t('analysisNotRun')}</p>
                : (
                  <div className={styles.metricBody}>
                    {run.kind === 'scalar' || run.rows.length === 0
                      ? <p className={styles.metricValue}>{run.rows[0]?.value ?? '—'}</p>
                      : (
                        <div className={styles.tableWrap}>
                          <table className={styles.table}>
                            <thead>
                              <tr>{run.variables.map(column => <th key={column} scope="col">{column}</th>)}</tr>
                            </thead>
                            <tbody>
                              {run.rows.map((row, index) => (
                                <tr key={`${metric.id}:${String(index)}`}>
                                  {run.variables.map(column => (
                                    <td key={column}>
                                      {column === 'key'
                                        ? (
                                          <div className={styles.barCell}>
                                            <div className={styles.barTrack}>
                                              <div className={styles.barFill} style={{ width: barWidth(run, row) }} />
                                            </div>
                                            <span>{row[column] ?? '—'}</span>
                                          </div>
                                        )
                                        : row[column] ?? '—'}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    <p className={styles.hint}>
                      {`${String(run.rows.length)} ${t('analysisRows')} · ${String(run.durationMs)}ms`}
                      {run.warnings.length === 0 ? '' : ` · ${run.warnings.join('；')}`}
                    </p>
                    <details className={styles.caveat}>
                      <summary>{t('analysisCaveat')}</summary>
                      <p>{metric.caveat}</p>
                      <p className={styles.hint}>{`${t('analysisRequires')}：${metric.requires.length === 0 ? '—' : metric.requires.join('、')}`}</p>
                      <pre className={styles.sparql}>{run.sparql}</pre>
                    </details>
                    <button
                      type="button"
                      className={styles.button}
                      disabled={busy !== null}
                      onClick={() => { void openDetail(metric.id) }}
                    >
                      {t('analysisDetail')}
                    </button>
                  </div>
                )}
            </article>
          )
        })}
      </div>

      {detail !== null && (
        <section className={styles.panelSection}>
          <div className={styles.panelHead}>
            <h3 className={styles.sectionTitle}>{`${t('analysisDetailTitle')} · ${detailOf ?? detail.metricId}`}</h3>
            <button type="button" className={styles.button} onClick={() => { setDetail(null); setDetailOf(null) }}>
              {t('close')}
            </button>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>{detail.variables.map(column => <th key={column} scope="col">{column}</th>)}</tr>
              </thead>
              <tbody>
                {detail.rows.map((row, index) => (
                  <tr key={`detail:${String(index)}`}>
                    {detail.variables.map(column => <td key={column}>{row[column] ?? '—'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.hint}>
            {`${String(detail.rows.length)} ${t('analysisRows')}${detail.truncated ? ` · ${t('analysisTruncated')}` : ''}`}
          </p>
        </section>
      )}
    </section>
  )
}
