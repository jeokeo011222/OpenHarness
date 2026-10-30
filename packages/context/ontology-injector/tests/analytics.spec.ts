import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AnalyticsError,
  compileMetric,
  drilldownMetric,
  explainMetric,
  listMetrics,
  runMetric,
} from '../src/analytics.ts'
import { forgetDatabase } from '../src/graph-db.ts'
import { sampleInstanceTurtle } from './instance-fixture.ts'
import { clearInstanceGraph, listInstanceBatches, writeInstanceGraph, writeLiveTurtle } from '../src/store.ts'

const TODAY = '2026-10-30'
const roots: string[] = []

/** Ontology the fixture instances are typed against; the metrics read this vocabulary. */
const CONTRACT_ONTOLOGY = `@prefix c: <http://example.org/ontology/contract#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .

c:Contract a owl:Class ; rdfs:label "合同" .
c:Party a owl:Class ; rdfs:label "签约方" .
c:contractTitle a owl:DatatypeProperty ; rdfs:domain c:Contract ; rdfs:range xsd:string .
c:contractAmount a owl:DatatypeProperty ; rdfs:domain c:Contract ; rdfs:range xsd:decimal .
c:signedDate a owl:DatatypeProperty ; rdfs:domain c:Contract ; rdfs:range xsd:date .
c:expiryDate a owl:DatatypeProperty ; rdfs:domain c:Contract ; rdfs:range xsd:date .
c:category a owl:DatatypeProperty ; rdfs:domain c:Contract ; rdfs:range xsd:string .
c:status a owl:DatatypeProperty ; rdfs:domain c:Contract ; rdfs:range xsd:string .
c:ownerDept a owl:DatatypeProperty ; rdfs:domain c:Contract ; rdfs:range xsd:string .
c:partyName a owl:DatatypeProperty ; rdfs:domain c:Party ; rdfs:range xsd:string .
c:hasParty a owl:ObjectProperty ; rdfs:domain c:Contract ; rdfs:range c:Party .`

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ontology-analytics-'))
  roots.push(root)
  return root
}

async function seededRoot(batches: readonly string[] = ['sample']): Promise<string> {
  const root = await newRoot()
  await writeLiveTurtle(root, 'contract', CONTRACT_ONTOLOGY)
  const sample = sampleInstanceTurtle(TODAY)
  for (const batch of batches) {
    await writeInstanceGraph(root, 'contract', batch, sample.turtle)
  }
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    forgetDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})

describe('analytics catalog', () => {
  it('lists the ontology-driven metric definitions in presentation order', async () => {
    const root = await newRoot()
    const metrics = await listMetrics(root, 'contract')
    expect(metrics.map(metric => metric.id)).toEqual([
      'instance-count',
      'class-distribution',
      'property-coverage',
      'relation-coverage',
      'property-values',
    ])
  })

  it('explains a metric with a query compiled from the domain vocabulary', async () => {
    const root = await seededRoot()
    const explanation = await explainMetric(root, 'contract', 'class-distribution', { class: 'Contract' })
    expect(explanation.unit).toBe('count')
    expect(explanation.variables).toEqual(['key', 'count'])
    expect(explanation.sparql).toContain('http://example.org/ontology/contract#Contract')
    expect(explanation.sparql).toContain('urn:dsh:ontology:graph:inst:contract:')
  })

  it('rejects an unknown metric', async () => {
    const root = await newRoot()
    await expect(explainMetric(root, 'contract', 'unknown')).rejects.toBeInstanceOf(AnalyticsError)
  })
})

