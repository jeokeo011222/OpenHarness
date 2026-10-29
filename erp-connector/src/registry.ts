/**
 * Adapter registry.
 *
 * The router never constructs adapters — it consumes them via the registry,
 * which lets adapters be registered at runtime (e.g. by the visualization
 * editor or by tests injecting mocks).
 *
 * Thread-safety: single-process, single-threaded Node — Map is fine.
 */

import type { ErpAdapter } from './types.js'

const registry = new Map<string, ErpAdapter>()

/** Register an adapter. Overwrites an existing adapter of the same name. */
export function registerAdapter(adapter: ErpAdapter): void {
  registry.set(adapter.name, adapter)
}

/** Remove a previously-registered adapter (primarily for tests). */
export function unregisterAdapter(name: string): void {
  registry.delete(name)
}

/** Look up a concrete adapter by name. Returns undefined when not found. */
export function getAdapter(name: string): ErpAdapter | undefined {
  return registry.get(name)
}

/** List the names of all registered adapters (for diagnostics). */
export function listAdapterNames(): string[] {
  return [...registry.keys()]
}

/** Reset all registrations — test utility. */
export function clearRegistry(): void {
  registry.clear()
}
