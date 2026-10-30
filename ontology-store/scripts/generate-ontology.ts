#!/usr/bin/env tsx
/**
 * One-shot ontology candidate generator.
 *
 * Extends the original extract pipeline with:
 *   - Markdown confirmation report (source_clause map + confidence)
 *   - Auto-status marking: ready-for-confirm / manual-intervention-needed
 *   - SHACL retry (up to 3) before giving up
 *
 * Does NOT write to the ontology store — snapshotting remains the sole job of
 * confirm-ontology.ts.
 *
 * Usage:
 *   pnpm exec tsx ontology-store/scripts/generate-ontology.ts \
 *     --domain contract \
 *     --source ./合同管理办法.md \
 *     --skeleton ontology-store/contract/skeleton.ttl \
 *     [--max-retries 3]
 *
 * `--skeleton` names a Turtle file; when that file is absent the domain's live
 * ontology is read from `graph.db.nq` instead.
 *
 * Env vars:
 *   DEEPSEEK_API_KEY    (required)
 *   DEEPSEEK_BASE_URL   (optional, default https://api.deepseek.com/v1)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { argv } from 'node:process'
import { readLiveTurtle, requireDomainId } from '../../packages/context/ontology-injector/src/store.ts'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')

// --- Arg parsing ---

interface GenArgs {
  domain: string
  source: string
  skeleton: string
  maxRetries: number
  model: string
}

function parseArgs(args: string[]): GenArgs {
  const out: GenArgs = {
    domain: '', source: '', skeleton: '',
    maxRetries: 3, model: 'deepseek-chat',
  }
  for (let i = 0; i < args.length; i += 1) {
    switch (args[i]) {
      case '--domain': out.domain = args[++i]; break
      case '--source': out.source = args[++i]; break
      case '--skeleton': out.skeleton = args[++i]; break
      case '--max-retries': out.maxRetries = Number(args[++i]); break
      case '--model': out.model = args[++i]; break
      default: throw new Error(`Unknown arg: ${args[i]}`)
    }
  }
  if (!out.domain || !out.source || !out.skeleton) {
    throw new Error('Required args: --domain, --source, --skeleton')
  }
  return out
}

// --- Text slicing ---

interface TextSlice { clause: string; text: string }
function sliceByClauses(text: string): TextSlice[] {
  const clauseRegex = /(第[一二三四五六七八九十百千万零\d]+[章节条款部分卷编篇])|(§\s*\d+)/g
  const markers: Array<{ clause: string; index: number }> = []
  let match: RegExpExecArray | null
  while ((match = clauseRegex.exec(text)) !== null) markers.push({ clause: match[0], index: match.index })
  if (markers.length === 0) {
    const numbered = /(^|\n)\s*\d+\.\s*/g
    let nm: RegExpExecArray | null
    while ((nm = numbered.exec(text)) !== null) markers.push({ clause: `段落${markers.length + 1}`, index: nm.index })
  }
  if (markers.length === 0) return [{ clause: '全文', text }]
  const slices: TextSlice[] = []
  for (let i = 0; i < markers.length; i += 1) {
    const start = markers[i].index
    const end = (i + 1 < markers.length) ? markers[i + 1].index : text.length
    slices.push({ clause: markers[i].clause, text: text.slice(start, end).trim() })
  }
  return slices.filter(s => s.text.length > 10)
}

// --- API ---

const SYSTEM_PROMPT = `你是一位企业本体工程师。你的任务是从制度文本中提取 OWL 本体三元组，输出合法的 Turtle 格式。

严格约束：
1. 只使用骨架中预定义的命名空间前缀，不要引入新的前缀
2. 每个新添加的 Class / ObjectProperty / DatatypeProperty 必须在前面加注释 "# source: 第X条"
3. 优先复用骨架中已有的类（rdfs:domain / rdfs:range 引用骨架中已定义的类）
4. 保持 Turtle 格式简洁，不要添加骨架中没有的装饰性注释
5. 输出必须能通过 SHACL 校验

输出 JSON 格式：
{
  "turtle": "...",
  "clauses": ["来源条款"],
  "confidence": 0.9
}`

interface ApiResponse { turtle: string; clauses: string[]; confidence?: number }

