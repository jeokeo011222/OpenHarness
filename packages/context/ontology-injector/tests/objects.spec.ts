import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { commitProposal, decideProposal, proposeAction } from '../src/objects/actions.ts'
import { parseCsv } from '../src/objects/csv.ts'
import { forgetObjectDatabase, objectDatabaseAt } from '../src/objects/db.ts'
import { aggregateObjects, getObject, searchObjects, traverseLinks } from '../src/objects/query.ts'
import { syncObjectType } from '../src/objects/sync.ts'
import { registerObjectTools } from '../src/objects/tools.ts'
import { objectIndexLine } from '../src/objects/index.ts'
import { readAudit } from '../src/store.ts'

/** Purchase orders plus the suppliers they point at. */
const ORDERS_CSV = `poNumber,supplierCode,status,amount,region,signedAt
PO-001,SUP-A,pending,6000000,east,
PO-002,SUP-B,approved,3000000,south,2026-08-15
PO-003,SUP-A,pending,12000000,east,
PO-004,SUP-C,pending,900000,west,
`

/** Supplier master, joined to orders by code. */
const SUPPLIERS_CSV = `code,name,region
SUP-A,华东钢铁,east
SUP-B,华南电子,south
SUP-C,西北重工,west
`

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    forgetObjectDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * Bind two object types, one link, and one action over a temporary store.
 * @returns the store root and the bound domain id.
 */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ontology-objects-'))
  roots.push(root)
  await writeFile(join(root, 'orders.csv'), ORDERS_CSV, 'utf8')
  await writeFile(join(root, 'suppliers.csv'), SUPPLIERS_CSV, 'utf8')

  const db = objectDatabaseAt(root)
  db.upsertObjectType({
    domain: 'procurement',
    objectType: 'PurchaseOrder',
    label: '采购订单',
    primaryKey: 'poNumber',
    labelField: 'poNumber',
    datasource: { kind: 'csv', path: 'orders.csv' },
    fields: [
      { name: 'poNumber', column: 'poNumber', type: 'string', filterable: true },
      { name: 'supplierCode', column: 'supplierCode', type: 'string', filterable: true },
      { name: 'status', column: 'status', type: 'string', filterable: true },
      { name: 'amount', column: 'amount', type: 'decimal', filterable: true },
      { name: 'region', column: 'region', type: 'string', filterable: true },
      { name: 'signedAt', column: 'signedAt', type: 'string', filterable: true },
    ],
  })
  db.upsertObjectType({
    domain: 'procurement',
    objectType: 'Supplier',
    label: '供应商',
    primaryKey: 'code',
    labelField: 'name',
    datasource: { kind: 'csv', path: 'suppliers.csv' },
    fields: [
      { name: 'code', column: 'code', type: 'string', filterable: true },
      { name: 'name', column: 'name', type: 'string', searchable: true },
      { name: 'region', column: 'region', type: 'string', filterable: true },
    ],
  })
  db.upsertLinkType({
    domain: 'procurement',
    linkId: 'poSupplier',
    label: '下单给',
    fromType: 'PurchaseOrder',
    toType: 'Supplier',
    fromProperty: 'supplierCode',
    toProperty: 'code',
  })
  db.upsertActionType({
    domain: 'procurement',
    actionId: 'approvePurchaseOrder',
    label: '审批采购订单',
    targetObjectType: 'PurchaseOrder',
    parameters: [{ name: 'comment', type: 'string' }],
    preconditions: [
      { kind: 'equals', property: 'status', value: 'pending', message: '只有待审批的订单可以审批' },
      { kind: 'lessThan', property: 'amount', value: '10000000', message: '超过一千万需要走招标流程' },
      { kind: 'linkExists', linkId: 'poSupplier', message: '订单缺少供应商' },
    ],
    effects: [{ kind: 'set-property', property: 'status', value: 'approved' }],
    approval: 'required',
  })
  await syncObjectType({ storePath: root, domain: 'procurement', objectType: 'PurchaseOrder' })
  await syncObjectType({ storePath: root, domain: 'procurement', objectType: 'Supplier' })
  return root
}

describe('csv reader', () => {
  it('handles quotes, embedded commas, and CRLF', () => {
    const table = parseCsv('a,b\r\n"x,1","he said ""hi"""\r\n')
    expect(table.header).toEqual(['a', 'b'])
    expect(table.rows).toEqual([{ a: 'x,1', b: 'he said "hi"' }])
  })
})

describe('object binding and sync', () => {
  it('records one sync run and the bound row count', async () => {
    const root = await fixture()
    const types = objectDatabaseAt(root).listObjectTypes('procurement')
    const orders = types.find(item => item.objectType === 'PurchaseOrder')
    expect(orders?.rowCount).toBe(4)
    expect(orders?.lastSyncedAt).not.toBeNull()

    const runs = objectDatabaseAt(root).listSyncRuns('procurement', 'PurchaseOrder', 5)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ mode: 'full', read: 4, inserted: 4, failedReason: null })
  })

  it('rejects a sync for an unbound object type', async () => {
    const root = await fixture()
    await expect(syncObjectType({
      storePath: root,
      domain: 'procurement',
      objectType: 'Ghost',
    })).rejects.toThrow('not bound')
  })
})

