import { describe, expect, it } from 'vitest'
import { emptyModel, emitTurtle, mergeExtraction, parseTurtle, patchToEdits } from '../src/model.ts'
import type { Extraction } from '../src/model.ts'

/** One extraction naming a class and a property. */
const EXTRACTION: Extraction = {
  confidence: 0.8,
  classes: [{ name: 'Contract', label: '合同', comment: '合同实体' }],
  properties: [{ name: 'hasParty', kind: 'object', label: '签约方', comment: '', domain: 'Contract', range: 'Party' }],
}

describe('mergeExtraction', () => {
  it('records the clause and its text on every new node', () => {
    const model = emptyModel('contract')
    const added = mergeExtraction(model, EXTRACTION, '第 3 条 合同', '甲方与乙方签订的合同。')

    expect(added).toEqual(['class:Contract', 'class:Party', 'property:hasParty'])
    const contract = model.classes.find(item => item.id === 'Contract')
    expect(contract?.source).toBe('第 3 条 合同')
    expect(contract?.sourceText).toBe('甲方与乙方签订的合同。')
    expect(model.properties[0]?.sourceText).toBe('甲方与乙方签订的合同。')
  })

  it('keeps the source clause already recorded on an existing node', () => {
    const model = emptyModel('contract')
    mergeExtraction(model, EXTRACTION, '第 1 条', '第一条正文')
    mergeExtraction(model, EXTRACTION, '第 2 条', '第二条正文')

    const contract = model.classes.find(item => item.id === 'Contract')
    expect(contract?.source).toBe('第 1 条')
    expect(contract?.sourceText).toBe('第一条正文')
    expect(model.classes).toHaveLength(2)
  })
})

describe('Turtle round-trip', () => {
  it('keeps the source paragraph through emit and parse', () => {
    const model = emptyModel('contract')
    mergeExtraction(model, EXTRACTION, '第 3 条 合同', '甲方与乙方签订的合同。')

    const parsed = parseTurtle(emitTurtle(model), 'contract')
    const contract = parsed.classes.find(item => item.id === 'Contract')
    expect(contract?.sourceText).toBe('甲方与乙方签订的合同。')
    expect(parsed.properties[0]?.sourceText).toBe('甲方与乙方签订的合同。')
  })
})

describe('patchToEdits', () => {
  it('adds absent entities and updates existing ones', () => {
    const model = emptyModel('contract')
    model.classes.push({ id: 'Contract', label: '合同', comment: '', parents: [], source: '', sourceText: '' })

    const edits = patchToEdits(model, {
      classes: [
        { id: 'Contract', label: '合同（修订）', comment: '修订版', parents: ['Agreement'] },
        { id: 'Invoice', label: '发票', comment: '', parents: [] },
      ],
      properties: [{ id: 'hasParty', kind: 'object', label: '签约方', comment: '', domain: 'Contract', range: 'Party' }],
    })

    expect(edits).toEqual([
      { op: 'update-class', id: 'Contract', label: '合同（修订）', comment: '修订版', parents: ['Agreement'] },
      { op: 'add-class', id: 'Invoice', label: '发票', comment: '' },
      { op: 'add-property', id: 'hasParty', kind: 'object', label: '签约方', comment: '', domain: 'Contract', range: 'Party' },
    ])
  })

  it('removes before adding so one patch can replace an entity', () => {
    const model = emptyModel('contract')
    model.properties.push({
      id: 'hasParty',
      kind: 'object',
      label: '签约方',
      comment: '',
      domain: 'Contract',
      range: 'Party',
      source: '',
      sourceText: '',
    })

    const edits = patchToEdits(model, {
      removeProperties: ['hasParty'],
      properties: [{ id: 'hasParty', kind: 'datatype', label: '签约方名称', comment: '', domain: 'Contract', range: 'xsd:string' }],
      removeClasses: ['Party'],
    })

    expect(edits[0]).toEqual({ op: 'delete-property', id: 'hasParty' })
    expect(edits[1]).toEqual({ op: 'delete-class', id: 'Party' })
    expect(edits[2]).toEqual({
      op: 'add-property',
      id: 'hasParty',
      kind: 'datatype',
      label: '签约方名称',
      comment: '',
      domain: 'Contract',
      range: 'xsd:string',
    })
  })
})
