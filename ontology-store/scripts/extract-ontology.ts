#!/usr/bin/env tsx
/**
 * Extract candidate Turtle ontology from institutional policy text.
 *
 * Pipeline:
 *   1. Slice input text by clause markers (第X条 / § / numbered sections)
 *   2. For each slice, call DeepSeek API (OpenAI-compatible) to generate
 *      a Turtle fragment scoped to the provided namespace skeleton
 *   3. Merge all fragments
 *   4. SHACL-validate the merged candidate with pySHACL subprocess;
 *      feed results_text back to the model for up to 2 correction retries
 *   5. Write {candidate}.ttl + {candidate}-report.txt to candidates/
 *
 * Does NOT write to the ontology store — promotion is a separate deliberate
 * action handled by publish-ontology.ts.
 *
 * Usage:
 *   pnpm exec tsx ontology-store/scripts/extract-ontology.ts \
 *     --domain contract \
 *     --input path/to/policy.md \
 *     --skeleton ontology-store/contract/skeleton.ttl \
 *     [--max-retries 2] \
 *     [--model deepseek-chat]
 *
 * `--skeleton` names a Turtle file; when that file is absent the domain's live
 * ontology is read from `graph.db.nq` instead.
 *
 * Env vars:
 *   DEEPSEEK_API_KEY    (required)
 *   DEEPSEEK_BASE_URL   (optional, default https://api.deepseek.com/v1)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { argv } from 'node:process'
import { readLiveTurtle, requireDomainId } from '../../packages/context/ontology-injector/src/store.ts'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')

// --- Argument parsing ---

interface ExtractArgs {
  domain: string
  input: string
  skeleton: string
  maxRetries: number
  model: string
}

function parseArgs(args: string[]): ExtractArgs {
  const out: ExtractArgs = {
    domain: '',
    input: '',
    skeleton: '',
    maxRetries: 2,
    model: 'deepseek-chat',
  }
  for (let i = 0; i < args.length; i += 1) {
    switch (args[i]) {
      case '--domain': out.domain = args[++i]; break
      case '--input': out.input = args[++i]; break
      case '--skeleton': out.skeleton = args[++i]; break
      case '--max-retries': out.maxRetries = Number(args[++i]); break
      case '--model': out.model = args[++i]; break
      default: throw new Error(`Unknown arg: ${args[i]}`)
    }
  }
  if (!out.domain || !out.input || !out.skeleton) {
    throw new Error('Required args: --domain, --input, --skeleton')
  }
  return out
}

// --- Text slicing ---

interface TextSlice {
  clause: string
  text: string
}

function sliceByClauses(text: string): TextSlice[] {
  // Match Chinese legal-style clauses: "第12条" / "第一章" / § 12
  const clauseRegex = /(第[一二三四五六七八九十百千万零\d]+[章节条款部分卷编篇])|(§\s*\d+)/g
  const slices: TextSlice[] = []
  let match: RegExpExecArray | null
  const markers: Array<{ clause: string; index: number }> = []
  while ((match = clauseRegex.exec(text)) !== null) {
    markers.push({ clause: match[0], index: match.index })
  }
  // Also fall back to numbered paragraphs like "1. xxx" if no clause markers
  if (markers.length === 0) {
    const numbered = /(^|\n)\s*\d+\.\s*/g
    let nm: RegExpExecArray | null
    while ((nm = numbered.exec(text)) !== null) {
      markers.push({ clause: `段落${markers.length + 1}`, index: nm.index })
    }
  }
  if (markers.length === 0) {
    // Whole text as one slice
    return [{ clause: '全文', text }]
  }
  for (let i = 0; i < markers.length; i += 1) {
    const start = markers[i].index
    const end = (i + 1 < markers.length) ? markers[i + 1].index : text.length
    slices.push({
      clause: markers[i].clause,
      text: text.slice(start, end).trim(),
    })
  }
  return slices.filter(s => s.text.length > 10)
}

// --- API prompt template ---

const SYSTEM_PROMPT = `你是一位企业本体工程师。你的任务是从制度文本中提取 OWL 本体三元组，输出合法的 Turtle 格式。

严格约束：
1. 只使用骨架中预定义的命名空间前缀，不要引入新的前缀
2. 每个新添加的 Class / ObjectProperty / DatatypeProperty 必须在前面加注释 "# source: 第X条"
3. 优先复用骨架中已有的类（rdfs:domain / rdfs:range 引用骨架中已定义的类）
4. 保持 Turtle 格式简洁，不要添加骨架中没有的装饰性注释
5. 输出必须能通过 SHACL 校验`

function buildUserPrompt(skeleton: string, slice: TextSlice): string {
  return `## 预定义命名空间骨架（必须复用）
\`\`\`turtle
${skeleton}
\`\`\`

## 制度文本片段（${slice.clause}）
${slice.text}

## 要求
输出严格的 JSON 格式，包含两个字段：
- turtle: 合法的 Turtle 片段（只定义新类或新属性）
- clauses: 数组，包含本次提取用到的来源子句

只输出 JSON，不要输出任何解释或 markdown 代码块标记。`
}

// --- API call ---

interface ApiResponse {
  turtle: string
  clauses: string[]
}

