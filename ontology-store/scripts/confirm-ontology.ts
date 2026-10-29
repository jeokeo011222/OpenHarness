#!/usr/bin/env tsx
/**
 * Confirm and promote an ontology candidate to a new version.
 *
 * NEVER skips confirmation. NEVER writes to versions/ without:
 *   1. A fresh SHACL pass over the candidate file
 *   2. A non-empty --approver
 *
 * Execution steps:
 *   1. Read the candidate .ttl
 *   2. Re-run pySHACL (must pass; fails = stop here, no mutation)
 *   3. Determine next version (default: bump last versions/* semver patch)
 *   4. Snapshot {candidate, shapes.ttl, summary.md} into versions/{version}/
 *   5. Replace live {domain}/ontology.ttl with candidate
 *   6. Regenerate summary.md via @deepseek-ai/dsh-ontology-injector's module
 *   7. Append confirmation entry to candidates.json (status → confirmed, approver, timestamp)
 *   8. Write confirmation metadata (approver, note, timestamp, git hash) into versions/{version}/.confirm.json
 *   9. Print a diff summary vs previous version
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

import { readFile, writeFile, copyFile, mkdir, stat } from 'node:fs/promises'
import { join, resolve, dirname, relative } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { argv } from 'node:process'
import { execSync } from 'node:child_process'

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

function bumpPatch(v: string): string {
  const p = parseSemver(v)
  if (!p) return v + '-1'
  return `${p.major}.${p.minor}.${p.patch + 1}`
}

function autoBump(versionsDir: string): string {
  if (!existsSync(versionsDir)) return '1.0.0'
  const dirs = readdirSync(versionsDir).filter(d => parseSemver(d))
  if (dirs.length === 0) return '1.0.0'
  dirs.sort((a, b) => {
    const pa = parseSemver(a)!
    const pb = parseSemver(b)!
    return (pb.major - pa.major) || (pb.minor - pa.minor) || (pb.patch - pa.patch)
  })
  return bumpPatch(dirs[0])
}

// --- Git hash ---

function tryGitHash(cwd: string): string {
  try { return execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim().slice(0, 8) } catch { return 'n/a' }
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
  const liveOntologyPath = join(domainDir, 'ontology.ttl')
  const versionsDir = join(domainDir, 'versions')
  const candidatesDir = join(storeRoot, 'candidates')

  // === Pre-conditions ===
  if (!existsSync(candidatePath)) { console.error(`Candidate not found: ${candidatePath}`); process.exit(1) }
  if (!existsSync(domainDir)) { console.error(`Domain dir not found: ${domainDir}`); process.exit(1) }
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
  let version = args.version
  if (!version) {
    version = autoBump(versionsDir)
    process.stdout.write(`[2/6] Auto-detected next version: ${version}...`)
  } else {
    if (!parseSemver(version)) { console.error(`Invalid semver: ${version}`); process.exit(1) }
    process.stdout.write(`[2/6] Using explicit version: ${version}...`)
  }
  const versionDir = join(versionsDir, version)
  if (existsSync(versionDir)) { console.error(`Version ${version} already exists. Cannot overwrite.`); process.exit(1) }
  console.log(' OK')

  // === 3. Snapshot current live ontology ===
  await mkdir(versionDir, { recursive: true })
  await copyFile(candidatePath, join(versionDir, 'ontology.ttl'))
  if (existsSync(shapesPath)) await copyFile(shapesPath, join(versionDir, 'shapes.ttl'))
  if (existsSync(join(domainDir, 'summary.md'))) {
    await copyFile(join(domainDir, 'summary.md'), join(versionDir, 'summary.md'))
  }
  console.log(`[3/6] Snapshot → ${relative(storeRoot, versionDir)}/`)

  // === 4. Replace live ontology.ttl ===
  if (existsSync(liveOntologyPath)) {
    await copyFile(liveOntologyPath, join(versionDir, 'ontology.prev.ttl'))
  }
  await copyFile(candidatePath, liveOntologyPath)
  console.log(`[4/6] Live ontology.ttl replaced`)

  // === 5. Regenerate summary.md (reuse injector's module) ===
  process.stdout.write(`[5/6] Regenerating summary.md...`)
  const turtle = await readFile(liveOntologyPath, 'utf8')
  try {
    const { generateSummary } = await import('@deepseek-ai/dsh-ontology-injector/src/summary.ts')
    await generateSummary(storeRoot, domain, turtle)
    console.log(' OK')
  } catch (err) {
    console.log(` fallback (inline)`)
    // Inline fallback: just write a header so summary.md exists
    const summaryPath = join(domainDir, 'summary.md')
    await writeFile(summaryPath, `## 当前业务域：${domain}\n\n（自动生成失败，需手动重建）\n`, 'utf8')
  }

  // === 6. Write confirmation metadata ===
  const now = new Date().toISOString()
  const confirmEntry = {
    approver: args.approver,
    note: args.note || '',
    confirmedAt: now,
    version,
    candidate: relative(storeRoot, candidatePath),
    shaclConforms: true,
    shaclReportPath: relative(storeRoot, join(candidatesDir, `${candidateName}-report.md`)),
    gitHash: tryGitHash(storeRoot),
  }
  await writeFile(join(versionDir, '.confirm.json'), JSON.stringify(confirmEntry, null, 2), 'utf8')

  // Update candidates.json
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

  console.log(`[6/6] Confirmation recorded → .confirm.json`)

  // === Diff summary ===
  let diffLines = 0, addedClasses = 0, removedClasses = 0
  const prevPath = join(versionDir, 'ontology.prev.ttl')
  if (existsSync(prevPath)) {
    const prev = await readFile(prevPath, 'utf8')
    const prevClasses = new Set([...prev.matchAll(/([\w:]+)\s+a\s+owl:Class/g)].map(m => m[1]))
    const newClasses = [...turtle.matchAll(/([\w:]+)\s+a\s+owl:Class/g)].map(m => m[1])
    const prevClassArr = [...prevClasses]
    for (const c of newClasses) if (!prevClasses.has(c)) addedClasses += 1
    for (const c of prevClassArr) if (!newClasses.includes(c)) removedClasses += 1
    const prevLines = new Set(prev.split('\n').filter(l => l.trim()))
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
  console.log(`  Snapshot:    ${relative(storeRoot, versionDir)}/`)
  console.log(`  SHACL:       ✅ PASSED (二次校验)`)
  if (existsSync(prevPath)) {
    console.log(`  +新增行:     ${diffLines}`)
    console.log(`  新增类:      ${addedClasses}`)
    console.log(`  移除类:      ${removedClasses}`)
  }
  if (args.note) console.log(`  Note:        ${args.note}`)
  console.log('')
  console.log('  所有历史版本保留在 versions/ 目录中，')
  console.log('  不支持无 approver 的直接发布。')
}

await main()
