/**
 * Editor state — Zustand store.
 *
 * State is split per-mapping (current mapping being edited) so side-by-side
 * editing of multiple mappings doesn't corrupt each other. The full config
 * is recomputed by reconstructing all mappings from their individual states.
 */

import { create } from 'zustand'
import type { ActionMapping, MappingConfigFile, ParamMapping, TransformerSpec } from './types.ts'
import { INITIAL_CONFIG } from './data.ts'

interface EditorState {
  /** Full mapping config (what we're building towards). */
  config: MappingConfigFile
  /** Index of the mapping currently being edited (-1 = adding new). */
  activeIdx: number
  /** The editable draft of the active mapping. */
  draft: ActionMapping | null

  // ---- Actions ----
  setActive: (idx: number) => void
  createNew: () => void
  updateDraft: (patch: Partial<ActionMapping>) => void
  updateDraftParam: (idx: number, patch: Partial<ParamMapping>) => void
  addDraftParam: () => void
  removeDraftParam: (idx: number) => void
  updateDraftTransformer: (idx: number, transformer: TransformerSpec | undefined) => void
  saveDraft: () => void
  deleteMapping: (idx: number) => void
  reset: () => void
  exportJson: () => string
}

const emptyDraft = (): ActionMapping => ({
  domain: '', action: '', erp: '', api: '', params: [],
})

export const useEditorStore = create<EditorState>((set, get) => ({
  config: { ...INITIAL_CONFIG, mappings: INITIAL_CONFIG.mappings.map(m => ({ ...m, params: m.params.map(p => ({ ...p, transform: p.transform ? { ...p.transform, map: p.transform.map ? { ...p.transform.map } : undefined } : undefined })) })) },
  activeIdx: 0,
  draft: { ...INITIAL_CONFIG.mappings[0], params: INITIAL_CONFIG.mappings[0].params.map(p => ({ ...p, transform: p.transform ? { ...p.transform, map: p.transform.map ? { ...p.transform.map } : undefined } : undefined })) },

  setActive: (idx) => set(s => ({
    activeIdx: idx,
    draft: idx >= 0 && idx < s.config.mappings.length
      ? { ...s.config.mappings[idx], params: s.config.mappings[idx].params.map(p => ({ ...p, transform: p.transform ? { ...p.transform, map: p.transform.map ? { ...p.transform.map } : undefined } : undefined })) }
      : emptyDraft(),
  })),

  createNew: () => set(s => ({
    activeIdx: -1,
    draft: { ...emptyDraft(), domain: s.config.mappings[0]?.domain ?? '' },
  })),

  updateDraft: (patch) => set(s => ({ draft: s.draft ? { ...s.draft, ...patch } : null })),

  updateDraftParam: (idx, patch) => set(s => {
    if (!s.draft) return {}
    const params = [...s.draft.params]
    params[idx] = { ...params[idx], ...patch }
    return { draft: { ...s.draft, params } }
  }),

  addDraftParam: () => set(s => {
    if (!s.draft) return {}
    return { draft: { ...s.draft, params: [...s.draft.params, { from: '', to: '', transform: undefined }] } }
  }),

  removeDraftParam: (idx) => set(s => {
    if (!s.draft) return {}
    const params = s.draft.params.filter((_, i) => i !== idx)
    return { draft: { ...s.draft, params } }
  }),

  updateDraftTransformer: (idx, transformer) => set(s => {
    if (!s.draft) return {}
    const params = [...s.draft.params]
    params[idx] = { ...params[idx], transform: transformer }
    return { draft: { ...s.draft, params } }
  }),

  saveDraft: () => set(s => {
    if (!s.draft) return {}
    // Validate
    if (!s.draft.domain || !s.draft.action || !s.draft.erp || !s.draft.api) {
      console.warn('Missing required fields — cannot save')
      return {}
    }
    const config = { ...s.config, mappings: [...s.config.mappings] }
    if (s.activeIdx === -1) {
      config.mappings.push({ ...s.draft })
      return { config, activeIdx: config.mappings.length - 1 }
    }
    config.mappings[s.activeIdx] = { ...s.draft }
    return { config, draft: null }
  }),

  deleteMapping: (idx) => set(s => {
    const config = { ...s.config, mappings: s.config.mappings.filter((_, i) => i !== idx) }
    const newIdx = Math.max(0, idx - 1)
    const nextDraft = config.mappings[newIdx]
      ? { ...config.mappings[newIdx], params: config.mappings[newIdx].params.map(p => ({ ...p })) }
      : emptyDraft()
    return { config, activeIdx: config.mappings.length > 0 ? newIdx : -1, draft: config.mappings.length > 0 ? nextDraft : emptyDraft() }
  }),

  reset: () => set(() => ({
    config: JSON.parse(JSON.stringify(INITIAL_CONFIG)),
    activeIdx: 0,
    draft: { ...INITIAL_CONFIG.mappings[0], params: INITIAL_CONFIG.mappings[0].params.map(p => ({ ...p })) },
  })),

  exportJson: () => JSON.stringify(get().config, null, 2),
}))
