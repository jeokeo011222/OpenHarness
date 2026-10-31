/**
 * Agent tools over the object layer.
 *
 * Two families, with deliberately different shapes:
 *
 * - Reads return references (id, label, a few fields) plus the unpaged total,
 *   never a row set. A model handed a table answers from the table; a model
 *   handed references keeps drilling down. The total is what tells it whether
 *   to narrow or to stop.
 * - Writes are two steps. `propose_action` shows the before/after and every
 *   blocking precondition and changes nothing; `commit_action` only runs on a
 *   proposal a human has approved. There is no tool that approves.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendAudit } from '../store.ts'
import { commitProposal, proposeAction } from './actions.ts'
import { objectDatabaseAt } from './db.ts'
import { aggregateObjects, getObject, searchObjects, traverseLinks } from './query.ts'
import type {
  ActionProposal,
  AggregateResult,
  ObjectFilter,
  ObjectFilterOp,
  ObjectPage,
  ObjectRecord,
} from './types.ts'

/** Operators accepted on the wire; anything else is rejected, never guessed. */
const FILTER_OPS: ReadonlySet<string> = new Set<ObjectFilterOp>([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'exists', 'missing',
])

/** Options for the object tools. */
export interface ObjectToolOptions {
  /** Root directory holding the object database. */
  readonly storePath: string
}

/**
 * Render one JSON value as text without falling back to `[object Object]`.
 * @param value - any value a caller may supply.
 * @returns a string, empty for null and undefined.
 */
function scalarText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString()
  }
  return JSON.stringify(value)
}

/**
 * Render one value, marking an empty one instead of printing nothing.
 * @param value - stored field value.
 * @returns the value, or a dash when it is blank.
 */
function cell(value: string | undefined): string {
  return value === undefined || value.length === 0 ? '—' : value
}

/**
 * Normalize model-supplied filters into validated clauses.
 * @param raw - filter objects as the model wrote them.
 * @returns one clause per usable entry.
 */
function normalizeFilters(raw: readonly Record<string, unknown>[] | undefined): ObjectFilter[] {
  if (raw === undefined) return []
  const filters: ObjectFilter[] = []
  for (const item of raw) {
    const property = item['property']
    const op = item['op']
    if (typeof property !== 'string' || property.length === 0) continue
    if (typeof op !== 'string' || !FILTER_OPS.has(op)) {
      throw new Error(`Unknown filter operator: ${String(op)}. Use one of ${[...FILTER_OPS].join(', ')}.`)
    }
    const value = item['value']
    const text = scalarText(value)
    filters.push({ property, op: op as ObjectFilterOp, value: text })
  }
  return filters
}

/**
 * Render one page of references.
 * @param page - the page and its total.
 * @param heading - what the page is about.
 * @returns the model-facing text.
 */
function renderPage(page: ObjectPage, heading: string): string {
  if (page.items.length === 0) {
    return `${heading}\n\n没有匹配的对象（总数 0）。可以放宽过滤条件，或先用 list_object_types 确认对象类型已绑定。`
  }
  const lines = page.items.map((item) => {
    const fields = Object.entries(item.fields)
      .map(([name, value]) => `${name}=${cell(value)}`)
      .join('，')
    return `- ${item.id}｜${item.label}｜${fields}`
  })
  const more = page.total > page.items.length ? `\n\n共 ${page.total} 条，已显示前 ${page.items.length} 条。` : ''
  return `${heading}\n\n${lines.join('\n')}${more}`
}

/**
 * Render one record with its declared fields.
 * @param record - the stored object.
 * @returns the model-facing text.
 */
function renderRecord(record: ObjectRecord): string {
  const fields = Object.entries(record.fields).map(([name, value]) => `- ${name}：${cell(value)}`)
  return [
    `## ${record.label}（${record.id}）`,
    `对象类型：${record.objectType}｜同步于 ${record.syncedAt}`,
    '',
    ...fields,
  ].join('\n')
}

/**
 * Render an aggregate answer.
 * @param result - the aggregate result.
 * @param objectType - type the answer is about.
 * @returns the model-facing text.
 */
