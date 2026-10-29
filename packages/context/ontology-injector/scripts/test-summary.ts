#!/usr/bin/env node
/**
 * Standalone test for loader + summary modules.
 *
 * Run with: pnpm exec tsx packages/context/ontology-injector/scripts/test-summary.ts
 * (or just:  node scripts/test-summary.js after build:artifacts)
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listDomains, loadOntology } from '../src/loader.ts'
import { parseOntology, renderSummary, generateSummary } from '../src/summary.ts'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const storePath = resolve(__dirname, '..', '..', '..', '..', 'ontology-store')

let exitCode = 0

async function main(): Promise<void> {
  console.log('=== ontology-injector summary test ===\n')

  // 1. listDomains
  console.log('--- 1. listDomains ---')
  const domains = await listDomains(storePath)
  console.log(`Domains: ${domains.join(', ')}`)
  if (!domains.includes('contract')) {
    console.error('FAIL: expected "contract" domain')
    exitCode = 1
    return
  }
  console.log('OK\n')

  // 2. loadOntology("contract")
  console.log('--- 2. loadOntology("contract") ---')
  const loaded = await loadOntology(storePath, 'contract')
  console.log(`Turtle length: ${loaded.turtle.length} chars`)
  console.log(`Shapes length: ${loaded.shapes.length} chars`)
  if (loaded.turtle.length < 100) {
    console.error('FAIL: turtle content too short')
    exitCode = 1
    return
  }
  console.log('OK\n')

  // 3. parseOntology + renderSummary
  console.log('--- 3. parseOntology + renderSummary ---')
  const parsed = parseOntology(loaded.turtle)
  console.log(`Classes found: ${parsed.classes.length}`)
  for (const c of parsed.classes) console.log(`  - ${c.label} (${c.localName})`)
  console.log(`Properties found: ${parsed.properties.length}`)
  for (const p of parsed.properties) {
    const kind = p.isObjectProperty ? 'OBJ' : 'DAT'
    console.log(`  - [${kind}] ${p.label}: ${p.domain} → ${p.range}`)
  }
  const summary = renderSummary('contract', parsed)
  console.log('\n--- Rendered summary ---')
  console.log(summary)
  console.log('OK\n')

  // 4. generateSummary — writes summary.md
  console.log('--- 4. generateSummary (writes summary.md) ---')
  const generated = await generateSummary(storePath, 'contract', loaded.turtle)
  console.log(`Generated ${generated.length} chars`)
  if (!generated.includes('当前业务域：contract')) {
    console.error('FAIL: summary missing domain header')
    exitCode = 1
    return
  }
  console.log('OK\n')

  // 5. Fallback test — Turtle with missing label/comment
  console.log('--- 5. Fallback (missing rdfs:label / rdfs:comment) ---')
  const minimal = `
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix test: <http://example.org/test#> .
test:Foo a owl:Class .
test:Bar a owl:Class .
test:doesSomething a owl:ObjectProperty ;
    <http://www.w3.org/2000/01/rdf-schema#domain> test:Foo ;
    <http://www.w3.org/2000/01/rdf-schema#range> test:Bar .
`
  const minimalParsed = parseOntology(minimal)
  const minimalSummary = renderSummary('minimal', minimalParsed)
  console.log(minimalSummary)
  if (!minimalSummary.includes('Foo') || !minimalSummary.includes('Bar') || !minimalSummary.includes('doesSomething')) {
    console.error('FAIL: fallback to localName did not work')
    exitCode = 1
    return
  }
  console.log('OK — fallback to localName works\n')

  // 6. loadOntology("procurement")
  console.log('--- 6. Second domain (procurement) ---')
  const procLoaded = await loadOntology(storePath, 'procurement')
  const procParsed = parseOntology(procLoaded.turtle)
  const procSummary = renderSummary('procurement', procParsed)
  console.log(procSummary)
  console.log('OK\n')

  // 7. Error path — missing domain
  console.log('--- 7. Error: missing domain ---')
  try {
    await loadOntology(storePath, 'nonexistent')
    console.error('FAIL: should have thrown')
    exitCode = 1
  } catch (err: any) {
    console.log(`Caught LoadError: kind=${err.kind}`)
    if (err.kind !== 'file-missing') {
      console.error('FAIL: wrong error kind')
      exitCode = 1
    }
  }
  console.log('OK\n')

  // 8. Error path — missing registry
  console.log('--- 8. Error: missing registry ---')
  try {
    await listDomains(resolve(storePath, '..', 'nonexistent-store'))
    console.error('FAIL: should have thrown')
    exitCode = 1
  } catch (err: any) {
    console.log(`Caught LoadError: kind=${err.kind}`)
    if (err.kind !== 'registry-missing') {
      console.error('FAIL: wrong error kind')
      exitCode = 1
    }
  }
  console.log('OK\n')

  if (exitCode === 0) {
    console.log('🎉 ALL TESTS PASSED')
  } else {
    console.log('❌ SOME TESTS FAILED')
  }
}

await main()
process.exit(exitCode)
