import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { OntologyEdgeKind, OntologyGraph, OntologyGraphEdge, OntologyGraphNode } from '../types.ts'
import type { Translate } from './Inspector.tsx'
import type { LocaleDict } from './locales.ts'
import { layoutGraph, type NodeBox } from './layout.ts'
import styles from './workbench.module.css'

/** Smallest magnification the canvas allows. */
const MIN_ZOOM = 0.5
/** Largest magnification the canvas allows. */
const MAX_ZOOM = 3
/** Edge kinds in toolbar order. */
const EDGE_KINDS: readonly OntologyEdgeKind[] = ['domain', 'range', 'subclass']
/** Locale key for each edge-kind toggle. */
const EDGE_LABELS: Record<OntologyEdgeKind, keyof LocaleDict> = {
  domain: 'edgeDomain',
  range: 'edgeRange',
  subclass: 'subclass',
}

/** Visible canvas region: origin plus magnification relative to the layout size. */
interface View {
  readonly x: number
  readonly y: number
  readonly scale: number
}

/** Props of the graph canvas. */
export interface GraphCanvasProps {
  readonly graph: OntologyGraph
  readonly selectedId: string | null
  readonly onSelect: (nodeId: string) => void
  readonly t: Translate
}

/** Truncate a node label to fit its box. */
function shorten(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Node class for one node kind. */
function nodeClass(node: OntologyGraphNode): string {
  const base = node.kind === 'class' ? styles.nodeClass : styles.nodeProperty
  return `${styles.node} ${base}`
}

/** Edge class for one relation kind. */
function edgeClass(edge: OntologyGraphEdge, selected: boolean): string {
  const base = edge.kind === 'domain' ? styles.edgeDomain : edge.kind === 'range' ? styles.edgeRange : styles.edgeSubclass
  return `${styles.edge} ${base}${selected ? ` ${styles.edgeSelected}` : ''}`
}

/** Clamp one magnification into the supported range. */
function clampZoom(scale: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale))
}

/**
 * Render the knowledge graph as an SVG canvas with draggable nodes.
 *
 * Selecting an edge selects the node that owns the relation, so the inspector
 * always edits a node rather than an anonymous line. The wheel zooms around the
 * pointer, dragging empty background pans, and the toolbar filters edge kinds
 * and highlights nodes matching the search text.
 *
 * @param props - graph, selected node id, selection callback, and copy.
 */
