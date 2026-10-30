import { describe, expect, it } from 'vitest'
import { evaluateQuality } from '../src/quality.ts'

const PREFIXES = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <http://example.org/ontology/contract#> .
`

const CURRENT = `${PREFIXES}
ex:Contract a owl:Class .
ex:Party a owl:Class .
ex:hasParty a owl:ObjectProperty ; rdfs:domain ex:Contract ; rdfs:range ex:Party .
`

const GOLD = `${PREFIXES}
ex:Contract a owl:Class .
ex:Party a owl:Class .
ex:Invoice a owl:Class .
ex:hasParty a owl:ObjectProperty ; rdfs:domain ex:Contract ; rdfs:range ex:Party .
ex:hasAmount a owl:DatatypeProperty ; rdfs:domain ex:Invoice ; rdfs:range xsd:decimal .
`

describe('evaluateQuality', () => {
  it('scores classes and properties against the gold standard', () => {
    const report = evaluateQuality('contract', '1.0.0', CURRENT, GOLD, 'gold.ttl')

    expect(report).toMatchObject({ domain: 'contract', version: '1.0.0', baselineName: 'gold.ttl' })
    expect(report.classes).toMatchObject({
      expected: 3,
      actual: 2,
      matched: 2,
      precision: 1,
      recall: 2 / 3,
      missing: ['Invoice'],
      unexpected: [],
    })
    expect(report.properties).toMatchObject({
      expected: 2,
      actual: 1,
      matched: 1,
      precision: 1,
      recall: 0.5,
      missing: ['hasAmount'],
      unexpected: [],
    })
  })

  it('reports extra entities as unexpected', () => {
    const report = evaluateQuality('contract', null, GOLD, CURRENT, 'gold.ttl')

    expect(report.classes.missing).toEqual([])
    expect(report.classes.unexpected).toEqual(['Invoice'])
    expect(report.classes.recall).toBe(1)
  })

  it('treats an empty side as complete recall and precision', () => {
    const report = evaluateQuality('contract', null, PREFIXES, PREFIXES, 'gold.ttl')

    expect(report.classes).toMatchObject({ expected: 0, actual: 0, matched: 0, precision: 1, recall: 1 })
    expect(report.properties).toMatchObject({ expected: 0, actual: 0, matched: 0, precision: 1, recall: 1 })
  })
})