function renderAggregate(result: AggregateResult, objectType: string): string {
  const scope = result.groupBy === null ? '全部' : `按 ${result.groupBy} 分组`
  const measure = result.property === null ? result.metric : `${result.metric}(${result.property})`
  if (result.rows.length === 0) return `${objectType} 的 ${measure}：无数据（${scope}）`
  const lines = result.rows.map(row => `- ${row.group === '' ? '（空）' : row.group}：${row.value}`)
  return `${objectType} 的 ${measure}（${scope}，${result.rows.length} 组）\n\n${lines.join('\n')}`
}

/**
 * Render one proposal for the model and the human reading the card.
 * @param proposal - the stored proposal.
 * @returns the model-facing text.
 */
function renderProposal(proposal: ActionProposal): string {
  const changeLines = proposal.changes.length === 0
    ? ['- （无字段变更）']
    : proposal.changes.map(change => `- ${change.property}：${cell(change.before)} → ${cell(change.after)}`)
  const violationLines = proposal.violations.length === 0
    ? ['- 无阻断项']
    : proposal.violations.map(item => `- ${item.message}`)
  const impactLines = proposal.impacts.length === 0
    ? ['- 无关联对象受影响']
    : proposal.impacts.map(item => `- ${item.linkId}（${item.direction === 'out' ? '下游' : '上游'}）：${item.count} 个对象`)
  const deferredLines = proposal.deferred.length === 0 ? [] : ['', '待接线副作用：', ...proposal.deferred.map(item => `- ${item}`)]
  return [
    `## 动作提案 ${proposal.proposalId}`,
    `动作：${proposal.actionLabel}（${proposal.actionId}）→ ${proposal.objectLabel}（${proposal.objectId}）`,
    `状态：${proposal.status}`,
    '',
    '将变更：',
    ...changeLines,
    '',
    '前置检查：',
    ...violationLines,
    '',
    '受影响关联：',
    ...impactLines,
    ...deferredLines,
    '',
    proposal.status === 'pending'
      ? '提案已保存，尚未执行。需要一名有权限的人在工作台批准后，才能调用 commit_action。'
      : `提案当前状态为 ${proposal.status}。`,
  ].join('\n')
}

/**
 * Register the object-layer tools on a context that has `tools`.
 *
 * Reads are safe to retry; the two writes are separate on purpose, and the
 * commit refuses anything a human has not approved.
 * @param ctx - context owning the registrations; tools are disposed with it.
 * @param options - store root the tools read and write.
 */
