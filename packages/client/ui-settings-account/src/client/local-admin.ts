/** Probe of the local account-directory session, used for the admin-console entry. */
/** Shape of the account-directory `/auth/state` response the menu consumes. */
interface LocalAccountState {
  readonly signedIn: boolean
  readonly account?: { readonly roles?: readonly string[] }
}

/**
 * Reports whether the browser's local account session holds the global admin role.
 * Any failure (desktop shell, offline probe, malformed response) reads as no entry.
 * @returns true when the admin console should be offered.
 */
export async function fetchLocalAdmin(): Promise<boolean> {
  try {
    const response = await fetch('auth/state', { headers: { accept: 'application/json' } })
    if (!response.ok) return false
    return isAdminState(await response.json())
  } catch {
    return false
  }
}

/** Type guard for the narrow slice of `/auth/state` this probe relies on. */
function isAdminState(state: unknown): state is LocalAccountState {
  if (typeof state !== 'object' || state === null) return false
  const candidate = state as Record<string, unknown>
  if (candidate.signedIn !== true) return false
  const account = candidate.account
  if (typeof account !== 'object' || account === null) return false
  const roles = (account as Record<string, unknown>).roles
  return Array.isArray(roles) && roles.includes('admin')
}