async function callDeepseek(prompt: string, system: string, model: string, apiKey: string, baseUrl: string): Promise<ApiResponse> {
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  })
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`DeepSeek API ${resp.status}: ${body}`)
  }
  const data = await resp.json()
  const content: string = data.choices?.[0]?.message?.content ?? ''
  // Parse response — sometimes the model wraps in backticks despite instructions
  const cleaned = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim()
  return JSON.parse(cleaned) as ApiResponse
}

// --- SHACL validate via pySHACL subprocess ---

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
          'pySHACL not found. Install with: pip install pyshacl\n'
          + `stderr: ${stderr}`))
      } else {
        reject(err)
      }
    })
    child.on('close', code => {
      // pySHACL: exit code 0 = conforms, non-zero = does not conform
      const conforms = code === 0
      resolve({ conforms, resultsText: stdout || stderr })
    })
  })
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

// --- Main pipeline ---

async function main(): Promise<void> {
  const args = parseArgs(argv.slice(2))
  const apiKey = process.env.DEEPSEEK_API_KEY
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1'
  if (!apiKey) {
    console.error('DEEPSEEK_API_KEY is required')
    process.exit(1)
  }

  const storeRoot = resolve(__dirname, '..')
  const inputPath = resolve(args.input)
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
  if (!existsSync(shapesPath)) { console.warn(`shapes.ttl not found at ${shapesPath}; SHACL step will be skipped`) }

  await mkdir(candidatesDir, { recursive: true })

  const inputText = await readFile(inputPath, 'utf8')
  const skeleton = await loadSkeleton(storeRoot, args.domain, skeletonPath)

  // 1. Slice
  const slices = sliceByClauses(inputText)
  console.log(`Sliced input into ${slices.length} clause groups`)

  // 2. Extract per slice
  const fragments: string[] = []
  const allClauses = new Set<string>()
  for (const slice of slices) {
    if (slice.text.length < 20) continue
    console.log(`  Extracting ${slice.clause} (${slice.text.length} chars)...`)
    try {
      const result = await callDeepseek(
        buildUserPrompt(skeleton, slice),
        SYSTEM_PROMPT,
        args.model,
        apiKey,
        baseUrl,
      )
      if (result.turtle && result.turtle.trim().length > 0) {
        fragments.push(result.turtle.trim())
        for (const c of result.clauses ?? []) allClauses.add(c)
      }
    } catch (err) {
      console.warn(`  ${slice.clause} failed: ${(err as Error).message}`)
      // Continue with other slices — one failure shouldn't kill the whole run
    }
  }

  if (fragments.length === 0) {
    console.error('No fragments extracted. Exiting.')
    process.exit(1)
  }

  // 3. Merge: skeleton header + fragments
  const merged = [skeleton, '', '# === Extracted candidates ===', ...fragments].join('\n')

  // 4. SHACL validate (skip if shapes.ttl missing)
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const candidateName = `${args.domain}-${timestamp}`
  const candidatePath = join(candidatesDir, `${candidateName}.ttl`)
  const reportPath = join(candidatesDir, `${candidateName}-report.txt`)

  await writeFile(candidatePath, merged, 'utf8')

  let finalTtl = merged
  let report = `# Ontology Extraction Report\n`
    + `Domain: ${args.domain}\n`
    + `Input: ${inputPath}\n`
    + `Fragments: ${fragments.length}\n`
    + `Clauses used: ${[...allClauses].join(', ')}\n\n`

  if (existsSync(shapesPath)) {
    console.log('Running SHACL validation...')
    let attempt = 0
    let result = await shaclValidate(candidatePath, shapesPath)
    report += `## SHACL Attempt 1\nConforms: ${result.conforms}\n`
    if (!result.conforms) {
      report += `Results:\n${result.resultsText}\n\n`
      // Retry up to maxRetries
      while (!result.conforms && attempt < args.maxRetries) {
        attempt += 1
        console.log(`SHACL failed — retry ${attempt}/${args.maxRetries}...`)
        const fixPrompt = `以下 Turtle 候选未能通过 SHACL 校验。

## 候选 Turtle
\`\`\`turtle
${finalTtl}
\`\`\`

## SHACL 校验报告
${result.resultsText}

请修正问题后，重新输出完整的合法 Turtle（JSON 格式：{"turtle": "...", "clauses": []}）。`
        try {
          const fixed = await callDeepseek(fixPrompt, SYSTEM_PROMPT, args.model, apiKey, baseUrl)
          if (fixed.turtle) {
            finalTtl = [skeleton, '', '# === Corrected candidates ===', fixed.turtle.trim()].join('\n')
            await writeFile(candidatePath, finalTtl, 'utf8')
          }
        } catch (err) {
          report += `Retry ${attempt} API failed: ${(err as Error).message}\n\n`
          break
        }
        result = await shaclValidate(candidatePath, shapesPath)
        report += `## SHACL Attempt ${attempt + 1}\nConforms: ${result.conforms}\n`
        if (!result.conforms) report += `Results:\n${result.resultsText}\n\n`
      }
    }
    report += `\nFinal: ${result.conforms ? 'PASSED' : 'FAILED — manual review required'}\n`
  } else {
    report += 'SHACL: SKIPPED (no shapes.ttl)\n'
  }

  await writeFile(reportPath, report, 'utf8')

  console.log('\n=== Extraction Complete ===')
  console.log(`Candidate: ${candidatePath}`)
  console.log(`Report:    ${reportPath}`)
  console.log(`Manual review required before publishing.`)
}

await main()
