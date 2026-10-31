/**
 * Wire and storage vocabulary of the ontology object layer (A-Box + kinetics).
 *
 * The T-Box lives in Turtle and describes vocabulary. Everything here is the
 * other half: object types bound to real data, the links between them, the
 * actions that may change them, and the proposals a human has to approve
 * before an action runs. Bindings are deployment configuration, so none of
 * these types ever reach the Turtle graph.
 */

/** Scalar types a bound field may declare. */
export type ObjectFieldType = 'string' | 'decimal' | 'date' | 'boolean'

/** One field of an object type and the source column it is read from. */
export interface ObjectFieldSpec {
  /** Property name the agent and the tools use. */
  readonly name: string
  /** Column or JSON key in the source. */
  readonly column: string
  readonly type: ObjectFieldType
  /** Whether `search_objects` matches this field by substring. */
  readonly searchable?: boolean
  /** Whether this field may appear in a filter or a grouping. */
  readonly filterable?: boolean
}

/** Where one object type's rows come from. */
export type ObjectDatasource =
  | { readonly kind: 'csv'; readonly path: string }
  | { readonly kind: 'rest'; readonly url: string; readonly itemsPath?: string }

/** One object type bound to a data source: the deployment half of a class. */
export interface ObjectTypeBinding {
  readonly domain: string
  /** Object type id, matching a class local name in the domain ontology. */
  readonly objectType: string
  readonly label: string
  /** Field holding the stable business key; the object id derives from it. */
  readonly primaryKey: string
  /** Field rendered as the object's display label; defaults to the key. */
  readonly labelField?: string
  /** Field used as the incremental watermark; absent means full sync only. */
  readonly updatedAtField?: string
  readonly datasource: ObjectDatasource
  readonly fields: readonly ObjectFieldSpec[]
}

/** One object type as the workbench lists it. */
export interface ObjectTypeSummary {
  readonly domain: string
  readonly objectType: string
  readonly label: string
  readonly primaryKey: string
  readonly fieldCount: number
  readonly rowCount: number
  readonly lastSyncedAt: string | null
  readonly datasourceKind: string
}

/** One object reference: what a tool returns instead of a row. */
export interface ObjectRef {
  /** Stable object id, `{domain}:{objectType}:{primaryKey}`. */
  readonly id: string
  readonly objectType: string
  readonly label: string
  /** Only the fields the caller asked for, stringified. */
  readonly fields: Readonly<Record<string, string>>
}

/** One object with its full bound record. */
export interface ObjectRecord extends ObjectRef {
  readonly domain: string
  readonly syncedAt: string
  readonly lastRunId: string
}

/** Filter operators a caller may use on a filterable field. */
export type ObjectFilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'in'
  | 'exists'
  | 'missing'

/** One filter clause; `value` is required for every operator but exists/missing. */
export interface ObjectFilter {
  readonly property: string
  readonly op: ObjectFilterOp
  readonly value?: string
}

/** Metric `aggregate_objects` computes over one group. */
export type ObjectAggregateMetric = 'count' | 'sum' | 'avg' | 'min' | 'max'

/** One row of an aggregate answer. */
export interface AggregateRow {
  readonly group: string
  readonly value: number
}

/** Result of `aggregate_objects`. */
export interface AggregateResult {
  readonly metric: ObjectAggregateMetric
  readonly property: string | null
  readonly groupBy: string | null
  readonly rows: readonly AggregateRow[]
}

/** A page of object references plus the unpaged total. */
export interface ObjectPage {
  readonly items: readonly ObjectRef[]
  readonly total: number
}

/** Outcome of one sync run. */
export interface SyncOutcome {
  /** Run id, also written to every row this run touched. */
  readonly runId: string
  readonly domain: string
  readonly objectType: string
  readonly mode: 'full' | 'incremental'
  readonly inserted: number
  readonly updated: number
  /** Source rows dropped because the primary key was blank. */
  readonly skipped: number
  /** Rows present in the source. */
  readonly read: number
  /** New watermark after this run; `null` when the type declares none. */
  readonly watermark: string | null
  readonly startedAt: string
  readonly finishedAt: string
}

/** One recorded sync run, as the workbench lists it. */
export interface SyncRunRecord extends SyncOutcome {
  readonly failedReason: string | null
}

/** One link type: how two object types join. */
export interface LinkTypeBinding {
  readonly domain: string
  readonly linkId: string
  readonly label: string
  /** Object type the link starts from. */
  readonly fromType: string
  /** Object type the link ends at. */
  readonly toType: string
  /** Field on `fromType` holding the shared key. */
  readonly fromProperty: string
  /** Field on `toType` holding the same key. */
  readonly toProperty: string
}

