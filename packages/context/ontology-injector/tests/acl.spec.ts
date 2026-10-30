import { describe, expect, it } from 'vitest'
import { ONTOLOGY_BASELINE, ontologyDomainBindings, ontologyDomainOf } from '../src/acl.ts'

function actionsFor(roles: Parameters<typeof ontologyDomainBindings>[1]): readonly string[] {
  const bindings = ontologyDomainBindings('d1', roles)
  return bindings.flatMap(binding => Array.from(binding.role.actions))
}

describe('ontology-domain bindings', () => {
  it('grants readers only the read endpoints', () => {
    const actions = actionsFor(['viewer'])
    expect(actions).toContain('ontologyStore/graph')
    expect(actions).toContain('ontologyStore/queryDomain')
    expect(actions).not.toContain('ontologyStore/generate')
    expect(actions).not.toContain('ontologyStore/submitReview')
    expect(actions).not.toContain('ontologyStore/publishVersion')
  })

  it('separates drafting, review, and publication', () => {
    expect(actionsFor(['author'])).toContain('ontologyStore/applyPatch')
    expect(actionsFor(['author'])).not.toContain('ontologyStore/submitReview')
    expect(actionsFor(['reviewer'])).toContain('ontologyStore/submitReview')
    expect(actionsFor(['reviewer'])).not.toContain('ontologyStore/publishVersion')
    expect(actionsFor(['publisher'])).toContain('ontologyStore/publishVersion')
    expect(actionsFor(['publisher'])).not.toContain('ontologyStore/generate')
  })

  it('grants owners domain and version management', () => {
    const actions = actionsFor(['owner'])
    expect(actions).toContain('ontologyStore/updateDomain')
    expect(actions).toContain('ontologyStore/deleteDomain')
    expect(actions).toContain('ontologyStore/deleteVersion')
    expect(actions).toContain('ontologyStore/publishVersion')
  })

  it('grants readers analytics reads and reserves instance writes for authors and owners', () => {
    expect(actionsFor(['viewer'])).toContain('ontologyStore/runMetric')
    expect(actionsFor(['viewer'])).toContain('ontologyStore/drilldownMetric')
    expect(actionsFor(['viewer'])).not.toContain('ontologyStore/importInstances')
    expect(actionsFor(['author'])).toContain('ontologyStore/importInstances')
    expect(actionsFor(['author'])).not.toContain('ontologyStore/deleteInstanceBatch')
    expect(actionsFor(['publisher'])).toContain('ontologyStore/explainMetric')
    expect(actionsFor(['owner'])).toContain('ontologyStore/deleteInstanceBatch')
  })

  it('binds one resource and drops roles the kind does not know', () => {
    expect(ontologyDomainBindings('d1', [])).toEqual([])
    const bindings = ontologyDomainBindings('d1', ['viewer', 'author'])
    expect(bindings).toHaveLength(1)
    expect(bindings[0]?.resource).toEqual({ kind: 'ontology-domain', id: 'd1' })
    expect(bindings[0]?.role.name).toBe('ontology-domain')
  })

  it('exposes the store-wide read surface to every signed-in account', () => {
    const actions = ONTOLOGY_BASELINE.flatMap(binding => Array.from(binding.role.actions))
    expect(actions).toContain('ontologyStore/listDomains')
    expect(actions).toContain('ontologyStore/health')
    expect(actions).toContain('ontologyStore/auditLog')
    expect(actions).not.toContain('ontologyStore/generate')
  })
})

describe('ontologyDomainOf', () => {
  it('reads a top-level or nested domain argument', () => {
    expect(ontologyDomainOf({ domain: 'd1' })).toBe('d1')
    expect(ontologyDomainOf({ request: { domain: 'd2' } })).toBe('d2')
    expect(ontologyDomainOf({ domain: '', request: { domain: 'd3' } })).toBe('d3')
  })

  it('reports no domain for store-wide calls', () => {
    expect(ontologyDomainOf({})).toBeUndefined()
    expect(ontologyDomainOf({ request: null, items: ['a'] })).toBeUndefined()
    expect(ontologyDomainOf({ request: { version: 2 } })).toBeUndefined()
  })
})
