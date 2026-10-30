/** Agent-facing read access to the published summary of one business domain. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { fetchDomainSummary, truncateSummary } from './injector.ts'

/** Store and budget one registered `domain_summary` tool reads through. */
export interface DomainSummaryToolOptions {
  /** Root directory holding the graph database. */
  readonly storePath: string
  /** Characters kept from one summary. */
  readonly maxChars: number
}

/**
 * Register the read-only `domain_summary` tool on a context that has `tools`.
 *
 * The per-turn injection carries only a one-line index, so the full vocabulary
 * stays out of unrelated requests. Only a published version is readable; drafts
 * and versions under review answer as missing.
 * @param ctx - context owning the registration; the tool is disposed with it.
 * @param options - store root and the summary character budget.
 */
export function registerDomainSummaryTool(ctx: Context, options: DomainSummaryToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'domain_summary',
    description: 'Read the full published ontology summary of one business domain: its classes, object relations, and data properties. Call it when a task needs more than the one-line domain index injected at the start of the turn. Drafts and versions under review are never returned.',
    parameters: {
      domain: { type: 'string', required: true, description: 'Business domain id, as listed in the injected business-domain index.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const summary = await fetchDomainSummary(options.storePath, args.domain)
      if (summary === undefined) throw new Error(`No published ontology summary for domain "${args.domain}"`)
      return truncateSummary(summary, options.maxChars)
    },
    presentCall: args => ({ card: 'generic', title: 'Read domain ontology', kind: 'read', rawInput: args }),
  }))
}
