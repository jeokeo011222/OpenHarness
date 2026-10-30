import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OntologyDatabase, databaseAt, forgetDatabase } from '../src/graph-db.ts'

const GRAPH = 'urn:test:graph'

const TURTLE = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <http://example.org/ontology/contract#> .

ex:Contract a owl:Class ;
  rdfs:label "合同" .
`

const UPDATED_TURTLE = `@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <http://example.org/ontology/contract#> .

ex:Contract a owl:Class ;
  rdfs:label "合同" .

ex:Service a owl:Class ;
  rdfs:label "服务" .
`

const roots: string[] = []

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ontology-db-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    forgetDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})

/** Write a lock record naming the current process. */
async function writeLock(root: string, startedAt: string): Promise<void> {
  await writeFile(join(root, 'graph.db.lock'), JSON.stringify({ pid: process.pid, startedAt }), 'utf8')
}

describe('durable image', () => {
  it('keeps the dataset across a reopened handle', async () => {
    const root = await newRoot()
    const db = databaseAt(root)
    await db.replaceGraph(GRAPH, TURTLE)
    expect(existsSync(join(root, 'graph.db.nq'))).toBe(true)

    forgetDatabase(root)
    const reopened = databaseAt(root)
    expect(await reopened.graphTurtle(GRAPH)).toContain('http://example.org/ontology/contract#Contract')
  })

  it('reloads the image written by another handle before the next read', async () => {
    const root = await newRoot()
    const first = databaseAt(root)
    await first.replaceGraph(GRAPH, TURTLE)

    // A second handle over the same root stands in for another process.
    const second = new OntologyDatabase(root)
    await second.replaceGraph(GRAPH, UPDATED_TURTLE)

    expect(await first.graphTurtle(GRAPH)).toContain('http://example.org/ontology/contract#Service')
  })

  it('fails loud on a corrupt image', async () => {
    const root = await newRoot()
    await writeFile(join(root, 'graph.db.nq'), 'this is not n-quads\n', 'utf8')
    const db = databaseAt(root)
    await expect(db.run(() => null)).rejects.toMatchObject({ kind: 'corrupt-image' })
  })

  it('fails loud when the image records a newer format version', async () => {
    const root = await newRoot()
    await writeFile(
      join(root, 'graph.db.nq'),
      '<urn:dsh:ontology:registry> <urn:dsh:ontology:formatVersion> "2" <urn:dsh:ontology:registry> .\n',
      'utf8',
    )
    const db = databaseAt(root)
    await expect(db.run(() => null)).rejects.toMatchObject({ kind: 'schema-mismatch' })
  })
})

describe('writer lock', () => {
  it('takes over a lock left by an over-age writer', async () => {
    const root = await newRoot()
    await writeLock(root, new Date(Date.now() - 120_000).toISOString())
    const db = databaseAt(root)
    await expect(db.mutate(() => {})).resolves.toBeUndefined()
    expect(existsSync(join(root, 'graph.db.lock'))).toBe(false)
  })

  it('refuses to write while a live writer holds the lock', async () => {
    const root = await newRoot()
    await writeLock(root, new Date().toISOString())
    const db = databaseAt(root)
    await expect(db.mutate(() => {})).rejects.toMatchObject({ kind: 'locked' })
    expect(existsSync(join(root, 'graph.db.lock'))).toBe(true)
  })
})

describe('backup and restore', () => {
  it('writes a loadable backup and restores it over later writes', async () => {
    const root = await newRoot()
    const db = databaseAt(root)
    await db.replaceGraph(GRAPH, TURTLE)

    const backup = await db.backup()
    expect(existsSync(backup)).toBe(true)
    expect(await db.graphTurtle(GRAPH)).toContain('http://example.org/ontology/contract#Contract')

    await db.replaceGraph(GRAPH, UPDATED_TURTLE)
    expect(await db.graphTurtle(GRAPH)).toContain('http://example.org/ontology/contract#Service')

    await OntologyDatabase.restore(root, backup)
    forgetDatabase(root)

    const restored = databaseAt(root)
    const turtle = await restored.graphTurtle(GRAPH)
    expect(turtle).toContain('http://example.org/ontology/contract#Contract')
    expect(turtle).not.toContain('http://example.org/ontology/contract#Service')
  })

  it('refuses to restore a backup that does not parse', async () => {
    const root = await newRoot()
    const broken = join(root, 'broken.nq')
    await writeFile(broken, 'not n-quads\n', 'utf8')
    await expect(OntologyDatabase.restore(root, broken)).rejects.toMatchObject({ kind: 'corrupt-image' })
  })
})
