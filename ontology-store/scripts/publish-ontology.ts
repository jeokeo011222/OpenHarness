#!/usr/bin/env tsx
/**
 * Publish a candidate Turtle ontology as a new semver version.
 *
 * Execution steps:
 *   1. Verify candidate file exists
 *   2. Run pySHACL against the current shapes.ttl — block if fails
 *   3. Create versions/{version}/ directory
 *   4. Copy candidate.ttl → versions/{version}/ontology.ttl
 *   5. Copy shapes.ttl → versions/{version}/shapes.ttl
 *   6. Replace live ontology.ttl with the candidate (keeping shapes.ttl)
 *   7. Regenerate summary.md via generateSummary()
 *   8. Print a diff-like change summary
 *
 * Usage:
 *   pnpm exec tsx ontology-store/scripts/publish-ontology.ts \
 *     --domain contract \
 *     --candidate candidates/contract-20261029.ttl \
 *     --version 1.1.0
 *
 * Exits non-zero if the candidate fails SHACL or any file is missing.
 */

import { readFile, writeFile, copyFile, mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { argv } from 'node:process'

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

// --- Change summary (naive line diff vs previous ontology.ttl) ---

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
    if (!newLines.has(line)) removed.push(line)
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
  const domainDir = join(storeRoot, args.domain)
  const candidatePath = resolve(args.candidate)
  const shapesPath = join(domainDir, 'shapes.ttl')
  const currentOntologyPath = join(domainDir, 'ontology.ttl')
  const versionsDir = join(domainDir, 'versions')
  const versionDir = join(versionsDir, args.version)

  // 1. Validate inputs
  if (!existsSync(candidatePath)) {
    console.error(`Candidate not found: ${candidatePath}`)
    process.exit(1)
  }
  if (!existsSync(shapesPath)) {
    console.error(`shapes.ttl not found at ${shapesPath}`)
    process.exit(1)
  }
  if (existsSync(versionDir)) {
    console.error(`Version directory already exists: ${versionDir}`)
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

  // 3. Create version dir
  await mkdir(versionDir, { recursive: true })

  // 4. Copy candidate + shapes into version dir
  await copyFile(candidatePath, join(versionDir, 'ontology.ttl'))
  await copyFile(shapesPath, join(versionDir, 'shapes.ttl'))
  console.log(`📁 Version ${args.version} snapshot written to ${versionDir}`)

  // 5. Read old ontology (for diff), then replace live ontology.ttl
  const oldOntology = existsSync(currentOntologyPath)
    ? await readFile(currentOntologyPath, 'utf8')
    : ''
  await copyFile(candidatePath, currentOntologyPath)
  console.log(`🔄 Live ontology.ttl replaced`)

  // 6. Regenerate summary.md
  const summaryTurtle = await readFile(currentOntologyPath, 'utf8')
  // Use the same generateSummary from the injector — re-import via lib path
  // For CLI simplicity, inline the summary generation by calling the module
  const { generateSummary } = await import(
    join(storeRoot, '..', 'packages/context/ontology-injector/lib/types/summary.js')
  )
  await generateSummary(storeRoot, args.domain, summaryTurtle)
  console.log(`📝 summary.md regenerated`)

  // 7. Diff summary
  const summary = diffOntologies(oldOntology, summaryTurtle)
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
  console.log(`Previous versions preserved under ${versionsDir}`)
}

await main()
