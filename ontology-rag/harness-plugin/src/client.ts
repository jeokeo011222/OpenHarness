/**
 * OntoRAG 后端的 HTTP 客户端。
 *
 * 约束：所有调用都带租户头、超时与有限重试；错误统一抛 `RagApiError`，
 * 调用方据 `status` 区分"被闸门阻断（422）"与"服务不可用（5xx）"。
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** 客户端配置。 */
export interface RagClientOptions {
  /** 后端根地址，例如 http://127.0.0.1:8000 */
  readonly baseUrl: string
  /** 租户密钥；为兼容本地演示允许为空，但生产必须配置 */
  readonly apiKey: string
  /** 租户 id，决定图、索引与审计分区 */
  readonly tenantId: string
  /** 单次请求超时（毫秒） */
  readonly timeoutMs: number
}

/** 后端返回的结构化错误。 */
export class RagApiError extends HarnessError {
  /** HTTP 状态码；0 表示网络层失败。 */
  readonly status: number
  /** 后端 `details` 字段，通常含 guard 冲突明细。 */
  readonly details: unknown

  constructor(message: string, code: string, status: number, details: unknown) {
    super(message, code)
    this.status = status
    this.details = details
  }
}

/** 极简延迟。 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 读取错误体中的 code/message/details。 */
function parseError(text: string): { code: string; message: string; details: unknown } {
  try {
    const parsed = JSON.parse(text) as { code?: unknown; message?: unknown; details?: unknown }
    return {
      code: typeof parsed.code === 'string' ? parsed.code : 'RAG_ERROR',
      message: typeof parsed.message === 'string' ? parsed.message : 'OntoRAG 调用失败',
      details: parsed.details,
    }
  } catch {
    return { code: 'RAG_ERROR', message: text.slice(0, 300) || 'OntoRAG 调用失败', details: undefined }
  }
}

/** 与后端通讯的薄客户端。 */
export class RagClient {
  constructor(private readonly options: RagClientOptions) {}

  /** 发送 JSON POST，返回解析后的响应体。 */
  async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const url = new URL(path, this.options.baseUrl.endsWith('/') ? this.options.baseUrl : `${this.options.baseUrl}/`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs)
    const forward = (): void => controller.abort()
    signal?.addEventListener('abort', forward, { once: true })
    let lastError: unknown

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Tenant-Id': this.options.tenantId,
              ...(this.options.apiKey.length > 0 ? { 'X-Api-Key': this.options.apiKey } : {}),
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          const text = await response.text()
          if (!response.ok) {
            const parsed = parseError(text)
            throw new RagApiError(parsed.message, parsed.code, response.status, parsed.details)
          }
          return JSON.parse(text) as T
        } catch (error) {
          if (error instanceof RagApiError) throw error
          lastError = error
          if (signal?.aborted === true || controller.signal.aborted) break
          await sleep(200 * (attempt + 1))
        }
      }
      throw new RagApiError(
        `无法连接 OntoRAG 后端：${lastError instanceof Error ? lastError.message : String(lastError)}`,
        'RAG_UNAVAILABLE',
        0,
        undefined,
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forward)
    }
  }
}