export function registerObjectTools(ctx: Context, options: ObjectToolOptions): void {
  const { storePath } = options

  ctx.tools.register(defineTool({
    name: 'list_object_types',
    description: 'List the object types bound to real data in one business domain, with each type\'s primary key, field count, row count, and last sync time. Call this before search_objects: it is the only way to learn which object types actually have data behind them.',
    parameters: {
      domain: { type: 'string', required: true, description: 'Business domain id from the injected index.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // oxlint-disable-next-line typescript/require-await -- defineTool's execute contract is async; these reads are synchronous.
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const types = objectDatabaseAt(storePath).listObjectTypes(args.domain)
      if (types.length === 0) {
        return `${args.domain} 还没有绑定对象类型。本体只描述了词汇，没有接数据；需要先绑定对象类型并同步。`
      }
      const lines = types.map(item =>
        `- ${item.objectType}（${item.label}）：主键 ${item.primaryKey}，${item.fieldCount} 个字段，${item.rowCount} 条对象，最后同步 ${item.lastSyncedAt ?? '从未'}，来源 ${item.datasourceKind}`)
      return `${args.domain} 的已绑定对象类型（${types.length} 个）：\n\n${lines.join('\n')}`
    },
    presentCall: args => ({ card: 'generic', title: 'List bound object types', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'search_objects',
    description: 'Search one bound object type and return references (id, label, a few fields) plus the unpaged total. Never returns full rows and never returns more than 50 items, so narrow the filters instead of raising the limit. Use the returned id with get_object or traverse_links.',
    parameters: {
      domain: { type: 'string', required: true, description: 'Business domain id.' },
      object_type: { type: 'string', required: true, description: 'Object type id from list_object_types.' },
      filters: {
        type: 'array',
        description: 'Clauses: [{property, op, value}]. op is one of eq, neq, gt, gte, lt, lte, contains, in, exists, missing. `in` takes a comma-separated value list.',
        items: { type: 'object', additionalProperties: true },
      },
      fields: {
        type: 'array',
        description: 'Fields to project onto each reference; omit for the type\'s default projection.',
        items: { type: 'string' },
      },
      limit: { type: 'integer', description: 'Page size, 1-50; defaults to 20.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // oxlint-disable-next-line typescript/require-await -- defineTool's execute contract is async; these reads are synchronous.
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const page = searchObjects(
        storePath,
        args.domain,
        args.object_type,
        normalizeFilters(args.filters),
        args.limit,
        args.fields,
      )
      return renderPage(page, `## ${args.object_type} 查询结果`)
    },
    presentCall: args => ({ card: 'generic', title: 'Search objects', kind: 'search', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'get_object',
    description: 'Read one object by id or business key: every bound field, the sync timestamp, and which object type it belongs to. Use it after search_objects when a reference needs its full record.',
    parameters: {
      domain: { type: 'string', required: true, description: 'Business domain id.' },
      object_type: { type: 'string', required: true, description: 'Object type id.' },
      object_id: { type: 'string', required: true, description: 'Object id (`domain:type:key`) or the bare business key.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // oxlint-disable-next-line typescript/require-await -- defineTool's execute contract is async; these reads are synchronous.
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const record = getObject(storePath, args.domain, args.object_type, args.object_id)
      if (record === undefined) {
        return `没有找到对象 ${args.object_id}（类型 ${args.object_type}）。它可能尚未同步，或主键写错了。`
      }
      return renderRecord(record)
    },
    presentCall: args => ({ card: 'generic', title: 'Read one object', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'traverse_links',
    description: 'Follow the declared link types attached to one object and return the objects on the other side, tagged with the link type and direction. This is how a model walks contract → supplier → purchase orders without writing a join.',
    parameters: {
      domain: { type: 'string', required: true, description: 'Business domain id.' },
      object_id: { type: 'string', required: true, description: 'Object id to start from.' },
      link_id: { type: 'string', description: 'Restrict to one link type; omit to follow every declared link touching this type.' },
      direction: { type: 'string', enum: ['out', 'in', 'both'], description: 'Follow downstream, upstream, or both; defaults to both.' },
      limit: { type: 'integer', description: 'Page size per link type, 1-50.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // oxlint-disable-next-line typescript/require-await -- defineTool's execute contract is async; these reads are synchronous.
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const direction = args.direction === 'out' || args.direction === 'in' ? args.direction : 'both'
      const refs = traverseLinks(storePath, args.domain, args.object_id, args.link_id, direction, args.limit)
      if (refs.length === 0) return `${args.object_id} 没有可遍历的关联对象。`
      const lines = refs.map((ref) => {
        const fields = Object.entries(ref.fields).map(([name, value]) => `${name}=${cell(value)}`).join('，')
        return `- ${ref.id}｜${ref.label}｜${ref.via}（${ref.direction === 'out' ? '下游' : '上游'}）｜${fields}`
      })
      return `## ${args.object_id} 的关联对象（${refs.length} 个）\n\n${lines.join('\n')}`
    },
    presentCall: args => ({ card: 'generic', title: 'Traverse links', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'aggregate_objects',
    description: 'Compute a number over bound objects: count, sum, avg, min, or max, optionally grouped by a field. Returns aggregate rows only, never individual objects — use it whenever the question is "how many" or "how much", and search_objects when the question is "which ones".',
    parameters: {
      domain: { type: 'string', required: true, description: 'Business domain id.' },
      object_type: { type: 'string', required: true, description: 'Object type id.' },
      metric: { type: 'string', required: true, enum: ['count', 'sum', 'avg', 'min', 'max'], description: 'Aggregate function.' },
      property: { type: 'string', description: 'Numeric field the metric reads; required for every metric but count.' },
      group_by: { type: 'string', description: 'Field to group by; omit for one overall row.' },
      filters: {
        type: 'array',
        description: 'Clauses applied before aggregating, same shape as search_objects.',
        items: { type: 'object', additionalProperties: true },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // oxlint-disable-next-line typescript/require-await -- defineTool's execute contract is async; these reads are synchronous.
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (args.metric !== 'count' && (args.property === undefined || args.property.length === 0)) {
        throw new Error(`Metric ${args.metric} needs a numeric property`)
      }
      const result = aggregateObjects(
        storePath,
        args.domain,
        args.object_type,
        args.metric,
        args.property,
        args.group_by,
        normalizeFilters(args.filters),
      )
      return renderAggregate(result, args.object_type)
    },
    presentCall: args => ({ card: 'generic', title: 'Aggregate objects', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'propose_action',
    description: 'Propose a declared action on one object. Nothing is changed: this stores a proposal, shows the before/after of every field it would write, lists every precondition that currently blocks it, and counts the linked objects it touches. A human must approve the proposal before it can be committed. Never tell the user the action is done after calling this.',
    parameters: {
      domain: { type: 'string', required: true, description: 'Business domain id.' },
      action_id: { type: 'string', required: true, description: 'Action type id declared for this domain.' },
      object_id: { type: 'string', required: true, description: 'Target object id from search_objects.' },
      params: {
        type: 'object',
        additionalProperties: true,
        description: 'Action parameter values, keyed by the declared parameter names.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const params: Record<string, string> = {}
      for (const [key, value] of Object.entries(args.params ?? {})) {
        params[key] = scalarText(value)
      }
      const proposal = proposeAction({
        storePath,
        domain: args.domain,
        actionId: args.action_id,
        objectId: args.object_id,
        params,
      })
      exec.signal.throwIfAborted()
      await appendAudit(storePath, {
        action: 'action-propose',
        domain: args.domain,
        detail: `提出动作提案「${proposal.actionLabel}」→ ${proposal.objectId}（${proposal.violations.length} 项待解决）`,
      })
      return renderProposal(proposal)
    },
    presentCall: args => ({ card: 'generic', title: 'Propose an action', kind: 'edit', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'commit_action',
    description: 'Execute an action proposal that a human has already approved. This fails unless the proposal status is `approved`; there is no way for you to approve one. Use it only after the user tells you they approved the proposal.',
    parameters: {
      proposal_id: { type: 'string', required: true, description: 'Proposal id returned by propose_action.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const outcome = commitProposal(storePath, args.proposal_id)
      exec.signal.throwIfAborted()
      const proposal = objectDatabaseAt(storePath).readProposal(args.proposal_id)
      if (outcome.status === 'committed') {
        await appendAudit(storePath, {
          action: 'action-commit',
          domain: proposal?.domain ?? '',
          detail: `执行动作提案 ${outcome.proposalId}（${outcome.changes.length} 个字段变更，批准人 ${proposal?.decidedBy ?? '—'}）`,
        })
      }
      const changeLines = outcome.changes.length === 0
        ? ['- （无字段变更）']
        : outcome.changes.map(change => `- ${change.property}：${cell(change.before)} → ${cell(change.after)}`)
      const violationLines = outcome.violations.map(item => `- ${item.message}`)
      const deferredLines = outcome.deferred.length === 0 ? [] : ['', '待接线副作用：', ...outcome.deferred.map(item => `- ${item}`)]
      return [
        `## 提案 ${outcome.proposalId}：${outcome.status}`,
        '',
        '已应用的变更：',
        ...changeLines,
        ...(violationLines.length === 0 ? [] : ['', '提交时发现的新阻断项：', ...violationLines]),
        ...deferredLines,
      ].join('\n')
    },
    presentCall: args => ({ card: 'generic', title: 'Commit an approved action', kind: 'edit', rawInput: args }),
  }))
}
