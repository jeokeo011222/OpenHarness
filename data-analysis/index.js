/**
 * Host entry of the data analysis bundle: dataset tools, the workbench HTTP
 * API, and the model-facing prompt section. The client half lives in
 * `client.js` and owns the sidebar panel and the workbench page.
 */
import { applyHost } from './host/plugin.js'

export const name = 'data-analysis'

/**
 * `webServer` is optional: the tools and the prompt work in a headless profile,
 * where nothing serves HTTP. Declaring it optional keeps that profile loading
 * this plugin while still letting the web profile resolve the seat.
 */
export const inject = {
  tools: { required: true },
  systemPrompt: { required: true },
  webServer: { required: false },
}

/**
 * @param ctx - Host cordis context.
 * @param config - Plugin config; `connections` and `sources` are optional.
 */
export function apply(ctx, config) {
  applyHost(ctx, config ?? {})
}
