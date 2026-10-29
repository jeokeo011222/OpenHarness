/**
 * Core types for the ERP connector router.
 *
 * These types are the public surface — adapters, transformers and the
 * config schema all reference them. Keeping them in one file avoids
 * import cycles between routers and adapters.
 */

// ---- Transformer ----

/** Allowed value-level transforms (safe, no free-form scripts). */
export type TransformKind = 'identity' | 'date_format' | 'enum_map'

/**
 * Transformer parameter descriptor. The router maps each request value
 * through one transform before handing it to the adapter.
 */
export interface TransformerSpec {
  kind: TransformKind
  /** For date_format: the target format (e.g. "YYYYMMDD"). */
  format?: string
  /** For enum_map: human→ERP value mapping. */
  map?: Record<string, string>
}

/** Input→output value transformation. */
export interface ParamMapping {
  /** Parameter name on the ontology/action side. */
  from: string
  /** Parameter name expected by the ERP API. */
  to: string
  /** Defaults to identity if omitted. */
  transform?: TransformerSpec
}

// ---- ErpAdapter ----

export interface ErpRequest {
  /** Adapter-specific API identifier (e.g. "u8_purchase_order_query"). */
  api: string
  /** Transformed params — the router has already applied ParamMapping transforms. */
  params: Record<string, unknown>
}

export interface ErpResponse {
  /** Whether the call succeeded. */
  success: boolean
  /** Adapter-agnostic structured result. Adapter decides shape. */
  data?: unknown
  /** Structured error when success=false. */
  error?: {
    code: string
    message: string
    /** Raw HTTP / ERP response for debugging (may be truncated). */
    raw?: unknown
  }
  /** Adapter version that served this request. */
  adapter?: string
  /** Execution latency in ms. */
  latencyMs?: number
}

/**
 * Adapter contract. Implement this for each ERP product+version.
 *
 * Adapters are responsible for:
 *   - HTTP transport (fetch / axios — they pick)
 *   - Version-specific handler naming
 *   - Authentication token consumption (passed as config, never in execute)
 *
 * Adapters are NOT responsible for:
 *   - Param mapping (router owns that)
 *   - Config loading (router owns that)
 *   - Token retrieval (they consume a token given at construction)
 */
export interface ErpAdapter {
  /** Unique identifier, e.g. "yonyou-u8-v13", "kingdee-cloud-galaxy". */
  readonly name: string

  /** Execute an ERP API call. Must never throw — always returns ErpResponse. */
  execute(request: ErpRequest): Promise<ErpResponse>
}

// ---- Mapping config (consumed by the router) ----

/**
 * One action→ERP-API entry in the mapping config.
 * This is the exact JSON shape written by the visualization editor
 * (modules one output).
 */
export interface ActionMapping {
  /** Business domain — groups related actions together. */
  domain: string
  /** Ontology action identifier, e.g. "queryPurchaseOrders". */
  action: string
  /** Adapter family, e.g. "yonyou" or "kingdee" — router resolves to a concrete adapter. */
  erp: string
  /** ERP-side API identifier passed to adapter.execute(). */
  api: string
  /** Param transformations. Missing params on the action side are skipped silently. */
  params: ParamMapping[]
}

/** Top-level mapping config file (written by the visualization editor). */
export interface MappingConfigFile {
  version: number
  mappings: ActionMapping[]
  /** Optional: default adapter family → version resolution table. */
  defaultAdapterByFamily?: Record<string, string>
}

// ---- Router surface ----

export interface RouterInvokeArgs {
  domain: string
  action: string
  /** Raw parameters from the action caller (pre-transform). */
  params: Record<string, unknown>
}
