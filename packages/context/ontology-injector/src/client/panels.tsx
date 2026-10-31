/**
 * Read-only workbench panels: store health, audit trail, structural validation,
 * and the read-only SPARQL console. Every panel receives copy through `t`.
 */

import { useState, type ReactNode } from 'react'
import type {
  AuditAction,
  AuditEntry,
  OntologyHealth,
  OntologyPatch,
  QualityReport,
  SparqlResult,
  ValidationIssue,
  ValidationReport,
} from '../types.ts'
import type { Translate } from './Inspector.tsx'
import type { LocaleDict } from './locales.ts'
import { messageOf } from './face.ts'
import styles from './workbench.module.css'

/** Locale key for each audited action. */
const ACTION_KEYS: Record<AuditAction, keyof LocaleDict> = {
  'domain-create': 'auditActionDomainCreate',
  'domain-update': 'auditActionDomainUpdate',
  'domain-delete': 'auditActionDomainDelete',
  'generate': 'auditActionGenerate',
  'edit': 'auditActionEdit',
  'patch': 'auditActionPatch',
  'version-create': 'auditActionVersionCreate',
  'version-review': 'auditActionVersionReview',
  'version-activate': 'auditActionVersionActivate',
  'version-publish': 'auditActionVersionPublish',
  'version-delete': 'auditActionVersionDelete',
  'import': 'auditActionImport',
  'export': 'auditActionExport',
  'validate': 'auditActionValidate',
  'quality': 'auditActionQuality',
  'metric-run': 'auditActionMetricRun',
  'instance-import': 'auditActionInstanceImport',
  'instance-clear': 'auditActionInstanceClear',
  'object-sync': 'auditActionObjectSync',
  'action-propose': 'auditActionActionPropose',
  'action-commit': 'auditActionActionCommit',
  'compliance-run': 'auditActionComplianceRun',
  'shapes-import': 'auditActionShapesImport',
}

/** Props of the store health line. */
export interface HealthLineProps {
  readonly health: OntologyHealth | null
  readonly t: Translate
}

/**
 * One line of store totals: domains, triples, versions, and the format version.
 *
 * @param props - the health snapshot and copy.
 * @returns the badge line, or nothing before the first read.
 */
export function HealthLine({ health, t }: HealthLineProps): ReactNode {
  if (health === null) return null
  const triples = health.domains.reduce((sum, stats) => sum + stats.tripleCount, 0)
  const versions = health.domains.reduce((sum, stats) => sum + stats.versionCount, 0)
  return (
    <p className={styles.health}>
      <span className={styles.healthLabel}>{t('health')}</span>
      <span>
        {health.domains.length} {t('domains')}
        {' · '}
        {triples} {t('triples')}
        {' · '}
        {versions} {t('versions')}
        {' · '}
        {t('formatVersion')} {health.formatVersion}
      </span>
    </p>
  )
}

/** Props of the audit trail. */
export interface AuditPanelProps {
  readonly entries: readonly AuditEntry[]
  readonly t: Translate
}

/**
 * Audit list with time, action, domain, and detail columns.
 *
 * @param props - newest-first entries and copy.
 * @returns the section.
 */
