import { useEditorStore } from '../store.ts'

export function JsonPreview() {
  const exportJson = useEditorStore(s => s.exportJson)

  const handleDownload = () => {
    const blob = new Blob([exportJson()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'mapping-config.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportJson())
      alert('已复制到剪贴板')
    } catch { alert('复制失败，请手动从预览区复制') }
  }

  return (
    <aside className="json-preview">
      <header>
        <h3>配置预览</h3>
        <div className="actions">
          <button onClick={handleCopy}>复制</button>
          <button onClick={handleDownload} className="primary">导出 JSON</button>
        </div>
      </header>
      <pre>{exportJson()}</pre>
    </aside>
  )
}
