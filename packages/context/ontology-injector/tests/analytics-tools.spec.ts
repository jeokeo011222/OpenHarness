import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { registerAnalyticsTools } from '../src/analytics-tools.ts'
import { forgetDatabase } from '../src/graph-db.ts'
import { readAudit, writeInstanceGraph, writeLiveTurtle } from '../src/store.ts'
import { sampleInstanceTurtle } from './instance-fixture.ts'

const TODAY = '2026-10-30'

/** Ontology the fixture instances are typed against. */
const CONTRACT_ONTOLOGY = `@prefix c: <http://example.org/ontology/contract#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .

c:Contract a owl:Class ; rdfs:label "合同" .
c:Party a owl:Class ; rdfs:label "签约方" .
c:contractTitle a owl:DatatypeProperty ; rdfs:domain c:Contract ; rdfs:range xsd:string .
c:contractAmount a owl:DatatypeProperty ; rdfs:domain c:Contract ; rdfs:range xsd:decimal .
c:status a owl:DatatypeProperty ; rdfs:domain c:Contract ; rdfs:range xsd:string .
c:category a owl:DatatypeProperty ; rdfs:domain c:Contract ; rdfs:range xsd:string .
c:hasParty a owl:ObjectProperty ; rdfs:domain c:Contract ; rdfs:range c:Party .`

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    forgetDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ontology-analytics-tools-'))
  roots.push(root)
  await writeLiveTurtle(root, 'contract', CONTRACT_ONTOLOGY)
  await writeInstanceGraph(root, 'contract', 'sample', sampleInstanceTurtle(TODAY).turtle)

  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  registerAnalyticsTools(ctx, { storePath: root })

  const call = (name: string, args: object) => executeToolFixture(ctx, {
    name,
    arguments: args,
    callId: ToolCallId(name),
    signal: new AbortController().signal,
  })
  return { root, call }
}

describe('analytics tools', () => {
  it('lists every metric with its caveat', async () => {
    const { call } = await fixture()
    const result = await call('list_metrics', { domain: 'contract' })
    expect(result.isError).toBe(false)
    const text = result.value as string
    expect(text).toContain('指标目录（5 个）')
    for (const id of ['instance-count', 'class-distribution', 'property-coverage', 'relation-coverage', 'property-values']) {
      expect(text).toContain(id)
    }
    expect(text).toContain('口径：')
  })

  it('runs a metric over the sample batch and writes an audit entry', async () => {
    const { root, call } = await fixture()
    const result = await call('run_metric', { domain: 'contract', metric: 'instance-count', class: 'Contract' })
    expect(result.isError).toBe(false)
    expect(result.value as string).toContain('12')

    const audit = await readAudit(root)
    expect(audit[0]).toMatchObject({ action: 'metric-run', domain: 'contract' })
    expect(audit[0]?.detail).toContain('实例总数')
  })

  it('groups by the classes the ontology declares', async () => {
    const { call } = await fixture()
    const result = await call('run_metric', { domain: 'contract', metric: 'class-distribution' })
    expect(result.isError).toBe(false)
    const text = result.value as string
    expect(text).toContain('| key | count |')
    expect(text).toContain('Contract')
    expect(text).toContain('Party')
  })

  it('rejects a class the ontology does not declare with a typed error', async () => {
    const { call } = await fixture()
    const result = await call('run_metric', { domain: 'contract', metric: 'instance-count', class: 'Widget' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('Widget')
  })

  it('refuses a value metric until a property is selected', async () => {
    const { call } = await fixture()
    const result = await call('run_metric', { domain: 'contract', metric: 'property-values' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('property')
  })

  it('explains a metric without running it', async () => {
    const { call } = await fixture()
    const result = await call('explain_metric', { domain: 'contract', metric: 'property-values', property: 'status' })
    expect(result.isError).toBe(false)
    const text = result.value as string
    expect(text).toContain('属性取值分布')
    expect(text).toContain('结果列：key, count')
    expect(text).toContain('```sparql')
    expect(text).toContain('GROUP BY ?key')
  })
})
