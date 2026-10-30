/**
 * Host entry of the data analysis bundle: dataset tools plus the model-facing prompt section.
 * The client half lives in `client.js` and owns the right-sidebar panel.
 */
import { applyHost } from './host/plugin.js'

export const name = 'data-analysis'

export const inject = ['tools', 'systemPrompt']

/**
 * @param ctx - Host cordis context.
 * @param config - Plugin config; `connections` and `sources` are optional.
 */
export function apply(ctx, config) {
  applyHost(ctx, config ?? {})
}
