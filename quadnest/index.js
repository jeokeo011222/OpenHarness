/**
 * Host entry of the QuadNest bundle: four companion Agents plus one group-chat
 * Agent behind four authenticated browser routes. The client half lives in
 * `client.js` and owns the left-sidebar world page.
 */

import { QuadNestPool } from './host/pool.js'
import { registerRoutes } from './host/routes.js'

export const name = 'quadnest'

export const inject = ['agents', 'connection', 'agentDefaultModel', 'webServer']

/** Default deadline for one companion turn, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 120_000
/** Largest accepted turn deadline, in milliseconds. */
const MAX_TIMEOUT_MS = 600_000
/** Default quiet interval before a companion opens a conversation, in milliseconds. */
const DEFAULT_IDLE_MS = 60_000
/** Shortest accepted quiet interval, in milliseconds. */
const MIN_IDLE_MS = 20_000
/** Longest accepted quiet interval, in milliseconds. */
const MAX_IDLE_MS = 600_000

/**
 * Validate one plugin config object.
 * @param config - raw Loader config.
 * @returns the resolved settings consumed by the pool, the browser, and the routes.
 * @throws when a provided field is not a usable value.
 */
function resolveSettings(config) {
  if (config === undefined || config === null) return { timeoutMs: DEFAULT_TIMEOUT_MS, idleMs: DEFAULT_IDLE_MS }
  if (typeof config !== 'object' || Array.isArray(config)) throw new Error('quadnest config must be an object')
  const settings = { timeoutMs: DEFAULT_TIMEOUT_MS, idleMs: DEFAULT_IDLE_MS }
  if (config.timeoutMs !== undefined) {
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`quadnest config.timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`)
    }
    settings.timeoutMs = config.timeoutMs
  }
  if (config.idleMs !== undefined) {
    if (!Number.isInteger(config.idleMs) || config.idleMs < MIN_IDLE_MS || config.idleMs > MAX_IDLE_MS) {
      throw new Error(`quadnest config.idleMs must be an integer between ${MIN_IDLE_MS} and ${MAX_IDLE_MS}`)
    }
    settings.idleMs = config.idleMs
  }
  return settings
}

/**
 * Mount the companion pool and its browser routes for one plugin fiber.
 * @param ctx - Host cordis context.
 * @param config - optional plugin config; see {@link resolveSettings}.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  const pool = new QuadNestPool(ctx, settings)
  registerRoutes(ctx, pool)
  ctx.effect(() => () => pool.dispose(), 'quadnest: dispose companions with the plugin fiber')
}
