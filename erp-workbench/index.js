/**
 * Host entry of the ERP workbench bundle: the call tools and the workbench HTTP
 * API. The client half lives in `client.js` and owns the page and sidebar row.
 */
import { registerApi } from './host/api.js'
import { registerTools } from './host/tools.js'

export const name = 'erp-workbench'

/**
 * `webServer` is optional so a headless profile still gets the agent tools;
 * `tools` is optional so a profile without tools still serves the page.
 */
export const inject = {
  tools: { required: false },
  webServer: { required: false },
}

/**
 * @param ctx - Host cordis context.
 */
export function apply(ctx) {
  ctx.inject(['tools'], scope => {
    ctx.effect(() => registerTools(scope), 'erp-workbench: tools')
  })
  ctx.effect(() => registerApi(ctx), 'erp-workbench: api')
}
