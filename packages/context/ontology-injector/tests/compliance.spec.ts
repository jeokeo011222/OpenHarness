import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { registerComplianceTool, renderCompliance, runCompliance } from '../src/compliance.ts'
import { forgetDatabase } from '../src/graph-db.ts'
import { loadShapes } from '../src/shacl/shapes.ts'
import {
  readAudit,
  readShapesTurtle,
  writeDomainMeta,
  writeInstanceGraph,
  writeLiveTurtle,
  writeShapes,
  writeRegistry,
} from '../src/store.ts'

const roots: string[] = []

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compliance-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    forgetDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})

/** Minimal contract ontology: two classes, the properties the shapes read. */
const ONTOLOGY = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix c: <http://example.org/ontology/contract#> .

c:Contract a owl:Class ; rdfs:label "合同" .
c:Party a owl:Class ; rdfs:label "签约方" .

c:contractId a owl:DatatypeProperty ;
  rdfs:label "合同编号" ; rdfs:domain c:Contract ; rdfs:range xsd:string .
c:contractAmount a owl:DatatypeProperty ;
  rdfs:label "合同金额" ; rdfs:domain c:Contract ; rdfs:range xsd:decimal .
c:effectiveDate a owl:DatatypeProperty ;
  rdfs:label "生效日期" ; rdfs:domain c:Contract ; rdfs:range xsd:date .
c:expiryDate a owl:DatatypeProperty ;
  rdfs:label "失效日期" ; rdfs:domain c:Contract ; rdfs:range xsd:date .
c:hasParty a owl:ObjectProperty ;
  rdfs:label "有签约方" ; rdfs:domain c:Contract ; rdfs:range c:Party .
c:partyId a owl:DatatypeProperty ;
  rdfs:label "方编号" ; rdfs:domain c:Party ; rdfs:range xsd:string .`

/** Shapes with the supported subset plus a cross-field SPARQL rule. */
const SHAPES = `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix c: <http://example.org/ontology/contract#> .

c:ContractShape
    a sh:NodeShape ;
    rdfs:label "合同必填与跨字段规则" ;
    sh:targetClass c:Contract ;
    sh:property [
        sh:path c:contractId ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
    ] ;
    sh:property [
        sh:path c:hasParty ;
        sh:minCount 2 ;
    ] ;
    sh:sparql [
        sh:message "生效日期须早于失效日期：{?this}" ;
        sh:select """
          SELECT $this ?effective ?expiry WHERE {
            $this c:effectiveDate ?effective ;
                  c:expiryDate ?expiry .
            FILTER(?effective >= ?expiry)
          }
        """ ;
    ] .

c:PartyShape
    a sh:NodeShape ;
    rdfs:label "签约方编号必填" ;
    sh:targetClass c:Party ;
    sh:property [
        sh:path c:partyId ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
    ] .`

/**
 * One clean contract, one contract missing its id and a party, one contract
 * with inverted dates, and one party missing its id.
 */
const INSTANCES = `@prefix c: <http://example.org/ontology/contract#> .
@prefix ex: <http://example.org/inst/contract#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

ex:C-1 a c:Contract ;
  c:contractId "C-1" ;
  c:contractAmount 1000 ;
  c:effectiveDate "2026-01-01"^^xsd:date ;
  c:expiryDate "2026-12-31"^^xsd:date ;
  c:hasParty ex:P-1 , ex:P-2 .

ex:C-2 a c:Contract ;
  c:contractAmount 2000 ;
  c:hasParty ex:P-1 .

ex:C-3 a c:Contract ;
  c:contractId "C-3" ;
  c:effectiveDate "2026-06-01"^^xsd:date ;
  c:expiryDate "2026-05-01"^^xsd:date ;
  c:hasParty ex:P-1 , ex:P-2 .

ex:P-1 a c:Party ; c:partyId "P-1" .
ex:P-2 a c:Party .`

async function seedDomain(root: string): Promise<void> {
  await writeRegistry(root, ['contract'])
  await writeDomainMeta(root, {
    id: 'contract',
    label: '合同管理',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeVersion: null,
    disabled: false,
  })
  await writeLiveTurtle(root, 'contract', ONTOLOGY)
  await writeShapes(root, 'contract', SHAPES)
  await writeInstanceGraph(root, 'contract', 'sample', INSTANCES)
}

describe('shapes storage', () => {
  it('writes shapes to their own graph and reads them back', async () => {
    const root = await newRoot()
    await writeRegistry(root, ['contract'])
    const written = await writeShapes(root, 'contract', SHAPES)
    expect(written).toBeGreaterThan(0)

    const turtle = await readShapesTurtle(root, 'contract')
    expect(turtle).toContain('shacl#NodeShape')

    const shapes = await loadShapes(root, 'contract')
    expect(shapes.map(shape => shape.label)).toEqual(['合同必填与跨字段规则', '签约方编号必填'])
  })

  it('replaces the whole shapes graph on rewrite', async () => {
    const root = await newRoot()
    await writeRegistry(root, ['contract'])
    await writeShapes(root, 'contract', SHAPES)
    await writeShapes(root, 'contract', `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix c: <http://example.org/ontology/contract#> .