describe('object reads', () => {
  it('filters on a bound field and reports the unpaged total', async () => {
    const root = await fixture()
    const page = searchObjects(
      root,
      'procurement',
      'PurchaseOrder',
      [{ property: 'amount', op: 'gt', value: '5000000' }],
      1,
      ['amount', 'status'],
    )
    expect(page.total).toBe(2)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.fields).toEqual({ amount: '6000000', status: 'pending' })
  })

  it('refuses a filter on a field the type does not declare', async () => {
    const root = await fixture()
    expect(() => searchObjects(
      root,
      'procurement',
      'PurchaseOrder',
      [{ property: 'secrecy', op: 'eq', value: 'x' }],
      10,
    )).toThrow('Unknown object field')
  })

  it('reads one object by key and by full id', async () => {
    const root = await fixture()
    const byKey = getObject(root, 'procurement', 'PurchaseOrder', 'PO-001')
    expect(byKey?.label).toBe('PO-001')
    const byId = getObject(root, 'procurement', 'PurchaseOrder', 'procurement:PurchaseOrder:PO-001')
    expect(byId?.fields['status']).toBe('pending')
  })

  it('traverses a link downstream and upstream', async () => {
    const root = await fixture()
    const supplier = traverseLinks(
      root,
      'procurement',
      'procurement:PurchaseOrder:PO-001',
      'poSupplier',
      'out',
      10,
    )
    expect(supplier).toHaveLength(1)
    expect(supplier[0]).toMatchObject({ id: 'procurement:Supplier:SUP-A', direction: 'out', via: 'poSupplier' })

    const orders = traverseLinks(
      root,
      'procurement',
      'procurement:Supplier:SUP-A',
      'poSupplier',
      'in',
      10,
    )
    expect(orders.map(item => item.id).sort()).toEqual([
      'procurement:PurchaseOrder:PO-001',
      'procurement:PurchaseOrder:PO-003',
    ])
  })

  it('aggregates amount by region', async () => {
    const root = await fixture()
    const result = aggregateObjects(root, 'procurement', 'PurchaseOrder', 'sum', 'amount', 'region', [])
    expect(result.rows).toEqual([
      { group: 'east', value: 18_000_000 },
      { group: 'south', value: 3_000_000 },
      { group: 'west', value: 900_000 },
    ])
  })
})

describe('action proposals', () => {
  it('blocks a proposal whose target fails a precondition', async () => {
    const root = await fixture()
    const proposal = proposeAction({
      storePath: root,
      domain: 'procurement',
      actionId: 'approvePurchaseOrder',
      objectId: 'procurement:PurchaseOrder:PO-002',
      params: {},
    })
    expect(proposal.status).toBe('pending')
    expect(proposal.violations).toHaveLength(1)
    expect(proposal.violations[0]?.message).toBe('只有待审批的订单可以审批')
    expect(proposal.changes).toEqual([{ property: 'status', before: 'approved', after: 'approved' }])
  })

  it('blocks an order above the threshold and records the link impact', async () => {
    const root = await fixture()
    const proposal = proposeAction({
      storePath: root,
      domain: 'procurement',
      actionId: 'approvePurchaseOrder',
      objectId: 'procurement:PurchaseOrder:PO-003',
      params: {},
    })
    expect(proposal.violations.map(item => item.kind)).toEqual(['lessThan'])
    expect(proposal.impacts).toEqual([{ linkId: 'poSupplier', direction: 'out', count: 1 }])
  })

  it('refuses to commit a pending proposal', async () => {
    const root = await fixture()
    const proposal = proposeAction({
      storePath: root,
      domain: 'procurement',
      actionId: 'approvePurchaseOrder',
      objectId: 'procurement:PurchaseOrder:PO-001',
      params: {},
    })
    expect(() => commitProposal(root, proposal.proposalId)).toThrow('must approve')
  })

  it('commits an approved proposal and writes the field', async () => {
    const root = await fixture()
    const proposal = proposeAction({
      storePath: root,
      domain: 'procurement',
      actionId: 'approvePurchaseOrder',
      objectId: 'procurement:PurchaseOrder:PO-001',
      params: {},
    })
    expect(proposal.violations).toEqual([])
    decideProposal(root, proposal.proposalId, 'approved', 'alice')

    const outcome = commitProposal(root, proposal.proposalId)
    expect(outcome.status).toBe('committed')
    expect(outcome.changes).toEqual([{ property: 'status', before: 'pending', after: 'approved' }])
    expect(getObject(root, 'procurement', 'PurchaseOrder', 'PO-001')?.fields['status']).toBe('approved')
    expect(objectDatabaseAt(root).readProposal(proposal.proposalId)?.decidedBy).toBe('alice')
  })

  it('fails the commit when the object moved on after approval', async () => {
    const root = await fixture()
    const proposal = proposeAction({
      storePath: root,
      domain: 'procurement',
      actionId: 'approvePurchaseOrder',
      objectId: 'procurement:PurchaseOrder:PO-001',
      params: {},
    })
    decideProposal(root, proposal.proposalId, 'approved', 'alice')
    objectDatabaseAt(root).writeField('procurement', 'PurchaseOrder', 'PO-001', 'status', 'rejected')

    const outcome = commitProposal(root, proposal.proposalId)
    expect(outcome.status).toBe('failed')
    expect(outcome.changes).toEqual([])
    expect(getObject(root, 'procurement', 'PurchaseOrder', 'PO-001')?.fields['status']).toBe('rejected')
  })

  it('refuses a second decision on a decided proposal', async () => {
    const root = await fixture()
    const proposal = proposeAction({
      storePath: root,
      domain: 'procurement',
      actionId: 'approvePurchaseOrder',
      objectId: 'procurement:PurchaseOrder:PO-001',
      params: {},
    })
    decideProposal(root, proposal.proposalId, 'approved', 'alice')
    expect(() => decideProposal(root, proposal.proposalId, 'rejected', 'bob')).toThrow('only a pending proposal')
  })
})

