/**
 * Local verification for the data analysis host half.
 * Runs the real tool definitions against a temporary workspace; no DSH runtime required.
 * Execute with `node tests/run.mjs`.
 */
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { applyHost } from '../host/plugin.js'
import { importWorkbookSheets, listSheets } from '../host/importers.js'
import { assertReadOnlySql } from '../host/sql.js'
import { compileExpression } from '../host/expr.js'
import { suggestChart } from '../host/charts.js'

const results = []
let failures = 0

/**
 * Record one assertion.
 * @param name - What is being proven.
 * @param condition - Truthy when the assertion holds.
 * @param detail - Evidence shown on failure.
 */
function check(name, condition, detail) {
  if (condition) {
    results.push({ ok: true, name })
  } else {
    failures += 1
    results.push({ ok: false, name, detail })
  }
}

/**
 * Assert that an async call rejects with a message containing a fragment.
 * @param name - Assertion label.
 * @param call - Async function expected to throw.
 * @param fragment - Required message fragment.
 */
async function rejects(name, call, fragment) {
  try {
    await call()
    check(name, false, 'expected a rejection, got a value')
  } catch (error) {
    check(name, String(error.message).includes(fragment), `message was: ${error.message}`)
  }
}

/**
 * Assert that a tool value survives lossless JSON, mirroring the harness tool
 * registry's snapshot rule: no nested `undefined`, non-finite numbers, or
 * exotic prototypes.
 * @param value - Candidate value.
 * @param trail - Path shown on failure.
 */
function assertLossless(value, trail = '$') {
  if (value === undefined) throw new Error(`tool value contains undefined at ${trail}`)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`tool value contains non-finite number at ${trail}`)
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertLossless(entry, `${trail}[${index}]`))
    return
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) throw new Error(`tool value has exotic prototype at ${trail}`)
  for (const [key, entry] of Object.entries(value)) assertLossless(entry, `${trail}.${key}`)
}

/**
 * Build a fake host context that collects tool definitions. Every execute is
 * wrapped so each tool value produced by the suite is checked for lossless JSON.
 * @returns `{ ctx, tools }`.
 */
