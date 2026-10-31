/**
 * 租户审计：把插件侧的每次工具调用与用量写到本地 JSONL。
 *
 * 后端已有一份完整审计；这里补的是"Harness 视角"——模型调了什么、耗时多少、
 * 是否被闸门拦下。两份对得上，才能证明链路没有被绕过。
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 一条插件侧审计记录。 */
export interface AuditEntry {
  /** ISO 时间戳。 */
  readonly at: string
  readonly tenantId: string
  readonly tool: string
  readonly ok: boolean
  readonly latencyMs: number
  readonly traceId?: string
  readonly tokens?: number
  readonly detail?: string
}

/** JSONL 审计写入器。 */
export class AuditLog {
  private readonly file: string

  constructor(directory: string) {
    this.file = join(directory, 'harness-audit.jsonl')
  }

  /** 追加一条记录；失败不阻断业务，只记录到控制台。 */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await mkdir(join(this.file, '..'), { recursive: true })
      await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (error) {
      console.warn('[ontology-rag] 审计写入失败', error)
    }
  }
}
