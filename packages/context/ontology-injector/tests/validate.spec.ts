import { describe, expect, it } from 'vitest'
import { validateOntology } from '../src/validate.ts'
import type { ValidationReport } from '../src/types.ts'

const PREFIXES = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <http://example.org/ontology/contract#> .
`

/** Wrap fixture statements in the shared prefix block. */
function document(body: string): string {
  return `${PREFIXES}\n${body}`
}

/** Codes reported in the requested section of a report. */
function codes(issues: ValidationReport['errors']): string[] {
  return issues.map(issue => issue.code)
}

describe('validation errors', () => {
  it('reports parse-error for an unparsable document', () => {
    const report = validateOntology('contract', 'not turtle at all')
    expect(codes(report.errors)).toEqual(['parse-error'])
    expect(report.warnings).toEqual([])
  })

  it('reports empty-ontology when nothing is declared', () => {
    const report = validateOntology('contract', document('ex:Thing a owl:Thing .\n'))
    expect(codes(report.errors)).toEqual(['empty-ontology'])
  })

  it('reports duplicate-class-iri when one IRI is a class and a property', () => {
    const report = validateOntology('contract', document('ex:Entry a owl:Class, owl:ObjectProperty ; rdfs:label "条目" .\n'))
    expect(codes(report.errors)).toContain('duplicate-class-iri')
  })

  it('reports duplicate-class-iri when a class is declared twice', () => {
    const report = validateOntology('contract', document('ex:Entry a owl:Class, rdfs:Class ; rdfs:label "条目" .\n'))
    expect(codes(report.errors)).toContain('duplicate-class-iri')
  })

  it('reports missing-label for a class without rdfs:label', () => {
    const report = validateOntology('contract', document('ex:Entry a owl:Class .\n'))
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'missing-label', subject: 'Entry' }))
  })

  it('reports missing-node for an unresolvable subclass edge', () => {
    const report = validateOntology(
      'contract',
      document('ex:Entry a owl:Class ; rdfs:label "条目" ; rdfs:subClassOf ex:Missing .\n'),
    )
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'missing-node', subject: 'Entry' }))
  })

  it('reports missing-node for an unresolvable property domain', () => {
    const report = validateOntology(
      'contract',
      document('ex:amount a owl:DatatypeProperty ; rdfs:label "金额" ; rdfs:domain ex:Missing ; rdfs:range xsd:decimal .\n'),
    )
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'missing-node', subject: 'amount' }))
  })

  it('reports missing-domain for a property without rdfs:domain', () => {
    const report = validateOntology(
      'contract',
      document('ex:amount a owl:DatatypeProperty ; rdfs:label "金额" ; rdfs:range xsd:decimal .\n'),
    )
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'missing-domain', subject: 'amount' }))
  })

  it('reports missing-range for a property without rdfs:range', () => {
    const report = validateOntology(
      'contract',
      document('ex:Entry a owl:Class ; rdfs:label "条目" .\nex:amount a owl:DatatypeProperty ; rdfs:label "金额" ; rdfs:domain ex:Entry .\n'),
    )
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'missing-range', subject: 'amount' }))
  })

  it('reports domain-equals-range for a self-referencing object property', () => {
    const report = validateOntology(
      'contract',
      document('ex:Entry a owl:Class ; rdfs:label "条目" .\nex:relates a owl:ObjectProperty ; rdfs:label "关联" ; rdfs:domain ex:Entry ; rdfs:range ex:Entry .\n'),
    )
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'domain-equals-range', subject: 'relates' }))
  })

  it('reports duplicate-label for entities sharing one label', () => {
    const report = validateOntology(
      'contract',
      document('ex:Entry a owl:Class ; rdfs:label "条目" .\nex:Other a owl:Class ; rdfs:label "条目" .\n'),
    )
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'duplicate-label' }))
  })
})

describe('validation warnings', () => {
  it('warns about a datatype property whose range is a class', () => {
    const report = validateOntology(
      'contract',
      document('ex:Entry a owl:Class ; rdfs:label "条目" .\nex:kind a owl:DatatypeProperty ; rdfs:label "类型" ; rdfs:domain ex:Entry ; rdfs:range ex:Entry .\n'),
    )
    expect(report.errors).toEqual([])
    expect(codes(report.warnings)).toEqual(['datatype-object-range'])
  })

  it('warns about an isolated class', () => {
    const report = validateOntology('contract', document('ex:Entry a owl:Class ; rdfs:label "条目" .\n'))
    expect(report.errors).toEqual([])
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'isolated-class', subject: 'Entry' }))
  })
})

describe('clean ontology', () => {
  it('reports no issues', () => {
    const report = validateOntology(
      'contract',
      document(`ex:Contract a owl:Class ; rdfs:label "合同" .
ex:Party a owl:Class ; rdfs:label "签约方" .
ex:hasParty a owl:ObjectProperty ; rdfs:label "所属签约方" ; rdfs:domain ex:Contract ; rdfs:range ex:Party .
ex:amount a owl:DatatypeProperty ; rdfs:label "金额" ; rdfs:domain ex:Contract ; rdfs:range xsd:decimal .
`),
    )
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
  })
})