export function GraphCanvas({ graph, selectedId, onSelect, t }: GraphCanvasProps): ReactNode {
  const layout = layoutGraph(graph)
  const [offsets, setOffsets] = useState<Record<string, { dx: number; dy: number }>>({})
  const [dragging, setDragging] = useState<{ id: string; startX: number; startY: number; dx: number; dy: number } | null>(null)
  const [pan, setPan] = useState<{ startX: number; startY: number; x: number; y: number } | null>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 })
  const [query, setQuery] = useState('')
  const [edgeKinds, setEdgeKinds] = useState<Record<OntologyEdgeKind, boolean>>({ domain: true, range: true, subclass: true })
  const svg = useRef<SVGSVGElement>(null)

  const baseWidth = layout.width
  const baseHeight = layout.height

  useEffect(() => {
    const element = svg.current
    if (element === null) return undefined
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const px = (event.clientX - rect.left) / rect.width
      const py = (event.clientY - rect.top) / rect.height
      setView((current) => {
        const scale = clampZoom(current.scale * Math.exp(-event.deltaY * 0.0015))
        if (scale === current.scale) return current
        const width = baseWidth / scale
        const height = baseHeight / scale
        const canvasX = current.x + px * (baseWidth / current.scale)
        const canvasY = current.y + py * (baseHeight / current.scale)
        return { scale, x: canvasX - px * width, y: canvasY - py * height }
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => { element.removeEventListener('wheel', onWheel) }
  }, [baseWidth, baseHeight])

  const boxOf = (id: string): NodeBox | undefined => {
    const base = layout.positions[id]
    if (!base) return undefined
    const offset = offsets[id] ?? { dx: 0, dy: 0 }
    return { ...base, x: base.x + offset.dx, y: base.y + offset.dy }
  }

  if (graph.nodes.length === 0) return null

  const needle = query.trim().toLowerCase()
  const matched = needle.length === 0
    ? null
    : new Set(graph.nodes
      .filter(node => node.label.toLowerCase().includes(needle) || node.id.toLowerCase().includes(needle))
      .map(node => node.id))

  const startPan = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.target !== event.currentTarget) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setPan({ startX: event.clientX, startY: event.clientY, x: view.x, y: view.y })
  }

  const movePan = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (pan === null) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const dx = (event.clientX - pan.startX) * (baseWidth / view.scale) / rect.width
    const dy = (event.clientY - pan.startY) * (baseHeight / view.scale) / rect.height
    setView(current => ({ ...current, x: pan.x - dx, y: pan.y - dy }))
  }

  const endPan = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (pan === null) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    setPan(null)
  }

  return (
    <div className={styles.canvasHost}>
      <div className={styles.canvasControls}>
        <input
          className={`${styles.input} ${styles.searchInput}`}
          value={query}
          aria-label={t('searchNodes')}
          placeholder={t('searchNodes')}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <div className={styles.toggleGroup} role="group" aria-label={t('edgeFilter')}>
          {EDGE_KINDS.map(kind => (
            <label key={kind} className={styles.toggle}>
              <input
                type="checkbox"
                checked={edgeKinds[kind]}
                onChange={() => { setEdgeKinds(current => ({ ...current, [kind]: !current[kind] })) }}
              />
              <span>{t(EDGE_LABELS[kind])}</span>
            </label>
          ))}
        </div>
      </div>

      <svg
        ref={svg}
        className={`${styles.canvas}${pan === null ? '' : ` ${styles.canvasPanning}`}`}
        viewBox={`${view.x} ${view.y} ${baseWidth / view.scale} ${baseHeight / view.scale}`}
        role="img"
        aria-label={graph.label}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <defs>
          <marker id="ontology-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" className={styles.arrow} />
          </marker>
        </defs>

        {graph.edges.map((edge) => {
          if (!edgeKinds[edge.kind]) return null
          const from = boxOf(edge.source)
          const to = boxOf(edge.target)
          if (!from || !to) return null
          // Use the facing edges, so a hop that runs against the column order still
          // starts and ends on the sides the two boxes expose.
          const forward = from.x + from.width / 2 <= to.x + to.width / 2
          const x1 = forward ? from.x + from.width : from.x
          const y1 = from.y + from.height / 2
          const x2 = forward ? to.x : to.x + to.width
          const y2 = to.y + to.height / 2
          const related = selectedId === edge.source || selectedId === edge.target
          const dimmed = matched !== null && !matched.has(edge.source) && !matched.has(edge.target)
          return (
            <g key={edge.id}>
              <line className={styles.edgeHit} x1={x1} y1={y1} x2={x2} y2={y2} onClick={() => { onSelect(edge.source) }} />
              <line
                className={`${edgeClass(edge, related)}${dimmed ? ` ${styles.edgeDim}` : ''}`}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                markerEnd="url(#ontology-arrow)"
              />
              <text className={styles.edgeLabel} x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6}>
                {edge.label}
              </text>
            </g>
          )
        })}

        {graph.nodes.map((node) => {
          const box = boxOf(node.id)
          if (!box) return null
          const selected = selectedId === node.id
          const dimmed = matched !== null && !matched.has(node.id)
          const matchedNode = matched !== null && matched.has(node.id)
          return (
            <g
              key={node.id}
              transform={`translate(${box.x} ${box.y})`}
              className={`${nodeClass(node)}${selected ? ` ${styles.nodeSelected}` : ''}${matchedNode ? ` ${styles.nodeMatch}` : ''}${dimmed ? ` ${styles.nodeDim}` : ''}`}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                const offset = offsets[node.id] ?? { dx: 0, dy: 0 }
                setDragging({ id: node.id, startX: event.clientX, startY: event.clientY, dx: offset.dx, dy: offset.dy })
                onSelect(node.id)
              }}
              onPointerMove={(event) => {
                if (dragging === null || dragging.id !== node.id) return
                const scale = event.currentTarget.ownerSVGElement
                  ? (event.currentTarget.ownerSVGElement.viewBox.baseVal.width / event.currentTarget.ownerSVGElement.clientWidth)
                  : 1
                const dx = dragging.dx + (event.clientX - dragging.startX) * scale
                const dy = dragging.dy + (event.clientY - dragging.startY) * scale
                setOffsets(current => ({ ...current, [node.id]: { dx, dy } }))
              }}
              onPointerUp={(event) => {
                event.currentTarget.releasePointerCapture(event.pointerId)
                setDragging(null)
              }}
            >
              <rect width={box.width} height={box.height} rx={8} />
              <text className={styles.nodeLabel} x={12} y={20}>
                {shorten(node.label, 22)}
              </text>
              <text className={styles.nodeId} x={12} y={36}>
                {shorten(node.id, 26)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
