import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { forgetDatabase } from '../src/graph-db.ts'
import { listDomains, loadOntology } from '../src/loader.ts'
import { writeRegistry } from '../src/store.ts'

const roots: string[] = []

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ontology-loader-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    forgetDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})

describe('listDomains', () => {
  it('returns an empty list for a store without domains', async () => {
    const root = await newRoot()
    await expect(listDomains(root)).resolves.toEqual([])
    await writeRegistry(root, ['contract'])
    await expect(listDomains(root)).resolves.toEqual(['contract'])
  })
})

describe('loadOntology', () => {
  it('throws domain-missing when the domain has no live graph', async () => {
    const root = await newRoot()
    await expect(loadOntology(root, 'contract')).rejects.toMatchObject({
      kind: 'domain-missing',
      domain: 'contract',
    })
  })

  it('throws domain-missing for a registered domain without a graph', async () => {
    const root = await newRoot()
    await writeRegistry(root, ['contract'])
    await expect(loadOntology(root, 'contract')).rejects.toMatchObject({ kind: 'domain-missing' })
  })
})
