/** Host plugin: register the analysis tools and the prompt section against the shared runtime. */
import { registerTools } from './tools.js'
import { sectionText } from './prompt.js'

/** Section order after the core tool guidance. */
const SECTION_ORDER = 120

/**
 * Mount the host half of the plugin.
 * @param ctx - Host cordis context.
 * @param config - Plugin config from `cordis.patch.yml`: `connections` and `sources`.
 */
export function applyHost(ctx, config) {
  const runtime = {
    config: { connections: config.connections ?? [], sources: config.sources ?? [] },
    queryCache: new Map(),
  }
  ctx.effect(() => registerTools(ctx, runtime), 'data-analysis: tools')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'data-analysis',
    order: SECTION_ORDER,
    /**
     * @returns The prompt section text.
     */
    text: () => sectionText(),
  }), 'data-analysis: prompt')
}
