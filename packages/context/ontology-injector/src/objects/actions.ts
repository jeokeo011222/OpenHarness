/**
 * The kinetic layer: proposals, human approval, and commit.
 *
 * An agent may propose. It may not decide. A proposal is stored with the record
 * before and after the change and with every precondition that currently blocks
 * it; only a human decision moves it to `approved`, and only an approved
 * proposal may be committed. The commit re-evaluates the preconditions instead
 * of trusting the proposal, because the world may have moved between the two.
 */

import { randomUUID } from 'node:crypto'
import { objectDatabaseAt } from './db.ts'
import type {
  ActionPrecondition,
  ActionProposal,
  ActionTypeBinding,
  CommitOutcome,
  LinkImpact,
  ObjectRecord,
  ObjectTypeBinding,
  PlannedChange,
  PreconditionViolation,
  ProposalStatus,
} from './types.ts'

/** Effect kinds this build can execute; the rest are reported as deferred. */
const EXECUTABLE_EFFECTS = new Set(['set-property'])

/** Caller-supplied inputs of one proposal. */
export interface ProposeInput {
  /** Ontology store root holding `objects.db`. */
  readonly storePath: string
  readonly domain: string
  readonly actionId: string
  /** Object id or bare primary key of the target. */
  readonly objectId: string
  readonly params: Readonly<Record<string, string>>
}

/**
 * Compare two values numerically.
 * @param left - stored value.
 * @param right - declared threshold.
 * @returns the comparison, or `undefined` when either side is not a number.
 */
function numericCompare(left: string, right: string): number | undefined {
  const a = Number(left)
  const b = Number(right)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined
  return a === b ? 0 : (a < b ? -1 : 1)
}

/**
 * Count the objects one link attaches to a target.
 * @param storePath - ontology root.
 * @param domain - business domain id.
 * @param objectType - the target's object type.
 * @param record - the target record supplying the join key.
 * @param linkId - link type to count.
 * @returns the impact row, or `undefined` when the link does not touch the type.
 */
function linkImpact(
  storePath: string,
  domain: string,
  objectType: string,
  record: ObjectRecord,
  linkId: string,
): LinkImpact | undefined {
  const db = objectDatabaseAt(storePath)
  const link = db.readLinkType(domain, linkId)
  if (link === undefined) return undefined
  if (link.fromType === objectType) {
    const key = record.fields[link.fromProperty] ?? ''
    if (key.length === 0) return { linkId, direction: 'out', count: 0 }
    return { linkId, direction: 'out', count: db.countByField(domain, link.toType, link.toProperty, key) }
  }
  if (link.toType === objectType) {
    const key = record.fields[link.toProperty] ?? ''
    if (key.length === 0) return { linkId, direction: 'in', count: 0 }
    return { linkId, direction: 'in', count: db.countByField(domain, link.fromType, link.fromProperty, key) }
  }
  return undefined
}

/**
 * Test one precondition against the current record.
 * @param storePath - ontology root.
 * @param domain - business domain id.
 * @param objectType - the target's object type.
 * @param record - the target as it stands now.
 * @param rule - the declared precondition.
 * @returns the violation, or `undefined` when the rule holds.
 */
function checkPrecondition(
  storePath: string,
  domain: string,
  objectType: string,
  record: ObjectRecord,
  rule: ActionPrecondition,
): PreconditionViolation | undefined {
  const field = rule.property ?? ''
  const current = record.fields[field] ?? ''
  const fail = (fallback: string): PreconditionViolation => ({
    kind: rule.kind,
    message: rule.message ?? fallback,
  })

  switch (rule.kind) {
    case 'equals':
      return current === (rule.value ?? '')
        ? undefined
        : fail(`${field} 应为 ${rule.value ?? ''}，当前为 ${current || '空'}`)
    case 'notEquals':
      return current !== (rule.value ?? '')
        ? undefined
        : fail(`${field} 不能为 ${rule.value ?? ''}`)
    case 'lessThan': {
      const compared = numericCompare(current, rule.value ?? '0')
      if (compared === undefined) return fail(`${field} 不是数值，无法比较上限`)
      return compared < 0 ? undefined : fail(`${field} 应小于 ${rule.value ?? '0'}，当前为 ${current}`)
    }
    case 'greaterThan': {
      const compared = numericCompare(current, rule.value ?? '0')
      if (compared === undefined) return fail(`${field} 不是数值，无法比较下限`)
      return compared > 0 ? undefined : fail(`${field} 应大于 ${rule.value ?? '0'}，当前为 ${current}`)
    }
    case 'in': {
      const allowed = rule.values ?? []
      return allowed.includes(current) ? undefined : fail(`${field} 不在允许值内（当前 ${current || '空'}）`)
    }
    case 'linkExists':
    case 'linkMissing': {
      const linkId = rule.linkId ?? ''
      const impact = linkImpact(storePath, domain, objectType, record, linkId)
      if (impact === undefined) return fail(`关联类型 ${linkId} 未声明`)
      if (rule.kind === 'linkExists') {
        return impact.count > 0 ? undefined : fail(`缺少必需的关联（${linkId}）`)
      }
      return impact.count === 0 ? undefined : fail(`存在不应出现的关联（${linkId}，${impact.count} 条）`)
    }
    default: {
      const unreachable: never = rule.kind
      throw new Error(`Unsupported precondition: ${String(unreachable)}`)
    }
  }
}

