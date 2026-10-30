/**
 * Account domain declaration: user records, grant records, and the schemas
 * guarding the shipped format at the durable boundary.
 * @module @deepseek-ai/dsh-account-directory/src/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { UserId } from './types.ts'

/** Account id schema at the durable boundary; branding has no runtime representation. */
const userId = z.string().transform(value => brandString<UserId>(value))

/** Every role name a grant may hold on one resource. */
export const ACCOUNT_ROLES = ['owner', 'author', 'reviewer', 'publisher', 'viewer'] as const

/** Role names a grant may hold on one resource. */
export type AccountRole = (typeof ACCOUNT_ROLES)[number]

/** Global role names this build accepts; they gate the administrative surface only. */
export const GLOBAL_ROLES = ['admin'] as const

/** Global roles: they gate the administrative surface, not resource access. */
export type GlobalRole = (typeof GLOBAL_ROLES)[number]

const globalRole = z.enum(GLOBAL_ROLES)

const accountRole = z.enum(ACCOUNT_ROLES)

/** Durable shape of one account. `password` holds the scrypt verifier, never the password. */
export const userRecord = z.object({
  username: z.string(),
  displayName: z.string(),
  roles: z.array(globalRole),
  password: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** One stored account record. */
export type StoredUser = z.infer<typeof userRecord>

/** Durable shape of one grant. */
export const grantRecord = z.object({
  userId,
  resourceKind: z.string(),
  resourceId: z.string(),
  roles: z.array(accountRole),
  updatedAt: z.string(),
})

/** One stored grant record with the account id branded. */
export type StoredGrant = Omit<z.infer<typeof grantRecord>, 'userId'> & { readonly userId: UserId }

/** Grant table key: a JSON array keeps arbitrary resource ids unambiguous. */
export type GrantKey = string

/**
 * Serialize one grant key.
 * @param userId - account the grant belongs to.
 * @param resourceKind - resource kind the grant covers.
 * @param resourceId - resource id inside its kind.
 * @returns the unambiguous table key.
 */
export function grantKey(userId: UserId, resourceKind: string, resourceId: string): GrantKey {
  return JSON.stringify([userId, resourceKind, resourceId])
}

/**
 * The account domain spec: accounts keyed by {@link UserId} plus grants keyed
 * by the serialized `(user, kind, id)` triple.
 */
export const accountDomainSpec = defineDomain({
  name: 'account',
  version: 1,
  tables: {
    users: domainTable<UserId, StoredUser>(userRecord),
    grants: domainTable<GrantKey, StoredGrant>(grantRecord),
  },
})
