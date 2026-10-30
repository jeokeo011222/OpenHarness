import { describe, expect, it } from 'vitest'
import { generateSummary, parseOntology, renderSummary } from '../src/summary.ts'

const TURTLE = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <http://example.org/ontology/contract#> .

ex:Contract a owl:Class ;
  rdfs:label "合同" ;
  rdfs:comment "本域核心业务实体" .

ex:Party a owl:Class ;
  rdfs:label "签约方" .

ex:hasParty a owl:ObjectProperty ;
  rdfs:label "签约方" ;
  rdfs:domain ex:Contract ;
  rdfs:range ex:Party .

ex:contractAmount a owl:DatatypeProperty ;
  rdfs:label "合同金额" ;
  rdfs:domain ex:Contract ;
  rdfs:range xsd:decimal .
`

describe('renderSummary', () => {
  it('renders classes, object relations, and datatype properties', () => {
    const summary = renderSummary('contract', parseOntology(TURTLE))
    expect(summary).toContain('## 当前业务域：contract')
    expect(summary).toContain('### 对象类')
    expect(summary).toContain('- 合同（Contract）：本域核心业务实体')
    expect(summary).toContain('- 签约方（Party）')
    expect(summary).toContain('### 关键关系')
    expect(summary).toContain('- Contract → 签约方 → Party')
    expect(summary).toContain('### 数据属性')
    expect(summary).toContain('- Contract → 合同金额（decimal）')
  })

  it('falls back to local names when labels are missing', () => {
    const summary = renderSummary('contract', parseOntology(`@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix ex: <http://example.org/ontology/contract#> .
ex:Contract a owl:Class .
`))
    expect(summary).toContain('- Contract（Contract）')
  })
})

describe('generateSummary', () => {
  it('renders the live Turtle of a domain', () => {
    const summary = generateSummary('contract', TURTLE)
    expect(summary).toContain('## 当前业务域：contract')
    expect(summary).toContain('- Contract → 合同金额（decimal）')
    expect(summary.endsWith('\n')).toBe(true)
  })
})
