/**
 * Deterministic three-column layout for the ontology graph.
 *
 * Classes that own properties occupy the left column, properties the middle
 * column, and classes that only appear as a property range the right one, so
 * domain and range edges read left to right. Properties are ordered by the row of
 * the class their `rdfs:domain` names, and range classes by the row of the first
 * property pointing at them, so both hops stay short. Positions are pure data; the
 * canvas keeps drag offsets locally.
 */

import type { OntologyGraph, OntologyGraphNode } from '../types.ts'

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
const ROW_GAP = 16
const ROW_HEIGHT = NODE_HEIGHT + ROW_GAP
const PADDING = 24
const COLUMN_GAP = 56
const DOMAIN_COLUMN = PADDING
const PROPERTY_COLUMN = DOMAIN_COLUMN + NODE_WIDTH + COLUMN_GAP
const RANGE_COLUMN = PROPERTY_COLUMN + NODE_WIDTH + COLUMN_GAP

/** Order nodes by a row key, keeping the original order for equal or unknown rows. */
function byRow<T extends { readonly index: number; readonly row: number }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => {
    const diff = left.row - right.row
    if (Number.isNaN(diff) || diff === 0) return left.index - right.index
    return diff < 0 ? -1 : 1
  })
}

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

  const domainOwners = new Set(graph.edges.filter(edge => edge.kind === 'domain').map(edge => edge.source))
  const rangeTargets = new Set(graph.edges.filter(edge => edge.kind === 'range').map(edge => edge.target))
  // A class that owns properties stays on the left even when it is also a range,
  // so its outgoing domain edges keep pointing rightwards.
  const domainClasses = classes.filter(node => domainOwners.has(node.id) || !rangeTargets.has(node.id))
  const rangeClasses = classes.filter(node => !domainOwners.has(node.id) && rangeTargets.has(node.id))

  const classRow = new Map(domainClasses.map((node, index) => [node.id, index]))
  const ownerRow = new Map<string, number>()
  for (const edge of graph.edges) {
    if (edge.kind !== 'domain') continue
    const row = classRow.get(edge.source)
    if (row !== undefined) ownerRow.set(edge.target, row)
  }

  const place = (node: OntologyGraphNode, x: number, row: number): void => {
    positions[node.id] = { x, y: PADDING + row * ROW_HEIGHT, width: NODE_WIDTH, height: NODE_HEIGHT }
  }

  domainClasses.forEach((node, index) => { place(node, DOMAIN_COLUMN, index) })

  const ordered = byRow(properties.map((node, index) => ({ node, index, row: ownerRow.get(node.id) ?? Number.POSITIVE_INFINITY })))
  const propertyRow = new Map<string, number>()
  ordered.forEach(({ node }, index) => {
    place(node, PROPERTY_COLUMN, index)
    propertyRow.set(node.id, index)
  })

  const rangeRow = new Map<string, number>()
  for (const edge of graph.edges) {
    if (edge.kind !== 'range') continue
    const row = propertyRow.get(edge.source)
    if (row !== undefined && !rangeRow.has(edge.target)) rangeRow.set(edge.target, row)
  }
  const orderedRanges = byRow(rangeClasses.map((node, index) => ({ node, index, row: rangeRow.get(node.id) ?? Number.POSITIVE_INFINITY })))
  orderedRanges.forEach(({ node }, index) => { place(node, RANGE_COLUMN, index) })

  const rows = Math.max(1, domainClasses.length, properties.length, rangeClasses.length)
  return {
    positions,
    width: RANGE_COLUMN + NODE_WIDTH + PADDING,
    height: PADDING * 2 + rows * ROW_HEIGHT,
  }
}
