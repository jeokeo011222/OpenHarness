import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from 'oxigraph'
import { afterEach, describe, expect, it } from 'vitest'
import { forgetDatabase } from '../src/graph-db.ts'
import {
  appendAudit,
  deleteDomain,
  deleteVersion,
  domainDirOf,
  domainStats,
  exportDomain,
  importOntology,
  listSources,
  listVersions,
  nextVersion,
  querySparql,
  readAudit,
  readDomainMeta,
  readLiveTurtle,
  readRegistry,
  readVersionTurtle,
  updateVersionRecord,
  writeDomainMeta,
  writeLiveTurtle,
  writeRegistry,
  writeSource,
  writeVersion,
} from '../src/store.ts'
import type { VersionRecord } from '../src/store.ts'

const TURTLE = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <http://example.org/ontology/contract#> .

ex:Contract a owl:Class ;
  rdfs:label "合同" .

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

const roots: string[] = []

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ontology-store-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    forgetDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})

/** Return the sorted absolute triples of a Turtle document. */
function triplesOf(turtle: string): string[] {
  const store = new Store()
  if (turtle.trim().length > 0) store.load(turtle, { format: 'text/turtle' })
  return store.match(null, null, null)
    .map(entry => `${entry.subject.value} ${entry.predicate.value} ${entry.object.value}`)
    .sort()
}

describe('domain registry and metadata', () => {
  it('round-trips registered domains and their metadata', async () => {
    const root = await newRoot()
    await writeRegistry(root, ['contract'])
    await expect(readRegistry(root)).resolves.toEqual(['contract'])

    const meta = {
      id: 'contract',
      label: '合同域',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
      activeVersion: '1.0.0',
      disabled: true,
    }
    await writeDomainMeta(root, meta)
    await expect(readDomainMeta(root, 'contract')).resolves.toEqual(meta)
  })

  it('synthesizes metadata for an unregistered domain', async () => {
    const root = await newRoot()
    await expect(readDomainMeta(root, 'unknown')).resolves.toEqual({
      id: 'unknown',
      label: 'unknown',
      createdAt: '',
      updatedAt: '',
      activeVersion: null,
      disabled: false,
    })
    await expect(readRegistry(root)).resolves.toEqual([])
  })

  it('drops metadata for domains removed from the registry list', async () => {
    const root = await newRoot()
    await writeRegistry(root, ['contract', 'procurement'])
    await writeRegistry(root, ['contract'])
    await expect(readRegistry(root)).resolves.toEqual(['contract'])
    await expect(readDomainMeta(root, 'procurement')).resolves.toMatchObject({ createdAt: '' })
  })
})

describe('live graphs and version snapshots', () => {
  it('writes and reads the live Turtle', async () => {
    const root = await newRoot()
    await writeLiveTurtle(root, 'contract', TURTLE)
    const live = await readLiveTurtle(root, 'contract')
    expect(live).toContain('http://example.org/ontology/contract#Contract')
    expect(triplesOf(live)).toEqual(triplesOf(TURTLE))
  })

  it('writes and reads an immutable version snapshot', async () => {
    const root = await newRoot()
    const record: VersionRecord = { version: '1.0.0', createdAt: '2026-01-01T00:00:00.000Z', approver: 'alice', note: '初稿', sourceName: 'contract.pdf', status: 'published' }
    await writeVersion(root, 'contract', TURTLE, record)

    const snapshot = await readVersionTurtle(root, 'contract', '1.0.0')
    expect(triplesOf(snapshot)).toEqual(triplesOf(TURTLE))
    await expect(listVersions(root, 'contract')).resolves.toEqual([record])
    await expect(readVersionTurtle(root, 'contract', '2.0.0')).rejects.toThrow('Version not found: 2.0.0')
  })

  it('computes the next patch version', () => {
    expect(nextVersion([])).toBe('1.0.0')
    expect(nextVersion(['1.0.0'])).toBe('1.0.1')
    expect(nextVersion(['1.0.0', '1.2.1'])).toBe('1.2.2')
  })

  it('imports an ontology as a draft version and working graph', async () => {
    const root = await newRoot()
    const version = await importOntology(root, 'contract', TURTLE, { approver: 'alice', note: '初稿', sourceName: 'contract.pdf' })
    expect(version).toBe('1.0.0')

    await expect(listVersions(root, 'contract')).resolves.toMatchObject([{
      version: '1.0.0',
      approver: 'alice',
      note: '初稿',
      sourceName: 'contract.pdf',
      status: 'draft',
    }])
    await expect(readDomainMeta(root, 'contract')).resolves.toMatchObject({ activeVersion: null, disabled: false })
    const live = await readLiveTurtle(root, 'contract')
    expect(triplesOf(live)).toEqual(triplesOf(TURTLE))

    const audit = await readAudit(root)
    expect(audit[0]).toMatchObject({ action: 'import', domain: 'contract' })
    expect(audit[0]?.detail).toContain('1.0.0')

    const second = await importOntology(root, 'contract', TURTLE, {})
    expect(second).toBe('1.0.1')
    await expect(readDomainMeta(root, 'contract')).resolves.toMatchObject({ activeVersion: null })
  })

  it('rejects a version that is the active one unless forced', async () => {
    const root = await newRoot()
    await importOntology(root, 'contract', TURTLE, {})
    await writeDomainMeta(root, {
      id: 'contract',
      label: 'contract',
      createdAt: '',
      updatedAt: '',
      activeVersion: '1.0.0',
      disabled: false,
    })

    await expect(deleteVersion(root, 'contract', '1.0.0')).rejects.toMatchObject({ kind: 'version-active' })
    await deleteVersion(root, 'contract', '1.0.0', true)

    await expect(readDomainMeta(root, 'contract')).resolves.toMatchObject({ activeVersion: null })
    await expect(listVersions(root, 'contract')).resolves.toEqual([])
    await expect(readVersionTurtle(root, 'contract', '1.0.0')).rejects.toThrow('Version not found: 1.0.0')
  })

  it('rejects deleting a version that was never stored', async () => {
    const root = await newRoot()
    await expect(deleteVersion(root, 'contract', '9.9.9')).rejects.toMatchObject({ kind: 'version-not-found' })
  })

  it('moves a version through review states without touching its snapshot', async () => {
    const root = await newRoot()
    await writeVersion(root, 'contract', TURTLE, {
      version: '1.0.0',
      createdAt: '2026-01-01T00:00:00.000Z',
      approver: 'alice',
      note: '初稿',
      sourceName: '',
      status: 'draft',
    })
    const records = await listVersions(root, 'contract')
    const record = records[0]
    expect(record?.status).toBe('draft')
    if (record === undefined) throw new Error('version record missing')

    await updateVersionRecord(root, 'contract', { ...record, status: 'review' })

    await expect(listVersions(root, 'contract')).resolves.toMatchObject([{ version: '1.0.0', status: 'review' }])
    expect(triplesOf(await readVersionTurtle(root, 'contract', '1.0.0'))).toEqual(triplesOf(TURTLE))
  })
})

