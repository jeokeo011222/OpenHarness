/**
 * Dependency-direction gate for the QuadNest plugin.
 *
 * The plugin has three halves with different runtimes and different blast radii:
 * `client.js` is a browser bundle, `host/*` runs in the Host process, and
 * `index.js` is the cordis entry that mounts both. The direction is clean today —
 * client never imports host, host modules only import their own directory, tests
 * import what they test — but "clean today" is not a property, it is a habit.
 * This script turns the habit into a check.
 *
 * Two things make it a gate rather than a suggestion:
 *   1. it fails the build (exit 1) on any violation, and
 *   2. `selfTest()` proves it still catches a planted violation, so a checker
 *      that quietly stopped seeing imports cannot pass as a green build.
 *
 * Run it directly (`node quadnest/scripts/check-imports.mjs`) or import
 * `checkImports` from a test.
 *
 * @module dsh-quadnest/scripts/check-imports
 */

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Specifiers every module may use: the Node standard library, nothing else. */
const NODE_BUILTIN = /^node:/

/** Which specifiers each part of the plugin may use. */
const RULES = [
  {
    part: 'entry',
    matches: file => file === 'index.js',
    allow: [/^\.\/host\/[a-z0-9-]+\.js$/],
    note: 'the entry mounts host modules and nothing else',
  },
  {
    part: 'client',
    matches: file => file === 'client.js',
    allow: [],
    note: 'the browser bundle has no static imports; it is registered, not imported',
  },
  {
    part: 'host',
    matches: file => file.startsWith('host/'),
    allow: [/^\.\/[a-z0-9-]+\.js$/],
    note: 'host modules import their own directory only',
  },
  {
    part: 'tests',
    matches: file => file.startsWith('tests/'),
    allow: [/^\.\.\/host\/[a-z0-9-]+\.js$/, /^\.\.\/scripts\/[a-z0-9-]+\.mjs$/, /^\.\.\/client\.js$/],
    note: 'tests import the modules under test',
  },
  {
    part: 'scripts',
    matches: file => file.startsWith('scripts/'),
    allow: [/^\.\/[a-z0-9-]+\.mjs$/],
    note: 'scripts stay independent of the plugin internals',
  },
]

/** Named imports a browser bundle is allowed to ask the loader for. */
const CLIENT_REQUIRES = new Set(['react'])

/** Static import/export-from and dynamic import, with enough context to report a line. */
const SPECIFIER_PATTERNS = [
  { kind: 'import', pattern: /(?:^|[\n;])\s*import\s+(?:[^'"()]*?\sfrom\s*)?['"]([^'"]+)['"]/g },
  { kind: 'export', pattern: /(?:^|[\n;])\s*export\s+[^'"()]*?\sfrom\s*['"]([^'"]+)['"]/g },
  { kind: 'dynamic', pattern: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
  { kind: 'require', pattern: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
]

/**
 * Blank out comments while keeping every byte offset and newline in place.
 *
 * A JSDoc line like `@type {import('cordis').Context}` is a type reference, not a
 * dependency, and scanning raw text would report it forever. Blanking instead of
 * deleting keeps reported line numbers honest.
 *
 * The scanner tracks strings and regex literals because this very file contains
 * patterns like `/['"]/` — treating that quote as a string opener would desync the
 * scan and leave later comments visible.
 * @param source - file contents.
 * @returns The same text with comment bodies replaced by spaces.
 */
function stripComments(source) {
  const out = source.split('')
  let index = 0
  let quote = ''
  let lastSignificant = ''
  const regexAllowedAfter = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n', '+', '-', '*', '%', '<', '>', '~', '^'])
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (quote !== '') {
      if (char === '\\') { index += 2; continue }
      if (char === quote) quote = ''
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out[index] = ' '
        index += 1
      }
      continue
    }
    if (char === '/' && next === '*') {
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] !== '\n') out[index] = ' '
        index += 1
      }
      out[index] = ' '
      out[index + 1] = ' '
      index += 2
      continue
    }
    if (char === '/' && regexAllowedAfter.has(lastSignificant)) {
      // Skip a regex literal whole, so its character class cannot open a string.
      index += 1
      let inClass = false
      while (index < source.length) {
        const current = source[index]
        if (current === '\\') { index += 2; continue }
        if (current === '\n') break
        if (current === '[') inClass = true
        else if (current === ']') inClass = false
        else if (current === '/' && !inClass) { index += 1; break }
        index += 1
      }
      lastSignificant = '/'
      continue
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char
      lastSignificant = char
      index += 1
      continue
    }
    if (!/\s/.test(char)) lastSignificant = char
    index += 1
  }
  return out.join('')
}

/**
 * Locate the rule that governs one file.
 * @param file - path relative to the plugin root, with forward slashes.
 * @returns The matching rule, or undefined for a file the gate does not police.
 */
function ruleFor(file) {
  if (file.startsWith('tests/')) return RULES.find(rule => rule.part === 'tests')
  if (file.startsWith('scripts/')) return RULES.find(rule => rule.part === 'scripts')
  return RULES.find(rule => rule.part !== 'tests' && rule.part !== 'scripts' && rule.matches(file))
}

/**
 * Read every import specifier out of one source file.
 *
 * `require` is only meaningful in the browser bundle — elsewhere it is a word in
 * a message, and scanning for it there would report the test's own assertion text
 * as a dependency.
 * @param source - file contents, comments already blanked.
 * @param options - whether to scan `require(...)`.
 * @returns `[{ specifier, kind, line }]` in source order.
 */
