import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { accountDomainSpec, ACCOUNT_ROLES, grantKey, grantRecord, userRecord } from '../src/spec.ts'
import type { UserId } from '../src/types.ts'

describe('account domain', () => {
  it('declares the account tables at their first version', () => {
    expect(accountDomainSpec.name).toBe('account')
    expect(accountDomainSpec.version).toBe(1)
    expect(Object.keys(accountDomainSpec.tables)).toEqual(['users', 'grants'])
  })

  it('accepts only the declared role names', () => {
    expect(ACCOUNT_ROLES).toEqual(['owner', 'author', 'reviewer', 'publisher', 'viewer'])
    expect(grantRecord.safeParse({
      userId: 'u1',
      resourceKind: 'ontology-domain',
      resourceId: 'd1',
      roles: ['owner', 'reviewer'],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }).success).toBe(true)
    expect(grantRecord.safeParse({
      userId: 'u1',
      resourceKind: 'ontology-domain',
      resourceId: 'd1',
      roles: ['administrator'],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }).success).toBe(false)
  })

  it('validates the stored account record', () => {
    expect(userRecord.safeParse({
      username: 'alice',
      displayName: 'Alice',
      roles: ['admin'],
      password: 'scrypt$16384$8$1$c2FsdA$aGFzaA',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }).success).toBe(true)
    expect(userRecord.safeParse({
      username: 'alice',
      displayName: 'Alice',
      roles: ['editor'],
      password: 'x',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }).success).toBe(false)
  })
})

describe('grantKey', () => {
  it('keeps resource ids unambiguous', () => {
    const userId = brandString<UserId>('account-1')
    expect(grantKey(userId, 'a', 'b|c')).toBe('["account-1","a","b|c"]')
    expect(grantKey(userId, 'a', 'b')).not.toBe(grantKey(userId, 'ab', ''))
  })
})
