/**
 * Router core.
 *
 * Responsibilities (in order):
 *   1. Load & validate the mapping config
 *   2. Resolve the concrete adapter from action + erp family
 *   3. Apply param transformations
 *   4. Delegate to adapter.execute()
 *   5. Return a unified ErpResponse (adapter error or not)
 *
 * The router is adapter-agnostic — it never imports a concrete adapter.
 * Adapters are registered at runtime via registry.ts.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { ActionMapping, ErpAdapter, ErpRequest, ErpResponse, MappingConfigFile, RouterInvokeArgs } from './types.js'
import { getAdapter, listAdapterNames } from './registry.js'
import { transformParams } from './transformers.js'

// ---- Zod schema for config validation ----

const paramMappingSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  transform: z.object({
    kind: z.enum(['identity', 'date_format', 'enum_map']),
    format: z.string().optional(),
    map: z.record(z.string(), z.string()).optional(),
  }).optional(),
})

const mappingEntrySchema = z.object({
  domain: z.string().min(1),
  action: z.string().min(1),
  erp: z.string().min(1),
  api: z.string().min(1),
  params: z.array(paramMappingSchema),
})

const configFileSchema = z.object({
  version: z.number().int().positive(),
  mappings: z.array(mappingEntrySchema),
  defaultAdapterByFamily: z.record(z.string(), z.string()).optional(),
})

// ---- Router ----

export interface Router {
  /** Load config from a JSON file path (FS). */
  loadFromFile(path: string): Promise<void>
  /** Load config from an already-parsed object. */
  load(config: MappingConfigFile): void
  /** Invoke an action. Returns ErpResponse — never throws. */
  invoke(args: RouterInvokeArgs): Promise<ErpResponse>
  /** Resolve a mapping entry — exported for editor preview use. */
  resolveMapping(domain: string, action: string): ActionMapping | undefined
  /** Diagnostics — list all known domain+action pairs. */
  knownActions(): Array<{ domain: string; action: string; erp: string; api: string }>
}

export interface CreateRouterOptions {
  /** Default adapter resolution table (family → concrete adapter name). */
  defaultFamilyResolution?: Record<string, string>
}

/**
 * Create a new router instance. Adapters must still be registered
 * (via registerAdapter()) before invoke() can succeed.
 */
export function createRouter(opts: CreateRouterOptions = {}): Router {
  let config: MappingConfigFile | null = null

  function resolveMapping(domain: string, action: string): ActionMapping | undefined {
    if (!config) return undefined
    return config.mappings.find(m => m.domain === domain && m.action === action)
  }

  function resolveAdapterName(erpFamily: string): string {
    // 1. Try config-level defaultAdapterByFamily
    const cfgDefault = config?.defaultAdapterByFamily?.[erpFamily]
    if (cfgDefault) return cfgDefault
    // 2. Try router-level defaultFamilyResolution
    const routerDefault = opts.defaultFamilyResolution?.[erpFamily]
    if (routerDefault) return routerDefault
    // 3. Fall back: family name IS the adapter name (user writes "yonyou-u8-v13" directly)
    return erpFamily
  }

  function findAdapter(name: string): ErpAdapter | undefined {
    // Exact name
    const direct = getAdapter(name)
    if (direct) return direct
    // Substring match: user says "yonyou", adapters are "yonyou-u8-v13" / "yonyou-u8-v15"
    // Take the highest-priority one registered (last registered wins)
    for (const registered of listAdapterNames()) {
      if (registered.startsWith(name + '-') || registered === name) {
        const hit = getAdapter(registered)
        if (hit) return hit
      }
    }
    return undefined
  }

  const router: Router = {
    async loadFromFile(path: string): Promise<void> {
      const abs = resolve(path)
      const text = await readFile(abs, 'utf8')
      const obj = JSON.parse(text)
      router.load(obj)
    },

    load(cfg: MappingConfigFile): void {
      const parsed = configFileSchema.parse(cfg)
      config = parsed
    },

    async invoke(args: RouterInvokeArgs): Promise<ErpResponse> {
      // 1. Find mapping
      const mapping = resolveMapping(args.domain, args.action)
      if (!mapping) {
        return {
          success: false,
          error: { code: 'MAPPING_NOT_FOUND', message: `No mapping for domain=${args.domain} action=${args.action}` },
        }
      }

      // 2. Resolve concrete adapter
      const adapterName = resolveAdapterName(mapping.erp)
      const adapter = findAdapter(adapterName)
      if (!adapter) {
        const known = listAdapterNames()
        return {
          success: false,
          error: {
            code: 'ADAPTER_NOT_REGISTERED',
            message: `No registered adapter for erp=${mapping.erp} (resolved=${adapterName}). Known: ${known.join(', ') || '(none)'}`,
          },
        }
      }

      // 3. Transform params
      let transformed: Record<string, unknown>
      try {
        transformed = transformParams(args.params, mapping.params)
      } catch (err) {
        return {
          success: false,
          error: { code: 'TRANSFORM_ERROR', message: (err as Error).message },
        }
      }

      // 4. Delegate
      const req: ErpRequest = { api: mapping.api, params: transformed }
      const start = performance.now()
      let result: ErpResponse
      try {
        result = await adapter.execute(req)
      } catch (err) {
        result = {
          success: false,
          error: { code: 'ADAPTER_THREW', message: (err as Error).message, raw: (err as Error).stack },
        }
      }
      result.latencyMs = Math.round(performance.now() - start)
      result.adapter = adapter.name
      return result
    },

    resolveMapping,

    knownActions() {
      if (!config) return []
      return config.mappings.map(m => ({
        domain: m.domain, action: m.action, erp: m.erp, api: m.api,
      }))
    },
  }

  return router
}
