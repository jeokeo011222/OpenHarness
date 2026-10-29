/**
 * Yonyou U8 adapter (skeleton — HTTP transport + auth wiring; real calls
 * left for when we have a deploy).
 *
 * Version-specific handler names live in handlerNamespace so one adapter
 * class can serve U8 V13 and V15 with a simple config swap.
 */

import type { ErpAdapter, ErpRequest, ErpResponse } from '../types.js'

export interface YonyouU8Config {
  version: 'v13' | 'v15'
  /** Base URL, e.g. "https://u8-demo.example.com" (OpenAPI) or "http://127.0.0.1:8000" (local DLL bridge). */
  baseUrl: string
  /** Auth token — consumer is responsible for rotating. */
  token: string
  /** HTTP path prefix (differs between OpenAPI vs API gateway). */
  pathPrefix?: string
  /** Optional timeout in ms; default 15s. */
  timeoutMs?: number
}

/**
 * U8 handler namespace mapping. A lightweight lookup — no SDK coupling.
 * Add new version→handler mappings here as more U8 versions are tested.
 */
const HANDLER_NAMESPACE: Record<YonyouU8Config['version'], Record<string, string>> = {
  v13: {
    // Purchase order
    'u8_purchase_order_query': '/Yonyou.U8.U9.PurchaseOrder.Query/Query',
    'u8_purchase_order_save': '/Yonyou.U8.U9.PurchaseOrder.Save/Save',
    // Sales
    'u8_sales_order_query': '/Yonyou.U8.U9.SalesOrder.Query/Query',
    // Goods
    'u8_goods_query': '/Yonyou.U8.U9.Goods.Query/Query',
    // Vendor
    'u8_vendor_query': '/Yonyou.U8.U9.Vendor.Query/Query',
  },
  v15: {
    'u8_purchase_order_query': '/Yonyou.U8.U9.PurchaseOrder.Query/Query',
    'u8_purchase_order_save': '/Yonyou.U8.U9.PurchaseOrder.Save/Save',
    'u8_sales_order_query': '/Yonyou.U8.U9.SalesOrder.Query/Query',
    'u8_goods_query': '/Yonyou.U8.U9.Goods.Query/Query',
    'u8_vendor_query': '/Yonyou.U8.U9.Vendor.Query/Query',
  },
}

export class YonyouU8Adapter implements ErpAdapter {
  readonly name: string
  private readonly cfg: Required<YonyouU8Config> & Pick<YonyouU8Config, 'pathPrefix'>

  constructor(cfg: YonyouU8Config) {
    this.name = `yonyou-u8-${cfg.version}`
    this.cfg = {
      pathPrefix: '/apilink/u8api',
      timeoutMs: 15_000,
      ...cfg,
    }
  }

  async execute(request: ErpRequest): Promise<ErpResponse> {
    // 1. Resolve handler path
    const handlerMap = HANDLER_NAMESPACE[this.cfg.version]
    const handlerPath = handlerMap[request.api]
    if (!handlerPath) {
      return {
        success: false,
        error: {
          code: 'UNKNOWN_U8_API',
          message: `Unknown API "${request.api}" for U8 ${this.cfg.version}. Known: ${Object.keys(handlerMap).join(', ')}`,
        },
      }
    }

    // 2. Build URL
    const url = `${this.cfg.baseUrl}${this.cfg.pathPrefix ?? ''}${handlerPath}`

    // 3. HTTP call with timeout
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs)
    let httpRes: Response
    try {
      httpRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.cfg.token}`,
        },
        body: JSON.stringify(request.params),
        signal: ctrl.signal,
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return { success: false, error: { code: 'TIMEOUT', message: `U8 call timed out after ${this.cfg.timeoutMs}ms` } }
      }
      return { success: false, error: { code: 'NETWORK_ERROR', message: (err as Error).message } }
    } finally {
      clearTimeout(timer)
    }

    // 4. Parse response
    const text = await httpRes.text()
    let data: unknown
    try { data = JSON.parse(text) } catch { data = text }

    if (!httpRes.ok) {
      return {
        success: false,
        error: { code: `HTTP_${httpRes.status}`, message: httpRes.statusText, raw: data },
      }
    }

    return { success: true, data }
  }
}
