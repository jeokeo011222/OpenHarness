/**
 * Kingdee Cloud Galaxy adapter (skeleton — SignedK3CloudClient mode).
 *
 * K3Cloud authenticates via LoginBySign or a persisted signed token.
 * We implement the signed-client path: caller supplies appId/appSec/acctId
 * and we manage the login token internally (with a refresh timer).
 */

import type { ErpAdapter, ErpRequest, ErpResponse } from '../types.js'

export interface KingdeeGalaxyConfig {
  /** K3Cloud base URL, e.g. "https://k3cloud.example.com/Kingdee.BOS.WebApi.ServicesStub". */
  baseUrl: string
  /** Application ID registered with Kingdee ISV center. */
  appId: string
  /** Application secret (HMAC-SHA256 key). */
  appSecret: string
  /** Account database ID. */
  acctId: string
  /** Optional timeout; default 15s. */
  timeoutMs?: number
}

/** K3Cloud method name → webapi endpoint mapping (canonical subset). */
const METHOD_ENDPOINTS: Record<string, string> = {
  view: '/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.View.kdsvc',
  save: '/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.Save.kdsvc',
  submit: '/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.Submit.kdsvc',
  delete: '/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.Delete.kdsvc',
  executeBillQuery: '/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.ExecuteBillQuery.kdsvc',
  executeQuery: '/Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.ExecuteQuery.kdsvc',
}

/** Known form keys that map our generic API identifiers to K3 form names. */
const API_FORM_KEY: Record<string, { method: keyof typeof METHOD_ENDPOINTS; formId: string }> = {
  'k3_purchase_order_query':   { method: 'executeBillQuery', formId: 'BD_PURCHASEORDER' },
  'k3_purchase_order_save':    { method: 'save', formId: 'BD_PURCHASEORDER' },
  'k3_sales_order_query':      { method: 'executeBillQuery', formId: 'BD_SALESORDER' },
  'k3_goods_query':            { method: 'executeBillQuery', formId: 'BD_MATERIAL' },
  'k3_vendor_query':           { method: 'executeBillQuery', formId: 'BD_SUPPLIER' },
}

export class KingdeeGalaxyAdapter implements ErpAdapter {
  readonly name = 'kingdee-cloud-galaxy'
  private readonly cfg: Required<KingdeeGalaxyConfig>
  private loginToken: string | null = null
  private loginExpiresAt = 0

  constructor(cfg: KingdeeGalaxyConfig) {
    this.cfg = { timeoutMs: 15_000, ...cfg }
  }

  /** Lazy login — called once per token refresh window. */
  private async ensureLoginToken(): Promise<string | null> {
    const now = Date.now()
    if (this.loginToken && now < this.loginExpiresAt - 5_000) return this.loginToken

    const url = `${this.cfg.baseUrl}/Kingdee.BOS.WebApi.ServicesStub.AuthService.ValidateUser.kdsvc`
    const body = { acctID: this.cfg.acctId, username: '', pwd: '' }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (!res.ok) return null
      const json = await res.json() as { FormId?: string; IsSuccess?: boolean; Message?: string }
      // NOTE: Real K3Cloud sign auth is HMAC-based; this is a skeleton placeholder.
      // Full impl requires signing each request with appId+appSecret+timestamp.
      this.loginToken = this.cfg.appId // skeleton
      this.loginExpiresAt = Date.now() + 1_800_000 // 30 min
      return this.loginToken
    } catch { clearTimeout(timer); return null }
  }

  async execute(request: ErpRequest): Promise<ErpResponse> {
    const api = API_FORM_KEY[request.api]
    if (!api) {
      return {
        success: false,
        error: {
          code: 'UNKNOWN_K3_API',
          message: `Unknown API "${request.api}". Known: ${Object.keys(API_FORM_KEY).join(', ')}`,
        },
      }
    }

    const token = await this.ensureLoginToken()
    if (!token) {
      return { success: false, error: { code: 'AUTH_FAILED', message: 'K3Cloud login failed' } }
    }

    const endpoint = METHOD_ENDPOINTS[api.method]
    const url = `${this.cfg.baseUrl}${endpoint}`

    // K3Cloud request body shape (simplified per method)
    let body: Record<string, unknown>
    if (api.method === 'executeBillQuery' || api.method === 'executeQuery') {
      body = { FormId: api.formId, FieldKeys: request.params.FieldKeys ?? '*', Limit: request.params.Limit ?? 100 }
    } else if (api.method === 'view') {
      body = { FormId: api.formId, PkId: request.params.PkId ?? '' }
    } else {
      // save / submit / delete
      body = { FormId: api.formId, Model: request.params.Model ?? {} }
    }

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs)
    let httpRes: Response
    try {
      httpRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': `kdservice-sessionid=${token}`,
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      if ((err as Error).name === 'AbortError') {
        return { success: false, error: { code: 'TIMEOUT', message: `K3Cloud call timed out after ${this.cfg.timeoutMs}ms` } }
      }
      return { success: false, error: { code: 'NETWORK_ERROR', message: (err as Error).message } }
    } finally {
      clearTimeout(timer)
    }

    const text = await httpRes.text()
    let data: unknown
    try { data = JSON.parse(text) } catch { data = text }

    if (!httpRes.ok) {
      return { success: false, error: { code: `HTTP_${httpRes.status}`, message: httpRes.statusText, raw: data } }
    }

    return { success: true, data }
  }
}