/**
 * Validate caller parameters against the action's declaration.
 * @param action - the action type.
 * @param params - caller-supplied values.
 * @returns the blocking messages; empty when the parameters are usable.
 */
function parameterViolations(
  action: ActionTypeBinding,
  params: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = []
  for (const parameter of action.parameters) {
    const value = params[parameter.name]
    if (parameter.required === true && (value === undefined || value.length === 0)) {
      problems.push(`缺少必填参数 ${parameter.name}`)
      continue
    }
    if (value !== undefined && value.length > 0 && parameter.values !== undefined
      && !parameter.values.includes(value)) {
      problems.push(`参数 ${parameter.name} 只接受 ${parameter.values.join(' / ')}`)
    }
  }
  return problems
}

/**
 * Compute the planned changes without applying them.
 * @param action - the action type.
 * @param before - the target as it stands now.
 * @param params - caller-supplied parameter values.
 * @returns the changes and the effects this build cannot execute yet.
 */
function planChanges(
  action: ActionTypeBinding,
  before: Readonly<Record<string, string>>,
  params: Readonly<Record<string, string>>,
): { changes: PlannedChange[]; after: Record<string, string>; deferred: string[] } {
  const after: Record<string, string> = { ...before }
  const changes: PlannedChange[] = []
  const deferred: string[] = []
  for (const effect of action.effects) {
    if (!EXECUTABLE_EFFECTS.has(effect.kind)) {
      const mapping = effect.mapping ?? '<未配置>'
      deferred.push(`连接器副作用 ${mapping} 已记录，待连接器接线后执行`)
      continue
    }
    const property = effect.property ?? ''
    if (property.length === 0) continue
    const fromParameter = effect.fromParameter
    const next = effect.value ?? (fromParameter === undefined ? '' : params[fromParameter] ?? '')
    const previous = before[property] ?? ''
    after[property] = next
    changes.push({ property, before: previous, after: next })
  }
  return { changes, after, deferred }
}

/**
 * Build and store one action proposal.
 * @param input - target action, target object, and parameter values.
 * @returns the stored proposal, including every blocking precondition.
 */
export function proposeAction(input: ProposeInput): ActionProposal {
  const db = objectDatabaseAt(input.storePath)
  const action = db.readActionType(input.domain, input.actionId)
  if (action === undefined) {
    throw new Error(`Action type is not declared: ${input.domain}/${input.actionId}`)
  }
  const binding: ObjectTypeBinding | undefined = db.readObjectType(input.domain, action.targetObjectType)
  if (binding === undefined) {
    throw new Error(`Target object type is not bound: ${action.targetObjectType}`)
  }
  const primaryKey = input.objectId.includes(':')
    ? input.objectId.slice(input.objectId.lastIndexOf(':') + 1)
    : input.objectId
  const record = db.readObject(input.domain, action.targetObjectType, primaryKey)
  if (record === undefined) throw new Error(`Target object not found: ${input.objectId}`)

  const violations: PreconditionViolation[] = []
  for (const message of parameterViolations(action, input.params)) {
    violations.push({ kind: 'equals', message })
  }
  for (const rule of action.preconditions) {
    const violation = checkPrecondition(input.storePath, input.domain, action.targetObjectType, record, rule)
    if (violation !== undefined) violations.push(violation)
  }

  const plan = planChanges(action, record.fields, input.params)
  const impacts: LinkImpact[] = []
  for (const link of db.listLinkTypes(input.domain)) {
    const impact = linkImpact(input.storePath, input.domain, action.targetObjectType, record, link.linkId)
    if (impact !== undefined && impact.count > 0) impacts.push(impact)
  }

  const proposal: ActionProposal = {
    proposalId: randomUUID(),
    domain: input.domain,
    actionId: action.actionId,
    actionLabel: action.label,
    objectType: action.targetObjectType,
    objectId: record.id,
    objectLabel: record.label,
    params: input.params,
    status: 'pending',
    before: record.fields,
    after: plan.after,
    changes: plan.changes,
    violations,
    impacts,
    deferred: plan.deferred,
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
    committedAt: null,
  }
  db.insertProposal(proposal)
  return proposal
}