async function callDeepseek(prompt: string, system: string, model: string, apiKey: string, baseUrl: string): Promise<ApiResponse> {
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], temperature: 0.2, response_format: { type: 'json_object' } }),
  })
  if (!resp.ok) { const body = await resp.text(); throw new Error(`DeepSeek API ${resp.status}: ${body}`) }
  const data = await resp.json()
  const content: string = data.choices?.[0]?.message?.content ?? ''
  const cleaned = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim()
  return JSON.parse(cleaned) as ApiResponse
}

function buildExtractPrompt(skeleton: string, slice: TextSlice): string {
  return `## 预定义命名空间骨架（必须复用）
\`\`\`turtle\n${skeleton}\n\`\`\`

## 制度文本片段（${slice.clause}）
${slice.text}

## 要求
输出 JSON（turtle + clauses + confidence），turtle 只包含新增的类或属性。`
}

function buildFixPrompt(currentTtl: string, skeleton: string, shaclText: string): string {
  return `## 骨架（必须复用已有前缀）
\`\`\`turtle\n${skeleton}\n\`\`\`

## 当前候选（校验未通过）
\`\`\`turtle\n${currentTtl}\n\`\`\`

## SHACL 校验报告
\`\`\`\n${shaclText}\n\`\`\`

请修正所有违规，返回完整合法的 Turtle + JSON（turtle + clauses + confidence）。`
}

// --- SHACL validate ---

interface ShaclResult { conforms: boolean; resultsText: string }

function shaclValidate(ttlPath: string, shapesPath: string): Promise<ShaclResult> {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = ''
    const child = spawn('python3', ['-m', 'pyshacl', '-s', shapesPath, '-df', 'turtle', ttlPath])
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', err => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('pySHACL not found. Install with: pip install pyshacl'))
      } else reject(err)
    })
    child.on('close', code => resolve({ conforms: code === 0, resultsText: stdout || stderr }))
  })
}

// --- Git hash for traceability ---

function tryGitHash(cwd: string): string {
  try { return execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim() } catch { return 'n/a' }
}

// --- Skeleton ---

/**
 * Read the Turtle skeleton candidates must reuse: the file named by
 * `--skeleton` when it exists, otherwise the domain's live ontology.
 * @param root - ontology store root.
 * @param domain - target domain id.
 * @param skeletonPath - path named by `--skeleton`.
 * @returns the skeleton Turtle.
 * @throws {Error} when neither the file nor a live ontology exists.
 */
async function loadSkeleton(root: string, domain: string, skeletonPath: string): Promise<string> {
  if (existsSync(skeletonPath)) return await readFile(skeletonPath, 'utf8')
  const live = await readLiveTurtle(root, domain)
  if (live.trim().length === 0) {
    throw new Error(`Skeleton not found: ${skeletonPath} (domain ${domain} has no live ontology)`)
  }
  return live
}

// --- Main ---

