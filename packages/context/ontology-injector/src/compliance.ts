/**
 * Compliance report: run a domain's SHACL shapes over its instance batches and
 * aggregate the verdict per rule.
 *
 * The retrieval gate answers "may this answer ship"; the compliance report
 * answers a different question the business asks directly — "how many of our
 * records break this rule" — and stays available whether or not a question is
 * being answered. It reuses the same shape loader and gate engine, so a rule
 * that blocks an answer is the same rule the report counts.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendAudit, instanceGraphIri, listInstanceBatches } from './store.ts'
import { loadLexicon } from './retrieval/lexicon.ts'
import { loadShapes } from './shacl/shapes.ts'
import { runGate } from './shacl/engine.ts'
import type { ComplianceReport, ComplianceRule } from './types.ts'

/** Focus nodes listed per rule before the sample list is cut. */
const MAX_SAMPLE_NODES = 10

/** Distinct messages listed per rule before the message list is cut. */
const MAX_MESSAGES = 5

/**
 * Run every shape over every instance batch and count violations per shape.
 *
 * @param root - ontology store root.
 * @param domain - domain id.
 * @returns the per-rule tallies plus the shapes that could not run.
 */
export async function runCompliance(root: string, domain: string): Promise<ComplianceReport> {
  const lexicon = await loadLexicon(root, domain)
  const shapes = await loadShapes(root, domain)
  const batches = await listInstanceBatches(root, domain)
  const graphs = batches.map(batch => instanceGraphIri(domain, batch.batch))
  const gate = await runGate({ root, domain, graphs, shapes, lexicon })

  const byShape = new Map<string, { count: number; nodes: string[]; messages: string[] }>()
  for (const violation of gate.violations) {
    const entry = byShape.get(violation.shape) ?? { count: 0, nodes: [], messages: [] }
    entry.count += 1
    if (violation.focusNode.length > 0 && !entry.nodes.includes(violation.focusNode)) {
      entry.nodes.push(violation.focusNode)
    }
    if (violation.message.length > 0 && !entry.messages.includes(violation.message)) {
      entry.messages.push(violation.message)
    }
    byShape.set(violation.shape, entry)
  }

  const rules: ComplianceRule[] = shapes.flatMap((shape) => {
    const tally = byShape.get(shape.label)
    if (tally === undefined) return []
    return [{
      shape: shape.iri,
      label: shape.label,
      targetClass: shape.targetClass,
      severity: shape.severity,
      violations: tally.count,
      focusNodes: tally.nodes.slice(0, MAX_SAMPLE_NODES),
      messages: tally.messages.slice(0, MAX_MESSAGES),
    }]
  })
  rules.sort((left, right) => right.violations - left.violations || left.shape.localeCompare(right.shape))

  return {
    domain,
    conforms: gate.conforms,
    batches: batches.map(batch => batch.batch),
    shapes: shapes.length,
    checked: gate.checked,
    rules,
    errors: gate.errors,
  }
}

/** Store root the compliance tool reads through. */
export interface ComplianceToolOptions {
  /** Root directory holding the graph database. */
  readonly storePath: string
}

/**
 * Register the read-only `compliance_report` tool on a context that has `tools`.
 *
 * The report counts SHACL violations per rule over the imported instance
 * batches and writes an audit entry, like the workbench run.
 *
 * @param ctx - context owning the registration; the tool is disposed with it.
 * @param options - store root the tool reads.
 */
export function registerComplianceTool(ctx: Context, options: ComplianceToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'compliance_report',
    description: 'Run the SHACL compliance report for one business domain: every constraint is checked against the imported instance batches, and the result counts violating records per rule (for example, how many contracts are missing a party identifier). Use it when the user asks about data quality, rule violations, or compliance of imported records.',
    parameters: {
      domain: { type: 'string', required: true, description: 'Business domain id from the injected index.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const report = await runCompliance(options.storePath, args.domain)
      exec.signal.throwIfAborted()
      await appendAudit(options.storePath, {
        action: 'compliance-run',
        domain: args.domain,
        detail: report.conforms
          ? `合规检查通过（${report.shapes} 个形状，${report.batches.length} 个批次）`
          : `合规检查未通过：${report.rules.reduce((sum, rule) => sum + rule.violations, 0)} 条违规`,
      })
      return renderCompliance(report)
    },
    presentCall: args => ({ card: 'generic', title: 'Run compliance report', kind: 'read', rawInput: args }),
  }))
}

/**
 * Render one compliance report as Markdown for the model.
 *
 * @param report - the report to render.
 * @returns Markdown text.
 */
export function renderCompliance(report: ComplianceReport): string {
  const lines = [`## 合规检查：${report.domain}`]
  lines.push(`结论：${report.conforms ? '通过' : '未通过'} · 形状 ${report.shapes} 个 · 检查 ${report.checked} 项 · 批次 ${report.batches.length} 个（${report.batches.join('、') || '无'}）`)
  if (report.rules.length === 0 && report.errors.length === 0) {
    lines.push('', '未发现违规。')
    return lines.join('\n')
  }
  for (const rule of report.rules) {
    lines.push('', `- ${rule.label}（目标类 ${rule.targetClass}，${rule.severity}）：${rule.violations} 条违规`)
    for (const message of rule.messages) lines.push(`  - ${message}`)
    if (rule.focusNodes.length > 0) lines.push(`  - 示例对象：${rule.focusNodes.join('、')}`)
  }
  if (report.errors.length > 0) {
    lines.push('', '未能执行的检查：', ...report.errors.map(error => `- ${error}`))
  }
  return lines.join('\n')
}
