import { useEditorStore } from '../store.ts'
import { ERP_OPTIONS, TRANSFORM_OPTIONS, type TransformerSpec, type TransformKind } from '../types.ts'

function transformerConfigPanel(
  current: TransformerSpec | undefined,
  onChange: (t: TransformerSpec | undefined) => void,
) {
  const kind = current?.kind ?? 'identity'
  const setKind = (k: TransformKind) => {
    if (k === 'identity') { onChange(undefined); return }
    if (k === 'date_format') { onChange({ kind: 'date_format', format: current?.format ?? 'YYYYMMDD' }); return }
    if (k === 'enum_map') { onChange({ kind: 'enum_map', map: current?.map ?? {} }); return }
  }

  return (
    <div className="transformer">
      <select value={kind} onChange={e => setKind(e.target.value as TransformKind)}>
        {TRANSFORM_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
      </select>
      {kind === 'date_format' && (
        <input
          type="text" placeholder="YYYYMMDD"
          value={current?.format ?? 'YYYYMMDD'}
          onChange={e => onChange({ kind: 'date_format', format: e.target.value })}
        />
      )}
      {kind === 'enum_map' && (
        <EnumMapEditor map={current?.map ?? {}} onChange={map => onChange({ kind: 'enum_map', map })} />
      )}
    </div>
  )
}

function EnumMapEditor({ map, onChange }: { map: Record<string, string>; onChange: (m: Record<string, string>) => void }) {
  const entries = Object.entries(map)
  const addRow = () => onChange({ ...map, '': '' })
  const removeRow = (k: string) => {
    const next = { ...map }
    delete next[k]
    onChange(next)
  }
  const updateRow = (oldK: string, newK: string, v: string) => {
    const next = { ...map }
    delete next[oldK]
    next[newK] = v
    onChange(next)
  }
  return (
    <div className="enum-map">
      {entries.map(([k, v]) => (
        <div key={k} className="enum-row">
          <input type="text" placeholder="本体值" value={k} onChange={e => updateRow(k, e.target.value, v)} />
          <span>→</span>
          <input type="text" placeholder="ERP值" value={v} onChange={e => updateRow(k, k, e.target.value)} />
          <button onClick={() => removeRow(k)} className="icon-btn">×</button>
        </div>
      ))}
      <button onClick={addRow} className="add-row">+ 添加映射</button>
    </div>
  )
}

export function MappingForm() {
  const draft = useEditorStore(s => s.draft)
  const activeIdx = useEditorStore(s => s.activeIdx)
  const updateDraft = useEditorStore(s => s.updateDraft)
  const updateDraftParam = useEditorStore(s => s.updateDraftParam)
  const addDraftParam = useEditorStore(s => s.addDraftParam)
  const removeDraftParam = useEditorStore(s => s.removeDraftParam)
  const updateDraftTransformer = useEditorStore(s => s.updateDraftTransformer)
  const saveDraft = useEditorStore(s => s.saveDraft)
  const deleteMapping = useEditorStore(s => s.deleteMapping)

  if (!draft) {
    return <div className="mapping-form empty">选择或新建一个映射开始编辑</div>
  }

  const title = activeIdx === -1 ? '新建映射' : `编辑映射 #${activeIdx + 1}`

  return (
    <main className="mapping-form">
      <h3>{title}</h3>

      <div className="form-grid">
        <label>
          <span>业务域</span>
          <input
            type="text" value={draft.domain}
            onChange={e => updateDraft({ domain: e.target.value })}
            placeholder="contract / procurement"
          />
        </label>

        <label>
          <span>本体 Action</span>
          <input
            type="text" value={draft.action}
            onChange={e => updateDraft({ action: e.target.value })}
            placeholder="queryPurchaseOrders"
          />
        </label>

        <label>
          <span>ERP 类型</span>
          <select
            value={draft.erp}
            onChange={e => updateDraft({ erp: e.target.value })}
          >
            <option value="">— 选择 —</option>
            {ERP_OPTIONS.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
        </label>

        <label>
          <span>ERP API 标识</span>
          <input
            type="text" value={draft.api}
            onChange={e => updateDraft({ api: e.target.value })}
            placeholder="u8_purchase_order_query"
          />
        </label>
      </div>

      <h4>参数映射</h4>
      <div className="param-table">
        <thead>
          <tr>
            <th>本体参数</th>
            <th>→</th>
            <th>ERP 参数</th>
            <th>转换函数</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {draft.params.map((p, i) => (
            <tr key={i}>
              <td><input type="text" value={p.from} onChange={e => updateDraftParam(i, { from: e.target.value })} placeholder="region" /></td>
              <td className="arrow">→</td>
              <td><input type="text" value={p.to} onChange={e => updateDraftParam(i, { to: e.target.value })} placeholder="cRegion" /></td>
              <td>{transformerConfigPanel(p.transform, t => updateDraftTransformer(i, t))}</td>
              <td><button onClick={() => removeDraftParam(i)} className="icon-btn">×</button></td>
            </tr>
          ))}
        </tbody>
      </div>
      <button onClick={addDraftParam} className="add-row">+ 添加参数映射</button>

      <div className="form-actions">
        <button className="save" onClick={saveDraft} disabled={!draft.domain || !draft.action || !draft.erp || !draft.api}>
          {activeIdx === -1 ? '创建映射' : '保存修改'}
        </button>
        {activeIdx !== -1 && (
          <button className="delete" onClick={() => deleteMapping(activeIdx)}>删除</button>
        )}
      </div>
    </main>
  )
}