export function AuditPanel({ entries, t }: AuditPanelProps): ReactNode {
  return (
    <section className={styles.panelSection}>
      <h3 className={styles.sectionTitle}>{`${t('auditLog')} (${entries.length})`}</h3>
      {entries.length === 0
        ? <p className={styles.hint}>{t('auditEmpty')}</p>
        : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('auditTime')}</th>
                  <th scope="col">{t('auditAction')}</th>
                  <th scope="col">{t('auditDomain')}</th>
                  <th scope="col">{t('auditDetail')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => (
                  <tr key={`${entry.at}:${index}`}>
                    <td>{entry.at.slice(0, 16).replace('T', ' ')}</td>
                    <td>{t(ACTION_KEYS[entry.action])}</td>
                    <td>{entry.domain}</td>
                    <td>{entry.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      <p className={styles.hint}>{t('auditHint')}</p>
    </section>
  )
}

/** Props of one validation issue row. */
interface IssueItemProps {
  readonly issue: ValidationIssue
  readonly severity: 'error' | 'warning'
}

/** One validation issue: code, message, and the entity it names. */
function IssueItem({ issue, severity }: IssueItemProps): ReactNode {
  return (
    <li className={`${styles.issue} ${severity === 'error' ? styles.issueError : styles.issueWarning}`}>
      <code className={styles.issueCode}>{issue.code}</code>
      <span>{issue.message}</span>
      {issue.subject !== undefined && <span className={styles.issueSubject}>{issue.subject}</span>}
    </li>
  )
}

/** Props of the structural validation panel. */
export interface ValidationPanelProps {
  readonly report: ValidationReport
  readonly onClose: () => void
  readonly t: Translate
}

/**
 * Validation result with hard errors and advisory warnings.
 *
 * @param props - the report, close action, and copy.
 * @returns the section.
 */
export function ValidationPanel({ report, onClose, t }: ValidationPanelProps): ReactNode {
  const empty = report.errors.length === 0 && report.warnings.length === 0
  return (
    <section className={styles.panelSection}>
      <div className={styles.panelHead}>
        <h3 className={styles.sectionTitle}>
          {`${t('validation')} · ${report.errors.length} ${t('validationErrors')} · ${report.warnings.length} ${t('validationWarnings')}`}
        </h3>
        <button type="button" className={styles.button} onClick={onClose}>{t('close')}</button>
      </div>
      {empty
        ? <p className={styles.hint}>{t('validationPassed')}</p>
        : (
          <ul className={styles.issueList}>
            {report.errors.map((issue, index) => <IssueItem key={`error:${index}`} issue={issue} severity="error" />)}
            {report.warnings.map((issue, index) => <IssueItem key={`warning:${index}`} issue={issue} severity="warning" />)}
          </ul>
        )}
    </section>
  )
}

/** Props of the read-only SPARQL console. */
export interface SparqlConsoleProps {
  /** Runs one query and resolves with its result table or ASK answer. */
  readonly onRun: (sparql: string) => Promise<SparqlResult>
  readonly onClose: () => void
  readonly t: Translate
}

/**
 * Read-only SPARQL console: query textarea, run action, and the result table.
 *
 * @param props - query runner, close action, and copy.
 * @returns the section.
 */
export function SparqlConsole({ onRun, onClose, t }: SparqlConsoleProps): ReactNode {
  const [query, setQuery] = useState(t('sparqlExample'))
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SparqlResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setResult(await onRun(query))
    } catch (failure) {
      setResult(null)
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.panelSection}>
      <div className={styles.panelHead}>
        <h3 className={styles.sectionTitle}>{t('sparqlConsole')}</h3>
        <button type="button" className={styles.button} onClick={onClose}>{t('close')}</button>
      </div>
      <p className={styles.hint}>{t('sparqlReadOnly')}</p>
      <textarea
        className={styles.textarea}
        rows={4}
        value={query}
        aria-label={t('sparqlConsole')}
        placeholder={t('sparqlExample')}
        onChange={(event) => { setQuery(event.target.value) }}
      />
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.buttonPrimary}
          disabled={busy || query.trim().length === 0}
          onClick={() => { void run() }}
        >
          {busy ? t('sparqlRunning') : t('sparqlRun')}
        </button>
      </div>
      {error !== null && (
        <p className={styles.errorLine} role="alert">{t('errorPrefix')}{error}</p>
      )}
      {result !== null && (result.rows.length === 0
        ? <p className={styles.hint}>{t('sparqlEmpty')}</p>
        : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {result.variables.map(variable => <th key={variable} scope="col">{variable}</th>)}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, index) => (
                  <tr key={index}>
                    {result.variables.map(variable => <td key={variable}>{row[variable] ?? ''}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  )
}

/**
 * Narrow a parsed JSON value to a record for field inspection.
 * @param raw - the parsed value.
 * @returns the value as a field record.
 * @throws {Error} when the value is not a JSON object.
 */
function recordOf(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected a JSON object')
  return raw as Record<string, unknown>
}

/**
 * Read an optional string field.
 * @param raw - the enclosing JSON object.
 * @param name - field name.
 * @param fallback - value used when the field is absent.
 * @returns the field string.
 * @throws {Error} when the field is present but not a string.
 */
function textField(raw: Record<string, unknown>, name: string, fallback = ''): string {
  const value = raw[name]
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

/**
 * Read an optional string-array field.
 * @param raw - the enclosing JSON object.
 * @param name - field name.
 * @returns the field strings, empty when the field is absent.
 * @throws {Error} when the field is present but not a string array.
 */
function textList(raw: Record<string, unknown>, name: string): readonly string[] {
  const value = raw[name]
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`${name} must be an array of strings`)
  }
  return value
}

/**
 * Read an optional array-of-objects field.
 * @param raw - the enclosing JSON object.
 * @param name - field name.
 * @returns the field objects, empty when the field is absent.
 * @throws {Error} when the field is present but not an array of objects.
 */
function objectList(raw: Record<string, unknown>, name: string): Record<string, unknown>[] {
  const value = raw[name]
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value.map(item => recordOf(item))
}

/**
 * Validate pasted JSON against the patch wire type.
 *
 * This is the user-input boundary, so every field is checked before the patch
 * reaches the Host.
 * @param text - pasted JSON text.
 * @returns the validated patch.
 * @throws {Error} when the text is not a JSON patch object.
 */
export function parsePatch(text: string): OntologyPatch {
  const raw: unknown = JSON.parse(text)
  const root = recordOf(raw)
  const classes = objectList(root, 'classes').map((item) => {
    const id = textField(item, 'id')
    if (id.length === 0) throw new Error('class id must not be empty')
    return {
      id,
      label: textField(item, 'label', id),
      comment: textField(item, 'comment'),
      parents: textList(item, 'parents'),
    }
  })
  const properties = objectList(root, 'properties').map((item) => {
    const id = textField(item, 'id')
    if (id.length === 0) throw new Error('property id must not be empty')
    const rawKind = textField(item, 'kind', 'object')
    if (rawKind !== 'object' && rawKind !== 'datatype') throw new Error('property kind must be object or datatype')
    const kind: 'object' | 'datatype' = rawKind === 'object' ? 'object' : 'datatype'
    return {
      id,
      kind,
      label: textField(item, 'label', id),
      comment: textField(item, 'comment'),
      domain: textField(item, 'domain'),
      range: textField(item, 'range'),
    }
  })
  return {
    classes,
    properties,
    removeClasses: textList(root, 'removeClasses'),
    removeProperties: textList(root, 'removeProperties'),
  }
}

/** Props of the incremental patch dialog. */
export interface PatchDialogProps {
  /** Applies one validated patch and resolves when the Host accepted it. */
  readonly onApply: (patch: OntologyPatch) => Promise<void>
  readonly onClose: () => void
  readonly busy: boolean
  readonly t: Translate
}

/**
 * JSON patch editor: validates pasted JSON, applies it, and reports failures
 * inline without closing.
 *
 * @param props - apply handler, close action, busy flag, and copy.
 * @returns the section.
 */
export function PatchDialog({ onApply, onClose, busy, t }: PatchDialogProps): ReactNode {
  const [text, setText] = useState(t('patchExample'))
  const [error, setError] = useState<string | null>(null)

  const apply = async (): Promise<void> => {
    setError(null)
    let patch: OntologyPatch
    try {
      patch = parsePatch(text)
    } catch (failure) {
      setError(`${t('patchInvalid')}${messageOf(failure)}`)
      return
    }
    try {
      await onApply(patch)
    } catch (failure) {
      setError(messageOf(failure))
    }
  }

  return (
    <section className={styles.panelSection}>
      <div className={styles.panelHead}>
        <h3 className={styles.sectionTitle}>{t('patchLabel')}</h3>
        <button type="button" className={styles.button} disabled={busy} onClick={onClose}>{t('close')}</button>
      </div>
      <p className={styles.hint}>{t('patchHint')}</p>
      <textarea
        className={styles.textarea}
        rows={8}
        value={text}
        aria-label={t('patchLabel')}
        onChange={(event) => { setText(event.target.value) }}
      />
      {error !== null && (
        <p className={styles.errorLine} role="alert">{t('errorPrefix')}{error}</p>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.buttonPrimary}
          disabled={busy || text.trim().length === 0}
          onClick={() => { void apply() }}
        >
          {busy ? t('patching') : t('patchApply')}
        </button>
      </div>
    </section>
  )
}

/** Props of the gold-standard quality panel. */
export interface QualityPanelProps {
  /** Scores the current graph against the uploaded baseline. */
  readonly onEvaluate: (goldTurtle: string, baselineName: string) => Promise<QualityReport>
  readonly onClose: () => void
  readonly t: Translate
}

/** One family row of the quality table. */
interface QualityRowProps {
  readonly label: string
  readonly metric: QualityReport['classes']
  readonly t: Translate
}

/** Percent label for one ratio. */
function percentOf(value: number): string {
  return `${Math.round(value * 100)}%`
}

/** One precision/recall row with its differing identifiers. */
function QualityRow({ label, metric, t }: QualityRowProps): ReactNode {
  return (
    <>
      <tr>
        <td>{label}</td>
        <td>{`${percentOf(metric.precision)} (${metric.matched}/${metric.actual})`}</td>
        <td>{`${percentOf(metric.recall)} (${metric.matched}/${metric.expected})`}</td>
      </tr>
      {metric.missing.length > 0 && (
        <tr>
          <td />
          <td colSpan={2} className={styles.hint}>{t('qualityMissing')}: {metric.missing.join(', ')}</td>
        </tr>
      )}
      {metric.unexpected.length > 0 && (
        <tr>
          <td />
          <td colSpan={2} className={styles.hint}>{t('qualityUnexpected')}: {metric.unexpected.join(', ')}</td>
        </tr>
      )}
    </>
  )
}

/**
 * Gold-standard evaluation panel: upload a baseline Turtle file and compare the
 * current graph's classes and properties against it.
 *
 * @param props - evaluate handler, close action, and copy.
 * @returns the section.
 */
export function QualityPanel({ onEvaluate, onClose, t }: QualityPanelProps): ReactNode {
  const [baseline, setBaseline] = useState('')
  const [baselineName, setBaselineName] = useState('')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<QualityReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pick = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    setError(null)
    setReport(null)
    try {
      setBaseline(await file.text())
      setBaselineName(file.name)
    } catch (failure) {
      setError(messageOf(failure))
    }
  }

  const evaluate = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setReport(await onEvaluate(baseline, baselineName))
    } catch (failure) {
      setReport(null)
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.panelSection}>
      <div className={styles.panelHead}>
        <h3 className={styles.sectionTitle}>{t('qualityLabel')}</h3>
        <button type="button" className={styles.button} disabled={busy} onClick={onClose}>{t('close')}</button>
      </div>
      <p className={styles.hint}>{t('qualityHint')}</p>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('qualityBaseline')}</span>
        <input
          className={styles.fileInput}
          type="file"
          accept=".ttl,text/turtle"
          onChange={(event) => { void pick(event.target.files?.[0]) }}
        />
      </label>
      {baselineName.length > 0 && <p className={styles.fileName}>{baselineName}</p>}
      {error !== null && (
        <p className={styles.errorLine} role="alert">{t('errorPrefix')}{error}</p>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.buttonPrimary}
          disabled={busy || baseline.length === 0}
          onClick={() => { void evaluate() }}
        >
          {busy ? t('qualityRunning') : t('qualityRun')}
        </button>
      </div>
      {report !== null && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{report.baselineName}</th>
                <th scope="col">{t('qualityPrecision')}</th>
                <th scope="col">{t('qualityRecall')}</th>
              </tr>
            </thead>
            <tbody>
              <QualityRow label={t('qualityClasses')} metric={report.classes} t={t} />
              <QualityRow label={t('qualityProperties')} metric={report.properties} t={t} />
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