/**
 * Move one proposal to a decided state.
 * @param storePath - ontology root.
 * @param proposalId - proposal to decide.
 * @param status - `approved` or `rejected`.
 * @param decidedBy - account that made the decision.
 * @returns the updated proposal.
 */
export function decideProposal(
  storePath: string,
  proposalId: string,
  status: Extract<ProposalStatus, 'approved' | 'rejected'>,
  decidedBy: string,
): ActionProposal {
  const db = objectDatabaseAt(storePath)
  const proposal = db.readProposal(proposalId)
  if (proposal === undefined) throw new Error(`Proposal not found: ${proposalId}`)
  if (proposal.status !== 'pending') {
    throw new Error(`Proposal ${proposalId} is ${proposal.status}; only a pending proposal can be decided`)
  }
  if (decidedBy.trim().length === 0) throw new Error('A decision must name the account that made it')
  db.updateProposalStatus(proposalId, status, decidedBy.trim(), null)
  const updated = db.readProposal(proposalId)
  if (updated === undefined) throw new Error(`Proposal vanished during the decision: ${proposalId}`)
  return updated
}

/**
 * Commit an approved proposal.
 *
 * The preconditions are re-evaluated here rather than trusted from the
 * proposal: an object may have moved on since the human approved it, and a
 * commit that would now violate a rule must not run.
 * @param storePath - ontology root.
 * @param proposalId - the approved proposal to execute.
 * @returns the outcome, including the changes actually applied.
 */
export function commitProposal(storePath: string, proposalId: string): CommitOutcome {
  const db = objectDatabaseAt(storePath)
  const proposal = db.readProposal(proposalId)
  if (proposal === undefined) throw new Error(`Proposal not found: ${proposalId}`)
  if (proposal.status !== 'approved') {
    throw new Error(`Proposal ${proposalId} is ${proposal.status}; a human must approve it before it can be committed`)
  }
  const action = db.readActionType(proposal.domain, proposal.actionId)
  if (action === undefined) throw new Error(`Action type was removed: ${proposal.actionId}`)
  const record = db.readObject(proposal.domain, proposal.objectType, parseKey(proposal.objectId))
  if (record === undefined) throw new Error(`Target object was removed: ${proposal.objectId}`)

  const violations: PreconditionViolation[] = []
  for (const rule of action.preconditions) {
    const violation = checkPrecondition(storePath, proposal.domain, proposal.objectType, record, rule)
    if (violation !== undefined) violations.push(violation)
  }
  if (violations.length > 0) {
    db.updateProposalStatus(proposalId, 'failed', proposal.decidedBy, null)
    return { proposalId, status: 'failed', changes: [], deferred: proposal.deferred, violations }
  }

  const applied: PlannedChange[] = []
  db.transaction(() => {
    for (const change of proposal.changes) {
      db.writeField(proposal.domain, proposal.objectType, parseKey(proposal.objectId), change.property, change.after)
      applied.push(change)
    }
    db.updateProposalStatus(proposalId, 'committed', proposal.decidedBy, new Date().toISOString())
  })
  return { proposalId, status: 'committed', changes: applied, deferred: proposal.deferred, violations }
}

/**
 * Read the primary key out of a stored object id.
 * @param objectId - `{domain}:{objectType}:{primaryKey}`.
 * @returns the trailing primary key segment.
 */
function parseKey(objectId: string): string {
  return objectId.slice(objectId.lastIndexOf(':') + 1)
}
