/** Agent-facing metric catalog, metric execution, and metric explanations. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendAudit } from './store.ts'
import { explainMetric, listMetrics, runMetric } from './analytics.ts'
import type { MetricFilters, MetricRun } from './analytics.ts'

/** Store root the analytics tools read through. */
export interface AnalyticsToolOptions {
  /** Root directory holding the graph database. */
  readonly storePath: string
}

/** Filters accepted from a tool call. */
interface FilterToolArgs {
  readonly class?: string
  readonly property?: string
}

/** Format one value for the model-facing text. */
function cell(value: string | undefined): string {
  return value === undefined || value.length === 0 ? '—' : value
}

/** Render one metric run as a compact table. */
function renderRun(run: MetricRun): string {
  const header = `## ${run.title}（${run.metricId}）\n`
  const meta = `\n${run.rows.length} 行 · ${run.durationMs}ms · 单位：${run.unit}\n`
  if (run.rows.length === 0) {
    return `${header}${meta}\n${run.warnings.join('\n')}\n\n查询：\n\n\`\`\`sparql\n${run.sparql}\n\`\`\``
  }
  const columns = run.variables
  const lines = [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...run.rows.map(row => `| ${columns.map(column => cell(row[column])).join(' | ')} |`),
  ]
  const warnings = run.warnings.length === 0 ? '' : `\n\n注意：${run.warnings.join('；')}`
  return `${header}${meta}\n${lines.join('\n')}${warnings}`
}

/** Build filters from flat tool arguments. */
function filtersOf(args: FilterToolArgs): MetricFilters {
  return {
    ...(args.class === undefined ? {} : { class: args.class }),
    ...(args.property === undefined ? {} : { property: args.property }),
  }
}

/**
 * Register the read-only analytics tools on a context that has `tools`.
 *
 * The catalog tool lists ids; `run_metric` executes one metric; `explain_metric`
 * returns its definition, caveats, and compiled SPARQL. Runs are written to the
 * domain audit trail like the workbench runs.
 * @param ctx - context owning the registrations; tools are disposed with it.
 * @param options - store root the tools read.
 */
export function registerAnalyticsTools(ctx: Context, options: AnalyticsToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'list_metrics',
    description: 'List the analytics metrics available for a business domain. Every entry carries its id, unit, the ontology terms it reads, and the caveat that explains why its number can differ from a naive ledger total. Call this before run_metric.',
    parameters: {
      domain: { type: 'string', required: true, description: 'Business domain id from the injected index.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args, exec) {
      exec.signal.throwIfAborted()
      return listMetrics(options.storePath, args.domain).then((metrics) => {
        const lines = metrics.map(metric => `- ${metric.id}（${metric.title}，单位 ${metric.unit}）：${metric.description} 口径：${metric.caveat}`)
        return `${args.domain} 的指标目录（${metrics.length} 个）：\n\n${lines.join('\n')}`
      })
    },
    presentCall: args => ({ card: 'generic', title: 'List analytics metrics', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'run_metric',
    description: 'Run one analytics metric over a business domain and return the deduplicated result table. Every instance counts once even when the same instance appears in several batch graphs. Use list_metrics first to obtain a valid metric id; class and property names must be declared by the domain ontology.',
    parameters: {
      domain: { type: 'string', required: true, description: 'Business domain id.' },
      metric: { type: 'string', required: true, description: 'Metric id from list_metrics.' },
      class: { type: 'string', description: 'Class local id declared by the domain ontology; scopes the metric to that class.' },
      property: { type: 'string', description: 'Property local id declared by the domain ontology; required by property-values.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const run = await runMetric(options.storePath, args.domain, args.metric, filtersOf(args))
      exec.signal.throwIfAborted()
      await appendAudit(options.storePath, {
        action: 'metric-run',
        domain: args.domain,
        detail: `工具运行指标「${run.title}」（${run.rows.length} 行，${run.durationMs}ms）`,
      })
      return renderRun(run)
    },
    presentCall: args => ({ card: 'generic', title: 'Run analytics metric', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'explain_metric',
    description: 'Explain one analytics metric: its definition, unit, required ontology terms, caveat, result columns, and the exact SPARQL it compiles to. Use it when a number needs justification or a口径 question must be answered without running the query.',
    parameters: {
      domain: { type: 'string', required: true, description: 'Business domain id.' },
      metric: { type: 'string', required: true, description: 'Metric id from list_metrics.' },
      class: { type: 'string', description: 'Optional class local id declared by the domain ontology.' },
      property: { type: 'string', description: 'Optional property local id the explanation compiles with; required by property-values.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const explanation = await explainMetric(options.storePath, args.domain, args.metric, filtersOf(args))
      exec.signal.throwIfAborted()
      return [
        `## ${explanation.title}（${explanation.id}）`,
        explanation.description,
        `单位：${explanation.unit}；所需属性：${explanation.requires.length === 0 ? '—' : explanation.requires.join('、')}`,
        `口径：${explanation.caveat}`,
        `结果列：${explanation.variables.join(', ')}`,
        '',
        '```sparql',
        explanation.sparql,
        '```',
      ].join('\n')
    },
    presentCall: args => ({ card: 'generic', title: 'Explain analytics metric', kind: 'read', rawInput: args }),
  }))
}