async function main(): Promise<void> {
  const args = parseArgs(argv.slice(2))
  const apiKey = process.env.DEEPSEEK_API_KEY
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1'
  if (!apiKey) { console.error('DEEPSEEK_API_KEY is required'); process.exit(1) }

  const storeRoot = resolve(__dirname, '..')
  const inputPath = resolve(args.source)
  const skeletonPath = resolve(args.skeleton)
  const domainDir = join(storeRoot, args.domain)
  const shapesPath = join(domainDir, 'shapes.ttl')
  const candidatesDir = join(storeRoot, 'candidates')

  if (!existsSync(inputPath)) { console.error(`Input not found: ${inputPath}`); process.exit(1) }
  try {
    requireDomainId(args.domain)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  await mkdir(candidatesDir, { recursive: true })

  const inputText = await readFile(inputPath, 'utf8')
  const skeleton = await loadSkeleton(storeRoot, args.domain, skeletonPath)
  const slices = sliceByClauses(inputText)
  console.log(`[1/4] Sliced input into ${slices.length} clause groups`)

  // 2. Extract
  const fragments: string[] = []
  const sourceMap: Array<{ clause: string; turtle: string; confidence: number }> = []
  for (const slice of slices) {
    if (slice.text.length < 20) continue
    process.stdout.write(`[2/4] Extracting ${slice.clause}...`)
    try {
      const r = await callDeepseek(buildExtractPrompt(skeleton, slice), SYSTEM_PROMPT, args.model, apiKey, baseUrl)
      if (r.turtle?.trim()) {
        fragments.push(r.turtle.trim())
        sourceMap.push({ clause: slice.clause, turtle: r.turtle.trim(), confidence: r.confidence ?? 0.5 })
        process.stdout.write(` ✓ (confidence ${(r.confidence ?? 0.5).toFixed(2)})\n`)
      } else {
        process.stdout.write(' (empty)\n')
      }
    } catch (err) {
      process.stdout.write(` ✗ ${(err as Error).message.slice(0, 60)}\n`)
    }
  }

  if (fragments.length === 0) { console.error('No fragments extracted.'); process.exit(1) }

  // 3. Merge
  const merged = [skeleton, '', '# === Auto-extracted candidates ===', ...fragments].join('\n')
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + new Date().toISOString().slice(11, 19).replace(/:/g, '')
  const candidateName = `${args.domain}-${timestamp}`
  const candidatePath = join(candidatesDir, `${candidateName}.ttl`)
  await writeFile(candidatePath, merged, 'utf8')

  // 4. SHACL
  process.stdout.write(`[3/4] SHACL validation...`)
  const hasShapes = existsSync(shapesPath)
  let finalTtl = merged
  let shaclConforms = !hasShapes
  let shaclAttempts = 0
  let shaclResults = ''

  if (hasShapes) {
    let r = await shaclValidate(candidatePath, shapesPath)
    shaclResults = `attempt-1: ${r.conforms ? 'PASSED' : 'FAILED'}\n${r.resultsText.slice(0, 2000)}`
    while (!r.conforms && shaclAttempts < args.maxRetries) {
      shaclAttempts += 1
      process.stdout.write(` retry ${shaclAttempts}/${args.maxRetries}...`)
      try {
        const fixed = await callDeepseek(buildFixPrompt(finalTtl, skeleton, r.resultsText), SYSTEM_PROMPT, args.model, apiKey, baseUrl)
        if (fixed.turtle) {
          finalTtl = [skeleton, '', '# === Corrected candidates ===', fixed.turtle.trim()].join('\n')
          await writeFile(candidatePath, finalTtl, 'utf8')
        }
      } catch { break }
      r = await shaclValidate(candidatePath, shapesPath)
      shaclResults += `\nattempt-${shaclAttempts + 1}: ${r.conforms ? 'PASSED' : 'FAILED'}\n${r.resultsText.slice(0, 1500)}`
    }
    shaclConforms = r.conforms
  } else {
    shaclResults = 'skipped (no shapes.ttl)'
  }

  process.stdout.write(shaclConforms ? ' PASSED\n' : (hasShapes ? ' FAILED (see report)\n' : ' SKIPPED\n'))

  // 5. Generate confirmation report (Markdown)
  const status = shaclConforms ? 'ready-for-confirm' : 'manual-intervention-needed'
  const now = new Date()
  const gitHash = tryGitHash(storeRoot)

  const newClassLines: string[] = []
  const newPropLines: string[] = []
  const newRelLines: string[] = []
  const sourceEntries: string[] = []
  for (const sm of sourceMap) {
    // Crude extraction: count owl:Class vs owl:Property declarations
    const classCount = (sm.turtle.match(/a\s+owl:Class/g) || []).length
    const objPropCount = (sm.turtle.match(/a\s+owl:ObjectProperty/g) || []).length
    const datPropCount = (sm.turtle.match(/a\s+owl:DatatypeProperty/g) || []).length
    const clsMatches = [...sm.turtle.matchAll(/([\w:]+)\s+a\s+owl:Class[^\n]*/g)].map(m => m[1])
    const objPropMatches = [...sm.turtle.matchAll(/([\w:]+)\s+a\s+owl:ObjectProperty/g)].map(m => m[1])
    const datPropMatches = [...sm.turtle.matchAll(/([\w:]+)\s+a\s+owl:DatatypeProperty/g)].map(m => m[1])
    for (const c of clsMatches) if (!newClassLines.includes(c)) newClassLines.push(c)
    for (const p of objPropMatches) if (!newRelLines.includes(p)) newRelLines.push(p)
    for (const p of datPropMatches) if (!newPropLines.includes(p)) newPropLines.push(p)
    sourceEntries.push(`| ${sm.clause} | ${classCount + objPropCount + datPropCount} | ${sm.confidence.toFixed(2)} | \`\`\`\n${sm.turtle.trim().slice(0, 200)}\n\`\`\` |`)
  }

  const report = [
    `# 本体候选确认报告`,
    ``,
    `**状态**: \`${status}\``,
    ``,
    `| 字段 | 值 |`,
    `|------|----|`,
    `| Domain | ${args.domain} |`,
    `| Source | ${relative(storeRoot, inputPath)} |`,
    `| Skeleton | ${relative(storeRoot, skeletonPath)} |`,
    `| Generated | ${now.toISOString()} |`,
    `| Git | \`${gitHash.slice(0, 8)}\` |`,
    `| Fragments | ${fragments.length} |`,
    `| SHACL | ${shaclConforms ? '✅ PASSED' : '❌ FAILED'}${shaclAttempts > 0 ? ` (${shaclAttempts} retries)` : ''} |`,
    ``,
    `## 本次变更概览`,
    ``,
    `### 新增类 (${newClassLines.length})`,
    newClassLines.length === 0 ? '_（无）_' : newClassLines.map(c => `- \`${c}\``).join('\n'),
    ``,
    `### 新增对象关系 (${newRelLines.length})`,
    newRelLines.length === 0 ? '_（无）_' : newRelLines.map(p => `- \`${p}\``).join('\n'),
    ``,
    `### 新增数据属性 (${newPropLines.length})`,
    newPropLines.length === 0 ? '_（无）_' : newPropLines.map(p => `- \`${p}\``).join('\n'),
    ``,
    `## 来源条款映射`,
    ``,
    `| 条款 | 新增实体数 | Confidence | Turtle 摘要 |`,
    `|------|-----------|------------|-------------|`,
    ...sourceEntries,
    ``,
    `## SHACL 校验详情`,
    ``,
    `\`\`\``,
    shaclResults,
    `\`\`\``,
    ``,
    `## 确认元数据（由 confirm-ontology.js 填充）`,
    ``,
    `- **Approver**: （待确认）`,
    `- **Confirmed At**: （待确认）`,
    `- **Confirmation Note**: （待确认）`,
    ``,
    `---`,
    `⚠️ **此候选尚未被人工确认，不要直接写入正式版本库。**`,
    `   确认命令：pnpm exec tsx ontology-store/scripts/confirm-ontology.ts \\`,
    `     --candidate ${relative(storeRoot, candidatePath)} --approver "张三"`,
  ].join('\n')

  const reportPath = join(candidatesDir, `${candidateName}-report.md`)
  await writeFile(reportPath, report, 'utf8')

  // 6. Index JSON for programmatic discovery
  const indexEntry = {
    id: candidateName,
    domain: args.domain,
    source: relative(storeRoot, inputPath),
    skeleton: relative(storeRoot, skeletonPath),
    generatedAt: now.toISOString(),
    gitHash,
    status,
    shaclConforms: shaclConforms,
    shaclRetries: shaclAttempts,
    fragments: fragments.length,
    newClasses: newClassLines.length,
    newRelations: newRelLines.length,
    newProperties: newPropLines.length,
    candidatePath: relative(storeRoot, candidatePath),
    reportPath: relative(storeRoot, reportPath),
  }
  const indexPath = join(candidatesDir, 'candidates.json')
  let index: Array<typeof indexEntry> = []
  try { index = JSON.parse(await readFile(indexPath, 'utf8')) } catch { /* empty */ }
  index.push(indexEntry)
  await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8')

  console.log(`[4/4] Report written`)
  console.log('')
  console.log(`═══════════════════════════════════`)
  console.log(`  Candidate: ${relative(storeRoot, candidatePath)}`)
  console.log(`  Report:    ${relative(storeRoot, reportPath)}`)
  console.log(`  Status:    ${status}`)
  console.log(`═══════════════════════════════════`)
  if (status === 'ready-for-confirm') {
    console.log(`\n✅ SHACL 已通过，可以运行确认命令：`)
    console.log(`   pnpm exec tsx ontology-store/scripts/confirm-ontology.ts \\`)
    console.log(`     --candidate ${relative(storeRoot, candidatePath)} --approver "张三"`)
  } else {
    console.log(`\n⚠️  SHACL 未通过（${shaclAttempts}/${args.maxRetries} 次重试后仍失败）`)
    console.log(`   候选已写入，请人工查看 report.md 中的违规详情，手动修正后重新运行 confirm-ontology.ts。`)
  }
}

await main()