/** One traversed link target. */
export interface LinkRef extends ObjectRef {
  /** Link type that produced this reference. */
  readonly via: string
  /** Whether the target was found downstream (`out`) or upstream (`in`). */
  readonly direction: 'out' | 'in'
}

/** Declarative precondition kinds an action may require. */
export type PreconditionKind =
  | 'equals'
  | 'notEquals'
  | 'lessThan'
  | 'greaterThan'
  | 'in'
  | 'linkExists'
  | 'linkMissing'

/** One precondition; no code, only a field comparison or a link test. */
export interface ActionPrecondition {
  readonly kind: PreconditionKind
  /** Field on the target object; unused by the link tests. */
  readonly property?: string
  /** Compared value, for the comparison kinds. */
  readonly value?: string
  /** Allowed values, for `in`. */
  readonly values?: readonly string[]
  /** Link type id, for `linkExists` / `linkMissing`. */
  readonly linkId?: string
  /** Why the precondition exists; shown when it blocks a proposal. */
  readonly message?: string
}

/** Declarative effect kinds an action may apply. */
export type EffectKind = 'set-property' | 'call-connector'

/** One effect. `call-connector` is recorded and deferred, never faked. */
export interface ActionEffect {
  readonly kind: EffectKind
  /** Field written by `set-property`. */
  readonly property?: string
  /** Parameter name supplying the new value; a literal `value` wins if set. */
  readonly fromParameter?: string
  /** Literal value written by `set-property`. */
  readonly value?: string
  /** Connector mapping id recorded for `call-connector`. */
  readonly mapping?: string
}

/** One declared input of an action. */
export interface ActionParameter {
  readonly name: string
  readonly type: ObjectFieldType
  readonly required?: boolean
  readonly description?: string
  /** Closed value set, when the parameter is an enum. */
  readonly values?: readonly string[]
}

/** Whether an approved proposal is required before an action may run. */
export type ActionApproval = 'none' | 'required'

/** One action type: the writable half of the ontology. */
export interface ActionTypeBinding {
  readonly domain: string
  readonly actionId: string
  readonly label: string
  /** Object type the action changes. */
  readonly targetObjectType: string
  readonly parameters: readonly ActionParameter[]
  readonly preconditions: readonly ActionPrecondition[]
  readonly effects: readonly ActionEffect[]
  readonly approval: ActionApproval
}

/** Lifecycle of one proposal. Only `approved` may be committed. */
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'committed' | 'failed'

/** One blocked precondition, rendered for both the model and the human. */
export interface PreconditionViolation {
  readonly kind: PreconditionKind
  readonly message: string
}

/** One property the commit will change. */
export interface PlannedChange {
  readonly property: string
  readonly before: string
  readonly after: string
}

/** How many objects one link type attaches to the target. */
export interface LinkImpact {
  readonly linkId: string
  readonly direction: 'out' | 'in'
  readonly count: number
}

/**
 * One action proposal.
 *
 * The model may create it and read it; only a human decision moves it to
 * `approved`, and only then may the commit run.
 */
export interface ActionProposal {
  readonly proposalId: string
  readonly domain: string
  readonly actionId: string
  readonly actionLabel: string
  readonly objectType: string
  readonly objectId: string
  readonly objectLabel: string
  readonly params: Readonly<Record<string, string>>
  readonly status: ProposalStatus
  /** Target record before the change, as bound fields. */
  readonly before: Readonly<Record<string, string>>
  /** Target record after the change, as bound fields. */
  readonly after: Readonly<Record<string, string>>
  readonly changes: readonly PlannedChange[]
  /** Every precondition that currently blocks the action; empty means valid. */
  readonly violations: readonly PreconditionViolation[]
  /** Downstream objects the change touches, per link type. */
  readonly impacts: readonly LinkImpact[]
  /** Effects that the commit cannot execute yet, reported verbatim. */
  readonly deferred: readonly string[]
  readonly createdAt: string
  readonly decidedAt: string | null
  readonly decidedBy: string | null
  readonly committedAt: string | null
}

/** Outcome of one commit. */
export interface CommitOutcome {
  readonly proposalId: string
  readonly status: ProposalStatus
  readonly changes: readonly PlannedChange[]
  /** Effects recorded but not executed; empty on a complete commit. */
  readonly deferred: readonly string[]
  /** Blocking violations found again at commit time. */
  readonly violations: readonly PreconditionViolation[]
}
