import type { ReactNode } from 'react'

/** One business domain surfaced in the store. */
export interface OntologyDomainRow {
  id: string
  label: string
  ready: boolean
  version: string | null
  hasShapes: boolean
  pendingCandidates: number
}

/**
 * Props received from the `main` slot. The slot system composes
 * `inject()` return value + locale translation + injected face props.
 * We declare the minimal shape we actually read back.
 */
export interface OntologyPanelInjected {
  domains: readonly OntologyDomainRow[]
  /** Locale translate — we pass through whatever the slot system gives us. */
  t: (key: never) => string
}

/**
 * Ontology generator panel — renders a static business-domain catalog and
 * documents the offline CLI pipeline (generate → confirm → publish).
 *
 * @param props - composed slot props: domains from inject(), locale t().
 */
export function OntologyPanel(props: OntologyPanelInjected): ReactNode {
  const { domains, t } = props
  // Widen t to accept the literal locale keys we pass below.
  const tr = (k: string): string => t(k as never)

  return (
    <div style={{ padding: '20px', fontFamily: 'var(--dsw-font-ui, system-ui)' }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{tr('title')}</h1>
        <p style={{ color: 'var(--dsw-text-muted, #6b7280)', marginTop: 4, fontSize: 13 }}>{tr('subtitle')}</p>
      </header>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 10px 0' }}>{tr('catalog')}</h2>
        {domains.length === 0 ? (
          <p style={{ color: 'var(--dsw-text-muted, #6b7280)', fontSize: 13 }}>{tr('noDomains')}</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {domains.map(domain => (
              <li
                key={domain.id}
                style={{
                  border: '1px solid var(--dsw-border-default, #e5e7eb)',
                  borderRadius: 8,
                  padding: '12px 16px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: domain.ready ? 'transparent' : 'var(--dsw-surface-muted, #f9fafb)',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{domain.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--dsw-text-muted, #6b7280)', marginTop: 2 }}>
                    {domain.id}
                    {domain.hasShapes && ` · ${tr('hasShapes')}`}
                    {domain.version ? ` · v${domain.version}` : ''}
                    {domain.pendingCandidates > 0 && ` · ${domain.pendingCandidates} ${tr('pending')}`}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: domain.ready ? 'var(--dsw-surface-success, #dcfce7)' : 'var(--dsw-surface-muted, #e5e7eb)',
                    color: domain.ready ? 'var(--dsw-text-success, #166534)' : 'var(--dsw-text-muted, #6b7280)',
                  }}
                >
                  {domain.ready ? tr('ready') : tr('incomplete')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 10px 0' }}>{tr('pipeline')}</h2>
        <ol style={{ paddingLeft: 20, fontSize: 13, color: 'var(--dsw-text-primary, #111827)', lineHeight: 1.9 }}>
          <li>
            <code>pnpm exec tsx ontology-store/scripts/generate-ontology.ts --domain {'{name}'} --source {'{policy.md}'} --skeleton ontology-store/{'{name}'}/ontology.ttl</code>
            <span style={{ color: 'var(--dsw-text-muted, #6b7280)' }}> — 生成 .ttl 候选 + Markdown 确认报告</span>
          </li>
          <li>
            <code>pnpm exec tsx ontology-store/scripts/confirm-ontology.ts --approve {'{'}your-name{'}'} --candidate {'{path}'}</code>
            <span style={{ color: 'var(--dsw-text-muted, #6b7280)' }}> — 双 SHACL 校验 + versions/ 快照</span>
          </li>
          <li>
            <code>pnpm exec tsx ontology-store/scripts/publish-ontology.ts --domain {'{name}'}</code>
            <span style={{ color: 'var(--dsw-text-muted, #6b7280)' }}> — 发布到当前生效版本</span>
          </li>
        </ol>
        <p style={{ fontSize: 12, color: 'var(--dsw-text-muted, #6b7280)', marginTop: 8 }}>
          {tr('pipelineHint')}
        </p>
      </section>
    </div>
  )
}
