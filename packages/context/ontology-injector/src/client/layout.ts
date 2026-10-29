/**
 * Deterministic two-column layout for the ontology graph.
 *
 * Classes occupy the right column and properties the left one, so `rdfs:domain`
 * edges always read left-to-right into their owning class. Positions are pure
 * data; the canvas keeps drag offsets locally.
 */

import type { OntologyGraph } from '../types.ts'

/** One node's box in the canvas coordinate space. */
export interface NodeBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Node width used by the layout and the canvas renderer. */
export const NODE_WIDTH = 200
/** Node height used by the layout and the canvas renderer. */
export const NODE_HEIGHT = 48
const ROW_GAP = 28
const PADDING = 24
const PROPERTY_COLUMN = PADDING
const CLASS_COLUMN = PADDING + NODE_WIDTH + 120

/**
 * Lay out every node of one graph.
 *
 * @param graph - graph to place.
 * @returns absolute boxes plus the canvas size that contains them.
 */
export function layoutGraph(graph: OntologyGraph): { positions: Record<string, NodeBox>; width: number; height: number } {
  const positions: Record<string, NodeBox> = {}
  const classes = graph.nodes.filter(node => node.kind === 'class')
  const properties = graph.nodes.filter(node => node.kind !== 'class')

  classes.forEach((node, index) => {
    positions[node.id] = {
      x: CLASS_COLUMN,
      y: PADDING + index * (NODE_HEIGHT + ROW_GAP),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }
  })
  properties.forEach((node, index) => {
    positions[node.id] = {
      x: PROPERTY_COLUMN,
      y: PADDING + index * (NODE_HEIGHT + ROW_GAP),
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }
  })

  const rows = Math.max(1, classes.length, properties.length)
  return {
    positions,
    width: CLASS_COLUMN + NODE_WIDTH + PADDING,
    height: PADDING * 2 + rows * (NODE_HEIGHT + ROW_GAP),
  }
}
