#!/usr/bin/env tsx
/**
 * Confirm and promote an ontology candidate to a new version.
 *
 * NEVER skips confirmation. NEVER writes a version snapshot without:
 *   1. A fresh SHACL pass over the candidate file
 *   2. A non-empty --approver
 *
 * Execution steps:
 *   1. Read the candidate .ttl
 *   2. Re-run pySHACL (must pass; fails = stop here, no mutation)
 *   3. Determine next version (default: patch bump over the stored version records)
 *   4. Write the version snapshot graph + version record into graph.db.nq
 *   5. Replace the domain's live graph with the candidate
 *   6. Set activeVersion/updatedAt and refresh the summary cache
 *   7. Append the confirmation entry to candidates.json (status → confirmed)
 *   8. Print a diff summary vs the previous live graph
 *
 * Usage:
 *   pnpm exec tsx ontology-store/scripts/confirm-ontology.ts \
 *     --candidate candidates/contract-20261029-143015.ttl \
 *     --approver "张三" \
 *     [--note "修复 #142 的合同类型定义"] \
 *     [--version 1.2.0]          # auto-detect if omitted
 *
 * Env vars: none required
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { argv } from 'node:process'
import {
  domainExists,
  listVersions,
  nextVersion,
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

// --- Arg parsing ---

interface ConfirmArgs {
  candidate: string
  approver: string
  note: string
  version: string
}

function parseArgs(args: string[]): ConfirmArgs {
  const out: ConfirmArgs = { candidate: '', approver: '', note: '', version: '' }
  for (let i = 0; i < args.length; i += 1) {
    switch (args[i]) {
      case '--candidate': out.candidate = args[++i]; break
      case '--approver': out.approver = args[++i]; break
      case '--note': out.note = args[++i]; break
      case '--version': out.version = args[++i]; break
      default: throw new Error(`Unknown arg: ${args[i]}`)
    }
  }
  if (!out.candidate || !out.approver) {
    throw new Error('Required args: --candidate, --approver')
  }
  out.approver = out.approver.trim()
  if (out.approver.length === 0) throw new Error('--approver must be non-empty')
  return out
}

// --- SHACL ---

function shaclValidate(ttlPath: string, shapesPath: string): Promise<{ conforms: boolean; text: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = ''
    const child = spawn('python3', ['-m', 'pyshacl', '-s', shapesPath, '-df', 'turtle', ttlPath])
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', err => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') reject(new Error('pySHACL not found. Install with: pip install pyshacl'))
      else reject(err)
    })
    child.on('close', code => resolve({ conforms: code === 0, text: stdout || stderr }))
  })
}

// --- Version bumping ---

function parseSemver(v: string): { major: number; minor: number; patch: number } | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

// --- Main ---

async function main(): Promise<void> {
  const args = parseArgs(argv.slice(2))
  const storeRoot = resolve(__dirname, '..')
  const candidatePath = resolve(args.candidate)
  const candidateName = candidatePath.split(/[\\/]/).pop()!.replace(/\.ttl$/, '')
  // Extract domain from candidate path: candidates/{domain}-{timestamp}.ttl
  const domain = candidateName.split('-')[0]
  const domainDir = join(storeRoot, domain)
  const shapesPath = join(domainDir, 'shapes.ttl')
  const candidatesDir = join(storeRoot, 'candidates')

  // === Pre-conditions ===
  if (!existsSync(candidatePath)) { console.error(`Candidate not found: ${candidatePath}`); process.exit(1) }
  try {
    requireDomainId(domain)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  if (!await domainExists(storeRoot, domain)) { console.error(`Domain not found in the ontology store: ${domain}`); process.exit(1) }
  if (!existsSync(shapesPath)) { console.error(`shapes.ttl not found at ${shapesPath}. Cannot confirm without SHACL.`); process.exit(1) }

  // === 1. Re-verify SHACL (fresh pass, no cache) ===
  process.stdout.write(`[1/6] Re-validating SHACL on ${relative(storeRoot, candidatePath)}...`)
  const shacl = await shaclValidate(candidatePath, shapesPath)
  if (!shacl.conforms) {
    console.log(' FAILED')
    console.error('\n❌ SHACL validation failed — confirmation BLOCKED.')
    console.error(shacl.text)
    process.exit(1)
  }
  console.log(' PASSED')

  // === 2. Determine version ===
  const stored = await listVersions(storeRoot, domain)
  let version = args.version
  if (!version) {
    version = nextVersion(stored.map(record => record.version))
    process.stdout.write(`[2/6] Auto-detected next version: ${version}...`)
  } else {
    if (!parseSemver(version)) { console.error(`Invalid semver: ${version}`); process.exit(1) }
    process.stdout.write(`[2/6] Using explicit version: ${version}...`)
  }
  if (stored.some(record => record.version === version)) {
    console.error(`Version ${version} already exists. Cannot overwrite.`)
    process.exit(1)
  }
  console.log(' OK')

  // === 3. Snapshot the candidate as an immutable version ===
  const turtle = await readFile(candidatePath, 'utf8')
  const previous = await readLiveTurtle(storeRoot, domain)
  const meta = await readDomainMeta(storeRoot, domain)
  const now = new Date().toISOString()
  await writeVersion(storeRoot, domain, turtle, {
    version,
    createdAt: now,
    approver: args.approver,
    note: args.note,
    sourceName: relative(storeRoot, candidatePath),
  })
  console.log(`[3/6] Snapshot → ${domain}@${version}`)

  // === 4. Replace the live graph ===
  await writeLiveTurtle(storeRoot, domain, turtle)
  await writeDomainMeta(storeRoot, {
    id: domain,
    label: meta.label,
    createdAt: meta.createdAt || now,
    updatedAt: now,
    activeVersion: version,
    disabled: meta.disabled,
  })
  console.log(`[4/6] Live graph replaced`)

  // === 5. Refresh the summary cache ===
  process.stdout.write(`[5/6] Refreshing summary cache...`)
  await writeSummaryCache(storeRoot, domain, { stamp: now, text: generateSummary(domain, turtle) })
  console.log(' OK')

  // === 6. Update candidates.json ===
  const indexPath = join(candidatesDir, 'candidates.json')
  if (existsSync(indexPath)) {
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as Array<Record<string, unknown>>
    const entry = index.find(e => e.id === candidateName)
    if (entry) {
      entry.status = 'confirmed'
      entry.confirmedBy = args.approver
      entry.confirmedAt = now
      entry.version = version
      await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8')
    }
  }

  console.log(`[6/6] Confirmation recorded → candidates.json`)

  // === Diff summary ===
  let diffLines = 0, addedClasses = 0, removedClasses = 0
  if (previous.trim().length > 0) {
    const prevClasses = new Set([...previous.matchAll(/([\w:]+)\s+a\s+owl:Class/g)].map(m => m[1]))
    const newClasses = [...turtle.matchAll(/([\w:]+)\s+a\s+owl:Class/g)].map(m => m[1])
    const prevClassArr = [...prevClasses]
    for (const c of newClasses) if (!prevClasses.has(c)) addedClasses += 1
    for (const c of prevClassArr) if (!newClasses.includes(c)) removedClasses += 1
    const prevLines = new Set(previous.split('\n').filter(l => l.trim()))
    for (const line of turtle.split('\n').filter(l => l.trim())) {
      if (!prevLines.has(line)) diffLines += 1
    }
  }

  console.log('')
  console.log('═══════════════════════════════════════════')
  console.log('  ✅ 确认完成')
  console.log('═══════════════════════════════════════════')
  console.log(`  Approver:    ${args.approver}`)
  console.log(`  Version:     ${version}`)
  console.log(`  Domain:      ${domain}`)
  console.log(`  Snapshot:    ${domain}@${version} (version graph)`)
  console.log(`  SHACL:       ✅ PASSED (二次校验)`)
  if (previous.trim().length > 0) {
    console.log(`  +新增行:     ${diffLines}`)
    console.log(`  新增类:      ${addedClasses}`)
    console.log(`  移除类:      ${removedClasses}`)
  }
  if (args.note) console.log(`  Note:        ${args.note}`)
  console.log('')
  console.log('  所有历史版本保留在 graph.db.nq 的版本图中，')
  console.log('  不支持无 approver 的直接发布。')
}

await main()