describe('injected object index', () => {
  it('names the queryable types and the available actions', async () => {
    const root = await fixture()
    const line = objectIndexLine(root, 'procurement')
    expect(line).toContain('PurchaseOrder（4 条，主键 poNumber）')
    expect(line).toContain('approvePurchaseOrder')
  })

  it('stays out of the prompt when nothing is bound', async () => {
    const root = await fixture()
    expect(objectIndexLine(root, 'contract')).toBe('')
  })
})

describe('object tools', () => {
  /**
   * Mount the tools over a fresh fixture.
   * @returns the store root and a call helper.
   */
  async function toolFixture(): Promise<{
    root: string
    call: (name: string, args: object) => Promise<ToolExecutionResult>
  }> {
    const root = await fixture()
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    registerObjectTools(ctx, { storePath: root })
    const call = (name: string, args: object) => executeToolFixture(ctx, {
      name,
      arguments: args,
      callId: ToolCallId(name),
      signal: new AbortController().signal,
    })
    return { root, call }
  }

  it('lists bound types with their row counts', async () => {
    const { call } = await toolFixture()
    const result = await call('list_object_types', { domain: 'procurement' })
    expect(result.isError).toBe(false)
    expect(result.value as string).toContain('PurchaseOrder（采购订单）')
    expect(result.value as string).toContain('4 条对象')
  })

  it('searches with a filter and reports the total', async () => {
    const { call } = await toolFixture()
    const result = await call('search_objects', {
      domain: 'procurement',
      object_type: 'PurchaseOrder',
      filters: [{ property: 'status', op: 'eq', value: 'pending' }],
      limit: 2,
    })
    expect(result.isError).toBe(false)
    const text = result.value as string
    expect(text).toContain('共 3 条，已显示前 2 条')
  })

  it('rejects an unknown filter operator instead of guessing', async () => {
    const { call } = await toolFixture()
    const result = await call('search_objects', {
      domain: 'procurement',
      object_type: 'PurchaseOrder',
      filters: [{ property: 'status', op: 'roughly', value: 'pending' }],
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('Unknown filter operator')
  })

  it('proposes without changing the object, then commits after approval', async () => {
    const { root, call } = await toolFixture()
    const proposed = await call('propose_action', {
      domain: 'procurement',
      action_id: 'approvePurchaseOrder',
      object_id: 'procurement:PurchaseOrder:PO-001',
      params: { comment: 'ok' },
    })
    expect(proposed.isError).toBe(false)
    const text = proposed.value as string
    expect(text).toContain('status：pending → approved')
    expect(getObject(root, 'procurement', 'PurchaseOrder', 'PO-001')?.fields['status']).toBe('pending')

    const proposalId = /提案 (\S+)/.exec(text)?.[1] ?? ''
    expect(proposalId).not.toBe('')

    const blocked = await call('commit_action', { proposal_id: proposalId })
    expect(blocked.isError).toBe(true)
    decideProposal(root, proposalId, 'approved', 'alice')
    const committed = await call('commit_action', { proposal_id: proposalId })
    expect(committed.isError).toBe(false)
    expect(committed.value as string).toContain('committed')
    expect(getObject(root, 'procurement', 'PurchaseOrder', 'PO-001')?.fields['status']).toBe('approved')

    const audit = await readAudit(root)
    expect(audit.some(entry => entry.action === 'action-propose')).toBe(true)
    expect(audit.some(entry => entry.action === 'action-commit')).toBe(true)
  })
})