describe('metric runs', () => {
  it('counts every typed instance once across batch graphs', async () => {
    const root = await seededRoot(['sample', 'sample-copy'])
    const run = await runMetric(root, 'contract', 'instance-count', { class: 'Contract' })
    expect(run.rows).toEqual([{ value: '12' }])
    expect(run.durationMs).toBeGreaterThanOrEqual(0)
    expect(run.warnings).toEqual([])
  })

  it('groups instances by their declared class', async () => {
    const root = await seededRoot()
    const run = await runMetric(root, 'contract', 'class-distribution')
    const rows = new Map(run.rows.map(row => [row.key, row.count]))
    expect(rows.get('Contract')).toBe('12')
    expect(rows.get('Party')).toBe('11')
  })

  it('counts how many instances carry each declared data property', async () => {
    const root = await seededRoot()
    const run = await runMetric(root, 'contract', 'property-coverage')
    const rows = new Map(run.rows.map(row => [row.key, row.count]))
    expect(rows.get('contractTitle')).toBe('12')
    expect(rows.get('partyName')).toBe('11')
    expect(rows.has('hasParty')).toBe(false)
  })

  it('counts how many instances use each declared object property', async () => {
    const root = await seededRoot()
    const run = await runMetric(root, 'contract', 'relation-coverage')
    expect(run.rows).toEqual([{ key: 'hasParty', count: '12' }])
  })

  it('distributes the selected property values', async () => {
    const root = await seededRoot()
    const run = await runMetric(root, 'contract', 'property-values', { property: 'status' })
    const rows = new Map(run.rows.map(row => [row.key, row.count]))
    expect(rows.get('履行中')).toBe('10')
    expect(rows.get('已履行')).toBe('1')
    expect(rows.get('待签署')).toBe('1')
  })

  it('scopes a run to one class', async () => {
    const root = await seededRoot()
    const run = await runMetric(root, 'contract', 'instance-count', { class: 'Party' })
    expect(run.rows).toEqual([{ value: '11' }])
  })

  it('warns instead of inventing a number when the store has no instances', async () => {
    const root = await newRoot()
    const run = await runMetric(root, 'contract', 'instance-count')
    expect(run.rows).toEqual([{ value: '0' }])
    expect(run.warnings).toHaveLength(1)
  })

  it('rejects filters the domain ontology cannot resolve', async () => {
    const root = await seededRoot()
    await expect(runMetric(root, 'contract', 'instance-count', { class: 'Widget' }))
      .rejects.toBeInstanceOf(AnalyticsError)
    await expect(runMetric(root, 'contract', 'property-values', {}))
      .rejects.toBeInstanceOf(AnalyticsError)
    await expect(runMetric(root, 'contract', 'property-values', { property: 'unknown' }))
      .rejects.toBeInstanceOf(AnalyticsError)
  })
})

describe('drilldown, batches, and compilation', () => {
  it('lists the deduplicated instances behind a metric', async () => {
    const root = await seededRoot(['sample', 'sample-copy'])
    const detail = await drilldownMetric(root, 'contract', 'class-distribution', { class: 'Contract' }, 100)
    expect(detail.rows).toHaveLength(12)
    expect(detail.variables).toEqual(['instance', 'type'])
    expect(detail.truncated).toBe(false)
  })

  it('marks a drilldown that reached its limit', async () => {
    const root = await seededRoot()
    const detail = await drilldownMetric(root, 'contract', 'class-distribution', {}, 1)
    expect(detail.rows).toHaveLength(1)
    expect(detail.truncated).toBe(true)
  })

  it('drills into the values of the selected property', async () => {
    const root = await seededRoot()
    const detail = await drilldownMetric(root, 'contract', 'property-values', { property: 'status' }, 100)
    expect(detail.variables).toEqual(['instance', 'value'])
    expect(detail.rows).toHaveLength(12)
  })

  it('reports instance batches and clears one', async () => {
    const root = await seededRoot(['sample', 'sample-copy'])
    const batches = await listInstanceBatches(root, 'contract')
    expect(batches.map(batch => batch.batch)).toEqual(['sample', 'sample-copy'])
    expect(batches.every(batch => batch.triples > 0)).toBe(true)
    expect(await clearInstanceGraph(root, 'contract', 'sample-copy')).toBeGreaterThan(0)
    expect(await listInstanceBatches(root, 'contract')).toHaveLength(1)
  })

  it('compiles a query without running it', async () => {
    const root = await seededRoot()
    const sparql = await compileMetric(root, 'contract', 'property-values', { property: 'status' })
    expect(sparql).toContain('http://example.org/ontology/contract#status')
    expect(sparql).toContain('GROUP BY ?key')
  })
})
