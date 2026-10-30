#!/usr/bin/env tsx
/**
 * Publish a candidate Turtle ontology as a new semver version.
 *
 * Execution steps:
 *   1. Verify candidate file exists and the domain is registered
 *   2. Run pySHACL against the current shapes.ttl — block if fails
 *   3. Write the version snapshot graph + version record into graph.db.nq
 *   4. Replace the domain's live graph with the candidate
 *   5. Set activeVersion/updatedAt and refresh the summary cache
 *   6. Print a diff-like change summary
 *
 * Usage:
 *   pnpm exec tsx ontology-store/scripts/publish-ontology.ts \
 *     --domain contract \
 *     --candidate candidates/contract-20261029.ttl \
 *     --version 1.1.0
 *
 * Exits non-zero if the candidate fails SHACL or any input is missing.
 */

import { readFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { argv } from 'node:process'
import {
  domainExists,
  listVersions,
  readDomainMeta,
  readLiveTurtle,
  requireDomainId,
  writeDomainMeta,
  writeLiveTurtle,
  writeSummaryCache,
  writeVersion,
} from '../../packages/context/ontology-injector/src/store.ts'
import { generateSummary } from '../../packages/context/ontology-injector/src/summary.ts'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')

// --- Argument parsing ---

interface PublishArgs {
  domain: string
  candidate: string
  version: string
}

function parseArgs(args: string[]): PublishArgs {
  const out: PublishArgs = { domain: '', candidate: '', version: '' }
  for (let i = 0; i < args.length; i += 1) {
    switch (args[i]) {
      case '--domain': out.domain = args[++i]; break
      case '--candidate': out.candidate = args[++i]; break
      case '--version': out.version = args[++i]; break
      default: throw new Error(`Unknown arg: ${args[i]}`)
    }
  }
  if (!out.domain || !out.candidate || !out.version) {
    throw new Error('Required args: --domain, --candidate, --version')
  }
  return out
}

// --- SHACL validate ---

interface ShaclResult {
  conforms: boolean
  resultsText: string
}

function shaclValidate(candidateTtlPath: string, shapesTtlPath: string): Promise<ShaclResult> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn('python3', [
      '-m', 'pyshacl',
      '-s', shapesTtlPath,
      '-df', 'turtle',
      candidateTtlPath,
    ])
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', err => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(
          'pySHACL not found. Install with: pip install pyshacl'))
      } else {
        reject(err)
      }
    })
    child.on('close', code => {
      resolve({ conforms: code === 0, resultsText: stdout || stderr })
    })
  })
}

// --- Change summary (naive line diff vs the previous live graph) ---

interface ChangeSummary {
  added: string[]
  removed: string[]
  addedCount: number
  removedCount: number
}

function diffOntologies(old: string, neo: string): ChangeSummary {
  const oldLines = new Set(old.split('\n').filter(l => l.trim().length > 0))
  const newLines = neo.split('\n').filter(l => l.trim().length > 0)
  const added: string[] = []
  const removed: string[] = []
  for (const line of newLines) {
    if (!oldLines.has(line)) added.push(line)
  }
  for (const line of oldLines) {
    if (!newLines.includes(line)) removed.push(line)
  }
  return {
    added,
    removed,
    addedCount: added.length,
    removedCount: removed.length,
  }
}

// --- Main ---

async function main(): Promise<void> {
  const args = parseArgs(argv.slice(2))
  const storeRoot = resolve(__dirname, '..')
  const candidatePath = resolve(args.candidate)
  const shapesPath = join(join(storeRoot, args.domain), 'shapes.ttl')

  // 1. Validate inputs
  if (!existsSync(candidatePath)) {
    console.error(`Candidate not found: ${candidatePath}`)
    process.exit(1)
  }
  try {
    requireDomainId(args.domain)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  if (!existsSync(shapesPath)) {
    console.error(`shapes.ttl not found at ${shapesPath}`)
    process.exit(1)
  }
  if (!await domainExists(storeRoot, args.domain)) {
    console.error(`Domain not found in the ontology store: ${args.domain}`)
    process.exit(1)
  }
  const stored = await listVersions(storeRoot, args.domain)
  if (stored.some(record => record.version === args.version)) {
    console.error(`Version already exists: ${args.domain}@${args.version}`)
    process.exit(1)
  }

  // 2. SHACL validate
  console.log(`Running pySHACL on ${candidatePath}...`)
  const result = await shaclValidate(candidatePath, shapesPath)
  if (!result.conforms) {
    console.error('\n❌ SHACL validation FAILED — publication blocked.')
    console.error(result.resultsText)
    process.exit(1)
  }
  console.log('✅ SHACL conforms')

  // 3. Write the immutable version snapshot
  const turtle = await readFile(candidatePath, 'utf8')
  const previous = await readLiveTurtle(storeRoot, args.domain)
  const meta = await readDomainMeta(storeRoot, args.domain)
  const now = new Date().toISOString()
  await writeVersion(storeRoot, args.domain, turtle, {
    version: args.version,
    createdAt: now,
    approver: 'cli',
    note: `Published from ${relative(storeRoot, candidatePath)}`,
    sourceName: relative(storeRoot, candidatePath),
  })
  console.log(`📁 Version ${args.version} snapshot written to the ontology store`)

  // 4. Replace the live graph and activate the version
  await writeLiveTurtle(storeRoot, args.domain, turtle)
  await writeDomainMeta(storeRoot, {
    id: args.domain,
    label: meta.label,
    createdAt: meta.createdAt || now,
    updatedAt: now,
    activeVersion: args.version,
    disabled: meta.disabled,
  })
  console.log(`🔄 Live graph replaced`)

  // 5. Refresh the summary cache
  await writeSummaryCache(storeRoot, args.domain, { stamp: now, text: generateSummary(args.domain, turtle) })
  console.log(`📝 Summary cache refreshed`)

  // 6. Diff summary
  const summary = diffOntologies(previous, turtle)
  console.log('\n=== Publication Summary ===')
  console.log(`Domain:   ${args.domain}`)
  console.log(`Version:  ${args.version}`)
  console.log(`Added:    ${summary.addedCount} lines`)
  console.log(`Removed:  ${summary.removedCount} lines`)
  if (summary.addedCount > 0) {
    console.log('\nAdded (first 10):')
    for (const line of summary.added.slice(0, 10)) console.log(`  + ${line.slice(0, 100)}`)
  }
  if (summary.removedCount > 0) {
    console.log('\nRemoved (first 10):')
    for (const line of summary.removed.slice(0, 10)) console.log(`  - ${line.slice(0, 100)}`)
  }
  console.log('\n✅ Publication complete.')
  console.log(`Previous versions preserved in the ontology store`)
}

await main()
