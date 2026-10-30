/**
 * Account vocabulary shared by the directory service, its HTTP surface, and
 * business packages that contribute resource ACL rules.
 * @module @deepseek-ai/dsh-account-directory/types
 */

import type { RemoteAccessBinding, RemoteAccessResourceKind } from '@deepseek-ai/dsh-api-remote-access'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AccountRole, GlobalRole } from './spec.ts'

export type { AccountRole, GlobalRole } from './spec.ts'

/** Durable account identity; the cookie and grant tables carry only this. */
export type UserId = Branded<'UserId'>

/** One account without its password hash. */
export interface AccountSummary {
  readonly id: UserId
  readonly username: string
  readonly displayName: string
  readonly roles: readonly GlobalRole[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** Roles one account holds on one resource. */
export interface GrantRecord {
  readonly userId: UserId
  readonly resourceKind: string
  readonly resourceId: string
  readonly roles: readonly AccountRole[]
  readonly updatedAt: string
}

/**
 * One business package's contribution: how a stored grant becomes Remote access
 * bindings for its resource kind.
 */
export interface AccountAclRule {
  /** Resource kind declared by the contributing package through `ctx.typert.resources`. */
  readonly kind: RemoteAccessResourceKind
  /**
   * Bindings contributed by one stored grant.
   * @param resourceId - Resource id stored on the grant.
   * @param roles - Role names the grant holds on that resource.
   * @returns the bindings that grant entitles; unknown roles contribute nothing.
   */
  bind(resourceId: string, roles: readonly AccountRole[]): readonly RemoteAccessBinding[]
}

/** Registry of per-kind grant rules and baseline bindings. */
export interface AccountAcl {
  /**
   * Contribute the grant rule of one resource kind.
   * @param rule - Rule binding stored grants to Remote access bindings.
   * @returns a disposer removing the rule.
   */
  register(rule: AccountAclRule): () => void
  /**
   * Contribute bindings every signed-in account holds regardless of grants.
   * @param bindings - Builds the baseline for one account.
   * @returns a disposer removing the contribution.
   */
  registerBaseline(bindings: (userId: UserId) => readonly RemoteAccessBinding[]): () => void
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** A signed browser session of a local account. */
    user: { readonly kind: 'user'; readonly userId: UserId }
  }
}
