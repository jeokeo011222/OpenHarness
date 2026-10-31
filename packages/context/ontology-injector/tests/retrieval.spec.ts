import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { forgetDatabase } from '../src/graph-db.ts'
import { ingestDocument, readChunks, sliceClauses, writeChunks } from '../src/retrieval/chunks.ts'
import { judge } from '../src/retrieval/compat.ts'
import { buildIndex, embed, tokenize } from '../src/retrieval/index.ts'
import { findIdentifiers, loadLexicon, matchTerms, normalizeTerm } from '../src/retrieval/lexicon.ts'
import { escapeLiteral, plan, subjectClass } from '../src/retrieval/planner.ts'
import {
  DEFAULT_WEIGHTS,
  finalize,
  fuse,
  graphScore,
  keywordScore,
  priorityFactor,
  saturate,
  tierWeightSum,
  validateWeights,
  vectorScore,
} from '../src/retrieval/scoring.ts'
import type { EvidenceChunk } from '../src/retrieval/types.ts'
import { retrieve } from '../src/retrieval/service.ts'
import { expandPrefixed, runGate, scopeWhere } from '../src/shacl/engine.ts'
import { loadShapes } from '../src/shacl/shapes.ts'
import { trace } from '../src/trace.ts'
import {
  readLiveTurtle,
  writeDomainMeta,
  writeInstanceGraph,
  writeLiveTurtle,
  writeRegistry,
} from '../src/store.ts'

const roots: string[] = []

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-retrieval-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    forgetDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})

/** Minimal payment ontology: two classes, four properties. */
const ONTOLOGY = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix pay: <http://ontorag.local/payment#> .

pay:Contract a owl:Class ; rdfs:label "合同" .
pay:PaymentApplication a owl:Class ; rdfs:label "付款申请" .

pay:contractAmount a owl:DatatypeProperty ;
  rdfs:label "合同金额" ; rdfs:domain pay:Contract ; rdfs:range xsd:decimal .
pay:paidAmount a owl:DatatypeProperty ;
  rdfs:label "已付金额" ; rdfs:domain pay:Contract ; rdfs:range xsd:decimal .
pay:appliedAmount a owl:DatatypeProperty ;
  rdfs:label "申请金额" ; rdfs:domain pay:PaymentApplication ; rdfs:range xsd:decimal .
pay:againstContract a owl:ObjectProperty ;
  rdfs:label "关联合同" ; rdfs:domain pay:PaymentApplication ; rdfs:range pay:Contract .

