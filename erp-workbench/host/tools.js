/**
 * Agent-facing ERP tools.
 *
 * The workbench page is where an operator wires a connection; these tools are
 * how an agent uses one afterwards. Both read the same store, so a mapping
 * saved in the page is immediately callable from a turn — and neither can write
 * a connection, because credentials do not belong in a prompt.
 */
import { mappingSummary, readStore, publicConnection } from './config-store.js'
import { invoke } from './runtime.js'
import { ErpError, text } from './util.js'

/**
 * Build a raw tool definition without importing the tool SDK.
 * @param definition - Name, description, parameters, title, kind, and execute.
 * @returns A definition accepted by `ctx.tools.register`.
 */
function tool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: {
      schema: { type: 'object' },
      /**
       * @param _args - Tool arguments, unused by the generic renderer.
       * @param value - Canonical tool value.
       * @returns One text content block.
       */
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: definition.execute,
    /**
     * @param args - Raw arguments.
     * @returns A generic call card.
     */
    presentCall: args => ({
      card: 'generic',
      title: definition.title,
      kind: definition.kind,
      rawInput: args,
    }),
  }
}

/**
 * Register the ERP tools on the host context.
 * @param ctx - Host cordis context.
 * @returns A disposer removing every registration.
 */
export function registerTools(ctx) {
  const disposers = []

  disposers.push(ctx.tools.register(tool({
    name: 'erp_list_actions',
    title: 'ERP actions',
    kind: 'read',
    description: 'List the ERP connections and the mapped actions this deployment can call, with the parameters each action takes.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    /**
     * @returns Connections (secrets masked) and the mapped actions.
     */
    async execute() {
      const store = await readStore()
      const summary = mappingSummary(store.mapping)
      return {
        ok: true,
        connections: store.connections.map(publicConnection),
        mapping: { configured: summary.configured, count: summary.count, families: summary.families },
        actions: summary.actions,
      }
    },
  })))

  disposers.push(ctx.tools.register(tool({
    name: 'erp_invoke',
    title: 'Call ERP',
    kind: 'write',
    description: 'Call one mapped ERP action through one saved connection. Parameters use the action-side names; the stored mapping renames and transforms them before the ERP sees them.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Mapping domain, e.g. "contract".' },
        action: { type: 'string', description: 'Mapped action name, e.g. "queryPurchaseOrders".' },
        connectionId: { type: 'string', description: 'Saved connection id; defaults to the only saved connection.' },
        params: { type: 'object', description: 'Action-side parameter values.', additionalProperties: true },
      },
      required: ['domain', 'action'],
      additionalProperties: false,
    },
    /**
     * @param args - Domain, action, optional connection id, and parameters.
     * @returns The outgoing request, the ERP response, and the mapping used.
     */
    async execute(args) {
      const store = await readStore()
      const id = text(args.connectionId) || (store.connections.length === 1 ? store.connections[0].id : '')
      const connection = store.connections.find(entry => entry.id === id)
      if (connection === undefined) {
        throw new ErpError(
          'connection_not_found',
          store.connections.length === 0
            ? 'No ERP connection is saved. Add one in the ERP workbench page first.'
            : `Choose a connection: ${store.connections.map(entry => entry.id).join(', ')}.`,
        )
      }
      return invoke(connection, store.mapping, {
        domain: text(args.domain),
        action: text(args.action),
        params: args.params !== null && typeof args.params === 'object' ? args.params : {},
      })
    },
  })))

  return () => { for (const dispose of disposers) dispose() }
}
