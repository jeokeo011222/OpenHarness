import { useState, type ReactNode } from 'react'
import type { OntologyGraph, OntologyGraphEdge, OntologyGraphNode } from '../types.ts'
import { layoutGraph, type NodeBox } from './layout.ts'
import styles from './workbench.module.css'

/** Props of the graph canvas. */
export interface GraphCanvasProps {
  readonly graph: OntologyGraph
  readonly selectedId: string | null
  readonly onSelect: (nodeId: string) => void
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

/**
 * Render the knowledge graph as an SVG canvas with draggable nodes.
 *
 * Selecting an edge selects the node that owns the relation, so the inspector
 * always edits a node rather than an anonymous line.
 *
 * @param props - graph, selected node id, and selection callback.
 */
export function GraphCanvas({ graph, selectedId, onSelect }: GraphCanvasProps): ReactNode {
  const layout = layoutGraph(graph)
  const [offsets, setOffsets] = useState<Record<string, { dx: number; dy: number }>>({})
  const [dragging, setDragging] = useState<{ id: string; startX: number; startY: number; dx: number; dy: number } | null>(null)

  const boxOf = (id: string): NodeBox | undefined => {
    const base = layout.positions[id]
    if (!base) return undefined
    const offset = offsets[id] ?? { dx: 0, dy: 0 }
    return { ...base, x: base.x + offset.dx, y: base.y + offset.dy }
  }

  if (graph.nodes.length === 0) return null

  return (
    <svg
      className={styles.canvas}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={graph.label}
    >
      <defs>
        <marker id="ontology-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M 0 0 L 8 4 L 0 8 z" className={styles.arrow} />
        </marker>
      </defs>

      {graph.edges.map((edge) => {
        const from = boxOf(edge.source)
        const to = boxOf(edge.target)
        if (!from || !to) return null
        const x1 = from.x + from.width
        const y1 = from.y + from.height / 2
        const x2 = to.x
        const y2 = to.y + to.height / 2
        const related = selectedId === edge.source || selectedId === edge.target
        return (
          <g key={edge.id}>
            <line className={styles.edgeHit} x1={x1} y1={y1} x2={x2} y2={y2} onClick={() => { onSelect(edge.source) }} />
            <line
              className={edgeClass(edge, related)}
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
        return (
          <g
            key={node.id}
            transform={`translate(${box.x} ${box.y})`}
            className={`${nodeClass(node)}${selected ? ` ${styles.nodeSelected}` : ''}`}
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
  )
}
