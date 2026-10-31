/**
 * OntoRAG × DeepSeek Harness 桥接插件。
 *
 * 职责边界：
 * - 工具面：把 SPARQL / SHACL / 实体链接 / 完整问答暴露给模型；
 * - 权限面：`tools.guard` 做单调的执行前判定（租户、密钥、工具启停），
 *   guard 只有"拒绝"没有"放行"，因此监听器顺序无法把它改成允许；
 * - 生命周期：`agent/pre-step` 注入本体解析结果（pre_retrieval_hook），
 *   `tools/post-execute` 在结果回到模型前强制复检（post_generation_hook）。
 *
 * 为什么闸门挂在 tools/post-execute：Harness 的助手文本是流式产出的，
 * 没有可撤回的落点；而 RAG 答案与 SHACL 结论都必须作为工具结果进入上下文，
 * 在这个边界上 block 才能真正做到"不通过则不返回"。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'

import { AuditLog } from './audit.ts'
import { RagApiError, RagClient } from './client.ts'
import { RAG_TOOL_NAMES, registerRagTools, takeCheck } from './tools.ts'
import type { QueryIntent } from './types.ts'

/**
 * 把本插件注册为合法的 user 消息来源。
 *
 * `MessageSourceMap` 是合并式联合（宿主约定：每个生产者在自己模块里声明自己的
 * `kind`，不存在共享的 catch-all），所以这里只做声明合并，不新增运行时逻辑。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'ontology-rag': { kind: 'ontology-rag' } & ContextFormed
  }
}

/** 插件配置。 */
export interface Config {
  /** OntoRAG 后端地址 */
  readonly baseUrl: string
  /** 租户密钥（禁止写进仓库，从 Harness 配置或环境注入） */
  readonly apiKey: string
  /** 租户 id */
  readonly tenantId: string
  /** 单次调用超时（毫秒） */
  readonly timeoutMs: number
  /** 单轮问答 token 上限，超过即中止继续检索 */
  readonly maxTokensPerTurn: number
  /** 插件侧审计目录 */
  readonly auditPath: string
  /** 是否在每轮开始注入本体解析结果 */
  readonly injectIntent: boolean
  /** 是否强制复检答案（关闭仅用于排障，生产必须为 true） */
  readonly enforceGuard: boolean
  /** 未配置密钥时是否拒绝调用工具（生产必须为 true） */
  readonly requireApiKey: boolean
  /** 允许模型调用的工具白名单；空数组视为"全部允许" */
  readonly enabledTools: string[]
}

/** 从消息中取最后一段用户文本。 */
function lastUserText(messages: readonly UserMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('\n')
      .trim()
    if (text.length > 0) return text
  }
  return ''
}

/** 把解析结果压成可注入的一段话。 */
function intentBlock(intent: QueryIntent): string {
  const classes = intent.classes.map(iri => iri.split('#').pop() ?? iri).join('、') || '未识别'
  const constraints = intent.constraints.join('、') || '无'
  const mentions = intent.entities
    .slice(0, 6)
    .map(item => `${item.surface}→${item.kind}`)
    .join('，')
  return [
    `<ontology-rag domain="${intent.domain}" complexity="${intent.complexity}">`,
    `业务域：${intent.domain}`,
    `命中本体类：${classes}`,
    `相关业务约束：${constraints}`,
    `术语对齐：${mentions || '无'}`,
    '执行要求：涉及金额、状态、边界归属、核算结论的问题，必须调用 ontology_rag_answer 获取证据链；',
    '需要自己下结论时，先用 ontology_entity_link 对齐术语、再查数、最后用 shacl_validate 过闸门。',
    '不得凭记忆作答。若工具返回阻断（block），请直接向用户说明冲突规则与证据，不要换措辞重试。',
    '</ontology-rag>',
  ].join('\n')
}

/** 插件主体。 */
export class OntologyRagBridge {
  static Config: z<Config> = z.object({
    baseUrl: z.string().default('http://127.0.0.1:8000'),
    apiKey: z.string().default(''),
    tenantId: z.string().default('demo'),
    timeoutMs: z.natural().default(30_000),
    maxTokensPerTurn: z.natural().default(24_000),
    auditPath: z.string().default('./var'),
    injectIntent: z.boolean().default(true),
    enforceGuard: z.boolean().default(true),
    requireApiKey: z.boolean().default(true),
    enabledTools: z.array(z.string()).default([]),
  })

  private readonly client: RagClient
  private readonly audit: AuditLog
  private readonly tenantId: string
  private readonly injectIntentEnabled: boolean
  private readonly enforceGuard: boolean
  private readonly maxTokensPerTurn: number
  /** 每个会话已注入的轮次，避免重复注入。 */
  private readonly injectedTurn = new WeakMap<Session, number>()
  /** 每个会话当轮累计 token。 */
  private readonly turnUsage = new WeakMap<Session, { turn: number; tokens: number }>()