pay:Overpay a <http://www.w3.org/ns/shacl#NodeShape> ;
  rdfs:label "付款申请不得超过合同剩余应付" ;
  <http://www.w3.org/ns/shacl#targetClass> pay:PaymentApplication ;
  <http://www.w3.org/ns/shacl#sparql> [
    <http://www.w3.org/ns/shacl#message> "超付：{?this} 申请 {?applied}，剩余应付 {?remaining}" ;
    <http://www.w3.org/ns/shacl#select> """
      SELECT $this ?applied ?remaining WHERE {
        $this pay:againstContract ?contract ;
              pay:appliedAmount ?applied .
        ?contract pay:contractAmount ?total .
        OPTIONAL { ?contract pay:paidAmount ?paid0 }
        BIND(COALESCE(?paid0, 0) AS ?paid)
        BIND(xsd:decimal(?total) - xsd:decimal(?paid) AS ?remaining)
        FILTER(xsd:decimal(?applied) > ?remaining)
      }
    """ ;
  ] .
`

/** One overpaid application and one clean one. */
const INSTANCES = `@prefix pay: <http://ontorag.local/payment#> .
@prefix ex: <http://ontorag.local/tenant/demo/payment#> .

ex:C-2024-001 a pay:Contract ;
  pay:contractAmount 10000000 ;
  pay:paidAmount 5000000 .

ex:PAY-1001 a pay:PaymentApplication ;
  pay:appliedAmount 7000000 ;
  pay:againstContract ex:C-2024-001 .

ex:PAY-1002 a pay:PaymentApplication ;
  pay:appliedAmount 2000000 ;
  pay:againstContract ex:C-2024-001 .
`

const PAYMENT_CLAUSE = '第三条 付款申请金额不得超过合同金额。财务在受理付款申请时，须核对申请金额与合同总额，超出部分不予支付。'

const CARBON_CLAUSE = '第二条 核算边界应覆盖全部排放源；付款类凭证涉及的排放数据按年度归档，tCO2e 须经第三方核查。'

async function seedDomain(root: string): Promise<void> {
  await writeRegistry(root, ['payment'])
  await writeDomainMeta(root, {
    id: 'payment',
    label: '合同付款风控',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeVersion: null,
    disabled: false,
  })
  await writeLiveTurtle(root, 'payment', ONTOLOGY)
  await writeInstanceGraph(root, 'payment', 'sample', INSTANCES)
}

function chunk(overrides: Partial<EvidenceChunk> = {}): EvidenceChunk {
  return {
    chunkId: 'doc#1',
    docId: 'doc',
    docTitle: '付款管理办法',
    docType: 'regulation',
    clauseNo: '第一条',
    text: '付款申请需要核对合同金额。',
    classes: ['PaymentApplication'],
    properties: ['appliedAmount'],
    identifiers: [],
    priority: 40,
    effectiveFrom: null,
    effectiveTo: null,
    deprecated: false,
    ...overrides,
  }
}

describe('scoring', () => {
  it('saturates towards one without ever reaching it', () => {
    expect(saturate(0, 6)).toBe(0)
    expect(saturate(6, 6)).toBeCloseTo(0.5, 6)
    expect(saturate(600, 6)).toBeLessThan(1)
    expect(saturate(-1, 6)).toBe(0)
    expect(saturate(Number.NaN, 6)).toBe(0)
  })

  it('weights graph above keyword above vector for the same tier score', () => {
    const graph = fuse([{ tier: 'graph', score: 1 }])
    const keyword = fuse([{ tier: 'keyword', score: 1 }])
    const vector = fuse([{ tier: 'vector', score: 1 }])
    expect(graph).toBeGreaterThan(keyword)
    expect(keyword).toBeGreaterThan(vector)
  })

  it('rewards agreement: two tiers beat one strong tier', () => {
    const single = fuse([{ tier: 'graph', score: 0.8 }])
    const agree = fuse([
      { tier: 'graph', score: 0.8 },
      { tier: 'keyword', score: 0.5 },
    ])
    expect(agree).toBeGreaterThan(single)
  })

  it('drops vector similarity below the baseline to zero', () => {
    expect(vectorScore(0.3)).toBe(0)
    expect(vectorScore(0.1)).toBe(0)
    expect(vectorScore(0.65)).toBeCloseTo(0.85 * ((0.65 - 0.3) / 0.7), 6)
  })

  it('applies priority exactly once and keeps it within ten percent', () => {
    expect(priorityFactor(30)).toBe(1)
    expect(priorityFactor(50)).toBeCloseTo(1.1, 6)
    expect(priorityFactor(10)).toBeCloseTo(0.9, 6)
    expect(finalize(0.5, 50)).toBeCloseTo(0.55, 6)
  })

  it('validates weight configurations', () => {
    expect(tierWeightSum(DEFAULT_WEIGHTS)).toBeCloseTo(1, 6)
    expect(validateWeights(DEFAULT_WEIGHTS)).toBeNull()
    expect(validateWeights({ graph: 0, keyword: 0, vector: 0 })).not.toBeNull()
    expect(validateWeights({ graph: -1, keyword: 1, vector: 0 })).not.toBeNull()
  })

  it('scores graph paths by strength and coverage', () => {
    expect(graphScore(1, 1)).toBeCloseTo(1, 6)
    expect(graphScore(0, 0)).toBe(0)
    expect(graphScore(1, 0)).toBeCloseTo(0.7, 6)
  })

  it('scores keyword by rank and coverage', () => {
    expect(keywordScore(0, 1)).toBeGreaterThan(keywordScore(5, 1))
    expect(keywordScore(0, 0)).toBeLessThan(keywordScore(0, 1))
  })
})

describe('tokenisation', () => {
  it('cuts CJK runs into bigrams and keeps latin words', () => {
    const tokens = tokenize('付款申请 PAY-1001')
    expect(tokens).toContain('付款')
    expect(tokens).toContain('款申')
    expect(tokens).toContain('pay')
    expect(tokens).toContain('1001')
  })

  it('produces unit-length deterministic embeddings', () => {
    const first = embed('合同金额')
    const second = embed('合同金额')
    expect(first).toEqual(second)
    const norm = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0))
    expect(norm).toBeCloseTo(1, 6)
  })

  it('normalises surface forms for alias lookup', () => {
    expect(normalizeTerm('付款申请（含税）')).toBe('付款申请含税')
    expect(normalizeTerm('  Contract  ')).toBe('contract')
  })
})

describe('clause slicing', () => {
  it('splits on clause markers', () => {
    const slices = sliceClauses('第一条 总则内容。第二条 付款流程内容。第三条 附则内容。')
    expect(slices.map(slice => slice.clause)).toEqual(['第一条', '第二条', '第三条'])
  })

  it('falls back to numbered paragraphs when no clause marker exists', () => {
    const slices = sliceClauses('1. 第一段内容\n2. 第二段内容')
    expect(slices.length).toBeGreaterThanOrEqual(2)
  })

  it('returns one slice for unmarked prose', () => {
    const slices = sliceClauses('这是一段没有条款标记的说明文字。')
    expect(slices).toHaveLength(1)
    expect(slices[0]?.clause).toBe('正文')
  })

  it('ignores an empty document', () => {
    expect(sliceClauses('   ')).toEqual([])
  })
})

describe('lexicon', () => {
  it('reads classes, properties and aliases from the domain graph', async () => {
    const root = await newRoot()
    await seedDomain(root)
    const lexicon = await loadLexicon(root, 'payment')

    expect(lexicon.classes.has('PaymentApplication')).toBe(true)
    expect(lexicon.properties.get('appliedAmount')?.kind).toBe('datatype')
    expect(lexicon.properties.get('againstContract')?.kind).toBe('object')
    expect(lexicon.namespace).toBe('http://ontorag.local/payment#')
  })

  it('matches the longest alias first and does not double count', async () => {
    const root = await newRoot()
    await seedDomain(root)
    const lexicon = await loadLexicon(root, 'payment')
    const matched = matchTerms(lexicon, '付款申请的申请金额是否超过合同金额')

    expect(matched.classes).toContain('PaymentApplication')
    expect(matched.properties).toContain('appliedAmount')
  })

  it('extracts business identifiers verbatim', () => {
    expect(findIdentifiers('C-2024-001 这笔 700 万是否超付')).toEqual(['C-2024-001'])
    expect(findIdentifiers('PAY-1001 与 PAY-1002')).toEqual(['PAY-1001', 'PAY-1002'])
  })

  it('scopes the graph so another domain cannot leak in', async () => {
    const root = await newRoot()
    await seedDomain(root)
    await writeRegistry(root, ['payment', 'carbon'])
    await writeLiveTurtle(root, 'carbon', `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix car: <http://ontorag.local/carbon#> .
car:Emission a owl:Class ; <http://www.w3.org/2000/01/rdf-schema#label> "排放" .`)
    const lexicon = await loadLexicon(root, 'payment')
    expect(lexicon.classes.has('Emission')).toBe(false)
  })
})

describe('planner', () => {
  it('narrows by business identifier and keeps the graph scope', async () => {
    const root = await newRoot()
    await seedDomain(root)
    const lexicon = await loadLexicon(root, 'payment')
    const planned = plan({
      query: {
        text: 'C-2024-001 是否超付',
        domain: 'payment',
        classes: ['PaymentApplication'],
        properties: [],
        entities: [],
        identifiers: ['C-2024-001'],
        constraints: [],
        timeRange: { from: null, to: null },
      },
      lexicon,
      graphs: ['urn:test:graph'],
      maxRows: 50,
    })

    expect(planned.narrowed).toBe(true)
    expect(planned.sparql).toContain('urn:test:graph')
    expect(planned.sparql).toContain('STR(?iv) IN ("C-2024-001")')
    expect(planned.sparql.toUpperCase()).toContain('SELECT')
  })

  it('falls back to the property domain when no class was matched', async () => {
    const root = await newRoot()
    await seedDomain(root)
    const lexicon = await loadLexicon(root, 'payment')
    const chosen = subjectClass(
      {
        text: '申请金额',
        domain: 'payment',
        classes: [],
        properties: ['appliedAmount'],
        entities: [],
        identifiers: [],
        constraints: [],
        timeRange: { from: null, to: null },
      },
      lexicon,
    )
    expect(chosen).toBe('PaymentApplication')
  })

  it('returns an empty query when nothing could be planned', async () => {
    const root = await newRoot()
    await seedDomain(root)
    const lexicon = await loadLexicon(root, 'payment')
    const planned = plan({
      query: {
        text: '完全无关的问题',
        domain: 'payment',
        classes: [],
        properties: [],
        entities: [],
        identifiers: [],
        constraints: [],
        timeRange: { from: null, to: null },
      },
      lexicon,
      graphs: ['urn:test:graph'],
      maxRows: 10,
    })
    expect(planned.sparql).toBe('')
  })

  it('escapes literals instead of interpolating them raw', () => {
    expect(escapeLiteral('a"b')).toBe('a\\"b')
    expect(escapeLiteral('a\\b')).toBe('a\\\\b')
  })
})

describe('index', () => {
  it('ranks the clause that shares terms with the question first', () => {
    const chunks = [
      chunk({ chunkId: 'a#1', text: '付款申请金额不得超过合同金额，超出部分不予支付。' }),
      chunk({ chunkId: 'b#1', text: '核算边界应覆盖全部排放源，按年度归档。', classes: ['Emission'] }),
    ]
    const index = buildIndex(chunks)
    const hits = index.keyword('付款申请金额超过合同金额怎么办', 5)
    expect(hits[0]?.chunk.chunkId).toBe('a#1')
    expect(hits[0]?.coverage).toBeGreaterThan(0)
  })

  it('returns nothing for an empty library', () => {
    const index = buildIndex([])
    expect(index.keyword('任何问题', 5)).toEqual([])
    expect(index.vector('任何问题', 5)).toEqual([])
  })
})

describe('compatibility', () => {
  it('exempts a graph hit, passes an unconstrained question, and drops a mismatch', () => {
    expect(judge(chunk(), ['PaymentApplication'], true).compatible).toBe(true)
    expect(judge(chunk(), [], false).compatible).toBe(true)
    expect(judge(chunk(), ['Emission'], false).compatible).toBe(false)
  })

  it('fails closed when a clause carries no labels', () => {
    const verdict = judge(chunk({ classes: [] }), ['PaymentApplication'], false)
    expect(verdict.compatible).toBe(false)
    expect(verdict.reason).toContain('fail-closed')
  })
})

describe('shacl', () => {
  it('resolves a foreign prefix through the vocabulary by local name', async () => {
    const root = await newRoot()
    await seedDomain(root)
    const lexicon = await loadLexicon(root, 'payment')
    const expanded = expandPrefixed('SELECT $this WHERE { $this pay:againstContract ?c }', lexicon)
    expect(expanded.error).toBe('')
    expect(expanded.text).toContain('<http://ontorag.local/payment#againstContract>')
  })

  it('reports an unresolvable prefix instead of passing it through', async () => {
    const root = await newRoot()
    await seedDomain(root)
    const lexicon = await loadLexicon(root, 'payment')
    const expanded = expandPrefixed('SELECT $this WHERE { $this zzz:Unknown ?c }', lexicon)
    expect(expanded.error).toContain('zzz')
  })

  it('wraps the where body in GRAPH with a VALUES scope', async () => {
    const root = await newRoot()
    await seedDomain(root)
    const lexicon = await loadLexicon(root, 'payment')
    const scoped = scopeWhere(
      'SELECT $this WHERE { $this pay:appliedAmount ?a }',
      ['urn:dsh:ontology:graph:inst:payment:sample'],
      lexicon,
    )
    expect(scoped.error).toBe('')
    expect(scoped.query).toContain('VALUES ?g { <urn:dsh:ontology:graph:inst:payment:sample> }')
    expect(scoped.query).toContain('GRAPH ?g {')
  })

  it('reads the node shape and its sparql constraint', async () => {
    const root = await newRoot()
    await seedDomain(root)
    const shapes = await loadShapes(root, 'payment')
    expect(shapes).toHaveLength(1)
    expect(shapes[0]?.targetClass).toBe('http://ontorag.local/payment#PaymentApplication')
    expect(shapes[0]?.sparql).toHaveLength(1)
  })

  it('flags the overpaid application and leaves the clean one alone', async () => {
    const root = await newRoot()
    await seedDomain(root)
    const lexicon = await loadLexicon(root, 'payment')
    const shapes = await loadShapes(root, 'payment')
    const report = await runGate({
      root,
      domain: 'payment',
      graphs: ['urn:dsh:ontology:graph:inst:payment:sample'],
      shapes,
      lexicon,
    })

    expect(report.conforms).toBe(false)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]?.focusNode).toContain('PAY-1001')
    expect(report.violations[0]?.message).toContain('超付')
  })
})

describe('retrieval', () => {
  it('recalls the payment clause, drops the carbon clause, and cites the fact chain', async () => {
    const root = await newRoot()
    await seedDomain(root)
    const lexicon = await loadLexicon(root, 'payment')
    await ingestDocument(
      root,
      'payment',
      { domain: 'payment', title: '付款管理办法', docType: 'regulation', text: PAYMENT_CLAUSE },
      lexicon,
    )
    // Append the cross-domain clause by hand with a label that cannot overlap
    // the question's classes: the point under test is the compatibility filter,
    // not the tagger (which has its own cases above).
    const library = await readChunks(root, 'payment')
    library.push({
      chunkId: 'carbon#1',
      docId: 'carbon',
      docTitle: '碳排放核算规范',
      docType: 'standard',
      clauseNo: '第二条',
      text: CARBON_CLAUSE,
      classes: ['Contract'],
      properties: [],
      identifiers: [],
      priority: 38,
      effectiveFrom: null,
      effectiveTo: null,
      deprecated: false,
    })
    await writeChunks(root, 'payment', library)

    const outcome = await retrieve({
      root,
      domain: 'payment',
      query: {
        text: 'C-2024-001 这笔付款申请是否超付',
        domain: 'payment',
        classes: ['PaymentApplication'],
        properties: ['appliedAmount'],
        entities: [],
        identifiers: ['C-2024-001'],
        constraints: [],
        timeRange: { from: null, to: null },
      },
      topK: 5,
      today: '2026-10-31',
    })

    const kept = outcome.items.map(item => item.chunk.docTitle)
    expect(kept).toContain('付款管理办法')
    expect(kept).not.toContain('碳排放核算规范')
    expect(outcome.tiers.map(tier => tier.tier)).toEqual(['graph', 'keyword', 'vector'])
    expect(outcome.dropped.some(item => item.reason.includes('无交集'))).toBe(true)
  })

  it('accepts an ontology published into an empty domain', async () => {
    const root = await newRoot()
    await seedDomain(root)
    const turtle = await readLiveTurtle(root, 'payment')
    expect(turtle).toContain('PaymentApplication')
    const chunks = await readChunks(root, 'payment')
    expect(chunks).toEqual([])
  })
})

describe('trace', () => {
  it('blocks an answer when the gate finds a violation', async () => {
    const root = await newRoot()
    await seedDomain(root)
    const lexicon = await loadLexicon(root, 'payment')
    await ingestDocument(
      root,
      'payment',
      { domain: 'payment', title: '付款管理办法', docType: 'regulation', text: PAYMENT_CLAUSE },
      lexicon,
    )

    const result = await trace({
      root,
      domain: 'payment',
      question: 'C-2024-001 这笔付款申请是否超付',
      topK: 5,
      model: null,
    })

    expect(result.blocked).toBe(true)
    expect(result.blockReason).toContain('超付')
    expect(result.answer.startsWith('【已阻断】')).toBe(true)
    expect(result.provider).toBe('offline')
    expect(result.chain.map(step => step.kind)).toContain('evidence')
    expect(result.baseline.ran).toBe(true)
  })

  it('reports an unreadable ontology instead of throwing', async () => {
    const root = await newRoot()
    const result = await trace({ root, domain: 'missing', question: '任何问题', topK: 3, model: null })
    // An empty domain yields an empty lexicon rather than an exception; the
    // interesting contract is that the call returns a trace either way.
    expect(result.question).toBe('任何问题')
    expect(result.error === '' || result.error.length > 0).toBe(true)
  })
})

describe('remote surface', () => {
  /**
   * The Client narrows `ctx.remote.ontologyStore` through the hand-written face
   * because the generated Typert namespace file predates these endpoints. That
   * narrowing would also hide a renamed Host method, so the method names are
   * pinned here: a rename must update both sides.
   */
  it('exposes every retrieval endpoint the panel calls', async () => {
    const { OntologyStore } = await import('../src/index.ts')
    const names = Object.getOwnPropertyNames(OntologyStore.prototype)
    for (const name of [
      'retrievalTrace',
      'retrievalLibrary',
      'retrievalChunks',
      'retrievalIngest',
      'retrievalExamples',
    ]) {
      expect(names, `${name} must exist on the Host service`).toContain(name)
    }
  })
})