function createCtx() {
  const tools = new Map()
  const ctx = {
    effect(fn) {
      fn()
    },
    // Services are declared, never property-accessed, so a headless profile
    // (no web server) is just an absent seat here.
    get(name) {
      return ctx[name]
    },
    tools: {
      register(definition) {
        const execute = definition.execute
        if (typeof execute === 'function') {
          definition.execute = async (...args) => {
            const value = await execute(...args)
            assertLossless(value, definition.name)
            return value
          }
        }
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section() {
        return () => {}
      },
    },
  }
  return { ctx, tools }
}

/**
 * @param cwd - Workspace for the call.
 * @param signal - Abort signal.
 * @returns Fake tool execution context.
 */
function execFor(cwd, signal) {
  return { agent: { session: { header: { cwd } } }, signal }
}

/**
 * Run a registered tool.
 * @param tools - Tool registry.
 * @param name - Tool name.
 * @param args - Arguments.
 * @param cwd - Workspace.
 * @returns The tool value.
 */
async function callTool(tools, name, args, cwd) {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} not registered`)
  return definition.execute(args, execFor(cwd, new AbortController().signal))
}

/**
 * Minimal stored-zip writer for building .xlsx fixtures.
 * @param files - Entry name to text map.
 * @returns A zip buffer.
 */
function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const content = Buffer.from(text, 'utf8')
    const nameBuffer = Buffer.from(name, 'utf8')
    const checksum = crc32(content)
    const local = Buffer.alloc(30 + nameBuffer.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(content.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuffer.copy(local, 30)
    const central = Buffer.alloc(46 + nameBuffer.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(content.length, 20)
    central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBuffer.copy(central, 46)
    locals.push(local, content)
    centrals.push(central)
    offset += local.length + content.length
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  void deflateRawSync
  return Buffer.concat([...locals, directory, eocd])
}

/**
 * Write a UTF-8 CSV fixture.
 * @param file - Destination path.
 * @param rows - Lines, already comma separated.
 */
async function writeCsv(file, rows) {
  await writeFile(file, `${rows.join('\n')}\n`, 'utf8')
}

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-analysis-'))
const workspace = path.join(root, 'workspace')
await mkdir(workspace, { recursive: true })

const { ctx, tools } = createCtx()
applyHost(ctx, {})
const cwd = workspace

try {
  // 1. Registration surface
  check('registers the expected tools', ['analysis_ping', 'dataset_import_file', 'dataset_query', 'dataset_profile', 'chart_create']
    .every(name => tools.has(name)), [...tools.keys()].join(','))

  // 2. Standard CSV with Chinese headers
  const standard = path.join(cwd, '标准.csv')
  await writeCsv(standard, [
    '姓名,部门,入职日期,工号,月薪',
    '张三,销售,2024-01-05,00123,12000.5',
    '李四,研发,2024/02/18,00124,18000',
    '王五,销售,2024-03-01,00125,9000',
  ])
  const imported = await callTool(tools, 'dataset_import_file', { path: '标准.csv', name: '标准表' }, cwd)
  const byName = new Map(imported.columns.map(column => [column.name, column]))
  check('imports the standard CSV', imported.rowCount === 3 && imported.columnCount === 5, JSON.stringify(imported))
  check('trims and keeps Chinese headers', byName.get('姓名') !== undefined, [...byName.keys()].join(','))
  check('infers date with mixed separators', byName.get('入职日期').type === 'date', byName.get('入职日期').type)
  check('keeps leading zeros as strings', byName.get('工号').type === 'string', JSON.stringify(byName.get('工号')))
  check('infers decimals as number', byName.get('月薪').type === 'number', byName.get('月薪').type)
  check('preview carries typed values', imported.preview[0]['工号'] === '00123' && imported.preview[0]['月薪'] === 12000.5, JSON.stringify(imported.preview[0]))

  // 3. Quoted commas, newlines, escaped quotes
  const quoted = path.join(cwd, 'quoted.csv')
  await writeCsv(quoted, [
    'id,备注,金额',
    '1,"含逗号, 的备注",100',
    '2,"第一行\n第二行",200',
    '3,"带""引号""",300',
  ])
  const quotedImport = await callTool(tools, 'dataset_import_file', { path: 'quoted.csv' }, cwd)
  check('parses quoted commas and newlines', quotedImport.rowCount === 3 && quotedImport.preview[1]['备注'] === '第一行\n第二行', JSON.stringify(quotedImport.preview))

  // 4. Dirty file: blanks, duplicate headers, mixed types, null markers
  const dirty = path.join(cwd, 'dirty.csv')
  await writeCsv(dirty, [
    'id,,金额,金额,备注',
    '1,甲,10,,N/A',
    '2,,20,,N/A',
    '3,,abc,,N/A',
    '',
    '4,,,,' ,
  ])
  const dirtyImport = await callTool(tools, 'dataset_import_file', { path: 'dirty.csv' }, cwd)
  const dirtyNames = dirtyImport.columns.map(column => column.name)
  check('fills blank headers', dirtyNames[1] === 'column_1', dirtyNames.join(','))
  check('renames duplicate headers', dirtyNames[3] === '金额_2', dirtyNames.join(','))
  check('mixed column stays string', dirtyImport.columns[2].type === 'string', dirtyImport.columns[2].type)
  check('keeps N/A literal in a textual column', dirtyImport.preview[0]['备注'] === 'N/A', JSON.stringify(dirtyImport.preview[0]))
  check('skips blank rows and warns about types', dirtyImport.rowCount === 4 && dirtyImport.warnings.some(text => text.includes('mixes types')), dirtyImport.warnings.join(' | '))

  // 5. Delimiter sniffing
  const semicolons = path.join(cwd, 'semi.csv')
  await writeCsv(semicolons, ['a;b;c', '1;2;3', '4;5;6'])
  const semiImport = await callTool(tools, 'dataset_import_file', { path: 'semi.csv' }, cwd)
  check('sniffs semicolon delimiter', semiImport.columnCount === 3 && semiImport.rowCount === 2, JSON.stringify(semiImport.columns))

  // 6. Non-UTF-8 rejection with actionable text
  const gbk = path.join(cwd, 'gbk.csv')
  await writeFile(gbk, Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x2c, 0x31, 0x0a, 0x32, 0x0a]))
  await rejects('rejects non-UTF-8 loudly', () => callTool(tools, 'dataset_import_file', { path: 'gbk.csv' }, cwd), 'UTF-8')

  // 7. Path traversal
  await rejects('rejects ../ traversal', () => callTool(tools, 'dataset_import_file', { path: '../escape.csv' }, cwd), 'outside the workspace')

  // 8. Idempotent content hash
  const again = await callTool(tools, 'dataset_import_file', { path: '标准.csv' }, cwd)
  check('same content reuses the dataset id', again.datasetId === imported.datasetId && again.reused === true, `${again.datasetId} vs ${imported.datasetId}`)

  // 9. 100k rows performance and distinct groups
  const big = path.join(cwd, 'big.csv')
  const bigLines = ['id,日期,金额,类别']
  for (let index = 0; index < 100_000; index += 1) {
    const month = String((index % 12) + 1).padStart(2, '0')
    bigLines.push(`${index},2024-${month}-15,${(index % 1000) + 1},类${index % 5}`)
  }
  await writeFile(big, `${bigLines.join('\n')}\n`, 'utf8')
  const importStarted = Date.now()
  const bigImport = await callTool(tools, 'dataset_import_file', { path: 'big.csv' }, cwd)
  const importMs = Date.now() - importStarted
  check('imports 100k rows', bigImport.rowCount === 100_000, `${bigImport.rowCount} rows in ${importMs} ms`)
  console.log(`  · 100k-row import: ${importMs} ms`)

  // 10. Aggregation with a hand-checked month
  const timeDataset = imported.datasetId
  await callTool(tools, 'dataset_add_field', {
    datasetId: timeDataset,
    name: '月份',
    expression: 'DATE_TRUNC("month", [入职日期])',
  }, cwd)
  const monthly = await callTool(tools, 'dataset_query', {
    datasetId: timeDataset,
    dimensions: [{ field: '月份' }],
    measures: [{ field: '月薪', agg: 'sum' }],
    orderBy: [{ field: '月份', direction: 'asc' }],
  }, cwd)
  check('aggregates by month with hand-checkable values',
    monthly.rows.length === 3 && monthly.rows[0][1] === 12000.5 && monthly.rows[1][1] === 18000 && monthly.rows[2][1] === 9000,
    JSON.stringify(monthly.rows))

  // 11. Null-skipping average
  const nulls = path.join(cwd, 'nulls.csv')
  await writeCsv(nulls, ['k,v', 'a,10', 'b,', 'c,20'])
  const nullImport = await callTool(tools, 'dataset_import_file', { path: 'nulls.csv' }, cwd)
  const average = await callTool(tools, 'dataset_query', {
    datasetId: nullImport.datasetId,
    measures: [{ field: 'v', agg: 'avg' }, { field: 'v', agg: 'count' }, { field: 'v', agg: 'countDistinct' }],
  }, cwd)
  check('avg denominator is non-null rows', average.rows[0][0] === 15 && average.rows[0][1] === 3 && average.rows[0][2] === 2, JSON.stringify(average.rows))

  // 12. Division by zero and injection-safe expressions
  const division = path.join(cwd, 'division.csv')
  await writeCsv(division, ['数量,金额', '0,100', '2,100'])
  const divisionImport = await callTool(tools, 'dataset_import_file', { path: 'division.csv' }, cwd)
  const derived = await callTool(tools, 'dataset_add_field', {
    datasetId: divisionImport.datasetId,
    name: '单价',
    expression: '[金额] / [数量]',
  }, cwd)
  const unitPrice = await callTool(tools, 'dataset_query', {
    datasetId: divisionImport.datasetId,
    dimensions: [{ field: '数量' }],
    measures: [{ field: '单价', agg: 'min' }],
  }, cwd)
  check('division by zero yields null', unitPrice.rows.some(row => row[0] === 0 && row[1] === null) && unitPrice.rows.some(row => row[0] === 2 && row[1] === 50), JSON.stringify(unitPrice.rows))
  check('adds a computed column and bumps version', derived.version === 2 && derived.schema.some(entry => entry.name === '单价'), JSON.stringify(derived.version))
  await rejects('rejects expression injection', () => callTool(tools, 'dataset_add_field', {
    datasetId: divisionImport.datasetId, name: '坏', expression: '1; process.exit()' , }, cwd), 'Expression error')
  await rejects('rejects unknown functions', () => callTool(tools, 'dataset_add_field', {
    datasetId: divisionImport.datasetId, name: '坏2', expression: 'EVAL(1)', }, cwd), 'unknown function')
  check('expression parser reports positions', (() => {
    try {
      compileExpression('FOO(1)', ['a'])
      return false
    } catch (error) {
      return error.position === 0
    }
  })())

  // 13. Limit cap, truncation, caching
  const capped = await callTool(tools, 'dataset_query', {
    datasetId: bigImport.datasetId,
    dimensions: [{ field: 'id' }],
    measures: [{ field: '金额', agg: 'sum' }],
    limit: 999_999,
  }, cwd)
  check('caps limit at 10000 and reports truncation', capped.rows.length === 10_000 && capped.truncated === true, `${capped.rows.length} rows, truncated=${capped.truncated}`)
  const first = await callTool(tools, 'dataset_query', {
    datasetId: bigImport.datasetId,
    dimensions: [{ field: '类别' }],
    measures: [{ field: '金额', agg: 'sum' }],
  }, cwd)
  const second = await callTool(tools, 'dataset_query', {
    datasetId: bigImport.datasetId,
    dimensions: [{ field: '类别' }],
    measures: [{ field: '金额', agg: 'sum' }],
  }, cwd)
  check('caches by dataset version', second.cached === true && second.elapsedMs === 0 && second.queryHash === first.queryHash, `first=${first.elapsedMs}ms second=${second.elapsedMs}ms`)
  console.log(`  · 100k-row aggregation: ${first.elapsedMs} ms`)

  // 14. Profile budget and answerable questions
  const profile = await callTool(tools, 'dataset_profile', { datasetId: bigImport.datasetId }, cwd)
  check('profile stays under 2 KB', JSON.stringify(profile).length <= 2200, `${JSON.stringify(profile).length} bytes`)
  check('profile suggests specific questions', profile.suggestedQuestions.length === 3 && profile.suggestedQuestions[0].includes('金额'), profile.suggestedQuestions.join(' | '))
  check('non-numeric profile stats are null, not undefined', profile.columns.every(column => column.min === null || typeof column.min === 'number'), JSON.stringify(profile.columns.map(column => column.min)))
  const answerable = await callTool(tools, 'dataset_query', {
    datasetId: bigImport.datasetId,
    dimensions: [{ field: '日期', timeGrain: 'month' }],
    measures: [{ field: '金额', agg: 'sum' }],
  }, cwd)
  check('suggested question is actually answerable', answerable.rows.length === 12, `${answerable.rows.length} months`)

  // 15. Excel fixture with two sheets and a real date column
  const serial = (Date.UTC(2024, 0, 15) - Date.UTC(1899, 11, 30)) / 86_400_000
  const xlsx = path.join(cwd, 'book.xlsx')
  await writeFile(xlsx, makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="订单" sheetId="1" r:id="rId1"/><sheet name="目标" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4"><si><t>日期</t></si><si><t>金额</t></si><si><t>类型</t></si><si><t>零售</t></si></sst>',
    'xl/styles.xml': '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" s="1"><v>${serial}</v></c><c r="B2"><v>100</v></c><c r="C2" t="s"><v>3</v></c></row><row r="3"><c r="A3" s="1"><v>${serial + 1}</v></c><c r="B3"><v>200</v></c><c r="C3" t="s"><v>3</v></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>目标</t></is></c></row><row r="2"><c r="A2"><v>500</v></c></row></sheetData></worksheet>',
  }))
  const excel = await callTool(tools, 'dataset_import_file', { path: 'book.xlsx' }, cwd)
  check('reads the first non-empty worksheet', excel.rowCount === 2 && excel.columnCount === 3, JSON.stringify(excel.columns))
  check('converts styled serial dates', excel.preview[0]['日期'] === '2024-01-15', JSON.stringify(excel.preview[0]))
  const targetSheet = await callTool(tools, 'dataset_import_file', { path: 'book.xlsx', sheet: '目标', name: '目标表' }, cwd)
  check('reads a named worksheet', targetSheet.rowCount === 1 && targetSheet.columnCount === 1, JSON.stringify(targetSheet.columns))
  await rejects('reports missing worksheets', () => callTool(tools, 'dataset_import_file', { path: 'book.xlsx', sheet: '不存在' }, cwd), 'was not found')

  // 15b. Multi-sheet import: a workbook becomes one dataset per ticked tab.
  const multiBook = path.join(cwd, 'multi.xlsx')
  await writeFile(multiBook, makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="华东" sheetId="1" r:id="rId1"/><sheet name="华南" sheetId="2" r:id="rId2"/><sheet name="空白" sheetId="3" r:id="rId3"/><sheet name="华北" sheetId="4" r:id="rId4"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Target="worksheets/sheet4.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>城市</t></is></c><c r="B1" t="inlineStr"><is><t>销量</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>上海</t></is></c><c r="B2"><v>12</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>城市</t></is></c><c r="B1" t="inlineStr"><is><t>销量</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>广州</t></is></c><c r="B2"><v>8</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>深圳</t></is></c><c r="B3"><v>9</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet3.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>备注</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet4.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>城市</t></is></c><c r="B1" t="inlineStr"><is><t>销量</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>北京</t></is></c><c r="B2"><v>21</v></c></row></sheetData></worksheet>',
  }))

  const sheetFacts = await listSheets(cwd, 'multi.xlsx')
  check('lists worksheets with row and column facts',
    sheetFacts.sheets.length === 4
      && sheetFacts.sheets[0].name === '华东' && sheetFacts.sheets[0].rows === 1 && sheetFacts.sheets[0].columns === 2
      && sheetFacts.sheets[1].rows === 2
      && sheetFacts.sheets[2].empty === true
      && sheetFacts.preferred === '华东',
    JSON.stringify(sheetFacts))

  const multi = await importWorkbookSheets(cwd, { path: 'multi.xlsx', sheets: ['华东', '华南', '空白'] })
  check('imports several worksheets into one dataset each',
    multi.datasets.length === 2
      && multi.datasets[0].name === 'multi · 华东' && multi.datasets[0].rowCount === 1
      && multi.datasets[1].name === 'multi · 华南' && multi.datasets[1].rowCount === 2
      && multi.datasets[1].source.detail.sheet === '华南'
      && multi.failures.length === 0,
    JSON.stringify(multi.datasets.map(entry => [entry.name, entry.rowCount])))
  check('a header-only worksheet is skipped, not failed',
    multi.skipped.length === 1 && multi.skipped[0].sheet === '空白',
    JSON.stringify(multi.skipped))

  const oneOfMany = await importWorkbookSheets(cwd, { path: 'multi.xlsx', sheets: ['华北'], name: '华北销量' })
  check('a single ticked worksheet keeps the name the caller gave',
    oneOfMany.datasets.length === 1 && oneOfMany.datasets[0].name === '华北销量',
    JSON.stringify(oneOfMany.datasets.map(entry => entry.name)))

  const repeated = await importWorkbookSheets(cwd, { path: 'multi.xlsx', sheets: ['华南'] })
  check('re-importing the same worksheet reuses its dataset instead of duplicating',
    repeated.datasets.length === 1 && repeated.datasets[0].reused === true && repeated.datasets[0].name === 'multi · 华南',
    JSON.stringify(repeated.datasets.map(entry => [entry.name, entry.reused])))

  await rejects('rejects unknown worksheets in a multi-sheet import',
    () => importWorkbookSheets(cwd, { path: 'multi.xlsx', sheets: ['华东', '缺失'] }), 'was not found')
  await rejects('rejects multi-sheet import of a delimited file',
    () => importWorkbookSheets(cwd, { path: 'nulls.csv' }), 'only .xlsx')

  // 15c. A stacked group header is folded into the column names, and the row
  // that carries the field labels never surfaces as a record.
  const stackedBook = path.join(cwd, 'stacked.xlsx')
  const cell = (reference, text) => `<c r="${reference}" t="inlineStr"><is><t>${text}</t></is></c>`
  const number = (reference, value) => `<c r="${reference}"><v>${value}</v></c>`
  await writeFile(stackedBook, makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="分期" sheetId="1" r:id="rId1"/><sheet name="明细" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${cell('A1', '序号')}${cell('B1', '单位')}${cell('C1', '2023年一期')}${cell('D1', '')}${cell('E1', '')}${cell('F1', '2024年一期')}${cell('G1', '')}${cell('H1', '')}${cell('I1', '')}${cell('J1', '')}</row><row r="2">${number('A2', 34)}${cell('B2', '')}${cell('C2', '欠费金额')}${cell('D2', '结算金额')}${cell('E2', '回款时间')}${cell('F2', '欠费金额')}${cell('G2', '结算金额')}${cell('H2', '回款时间')}${cell('I2', '开票时间')}${cell('J2', '备注')}</row><row r="3">${number('A3', 1)}${cell('B3', '甲公司')}${number('C3', 100)}${number('D3', 200)}${cell('E3', '2024-01-05')}${number('F3', 110)}${number('G3', 220)}${cell('H3', '2024-02-05')}${cell('I3', '2024-01-06')}${cell('J3', '正常')}</row><row r="4">${number('A4', 2)}${cell('B4', '乙公司')}${number('C4', 300)}${number('D4', 400)}${cell('E4', '2024-03-05')}${number('F4', 310)}${number('G4', 420)}${cell('H4', '2024-04-05')}${cell('I4', '2024-03-06')}${cell('J4', '逾期')}</row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${cell('A1', '城市')}${cell('B1', '公司')}${cell('C1', '状态')}</row><row r="2">${cell('A2', '上海')}${cell('B2', '甲公司')}${cell('C2', '正常')}</row></sheetData></worksheet>`,
  }))

  const stacked = await callTool(tools, 'dataset_import_file', { path: 'stacked.xlsx', sheet: '分期' }, cwd)
  check('folds a group header into "group · field" names',
    JSON.stringify(stacked.columns.map(column => column.name)) === JSON.stringify([
      '序号', '单位',
      '2023年一期 · 欠费金额', '2023年一期 · 结算金额', '2023年一期 · 回款时间',
      '2024年一期 · 欠费金额', '2024年一期 · 结算金额', '2024年一期 · 回款时间',
      '2024年一期 · 开票时间', '2024年一期 · 备注',
    ]),
    JSON.stringify(stacked.columns.map(column => column.name)))
  check('drops the field-label row instead of keeping it as a record',
    stacked.rowCount === 2 && stacked.preview[0]['序号'] === 1 && stacked.preview[0]['2023年一期 · 欠费金额'] === 100,
    JSON.stringify([stacked.rowCount, stacked.preview[0]]))
  check('reports the folded header',
    stacked.warnings.some(warning => warning.includes('continues the header')),
    JSON.stringify(stacked.warnings))

  const plainText = await callTool(tools, 'dataset_import_file', { path: 'stacked.xlsx', sheet: '明细' }, cwd)
  check('keeps an all-text record under named headers as data',
    plainText.rowCount === 1 && plainText.columnCount === 3 && plainText.preview[0]['公司'] === '甲公司',
    JSON.stringify([plainText.rowCount, plainText.columns.map(column => column.name), plainText.preview[0]]))

  // 16. SQL guard
  check('accepts SELECT', assertReadOnlySql('SELECT * FROM t') === 'SELECT * FROM t')
  for (const [label, sql] of [
    ['DROP', 'DROP TABLE t'],
    ['stacked statements', 'SELECT 1; DELETE FROM t'],
    ['comment-hidden delete', 'SELECT 1 -- ok\nDELETE FROM t'],
    ['PRAGMA', 'PRAGMA writable_schema=ON'],
    ['write inside CTE', 'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x'],
  ]) {
    await rejects(`rejects ${label}`, async () => assertReadOnlySql(sql), '')
  }

  // 17. Chart recommendation and storage
  const chart = await callTool(tools, 'chart_create', { datasetId: bigImport.datasetId, type: 'auto' }, cwd)
  check('auto-picks line for a time dimension', chart.spec.type === 'line', chart.spec.type)
  check('chart summary names the peak', chart.summary.includes('peak'), chart.summary)
  const chartFile = path.join(cwd, '.analysis', 'charts', `${chart.chartId}.json`)
  const restored = JSON.parse(await readFile(chartFile, 'utf8'))
  check('chart spec round-trips through disk', restored.id === chart.chartId && restored.encoding.x.field === '日期', chartFile)
  check('chart index lists the spec', (await callTool(tools, 'chart_list', {}, cwd)).charts.length === 1)
  check('suggestChart prefers horizontal bars past 12 categories',
    suggestChart({ hasTime: false, dimensionCount: 1, categoryCount: 40, measureCount: 1 }).horizontal === true)

  // 18. SQLite source: read-only, import, and write rejection
  const { DatabaseSync } = await import('node:sqlite')
  const databaseFile = path.join(cwd, 'demo.db')
  const database = new DatabaseSync(databaseFile)
  database.exec('CREATE TABLE sales (region TEXT, amount REAL, day TEXT)')
  database.exec("INSERT INTO sales VALUES ('华东', 10, '2024-01-01'), ('华北', 20, '2024-02-01')")
  database.close()
  const runtimeTools = new Map()
  const sqliteCtx = { ...ctx }
  const harness = createCtx()
  applyHost(harness.ctx, { connections: [{ id: 'demo', kind: 'sqlite', path: 'demo.db' }], sources: [] })
  scanSqlite(harness.tools, runtimeTools)
  const sqlite = harness.tools
  const ping = await callTool(sqlite, 'db_test_connection', { connectionId: 'demo' }, cwd)
  check('sqlite connection opens read-only', ping.ok === true, JSON.stringify(ping))
  const objects = await callTool(sqlite, 'db_list_objects', { connectionId: 'demo' }, cwd)
  check('lists sqlite tables', objects.objects.some(row => row.name === 'sales'), JSON.stringify(objects.objects))
  const described = await callTool(sqlite, 'db_describe_table', { connectionId: 'demo', table: 'sales' }, cwd)
  check('describes table columns', described.columns.length === 3, JSON.stringify(described.columns))
  await rejects('rejects writes on db_query', () => callTool(sqlite, 'db_query', { connectionId: 'demo', sql: 'DELETE FROM sales' }, cwd), 'Only read-only SELECT')
  const selected = await callTool(sqlite, 'db_query', { connectionId: 'demo', sql: 'SELECT region, amount FROM sales ORDER BY region' }, cwd)
  check('runs a read-only select', selected.rows.length === 2 && ['number', 'integer'].includes(selected.columns[1].type), JSON.stringify(selected.rows))
  const dbImport = await callTool(sqlite, 'db_import_table', { connectionId: 'demo', table: 'sales' }, cwd)
  const dbQuery = await callTool(sqlite, 'dataset_query', {
    datasetId: dbImport.datasetId,
    dimensions: [{ field: 'region' }],
    measures: [{ field: 'amount', agg: 'sum' }],
  }, cwd)
  check('database rows use the same query DSL', dbQuery.rows.length === 2 && dbQuery.rows[0][1] === 20, JSON.stringify(dbQuery.rows))
  void runtimeTools
  void sqliteCtx

  // 19. REST: pagination, retry, allowlist, flattening, byte cap
  let flaky = true
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/items') {
      const page = Number(url.searchParams.get('page') ?? '1')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        data: {
          items: [
            { id: page * 10 + 1, amount: 100, region: '华东', meta: { level: 'A' } },
            { id: page * 10 + 2, amount: 200, region: '华北', meta: { level: 'B' } },
          ],
          next: page < 2 ? `${page + 1}` : null,
        },
      }))
      return
    }
    if (url.pathname === '/flaky') {
      if (flaky) {
        flaky = false
        response.statusCode = 429
        response.end('{}')
        return
      }
      response.end(JSON.stringify({ ok: true }))
      return
    }
    if (url.pathname === '/large') {
      const text = JSON.stringify({ data: 'x'.repeat(4096) })
      response.setHeader('content-length', String(text.length))
      response.end(text)
      return
    }
    response.statusCode = 404
    response.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const restCtx = createCtx()
  applyHost(restCtx.ctx, {
    connections: [],
    sources: [{ id: 'crm', name: 'CRM', baseUrl: `http://127.0.0.1:${port}`, allowedHosts: [`127.0.0.1:${port}`] }],
  })
  const rest = restCtx.tools
  const discovered = await callTool(rest, 'api_discover', { sourceId: 'crm', path: '/items?page=1' }, cwd)
  check('discovers the record path', discovered.suggestedRecordsPath === 'data.items', JSON.stringify(discovered.recordPaths))
  const pageImport = await callTool(rest, 'api_import', {
    sourceId: 'crm', path: '/items', recordsPath: 'data.items',
    pagination: { style: 'page', param: 'page', pageSize: 2, maxPages: 2 },
  }, cwd)
  check('imports paginated records and flattens nested keys', pageImport.rowCount === 4 && pageImport.columns.some(column => column.name === 'meta.level'), JSON.stringify(pageImport.columns.map(column => column.name)))
  const retried = await callTool(rest, 'api_request', { sourceId: 'crm', path: '/flaky' }, cwd)
  check('retries a 429 then succeeds', retried.status === 200 && retried.requests === 2 && retried.sampleRecords[0].ok === true, JSON.stringify(retried))
  await rejects('blocks hosts outside the allowlist', () => callTool(rest, 'api_request', {
    sourceId: 'crm', path: 'http://example.com/data', }, cwd), 'not in this source')
  await rejects('enforces maxBytes', () => callTool(rest, 'api_request', { sourceId: 'crm', path: '/large', maxBytes: 1024 }, cwd), 'above maxBytes')
  server.close()

  // 20. Dataset listing
  const listed = await callTool(tools, 'dataset_list', {}, cwd)
  check('lists every imported dataset', listed.datasets.length >= 6, `${listed.datasets.length} datasets`)
  check('analysis ping reports the data root', (await callTool(tools, 'analysis_ping', {}, cwd)).dataRoot.endsWith('.analysis'))
} catch (error) {
  failures += 1
  results.push({ ok: false, name: 'unhandled error', detail: `${error.stack ?? error.message}` })
} finally {
  await rm(root, { recursive: true, force: true })
}

/**
 * Copy registered sqlite-capable tools into the shared map used by later probes.
 * @param source - Tool registry.
 * @param target - Destination map.
 */
function scanSqlite(source, target) {
  for (const name of ['db_test_connection', 'db_list_objects', 'db_describe_table', 'db_query', 'db_import_table', 'dataset_query']) {
    const definition = source.get(name)
    if (definition !== undefined) target.set(name, definition)
  }
}

for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.ok || result.detail === undefined ? '' : `\n      ${result.detail}`}`)
}
console.log(`\n${results.filter(result => result.ok).length}/${results.length} checks passed`)
if (failures > 0) process.exitCode = 1
