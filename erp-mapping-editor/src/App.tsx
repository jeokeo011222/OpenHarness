import { ActionList } from './components/ActionList.tsx'
import { MappingForm } from './components/MappingForm.tsx'
import { JsonPreview } from './components/JsonPreview.tsx'
import './App.css'

function App() {
  return (
    <div className="app">
      <header className="top-bar">
        <h1>ERP 映射配置编辑器</h1>
        <p className="subtitle">定义本体行动 → 用友/金蝶 API 的映射关系 · 转换规则 · 导出 JSON</p>
      </header>
      <div className="layout">
        <ActionList />
        <MappingForm />
        <JsonPreview />
      </div>
    </div>
  )
}

export default App
