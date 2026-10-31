/**
 * Retrieval verification panel: one question, every stage laid out in order.
 *
 * The panel shows what the pipeline actually did, not a summary of it: the
 * SPARQL that ran, each tier's contribution and the reason a tier stayed
 * silent, the clauses that were dropped and why, and the gate verdict. If a
 * number appears here it came from the same run that produced the answer.
 *
 * The plain-vector baseline sits at the bottom with the **same** compatibility
 * filter applied. Comparing against an unfiltered baseline would only prove that
 * filtering helps, which nobody doubts; the interesting question is whether the
 * ontology supplies a filter worth having.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type {
  ChunkLibraryStats,
  RankedChunk,
  TraceExample,
  TraceResult,
} from '../types.ts'
import { messageOf, unwrap, type OntologyStoreFace } from './face.ts'
import type { Translate } from './Inspector.tsx'
import styles from './retrieval.module.css'

/** Props of the retrieval tab. */
export interface RetrievalPanelProps {
  readonly store: OntologyStoreFace
  readonly t: Translate
  /** Domain under inspection; `null` disables the tab. */
  readonly domain: string | null
  /** Called when the user wants to pick a domain first. */
  readonly onNeedDomain: () => void
}

/** One tier badge colour. */
function tierClass(tier: string): string {
  if (tier === 'graph') return styles.tierGraph ?? ''
  if (tier === 'keyword') return styles.tierKeyword ?? ''
  return styles.tierVector ?? ''
}

/**
 * Render the retrieval verification tab.
 *
 * @param props - store face, copy, and the active domain.
 * @returns the tab contents.
 */
