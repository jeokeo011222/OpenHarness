/**
 * Shared types for the mapping editor.
 * Keep aligned with erp-connector's src/types.ts — this editor writes
 * JSON that erp-connector consumes verbatim.
 */

export type TransformKind = 'identity' | 'date_format' | 'enum_map'

export interface TransformerSpec {
  kind: TransformKind
  format?: string
  map?: Record<string, string>
}

export interface ParamMapping {
  from: string
  to: string
  transform?: TransformerSpec
}

export interface ActionMapping {
  domain: string
  action: string
  erp: string
  api: string
  params: ParamMapping[]
}

export interface MappingConfigFile {
  version: number
  mappings: ActionMapping[]
  defaultAdapterByFamily?: Record<string, string>
}

/** Known ERP families — editor's dropdown. */
export const ERP_OPTIONS = ['yonyou', 'kingdee'] as const

/** Fixed list of transform kinds — no free-form scripts. */
export const TRANSFORM_OPTIONS: TransformKind[] = ['identity', 'date_format', 'enum_map']

/** Ontology-side action with its parameters (parsed from summary.md or ontology.ttl). */
export interface OntologyAction {
  domain: string
  name: string
  params: Array<{ name: string; type: string; required?: boolean }>
}
