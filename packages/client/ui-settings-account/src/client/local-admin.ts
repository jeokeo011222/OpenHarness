/** Probe of the local account-directory session, shared by the account menu and the admin workbench. */

/** Narrow shape of the account-directory `/auth/state` response the client consumes. */
export interface LocalAccountState {
  readonly signedIn: boolean
  readonly account?: { readonly username: string; readonly displayName: string; readonly roles: readonly string[] }
}

/** One resource kind the grant form offers, with how many ids it can list. */
export interface LocalAdminResourceKind {
  readonly kind: string
  readonly label: string
  readonly count?: number
}

/** One resource id inside a kind. */
export interface LocalAdminResourceEntry {
  readonly id: string
  readonly label?: string
}

/** The dictionary the permission form picks resource kinds and ids from. */
export interface LocalAdminResourceDictionary {
  readonly kinds: readonly LocalAdminResourceKind[]
  readonly resources: Readonly<Record<string, readonly LocalAdminResourceEntry[]>>
}

/** Narrow shape of the account-directory `/admin/state` response the workbench consumes. */
export interface LocalAdminState {
  readonly account: { readonly username: string; readonly displayName: string; readonly roles: readonly string[] }
  readonly accounts: readonly {
    readonly id: string
    readonly username: string
    readonly displayName: string
    readonly roles: readonly string[]
  }[]
  readonly grants: readonly {
    readonly userId: string
    readonly resourceKind: string
    readonly resourceId: string
    readonly roles: readonly string[]
  }[]
  /** Resource dictionary; absent on a Host that predates it. */
  readonly resources?: LocalAdminResourceDictionary
}

/** Whether one parsed session state carries the global admin role. */
export function isAdminState(state: LocalAccountState): boolean {
  return state.signedIn && state.account !== undefined && state.account.roles.includes('admin')
}

/**
 * Read the browser's local account session. Any failure (desktop shell, offline
 * probe, malformed response) reads as no session.
 * @returns the parsed state, or `undefined` when it cannot be read.
 */
export async function fetchLocalAccount(): Promise<LocalAccountState | undefined> {
  try {
    const response = await fetch('auth/state', { headers: { accept: 'application/json' } })
    if (!response.ok) return undefined
    const value: unknown = await response.json()
    return isAccountState(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Reports whether the browser's local account session holds the global admin role.
 * Any failure reads as no entry.
 * @returns true when the admin console should be offered.
 */
export async function fetchLocalAdmin(): Promise<boolean> {
  const state = await fetchLocalAccount()
  return state !== undefined && isAdminState(state)
}

/**
 * Read the admin workbench state. Any failure reads as unreadable.
 * @returns the parsed state, or `undefined` when the session is not an administrator's.
 */
export async function fetchAdminState(): Promise<LocalAdminState | undefined> {
  try {
    const response = await fetch('admin/state', { headers: { accept: 'application/json' } })
    if (!response.ok) return undefined
    const value: unknown = await response.json()
    return isAdminShape(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Type guard for the narrow slice of `/auth/state` this module relies on. */
function isAccountState(state: unknown): state is LocalAccountState {
  if (typeof state !== 'object' || state === null) return false
  const candidate = state as Record<string, unknown>
  if (typeof candidate.signedIn !== 'boolean') return false
  if (candidate.account === undefined) return true
  return isAccount(candidate.account)
}

/** Type guard for the narrow slice of `/admin/state` the workbench relies on. */
function isAdminShape(state: unknown): state is LocalAdminState {
  if (typeof state !== 'object' || state === null) return false
  const candidate = state as Record<string, unknown>
  if (!isAccount(candidate.account) || !Array.isArray(candidate.accounts) || !Array.isArray(candidate.grants)) return false
  if (candidate.resources !== undefined && !isResourceDictionary(candidate.resources)) return false
  return candidate.accounts.every(isAccountRecord) && candidate.grants.every(isGrantRecord)
}

/** Type guard for the resource dictionary; a malformed one reads as absent. */
function isResourceDictionary(value: unknown): value is LocalAdminResourceDictionary {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (!Array.isArray(candidate.kinds)) return false
  const resources = candidate.resources
  if (typeof resources !== 'object' || resources === null) return false
  const kindsOk = candidate.kinds.every(entry => typeof entry === 'object' && entry !== null
    && typeof (entry as Record<string, unknown>).kind === 'string')
  if (!kindsOk) return false
  return Object.values(resources).every(list => Array.isArray(list)
    && list.every(entry => typeof entry === 'object' && entry !== null && typeof entry.id === 'string'))
}

function isAccount(value: unknown): value is LocalAdminState['account'] {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.username === 'string' && typeof candidate.displayName === 'string' && Array.isArray(candidate.roles)
}

function isAccountRecord(value: unknown): value is LocalAdminState['accounts'][number] {
  return isAccount(value) && typeof (value as Record<string, unknown>).id === 'string'
}

function isGrantRecord(value: unknown): value is LocalAdminState['grants'][number] {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.userId === 'string'
    && typeof candidate.resourceKind === 'string'
    && typeof candidate.resourceId === 'string'
    && Array.isArray(candidate.roles)
}

/**
 * Submit one administrative form action and report whether the directory accepted it.
 * @param path - administrative form endpoint under the Host root.
 * @param fields - form field names and values; repeated names keep every value.
 * @returns true when the submission was accepted.
 */
export async function submitAdminForm(path: string, fields: Record<string, string | readonly string[]>): Promise<boolean> {
  const body = new URLSearchParams()
  for (const [name, value] of Object.entries(fields)) {
    for (const item of typeof value === 'string' ? [value] : value) body.append(name, item)
  }
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    return response.ok
  } catch {
    return false
  }
}
