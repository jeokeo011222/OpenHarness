import { useEditorStore } from '../store.ts'
import { MOCK_ACTIONS } from '../data.ts'

export function ActionList() {
  const config = useEditorStore(s => s.config)
  const setActive = useEditorStore(s => s.setActive)
  const createNew = useEditorStore(s => s.createNew)
  const activeIdx = useEditorStore(s => s.activeIdx)

  return (
    <aside className="action-list">
      <header>
        <h3>本体行动列表</h3>
        <button onClick={createNew} className="new-btn">+ 新建映射</button>
      </header>

      <div className="section">
        <h4>已配置的映射 ({config.mappings.length})</h4>
        {config.mappings.length === 0 && <p className="empty">暂无</p>}
        {config.mappings.map((m, i) => (
          <button
            key={i}
            className={`action-item ${activeIdx === i ? 'active' : ''}`}
            onClick={() => setActive(i)}
          >
            <span className="action-domain">[{m.domain}]</span>
            <span className="action-name">{m.action}</span>
            <span className="action-erp">→ {m.erp}</span>
          </button>
        ))}
      </div>

      <div className="section">
        <h4>可用本体行动</h4>
        {MOCK_ACTIONS.map(a => {
          const configured = config.mappings.some(m => m.action === a.name)
          return (
            <div key={a.name} className={`ontology-action ${configured ? 'configured' : ''}`}>
              <div>
                <span className="action-domain">[{a.domain}]</span>
                <span>{a.name}</span>
              </div>
              <small>{a.params.map(p => p.name).join(', ') || '无参数'}</small>
              {configured && <span className="badge">已配置</span>}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