function specifiersOf(source, options = {}) {
  const found = []
  const patterns = options.require === true
    ? SPECIFIER_PATTERNS
    : SPECIFIER_PATTERNS.filter(entry => entry.kind !== 'require')
  for (const { kind, pattern } of patterns) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(source)) !== null) {
      // The pattern may swallow the newline or `;` that precedes the keyword;
      // count from the keyword itself so the reported line is the real one.
      const offset = Math.max(match[0].search(/\b(import|export|require)\b/), 0)
      found.push({
        specifier: match[1],
        kind,
        line: source.slice(0, match.index + offset).split('\n').length,
      })
    }
  }
  return found.sort((left, right) => left.line - right.line)
}

/**
 * Walk one directory tree for source files.
 * @param root - directory to walk.
 * @param current - directory being read, relative to root.
 * @returns Paths relative to root, forward-slashed.
 */
async function sourceFiles(root, current = '') {
  const entries = await readdir(join(root, current), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const next = current === '' ? entry.name : `${current}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      files.push(...await sourceFiles(root, next))
      continue
    }
    if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(next)
  }
  return files.sort()
}

/**
 * Check every import in one plugin directory against the dependency rules.
 * @param root - plugin root holding `index.js`, `client.js`, `host/`, `tests/`, `scripts/`.
 * @returns Violations, the files inspected, and the host-to-host edges (for docs).
 */
export async function checkImports(root) {
  const files = await sourceFiles(root)
  const violations = []
  const edges = []
  for (const file of files) {
    const rule = ruleFor(file)
    if (rule === undefined) {
      violations.push({ file, line: 0, specifier: '', rule: 'unclassified-file', detail: `${file} is not covered by any dependency rule` })
      continue
    }
    const source = stripComments(await readFile(join(root, file), 'utf8'))
    for (const { specifier, kind, line } of specifiersOf(source, { require: rule.part === 'client' })) {
      // A `require` in the browser bundle is the module loader asking for a
      // host-provided dependency, not a Node resolution: react is the only one.
      if (rule.part === 'client') {
        if (kind !== 'require' || !CLIENT_REQUIRES.has(specifier)) {
          violations.push({ file, line, specifier, rule: 'client-no-imports', detail: `client.js may only require(${[...CLIENT_REQUIRES].join(', ')}) inside its factory, found ${kind} '${specifier}'` })
        }
        continue
      }
      if (NODE_BUILTIN.test(specifier)) continue
      if (!specifier.startsWith('.')) {
        violations.push({ file, line, specifier, rule: 'bare-specifier', detail: `${rule.part} may not depend on the package '${specifier}'` })
        continue
      }
      const target = relative(root, resolve(root, dirname(file), specifier)).split(sep).join('/')
      if (target.startsWith('..')) {
        violations.push({ file, line, specifier, rule: 'escapes-plugin', detail: `'${specifier}' resolves outside the plugin (${target})` })
        continue
      }
      if (!rule.allow.some(pattern => pattern.test(specifier))) {
        violations.push({ file, line, specifier, rule: 'wrong-direction', detail: `${file} may not import '${specifier}' — ${rule.note}` })
        continue
      }
      if (rule.part === 'host') edges.push({ from: file, to: target })
    }
  }
  return { violations, files, edges }
}

/**
 * Build a throwaway plugin tree and prove the gate still catches its violations.
 *
 * A checker that silently stopped parsing would report zero violations and look
 * healthy forever; this is the assertion that it cannot.
 * @returns `{ caught, expected, ok }` — `ok` when every planted violation was caught.
 */
export async function selfTest() {
  const root = await mkdtemp(join(tmpdir(), 'quadnest-imports-'))
  const expected = [
    'host/rogue.js:2 escapes-plugin',
    'host/rogue.js:3 bare-specifier',
    'host/rogue.js:4 wrong-direction',
    'client.js:3 client-no-imports',
    'index.js:2 escapes-plugin',
    'index.js:3 wrong-direction',
  ]
  try {
    await mkdir(join(root, 'host'), { recursive: true })
    await writeFile(join(root, 'index.js'), [
      "import { readFile } from 'node:fs/promises'",
      "import '../elsewhere/index.js'",
      "import './client.js'",
    ].join('\n'), 'utf8')
    await writeFile(join(root, 'client.js'), "window.__ModuleLoader__.load({\n  factory(require) {\n    require('lodash')\n  },\n})\n", 'utf8')
    await writeFile(join(root, 'host', 'rogue.js'), [
      "import { join } from 'node:path'",
      "import { x } from '../../../outside/plugin/host/x.js'",
      "import { y } from 'some-package'",
      "import { z } from '../client.js'",
    ].join('\n'), 'utf8')
    const { violations } = await checkImports(root)
    const caught = violations.map(item => `${item.file}:${item.line} ${item.rule}`)
    const ok = expected.every(want => caught.includes(want))
    return { ok, expected, caught }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Describe violations for the console. */
function report(result) {
  if (result.violations.length === 0) {
    console.log(`quadnest imports: ${result.files.length} files, ${result.edges.length} host edges, 0 violations`)
    return
  }
  for (const violation of result.violations) {
    const where = violation.line === 0 ? violation.file : `${violation.file}:${violation.line}`
    console.log(`${where}  [${violation.rule}]  ${violation.detail}`)
  }
  console.log(`\nquadnest imports: ${result.violations.length} violation(s) in ${result.files.length} files`)
}

/** Run as a script: check the plugin this file lives in. */
async function main() {
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const self = await selfTest()
  console.log(self.ok
    ? 'quadnest imports: gate self-test passed (planted violations were caught)'
    : `quadnest imports: GATE IS BROKEN — missed ${self.expected.filter(want => !self.caught.includes(want)).join(', ')}`)
  const result = await checkImports(pluginRoot)
  report(result)
  if (!self.ok || result.violations.length > 0) process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
