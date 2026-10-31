/**
 * Operator CLI for the object layer.
 *
 * Bindings are deployment configuration, so they are applied from a JSON file
 * rather than hand-edited in a database. The same CLI owns the human half of
 * the action loop: a proposal only becomes committable after `approve` names
 * the account that decided it. No agent tool can call this.
 *
 * Usage:
 *   npx tsx scripts/objects-cli.ts --store <root> types <domain>
 *   npx tsx scripts/objects-cli.ts --store <root> apply <domain> <bindings.json>
 *   npx tsx scripts/objects-cli.ts --store <root> sync <domain> [objectType]
 *   npx tsx scripts/objects-cli.ts --store <root> runs <domain> [objectType]
 *   npx tsx scripts/objects-cli.ts --store <root> proposals <domain> [status]
 *   npx tsx scripts/objects-cli.ts --store <root> approve <proposalId> <account>
 *   npx tsx scripts/objects-cli.ts --store <root> reject <proposalId> <account>
 *   npx tsx scripts/objects-cli.ts --store <root> commit <proposalId>
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { commitProposal, decideProposal, proposeAction } from '../src/objects/actions.ts'
import { objectDatabaseAt } from '../src/objects/db.ts'
import { syncObjectType } from '../src/objects/sync.ts'
import type { ActionTypeBinding, LinkTypeBinding, ObjectTypeBinding, ProposalStatus } from '../src/objects/types.ts'

/** One declarative binding file: everything a deployment declares at once. */
interface BindingsFile {
  readonly objectTypes?: readonly ObjectTypeBinding[]
  readonly links?: readonly LinkTypeBinding[]
  readonly actions?: readonly ActionTypeBinding[]
}

/**
 * Print the usage banner and exit.
 * @param code - process exit code.
 */
function usage(code: number): never {
  process.stderr.write([
    'usage: objects-cli --store <root> <command> [args]',
    '',
    '  types <domain>                     list bound object types',
    '  apply <domain> <bindings.json>     upsert object types, links, and actions',
    '  sync <domain> [objectType]         refresh bound rows from their sources',
    '  runs <domain> [objectType]         list recent sync runs',
    '  propose <domain> <actionId> <objectId> [json]   record a proposal (agents do this via tools)',
    '  proposals <domain> [status]        list action proposals',
    '  approve <proposalId> <account>     approve a pending proposal (human only)',
    '  reject <proposalId> <account>      reject a pending proposal',
    '  commit <proposalId>                execute an approved proposal',
    '',
  ].join('\n'))
  process.exit(code)
}

/** Parsed command line. */
interface Invocation {
  readonly store: string
  readonly command: string
  readonly rest: readonly string[]
}

/**
 * Split argv into a store root, a command, and its arguments.
 * @param argv - `process.argv.slice(2)`.
 * @returns the parsed invocation.
 */
function parseArgs(argv: readonly string[]): Invocation {
  let store = ''
  const rest: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--store') {
      store = argv[index + 1] ?? ''
      index += 1
      continue
    }
    if (token !== undefined) rest.push(token)
  }
  const command = rest.shift() ?? ''
  if (store.length === 0) store = resolve(import.meta.dirname, '../../../..', 'ontology-store')
  return { store: resolve(store), command, rest }
}

/**
 * Run one command.
 * @param invocation - parsed argv.
 * @returns the text to print on stdout.
 */
