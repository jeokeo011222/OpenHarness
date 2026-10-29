/**
 * Client-side ontology catalog panel registration.
 *
 * Registers two sidebar/main slots:
 *   - `sidebar.panellist` row with a 2×2 grid icon
 *   - `main` page with the domain catalog + CLI pipeline documentation
 *
 * The panel ships with a static domain catalog that mirrors the shipped
 * ontology-store/registry.json. Live filesystem re-reading would need a
 * host-side bridge; this keeps the client entry bundle-pure and zero-deps.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { OntologyPanel, type OntologyDomainRow } from './OntologyPanel.tsx'
import { OntologyIcon } from './OntologyIcon.tsx'

const NS = 'ontology.panel'

interface LocaleDict {
  title: string
  subtitle: string
  catalog: string
  noDomains: string
  ready: string
  incomplete: string
  hasShapes: string
  pending: string
  pipeline: string
  pipelineHint: string
}

const zh: LocaleDict = {
  title: '本体中心',
  subtitle: '业务域本体目录、一键生成 CLI 入口与发布状态。',
  catalog: '业务域目录',
  noDomains: '尚未注册任何本体业务域，执行 generate-ontology.ts 开始构建。',
  ready: '就绪',
  incomplete: '待完善',
  hasShapes: '含 SHACL',
  pending: '待确认候选',
  pipeline: '离线流水线',
  pipelineHint: '一键生成、人工确认、发布三个步骤通过 CLI 完成；修改 ontology-store/registry.json 后刷新页面可自动反映最新目录。',
}

const en: LocaleDict = {
  title: 'Ontology Center',
  subtitle: 'Business-domain ontology catalog, CLI entry points, and publish status.',
  catalog: 'Domain catalog',
  noDomains: 'No ontology domains registered yet — run generate-ontology.ts to start.',
  ready: 'Ready',
  incomplete: 'Incomplete',
  hasShapes: 'with SHACL',
  pending: 'pending candidates',
  pipeline: 'Offline pipeline',
  pipelineHint: 'One-shot generation, human confirm, publish — all driven through CLI. Edit ontology-store/registry.json and reload to reflect the latest catalog.',
}

/** Static catalog bundled with the panel — mirrors the shipped ontology-store. */
const STATIC_CATALOG: OntologyDomainRow[] = [
  { id: 'contract', label: '合同管理', ready: true, version: '0.1.0', hasShapes: true, pendingCandidates: 0 },
  { id: 'procurement', label: '采购管理', ready: true, version: null, hasShapes: false, pendingCandidates: 0 },
]

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    [NS]: keyof LocaleDict
  }
}

/** Required client services. */
export const inject = ['slots', 'locale']

/** Panel id kept as plain string so it matches the cordis.patch.yml entry. */
const PANEL_ID = 'ontology'

/**
 * Register the ontology catalog panel — sidebar row + main page.
 *
 * @param ctx - Client root context with slots + locale merged in.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ontology-panel: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ domains: STATIC_CATALOG, t }),
  }, OntologyPanel))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 90,
    locale: NS,
    label: () => t('title'),
  }, OntologyIcon))
}
