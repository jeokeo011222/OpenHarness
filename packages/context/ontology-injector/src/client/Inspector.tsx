import { useState, type ReactNode } from 'react'
import type { OntologyEdit, OntologyGraph, OntologyGraphNode } from '../types.ts'
import type { LocaleDict } from './locales.ts'
import styles from './workbench.module.css'

/** Translate function bound to the workbench namespace. */
export type Translate = (key: keyof LocaleDict) => string

/** Props of the node and relation inspector. */
export interface InspectorProps {
  readonly graph: OntologyGraph
  readonly selectedId: string | null
  readonly busy: boolean
  readonly t: Translate
  readonly onApply: (edits: OntologyEdit[]) => void
}

/** Node kind label. */
function kindLabel(node: OntologyGraphNode, t: Translate): string {
  if (node.kind === 'class') return t('classKind')
  return node.kind === 'object-property' ? t('objectProperty') : t('datatypeProperty')
}

/**
 * Edit one selected node: label, comment, parents, domain, range.
 *
 * Every change is sent as a single micro-edit; the Host validates and snapshots.
 *
 * @param props - graph, selection, busy flag, copy, and edit sink.
 */
export function Inspector({ graph, selectedId, busy, t, onApply }: InspectorProps): ReactNode {
  const node = graph.nodes.find(item => item.id === selectedId) ?? null
  const [label, setLabel] = useState(node?.label ?? '')
  const [comment, setComment] = useState(node?.comment ?? '')
  const [parents, setParents] = useState(node?.parents.join(', ') ?? '')
  const [domain, setDomain] = useState(node?.domain ?? '')
  const [range, setRange] = useState(node?.range ?? '')
  const [draft, setDraft] = useState<'none' | 'class' | 'property'>('none')
  const [newId, setNewId] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newKind, setNewKind] = useState<'object' | 'datatype'>('object')
  const [newDomain, setNewDomain] = useState('')
  const [newRange, setNewRange] = useState('')

  const classes = graph.nodes.filter(item => item.kind === 'class')

  const save = (): void => {
    if (!node) return
    if (node.kind === 'class') {
      onApply([{
        op: 'update-class',
        id: node.id,
        label,
        comment,
        parents: parents.split(/[,，\s]+/).map(item => item.trim()).filter(item => item.length > 0),
      }])
      return
    }
    onApply([{
      op: 'update-property',
      id: node.id,
      label,
      comment,
      domain,
      range,
    }])
  }

  const submitNew = (): void => {
    if (draft === 'class') {
      onApply([{ op: 'add-class', id: newId.trim(), label: newLabel.trim() || newId.trim(), comment: '' }])
    } else if (draft === 'property') {
      onApply([{
        op: 'add-property',
        id: newId.trim(),
        kind: newKind,
        label: newLabel.trim() || newId.trim(),
        comment: '',
        domain: newDomain,
        range: newKind === 'datatype' && newRange.trim().length === 0 ? 'xsd:string' : newRange.trim(),
      }])
    }
    setDraft('none')
    setNewId('')
    setNewLabel('')
  }

  return (
    <aside className={styles.inspector}>
      <div className={styles.inspectorHeader}>
        <h3 className={styles.sectionTitle}>{t('inspector')}</h3>
      </div>

      {node === null
        ? <p className={styles.hint}>{t('inspectorEmpty')}</p>
        : (
          <div className={styles.form}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('nodeKind')}</span>
              <input className={styles.input} value={kindLabel(node, t)} readOnly />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('nodeId')}</span>
              <input className={styles.input} value={node.id} readOnly />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('nodeLabel')}</span>
              <input className={styles.input} value={label} onChange={(event) => { setLabel(event.target.value) }} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('nodeComment')}</span>
              <textarea className={styles.textarea} value={comment} onChange={(event) => { setComment(event.target.value) }} rows={3} />
            </label>
            {node.kind === 'class'
              ? (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('nodeParents')}</span>
                  <input
                    className={styles.input}
                    value={parents}
                    onChange={(event) => { setParents(event.target.value) }}
                  />
                </label>
              )
              : (
                <>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>{t('nodeDomain')}</span>
                    <select className={styles.input} value={domain} onChange={(event) => { setDomain(event.target.value) }}>
                      <option value="" />
                      {classes.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>{t('nodeRange')}</span>
                    <input className={styles.input} value={range} onChange={(event) => { setRange(event.target.value) }} />
                  </label>
                </>
              )}
            {node.source.length > 0 && (
              <p className={styles.source}>{t('nodeSource')}: {node.source}</p>
            )}
            <div className={styles.actions}>
              <button type="button" className={styles.buttonPrimary} disabled={busy} onClick={save}>
                {busy ? t('saving') : t('save')}
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={busy}
                onClick={() => { onApply([{ op: node.kind === 'class' ? 'delete-class' : 'delete-property', id: node.id }]) }}
              >
                {t('remove')}
              </button>
            </div>
          </div>
        )}

      <div className={styles.addSection}>
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={() => { setDraft('class'); setNewId(''); setNewLabel('') }}>
            {t('addClass')}
          </button>
          <button type="button" className={styles.button} onClick={() => { setDraft('property'); setNewId(''); setNewLabel('') }}>
            {t('addProperty')}
          </button>
        </div>

        {draft !== 'none' && (
          <div className={styles.form}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('nodeId')}</span>
              <input className={styles.input} value={newId} onChange={(event) => { setNewId(event.target.value) }} />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('nodeLabel')}</span>
              <input className={styles.input} value={newLabel} onChange={(event) => { setNewLabel(event.target.value) }} />
            </label>
            {draft === 'property' && (
              <>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('propertyKind')}</span>
                  <select
                    className={styles.input}
                    value={newKind}
                    onChange={(event) => { setNewKind(event.target.value === 'datatype' ? 'datatype' : 'object') }}
                  >
                    <option value="object">{t('objectProperty')}</option>
                    <option value="datatype">{t('datatypeProperty')}</option>
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('nodeDomain')}</span>
                  <select className={styles.input} value={newDomain} onChange={(event) => { setNewDomain(event.target.value) }}>
                    <option value="" />
                    {classes.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('nodeRange')}</span>
                  <input className={styles.input} value={newRange} onChange={(event) => { setNewRange(event.target.value) }} />
                </label>
              </>
            )}
            <div className={styles.actions}>
              <button type="button" className={styles.buttonPrimary} disabled={busy || newId.trim().length === 0} onClick={submitNew}>
                {t('save')}
              </button>
              <button type="button" className={styles.button} onClick={() => { setDraft('none') }}>
                {t('cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