async function run(invocation: Invocation): Promise<string> {
  const { store, command, rest } = invocation
  const domain = rest[0] ?? ''

  switch (command) {
    case 'types': {
      if (domain.length === 0) usage(2)
      const types = objectDatabaseAt(store).listObjectTypes(domain)
      if (types.length === 0) return `${domain} has no bound object types`
      return types
        .map(item => `${item.objectType.padEnd(22)} ${String(item.rowCount).padStart(7)} rows  pk=${item.primaryKey}  ${item.lastSyncedAt ?? 'never synced'}`)
        .join('\n')
    }
    case 'apply': {
      const file = rest[1]
      if (domain.length === 0 || file === undefined) usage(2)
      const bindings = JSON.parse(await readFile(file, 'utf8')) as BindingsFile
      const db = objectDatabaseAt(store)
      for (const objectType of bindings.objectTypes ?? []) {
        db.upsertObjectType({ ...objectType, domain })
      }
      for (const link of bindings.links ?? []) {
        db.upsertLinkType({ ...link, domain })
      }
      for (const action of bindings.actions ?? []) {
        db.upsertActionType({ ...action, domain })
      }
      return `applied ${bindings.objectTypes?.length ?? 0} object types, ${bindings.links?.length ?? 0} links, ${bindings.actions?.length ?? 0} actions to ${domain}`
    }
    case 'sync': {
      if (domain.length === 0) usage(2)
      const db = objectDatabaseAt(store)
      const targets = rest[1] === undefined
        ? db.listObjectTypes(domain).map(item => item.objectType)
        : [rest[1]]
      if (targets.length === 0) return `${domain} has no bound object types to sync`
      const lines: string[] = []
      for (const objectType of targets) {
        const outcome = await syncObjectType({ storePath: store, domain, objectType })
        lines.push(`${objectType}: read ${outcome.read}, inserted ${outcome.inserted}, updated ${outcome.updated}, skipped ${outcome.skipped} (${outcome.mode})`)
      }
      return lines.join('\n')
    }
    case 'runs': {
      if (domain.length === 0) usage(2)
      const runs = objectDatabaseAt(store).listSyncRuns(domain, rest[1] ?? null, 20)
      if (runs.length === 0) return `${domain} has no sync runs`
      return runs
        .map(item => `${item.startedAt}  ${item.objectType.padEnd(20)} ${item.mode.padEnd(11)} +${item.inserted}/~${item.updated}${item.failedReason === null ? '' : `  FAILED: ${item.failedReason}`}`)
        .join('\n')
    }
    case 'proposals': {
      if (domain.length === 0) usage(2)
      const status = (rest[1] ?? null) as ProposalStatus | null
      const proposals = objectDatabaseAt(store).listProposals(domain, status, 30)
      if (proposals.length === 0) return `${domain} has no proposals`
      return proposals
        .map(item => `${item.proposalId}  ${item.status.padEnd(10)} ${item.actionId} → ${item.objectId}  ${item.violations.length} blocking`)
        .join('\n')
    }
    case 'propose': {
      const actionId = rest[1]
      const objectId = rest[2]
      if (domain.length === 0 || actionId === undefined || objectId === undefined) usage(2)
      const params = rest[3] === undefined ? {} : JSON.parse(rest[3]) as Record<string, string>
      const proposal = proposeAction({ storePath: store, domain, actionId, objectId, params })
      const blockings = proposal.violations.map(item => `  blocked: ${item.message}`)
      const changes = proposal.changes.map(change => `  ${change.property}: ${change.before || '—'} → ${change.after || '—'}`)
      return [
        `proposal ${proposal.proposalId} (${proposal.status})`,
        ...changes,
        ...blockings,
        'a human must approve it: objects-cli approve <proposalId> <account>',
      ].join('\n')
    }
    case 'approve':
    case 'reject': {
      const proposalId = rest[0]
      const account = rest[1]
      if (proposalId === undefined || account === undefined) usage(2)
      const proposal = decideProposal(store, proposalId, command === 'approve' ? 'approved' : 'rejected', account)
      return `proposal ${proposal.proposalId} is now ${proposal.status} (decided by ${proposal.decidedBy})`
    }
    case 'commit': {
      const proposalId = rest[0]
      if (proposalId === undefined) usage(2)
      const outcome = commitProposal(store, proposalId)
      const changes = outcome.changes.map(change => `  ${change.property}: ${change.before || '—'} → ${change.after || '—'}`)
      const violations = outcome.violations.map(item => `  blocked: ${item.message}`)
      const deferred = outcome.deferred.map(item => `  deferred: ${item}`)
      return [`proposal ${outcome.proposalId}: ${outcome.status}`, ...changes, ...violations, ...deferred].join('\n')
    }
    default:
      usage(2)
  }
}

const invocation = parseArgs(process.argv.slice(2))
if (invocation.command.length === 0) usage(2)
try {
  process.stdout.write(`${await run(invocation)}\n`)
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
