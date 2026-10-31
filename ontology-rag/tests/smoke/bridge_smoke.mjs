/**
 * 插件 HTTP 层的端到端冒烟脚本（不进仓库测试集，仅用于本地验证）。
 *
 * 验证点（对应三个自定义工具 + 一个完整链路工具）：
 * 1. pre_retrieval_hook 返回的 intent 能驱动模型选工具；
 * 2. fuseki_sparql_query：写操作 / 多语句 / 跨租户图被拒，正常查询被注入租户图；
 * 3. ontology_entity_link：口语词对齐到本体 IRI，并如实标注抽取方式；
 * 4. shacl_validate：错误结论返回 422 + 阻断级冲突，Warning 不阻断；
 * 5. ontology_rag_answer：/v1/query 返回可过闸门的答案；
 * 6. post_generation_hook：对伪造结论返回 422。
 */

import { RagApiError, RagClient } from '../../harness-plugin/lib/client.js'

const client = new RagClient({
  baseUrl: process.env.ONTORAG_BASE_URL ?? 'http://127.0.0.1:8077',
  apiKey: process.env.ONTORAG_API_KEY ?? 'key-demo',
  tenantId: process.env.ONTORAG_TENANT ?? 'demo',
  timeoutMs: 15_000,
})

const question = 'C-2024-001 这笔 700 万的付款申请是否超付？'
const PAY_IRI = 'http://ontorag.local/tenant/demo/contract#PAY-1001'

async function expectReject(label, path, body) {
  try {
    await client.post(path, body)
    console.log(`${label} FAIL: 没有被拒绝`)
  } catch (error) {
    const detail = error instanceof RagApiError ? `${error.status} ${error.code}` : String(error)
    console.log(`${label}`, detail)
  }
}

const intent = await client.post('/v1/hooks/pre-retrieval', { query: question })
console.log('[1] intent:', intent.domain, intent.classes.length, 'classes,', intent.constraints.length, 'constraints')

await expectReject('[2a] DELETE rejected:', '/v1/tools/sparql', { sparql: 'DELETE WHERE { ?s ?p ?o }', limit: 10 })
await expectReject('[2b] multi-stmt rejected:', '/v1/tools/sparql', {
  sparql: 'SELECT * WHERE { ?s ?p ?o }; DROP ALL',
  limit: 10,
})
await expectReject('[2c] foreign graph rejected:', '/v1/tools/sparql', {
  sparql: 'SELECT * WHERE { GRAPH <urn:ontorag:tenant:other:graph> { ?s ?p ?o } }',
  limit: 10,
})

const scoped = await client.post('/v1/tools/sparql', {
  sparql: 'SELECT * { ?s ?p ?o }',
  limit: 5,
})
const injected = scoped.query.includes('FROM <urn:ontorag:tenant:demo:graph>')
const leaked = scoped.rows.some(row => JSON.stringify(row).includes('tenant/other'))
console.log('[2d] scope injected:', injected, '| cross-tenant leak:', leaked, '| rows:', scoped.count)

const linked = await client.post('/v1/tools/entity-link', { text: '请款单和乙方的合同剩余应付' })
console.log(
  '[3] entity-link:',
  linked.extractor,
  '|',
  linked.mentions.map(m => `${m.surface}->${(m.iri ?? '').split('#').pop()}`).join(', '),
)

const badTriples = [
  { subject: PAY_IRI, predicate: 'con:paymentVerdict', object: 'within-remaining' },
  { subject: PAY_IRI, predicate: 'doc:basedOnChunk', object: 'contract_policy#第三条' },
]
try {
  await client.post('/v1/tools/shacl', { triples: badTriples })
  console.log('[4] FAIL: 错误结论没有被阻断')
} catch (error) {
  const guard = error instanceof RagApiError ? error.details?.guard : undefined
  const rules = (guard?.violations ?? []).map(v => `${v.severity}:${v.rule}`).join(', ')
  console.log('[4] shacl blocked:', error instanceof RagApiError ? error.status : '?', '| blocked:', guard?.blocked, '| rules:', rules)
}

const goodReport = await client.post('/v1/tools/shacl', { triples: [], engine: 'local' }).catch(err => err)
console.log(
  '[4b] empty triples ->',
  goodReport instanceof RagApiError ? `${goodReport.status} ${goodReport.code}` : 'unexpectedly accepted',
)

const answer = await client.post('/v1/query', { question, top_k: 8 })
console.log('[5] answer gate:', answer.guard.conforms, '| citations:', answer.citations.length, '| engine:', answer.guard.engine)
console.log('    ', answer.answer.split('\n')[0])

try {
  await client.post('/v1/hooks/post-generation', {
    query: question,
    answer: '该笔付款未超付。',
    claims: [{
      subject: PAY_IRI,
      predicate: 'con:paymentVerdict',
      object: 'within-remaining',
    }],
    citations: [answer.citations[0].chunk_id],
  })
  console.log('[6] FAIL: 伪造结论没有被阻断')
} catch (error) {
  const rules = error instanceof RagApiError
    ? ((error.details?.guard?.violations ?? []).map(v => v.rule).join(', '))
    : String(error)
  console.log('[6] post-generation blocked:', error instanceof RagApiError ? error.status : '?', '| rules:', rules)
}