export function RetrievalPanel({ store, t, domain, onNeedDomain }: RetrievalPanelProps): ReactNode {
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TraceResult | null>(null)
  const [stats, setStats] = useState<ChunkLibraryStats | null>(null)
  const [examples, setExamples] = useState<TraceExample[]>([])
  const [showSparql, setShowSparql] = useState(false)

  // A new scope is a new corpus: the previous run's tiers, gate verdict and
  // answer all describe a domain that is no longer on screen, and showing them
  // beside the new scope reads as a result for that scope.
  useEffect(() => {
    setResult(null)
    setError(null)
  }, [domain])

  useEffect(() => {
    if (domain === null) {
      setStats(null)
      return undefined
    }
    // A mutable box, not a closure variable: `let cancelled = false` narrows to
    // the literal `false` at every read, so the guard would be typed away.
    const live = { value: true }
    void (async () => {
      try {
        const next = unwrap(await store.retrievalLibrary(domain))
        if (live.value) setStats(next)
      } catch {
        if (live.value) setStats(null)
      }
    })()
    return () => { live.value = false }
  }, [store, domain])

  useEffect(() => {
    const live = { value: true }
    void (async () => {
      try {
        const list = unwrap(await store.retrievalExamples())
        if (live.value) setExamples(list)
      } catch {
        // Examples are convenience copy; losing them must not break the tab.
      }
    })()
    return () => { live.value = false }
  }, [store])

  const run = async (text: string): Promise<void> => {
    if (domain === null || text.trim().length < 2) return
    setBusy(true)
    setError(null)
    try {
      const next = unwrap(await store.retrievalTrace(domain, text.trim(), 5))
      setResult(next)
    } catch (failure) {
      setError(messageOf(failure))
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  if (domain === null) {
    return (
      <div className={styles.empty}>
        <p>{t('retrievalNoDomain')}</p>
        <button type="button" className={styles.button} onClick={onNeedDomain}>{t('tabOntologies')}</button>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.askRow}>
        <input
          className={styles.input}
          value={question}
          placeholder={t('retrievalPlaceholder')}
          onChange={(event) => { setQuestion(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter' && !busy) void run(question) }}
        />
        <button type="button" className={styles.primary} disabled={busy || question.trim().length < 2} onClick={() => { void run(question) }}>
          {busy ? t('retrievalRunning') : t('retrievalAsk')}
        </button>
      </div>

      <div className={styles.metaRow}>
        <span className={styles.meta}>{t('retrievalDocs')} {stats?.documents ?? 0}</span>
        <span className={styles.meta}>{t('retrievalChunks')} {stats?.chunks ?? 0}</span>
        <span className={styles.meta}>{t('retrievalClasses')} {stats?.classes.length ?? 0}</span>
        <span className={styles.spacer} />
        {examples.map(item => (
          <button
            key={item.question}
            type="button"
            className={styles.chip}
            title={item.note}
            onClick={() => { setQuestion(item.question); void run(item.question) }}
          >
            {item.question}
          </button>
        ))}
      </div>

      {error !== null && <div className={styles.error}>{error}</div>}

      {result === null
        ? <div className={styles.empty}><p>{t('retrievalEmpty')}</p></div>
        : <ResultView result={result} t={t} showSparql={showSparql} onToggleSparql={() => { setShowSparql(value => !value) }} />}
    </div>
  )
}

/** Props of the result block. */
interface ResultViewProps {
  readonly result: TraceResult
  readonly t: Translate
  readonly showSparql: boolean
  readonly onToggleSparql: () => void
}

/**
 * Render one traced run.
 *
 * @param props - trace, copy, and SPARQL disclosure state.
 * @returns the result sections.
 */
function ResultView({ result, t, showSparql, onToggleSparql }: ResultViewProps): ReactNode {
  const retrieval = result.retrieval
  return (
    <div className={styles.result}>
      {result.blocked && (
        <div className={styles.blocked}>
          <strong>{t('retrievalBlocked')}</strong>
          <span>{result.blockReason}</span>
        </div>
      )}
      {result.error.length > 0 && <div className={styles.warn}>{result.error}</div>}

      <Section title={t('retrievalIntent')} note={`${result.totalMs.toFixed(0)} ms`}>
        <div className={styles.intentGrid}>
          <Field label={t('retrievalClassLabel')} value={result.parsed?.classes.join('、') ?? ''} />
          <Field label={t('retrievalPropertyLabel')} value={result.parsed?.properties.join('、') ?? ''} />
          <Field label={t('retrievalIdLabel')} value={result.parsed?.identifiers.join('、') ?? ''} />
        </div>
        <div className={styles.stages}>
          {result.stages.map(stage => (
            <span key={stage.stage} className={styles.stage}>
              {stage.stage} · {stage.ms.toFixed(0)}ms · {stage.note}
            </span>
          ))}
        </div>
      </Section>

      <Section title={t('retrievalTiers')} note={`${retrieval?.items.length ?? 0}`}>
        <div className={styles.tierReport}>
          {(retrieval?.tiers ?? []).map(tier => (
            <div key={tier.tier} className={tier.ran ? styles.tierRow : `${styles.tierRow} ${styles.tierMuted}`}>
              <span className={`${styles.badge} ${tierClass(tier.tier)}`}>{tier.tier}</span>
              <span className={styles.tierReason}>{tier.reason}</span>
              <span className={styles.tierCount}>{tier.candidates}</span>
            </div>
          ))}
        </div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('retrievalColClause')}</th>
              <th>{t('retrievalColTier')}</th>
              <th>{t('retrievalColScore')}</th>
              <th>{t('retrievalColReason')}</th>
            </tr>
          </thead>
          <tbody>
            {(retrieval?.items ?? []).map(item => <EvidenceRow key={item.chunk.chunkId} item={item} />)}
          </tbody>
        </table>
        {(retrieval?.dropped.length ?? 0) > 0 && (
          <div className={styles.dropped}>
            <span className={styles.droppedTitle}>{t('retrievalDropped')}</span>
            {(retrieval?.dropped ?? []).map(item => (
              <span key={item.chunkId} className={styles.droppedItem}>{item.chunkId}：{item.reason}</span>
            ))}
          </div>
        )}
      </Section>

      {(retrieval?.facts.length ?? 0) > 0 && (
        <Section title={t('retrievalFacts')} note={`${retrieval?.facts.length ?? 0}`}>
          <ul className={styles.facts}>
            {(retrieval?.facts ?? []).slice(0, 8).map(fact => <li key={fact.label}>{fact.label}</li>)}
          </ul>
        </Section>
      )}

      <Section
        title={t('retrievalSparql')}
        note={showSparql ? t('retrievalHide') : t('retrievalShow')}
        onClick={onToggleSparql}
      >
        {showSparql && <pre className={styles.code}>{retrieval?.sparql.query ?? ''}</pre>}
      </Section>

      <Section title={t('retrievalGate')} note={result.gate === null ? '-' : `${result.gate.checked}`}>
        {result.gate === null
          ? <div className={styles.muted}>{t('retrievalGateSkipped')}</div>
          : (
            <>
              <div className={result.gate.conforms ? styles.pass : styles.fail}>
                {result.gate.conforms ? t('retrievalGatePass') : t('retrievalGateFail')}
              </div>
              {result.gate.violations.map((violation, index) => (
                <div key={`${violation.shape}-${index}`} className={styles.violation}>
                  <span className={styles.violationShape}>{violation.shape}</span>
                  <span>{violation.message}</span>
                  <span className={styles.violationNode}>{violation.focusNode}</span>
                </div>
              ))}
              {result.gate.errors.map(text => <div key={text} className={styles.warn}>{text}</div>)}
            </>
          )}
      </Section>

      <Section title={t('retrievalAnswer')} note={result.provider}>
        <pre className={styles.answer}>{result.answer}</pre>
      </Section>

      <Section title={t('retrievalChain')} note={`${result.chain.length}`}>
        <ol className={styles.chain}>
          {result.chain.map((step, index) => (
            <li key={`${step.kind}-${index}`}>
              <span className={styles.chainKind}>{step.title}</span>
              <span>{step.detail}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section title={t('retrievalBaseline')} note={result.baseline.ran ? 'vector' : '-'}>
        <div className={styles.muted}>{result.baseline.note}</div>
        <div className={styles.baselineRow}>
          {result.baseline.topK.map(id => <span key={id} className={styles.kept}>{id}</span>)}
          {result.baseline.incompatible.map(id => <span key={id} className={styles.incompatible}>{id}</span>)}
        </div>
      </Section>
    </div>
  )
}

/** One evidence row. */
function EvidenceRow({ item }: { readonly item: RankedChunk }): ReactNode {
  return (
    <tr>
      <td>
        <div className={styles.clauseTitle}>{item.chunk.docTitle} {item.chunk.clauseNo}</div>
        <div className={styles.clauseText}>{item.chunk.text.replace(/\s+/g, ' ').slice(0, 180)}</div>
      </td>
      <td>{item.tiers.map(tier => <span key={tier} className={`${styles.badge} ${tierClass(tier)}`}>{tier}</span>)}</td>
      <td className={styles.score}>{item.finalScore.toFixed(3)}</td>
      <td className={styles.reasonCell}>{item.reasons.join('；')}</td>
    </tr>
  )
}

/** A labelled section with an optional trailing note. */
function Section({ title, note, onClick, children }: {
  readonly title: string
  readonly note?: string
  readonly onClick?: () => void
  readonly children: ReactNode
}): ReactNode {
  return (
    <section className={styles.section}>
      <header
        className={onClick === undefined ? styles.sectionHead : `${styles.sectionHead} ${styles.clickable}`}
        onClick={onClick}
      >
        <span className={styles.sectionTitle}>{title}</span>
        {note !== undefined && note.length > 0 && <span className={styles.sectionNote}>{note}</span>}
      </header>
      {children}
    </section>
  )
}

/** One labelled value. */
function Field({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldValue}>{value.length > 0 ? value : '—'}</span>
    </div>
  )
}