describe('export and deletion', () => {
  it('exports the live graph as the same Turtle triples', async () => {
    const root = await newRoot()
    await importOntology(root, 'contract', TURTLE, {})
    const exported = await exportDomain(root, 'contract')
    expect(triplesOf(exported)).toEqual(triplesOf(TURTLE))
  })

  it('deletes a domain, its versions, and keeps uploaded sources on disk', async () => {
    const root = await newRoot()
    await importOntology(root, 'contract', TURTLE, {})
    const bytes = new TextEncoder().encode('contract text')
    const stored = await writeSource(root, 'contract', 'contract.md', bytes)
    await expect(listSources(root, 'contract')).resolves.toEqual([stored])

    await deleteDomain(root, 'contract')

    await expect(readRegistry(root)).resolves.toEqual([])
    await expect(readDomainMeta(root, 'contract')).resolves.toMatchObject({ createdAt: '' })
    await expect(listVersions(root, 'contract')).resolves.toEqual([])
    await expect(readLiveTurtle(root, 'contract')).resolves.toBe('')
    await expect(readVersionTurtle(root, 'contract', '1.0.0')).rejects.toThrow('Version not found: 1.0.0')
    await expect(listSources(root, 'contract')).resolves.toEqual([stored])
    expect(await readFile(join(domainDirOf(root, 'contract'), 'sources', stored))).toEqual(Buffer.from(bytes))
  })
})

describe('audit trail', () => {
  it('appends entries and reads them newest first with their fields', async () => {
    const root = await newRoot()
    await appendAudit(root, { action: 'domain-create', domain: 'contract', detail: '创建业务域' })
    await appendAudit(root, { action: 'domain-update', domain: 'contract', detail: '改名' })

    const entries = await readAudit(root)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ action: 'domain-update', domain: 'contract', detail: '改名' })
    expect(entries[1]).toMatchObject({ action: 'domain-create', detail: '创建业务域' })
    expect(entries[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('domain stats', () => {
  it('counts classes, properties, and versions in the live graph', async () => {
    const root = await newRoot()
    await importOntology(root, 'contract', TURTLE, {})
    const stats = await domainStats(root, 'contract')
    expect(stats).toMatchObject({
      tripleCount: 12,
      classCount: 2,
      propertyCount: 2,
      versionCount: 1,
      activeVersion: null,
      disabled: false,
    })
    expect(stats.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('SPARQL queries', () => {
  it('returns solution rows for SELECT', async () => {
    const root = await newRoot()
    await importOntology(root, 'contract', TURTLE, {})
    const result = await querySparql(
      root,
      'SELECT DISTINCT ?class WHERE { ?class a <http://www.w3.org/2002/07/owl#Class> }',
    )
    expect(result.kind).toBe('select')
    expect(result.variables).toEqual(['class'])
    expect(result.rows.map(row => row.class).sort()).toEqual([
      'http://example.org/ontology/contract#Contract',
      'http://example.org/ontology/contract#Party',
    ])
  })

  it('returns the answer for ASK', async () => {
    const root = await newRoot()
    await importOntology(root, 'contract', TURTLE, {})
    const result = await querySparql(root, 'ASK { ?s a <http://www.w3.org/2002/07/owl#Class> }')
    expect(result).toEqual({ variables: ['boolean'], rows: [{ boolean: 'true' }], kind: 'ask' })
  })

  it.each([
    ['INSERT', 'INSERT DATA { <urn:s> <urn:p> "value" }'],
    ['DELETE', 'DELETE WHERE { ?s ?p ?o }'],
    ['CLEAR', 'CLEAR GRAPH <urn:test:graph>'],
    ['DROP', 'DROP GRAPH <urn:test:graph>'],
  ])('rejects the %s update form', async (_label, sparql) => {
    const root = await newRoot()
    await expect(querySparql(root, sparql)).rejects.toMatchObject({ kind: 'query-rejected' })
  })
})