  constructor(ctx: Context, config: Config) {
    this.client = new RagClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      tenantId: config.tenantId,
      timeoutMs: config.timeoutMs,
    })
    this.audit = new AuditLog(config.auditPath)
    this.tenantId = config.tenantId
    this.injectIntentEnabled = config.injectIntent
    this.enforceGuard = config.enforceGuard
    this.maxTokensPerTurn = config.maxTokensPerTurn

    const ragTools = new Set<string>(RAG_TOOL_NAMES)
    const allowlist = new Set<string>(
      config.enabledTools.length > 0 ? config.enabledTools : RAG_TOOL_NAMES,
    )
    const missingTenant = this.tenantId.trim().length === 0
    const missingKey = config.requireApiKey && config.apiKey.trim().length === 0

    ctx.inject(['tools'], scope => {
      // ---- 权限闸门（单调，先于工具体执行）----
      // 放在这里而不是每个工具的 execute 里：一处判定覆盖全部工具，
      // 新增工具时不会因为"忘了加校验"而漏掉。
      scope.tools.guard(execution => {
        if (!ragTools.has(execution.name)) return undefined
        if (missingTenant) {
          return '本体中心未配置租户（tenantId 为空），拒绝调用任何本体工具'
        }
        if (missingKey) {
          return '本体中心未配置租户密钥（apiKey 为空，且 requireApiKey=true），拒绝调用任何本体工具'
        }
        if (!allowlist.has(execution.name)) {
          return `工具 ${execution.name} 已被策略禁用（enabledTools 未包含它）`
        }
        return undefined
      })

      registerRagTools(scope, {
        client: this.client,
        audit: this.audit,
        tenantId: this.tenantId,
        requestTimeoutMs: config.timeoutMs,
      })
    })

    ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      if (step !== 1 || !this.injectIntentEnabled) return decision
      if (this.injectedTurn.get(agent.session) === turn) return decision
      this.turnUsage.set(agent.session, { turn, tokens: 0 })

      const question = lastUserText(messages)
      if (question.length < 2) return decision
      try {
        const intent = await this.client.post<QueryIntent>(
          '/v1/hooks/pre-retrieval',
          { query: question },
          signal,
        )
        this.injectedTurn.set(agent.session, turn)
        const message = createUserMessage({
          content: [{ type: 'text', text: intentBlock(intent) }],
          source: {
            kind: 'ontology-rag',
            form: 'instructions',
            sections: [{ name: `ontology-rag/${intent.domain}`, text: intent.query }],
          },
        })
        return { ...decision, messages: [...decision.messages, message] }
      } catch (error) {
        // 解析失败不阻断对话：工具仍可显式调用，只是少了预注入的约束提示
        await this.audit.record({
          at: new Date().toISOString(),
          tenantId: this.tenantId,
          tool: 'pre_retrieval_hook',
          ok: false,
          latencyMs: 0,
          detail: error instanceof Error ? error.message : String(error),
        })
        return decision
      }
    })

    ctx.on('tools/post-execute', async (exec, _result, next) => {
      if (!ragTools.has(exec.name)) return next()
      if (!this.enforceGuard) return next()
      const check = takeCheck(exec.token)
      if (check === undefined) return next()

      // ---- 分支一：候选三元组校验。后端已判阻断的直接中止本轮 ----
      if (check.kind === 'shacl') {
        if (check.guard.blocked !== true) return next()
        const lines = check.guard.violations
          .filter(item => (item.severity ?? 'Violation') === 'Violation')
          .map(item => `- [${item.rule}] ${item.message}`)
          .join('\n')
        await this.audit.record({
          at: new Date().toISOString(),
          tenantId: this.tenantId,
          tool: 'shacl_gate',
          ok: false,
          latencyMs: 0,
          detail: `blocked: ${lines.slice(0, 400)}`,
        })
        return {
          kind: 'block',
          feedback: [{
            type: 'text',
            text: `候选结论未通过 SHACL 校验，本次校验被阻断：\n${lines}\n必须把上述冲突规则与证据原样告知用户，不得改写结论后重试。`,
          }],
        }
      }

      // ---- 分支二：完整链路答案。先查 token 预算，再让后端复检 ----
      const session = exec.agent?.session
      if (session !== undefined) {
        const usage = this.turnUsage.get(session)
        const used = (usage?.tokens ?? 0) + check.tokens
        this.turnUsage.set(session, { turn: usage?.turn ?? 0, tokens: used })
        if (used > this.maxTokensPerTurn) {
          return {
            kind: 'block',
            feedback: [{
              type: 'text',
              text: `本轮 token 已用 ${used}，超过上限 ${this.maxTokensPerTurn}，已停止继续检索。请缩小问题范围或改用更精确的合同/单据编号。`,
            }],
          }
        }
      }

      try {
        await this.client.post(
          '/v1/hooks/post-generation',
          {
            query: check.question,
            answer: check.answer ?? '',
            claims: check.claims ?? [],
            citations: check.citations ?? [],
          },
          exec.signal,
        )
        return next()
      } catch (error) {
        if (error instanceof RagApiError && error.status === 422) {
          const details = error.details as { guard?: { violations?: { rule: string; message: string }[] } } | undefined
          const violations = details?.guard?.violations ?? []
          const lines = violations.map(item => `- [${item.rule}] ${item.message}`).join('\n')
          await this.audit.record({
            at: new Date().toISOString(),
            tenantId: this.tenantId,
            tool: 'post_generation_hook',
            ok: false,
            latencyMs: 0,
            traceId: check.traceId,
            detail: error.message,
          })
          return {
            kind: 'block',
            feedback: [{
              type: 'text',
              text: `答案未通过 SHACL 闸门，已阻止返回（trace ${check.traceId}）：\n${lines || error.message}\n请直接说明冲突规则，不要重新措辞规避。`,
            }],
          }
        }
        throw error
      }
    })
  }
}

export default OntologyRagBridge
