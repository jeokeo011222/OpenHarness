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

/**
 * One resource a grant may name, contributed by the business package that owns
 * the kind. The workbench renders these as a dictionary instead of asking the
 * administrator to type an id from memory.
 */
export interface AccountResourceEntry {
  /** Resource id stored on the grant. */
  readonly id: string
  /** Human label for the id; defaults to the id itself. */
  readonly label?: string
}

/**
 * One business package's resource dictionary: the ids of the kind it owns.
 *
 * A kind with no source still appears in the dictionary as soon as a grant
 * names it, so an existing grant never becomes un-editable.
 */
export interface AccountResourceSource {
  /** Resource kind, e.g. `ontology-domain`. */
  readonly kind: string
  /** Human label for the kind; defaults to the kind itself. */
  readonly label?: string
  /**
   * List the ids of this kind that exist right now.
   * @returns the entries the administrator may grant.
   */
  list(): Promise<readonly AccountResourceEntry[]>
}

/** Registry of per-kind resource dictionaries. */
export interface AccountResourceCatalog {
  /**
   * Contribute the dictionary of one resource kind.
   * @param source - Kind, label, and the id list it can enumerate.
   * @returns a disposer removing the contribution.
   */
  register(source: AccountResourceSource): () => void
}

/**
 * The dictionary an administration surface renders: every kind that can be
 * granted, and the ids behind each of them.
 */
export interface AccountResourceDictionary {
  readonly kinds: readonly { readonly kind: string; readonly label: string; readonly count: number }[]
  readonly resources: Readonly<Record<string, readonly AccountResourceEntry[]>>
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