c:PartyShape a sh:NodeShape ; sh:targetClass c:Party .`)
    const shapes = await loadShapes(root, 'contract')
    expect(shapes).toHaveLength(1)
    expect(shapes[0]?.iri).toContain('PartyShape')
  })

  it('rejects unparsable shapes Turtle', async () => {
    const root = await newRoot()
    await writeRegistry(root, ['contract'])
    await expect(writeShapes(root, 'contract', 'this is not turtle {')).rejects.toThrow(/无法解析/)
  })

  it('imports shapes.ttl from the legacy layout', async () => {
    const root = await newRoot()
    await writeFile(join(root, 'registry.json'), JSON.stringify({ domains: ['contract'] }))
    await mkdir(join(root, 'contract'), { recursive: true })
    await writeFile(join(root, 'contract', 'shapes.ttl'), SHAPES)

    const shapes = await loadShapes(root, 'contract')
    expect(shapes.map(shape => shape.label)).toEqual(['合同必填与跨字段规则', '签约方编号必填'])
  })
})

describe('compliance report', () => {
  it('counts violations per rule across every batch', async () => {
    const root = await newRoot()
    await seedDomain(root)
    const report = await runCompliance(root, 'contract')

    expect(report.conforms).toBe(false)
    expect(report.batches).toEqual(['sample'])
    expect(report.errors).toEqual([])

    const byLabel = new Map(report.rules.map(rule => [rule.label, rule]))
    // C-2 misses its id; C-1, C-2, C-3 each have fewer than two parties.
    expect(byLabel.get('合同必填与跨字段规则')?.violations).toBe(3)
    // C-3 has effectiveDate >= expiryDate.
    expect(byLabel.get('合同必填与跨字段规则')?.focusNodes).toContain('http://example.org/inst/contract#C-3')
    // P-2 misses its partyId.
    expect(byLabel.get('签约方编号必填')?.violations).toBe(1)
    expect(byLabel.get('签约方编号必填')?.focusNodes).toEqual(['http://example.org/inst/contract#P-2'])
  })

  it('passes when every record conforms', async () => {
    const root = await newRoot()
    await writeRegistry(root, ['contract'])
    await writeLiveTurtle(root, 'contract', ONTOLOGY)
    await writeShapes(root, 'contract', SHAPES)
    await writeInstanceGraph(root, 'contract', 'sample', `@prefix c: <http://example.org/ontology/contract#> .
@prefix ex: <http://example.org/inst/contract#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
ex:C-1 a c:Contract ; c:contractId "C-1" ; c:effectiveDate "2026-01-01"^^xsd:date ; c:expiryDate "2026-12-31"^^xsd:date ; c:hasParty ex:P-1 , ex:P-2 .
ex:P-1 a c:Party ; c:partyId "P-1" .
ex:P-2 a c:Party ; c:partyId "P-2" .`)

    const report = await runCompliance(root, 'contract')
    expect(report.conforms).toBe(true)
    expect(report.rules).toEqual([])
    expect(renderCompliance(report)).toContain('未发现违规')
  })

  it('reports a shape that cannot run as non-conforming', async () => {
    const root = await newRoot()
    await writeRegistry(root, ['contract'])
    await writeLiveTurtle(root, 'contract', ONTOLOGY)
    await writeShapes(root, 'contract', `@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix c: <http://example.org/ontology/contract#> .
c:BrokenShape a sh:NodeShape ; sh:targetClass c:Contract ;
  sh:sparql [ sh:select "SELECT $this WHERE { NOT A QUERY }" ] .`)

    const report = await runCompliance(root, 'contract')
    expect(report.conforms).toBe(false)
    expect(report.errors.length).toBeGreaterThan(0)
    expect(report.errors.join('')).toContain('BrokenShape')
  })
})

describe('compliance tool', () => {
  it('renders the report and writes an audit entry', async () => {
    const root = await newRoot()
    await seedDomain(root)

    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    registerComplianceTool(ctx, { storePath: root })

    const result = await executeToolFixture(ctx, {
      name: 'compliance_report',
      arguments: { domain: 'contract' },
      callId: ToolCallId('compliance_report'),
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    const text = result.value as string
    expect(text).toContain('合规检查：contract')
    expect(text).toContain('合同必填与跨字段规则')
    expect(text).toContain('3 条违规')

    const audit = await readAudit(root)
    expect(audit[0]).toMatchObject({ action: 'compliance-run', domain: 'contract' })
    expect(audit[0]?.detail).toContain('未通过')
  })
})
