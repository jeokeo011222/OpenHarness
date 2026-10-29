/**
 * Ontology injector plugin: injects Turtle-parsed OWL/RDF ontology summaries
 * into agent context per business domain.
 *
 * Wires three pure modules together:
 *   - loader.ts         — read .ttl files from the store directory
 *   - summary.ts        — rdflib parse → Markdown summary
 *   - injector.ts       — cache strategy + <system-reminder> envelope
 *
 * Injection happens only at step 1 of each turn, when a non-null domain is
 * available. The per-session businessDomain comes from Config.defaultDomain
 * in this initial version; a later phase will extend it to a session
 * projection that external commands can mutate.
 *
 * The pre-step listener is a waterfall — it MUST call `next()` or the
 * agent loop stalls.
 *
 * @module @deepseek-ai/dsh-ontology-injector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { resolveInjectorConfig, fetchDomainSummary, wrapInjection, type InjectorConfig } from './injector.ts'
import z from '@deepseek-ai/schemastery'

/** Register our plugin name as a valid user-message source kind. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'ontology-injector': { kind: 'ontology-injector' } & ContextFormed
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ontology-injector'

/** Services required for pre-step event wiring. */
export const inject = ['agents']

/** Plugin configuration — paths and fallback domain. */
export interface Config extends InjectorConfig {}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  storePath: z.string(),
  defaultDomain: z.string(),
})

/**
 * Register the pre-step listener.
 *
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - optional storePath / defaultDomain overrides.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveInjectorConfig(config)
  ctx.logger.info('[%s] plugin loaded (store=%s, defaultDomain=%s)',
    name, resolved.storePath, resolved.defaultDomain ?? '<none>')

  /** Track last injected turn per session so we never double-inject. */
  const injectedTurnBySession = new WeakMap<Session, number>()

  ctx.on('agent/pre-step', async (
    { agent, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    // MUST call next() — waterfall semantics; omitting it stalls the loop.
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    // Only inject at step 1 of each turn — tool-continuation steps should
    // not re-anchor the domain context that was already injected when the
    // turn opened.
    if (step !== 1) return decision

    // Skip if this session has already been served for this turn — guards
    // against listener re-entry or duplicate pre-step dispatches.
    const lastInjected = injectedTurnBySession.get(agent.session)
    if (lastInjected === turn) return decision

    // Resolve effective domain — Config.defaultDomain is the only source in
    // this phase; session-level mutation comes in a later iteration.
    const domain = resolved.defaultDomain
    if (domain === undefined) return decision

    ctx.logger.info('[%s] injecting domain=%s (turn=%d)', name, domain, turn)

    // Fetch/refresh summary from the store. undefined = broken or missing files.
    const summary = await fetchDomainSummary(resolved.storePath, domain)
    if (summary === undefined) return decision

    const wrapped = wrapInjection(summary, domain)
    const injectionMessage = createUserMessage({
      content: [{ type: 'text', text: wrapped }],
      source: { kind: name, form: 'instructions', sections: [{ name, text: summary }] },
    })

    injectedTurnBySession.set(agent.session, turn)

    return {
      ...decision,
      messages: [...decision.messages, injectionMessage],
    }
  })
}
