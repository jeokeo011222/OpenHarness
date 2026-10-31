/** Admin workbench: a tabbed account list, role list, and permission grant board. */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { fetchAdminState, submitAdminForm, type LocalAdminResourceDictionary, type LocalAdminResourceEntry, type LocalAdminState } from './local-admin.ts'
import css from './AdminWorkbench.module.css'

/** Props of the admin workbench page. */
export interface AdminWorkbenchProps {
  /** Translate a dictionary key of the account namespace. */
  readonly t: TranslateNS<'settings.account'>
}

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'ready'; readonly state: LocalAdminState }

type Account = LocalAdminState['accounts'][number]
type Grant = LocalAdminState['grants'][number]
type AdminTab = 'users' | 'roles' | 'permissions'
type Dialog =
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly account: Account }
  | { readonly kind: 'delete'; readonly account: Account }
  | { readonly kind: 'permissions'; readonly account: Account }

/** Submit one account form action; resolves to whether the directory accepted it. */
type FormAction = (path: string, fields: Record<string, string | readonly string[]>) => Promise<boolean>

/** Accounts shown on one user-list page. */
const PAGE_SIZE = 15
/** Resource roles a grant may hold, in display order. */
const GRANT_ROLES = ['owner', 'author', 'reviewer', 'publisher', 'viewer'] as const
/** Option that swaps a dictionary select for a free-text input. */
const CUSTOM_OPTION = '__custom__'
/** Every role the workbench reports, with the scope it applies to. */
const ROLE_ROWS: readonly { readonly id: string; readonly scope: 'global' | 'resource' }[] = [
  { id: 'admin', scope: 'global' },
  ...GRANT_ROLES.map(id => ({ id, scope: 'resource' as const })),
]

/**
 * The kinds and ids the permission form offers.
 *
 * The Host's dictionary is authoritative, but a grant can outlive the package
 * that declared its kind, so kinds and ids named by stored grants are merged in:
 * otherwise those grants would be invisible in the form and impossible to
 * revoke without hand-crafting a request.
 * @param state - workbench state as `/admin/state` returned it.
 * @returns merged kind labels and ids.
 */
function dictionaryOf(state: LocalAdminState): LocalAdminResourceDictionary {
  const labels = new Map<string, string>()
  for (const entry of state.resources?.kinds ?? []) labels.set(entry.kind, entry.label ?? entry.kind)
  for (const grant of state.grants) if (!labels.has(grant.resourceKind)) labels.set(grant.resourceKind, grant.resourceKind)
  const resources: Record<string, LocalAdminResourceEntry[]> = {}
  for (const [kind, list] of Object.entries(state.resources?.resources ?? {})) resources[kind] = [...list]
  for (const grant of state.grants) {
    const list = resources[grant.resourceKind] ?? (resources[grant.resourceKind] = [])
    if (!list.some(entry => entry.id === grant.resourceId)) list.push({ id: grant.resourceId })
  }
  return {
    kinds: Array.from(labels, ([kind, label]) => ({ kind, label, count: resources[kind]?.length ?? 0 }))
      .sort((left, right) => left.kind.localeCompare(right.kind)),
    resources,
  }
}

/**
 * Tabbed page over the Host's `/admin/state` JSON and form routes: a paginated
 * account list, a role table, and a permission grant board.
 * @param props - copy.
 * @returns the workbench page.
 */
export function AdminWorkbench({ t }: AdminWorkbenchProps): ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [tab, setTab] = useState<AdminTab>('users')
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined)
  const reload = useCallback(async (): Promise<void> => {
    const state = await fetchAdminState()
    setPhase(state === undefined ? { kind: 'forbidden' } : { kind: 'ready', state })
  }, [])
  useEffect(() => { void reload() }, [reload])
  if (phase.kind !== 'ready') {
    return <div className={css.page}>
      <h1 className={css.title}>{t('adminTitle')}</h1>
      <p className={css.status} data-error={phase.kind === 'forbidden'}>
        {phase.kind === 'loading' ? t('adminLoading') : t('adminForbidden')}
      </p>
    </div>
  }
  const { state } = phase
  /** Run one administrative form action, then refresh the tables. */
  const act: FormAction = async (path, fields) => {
    setNotice(undefined)
    const ok = await submitAdminForm(path, fields)
    if (!ok) setNotice(t('adminError'))
    await reload()
    return ok
  }
  const closeDialog = (): void => { setDialog(undefined) }
  const totalPages = Math.max(1, Math.ceil(state.accounts.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageAccounts = state.accounts.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  return <div className={css.page}>
    <header className={css.header}>
      <h1 className={css.title}>{t('adminTitle')}</h1>
      <p className={css.description}>{t('adminDescription')}</p>
    </header>
    <nav className={css.tabs} role="tablist">
      <button type="button" role="tab" className={css.tab} aria-selected={tab === 'users'}
        onClick={() => { setTab('users') }}>
        {t('adminTabUsers')}
      </button>
      <button type="button" role="tab" className={css.tab} aria-selected={tab === 'roles'}
        onClick={() => { setTab('roles') }}>
        {t('adminTabRoles')}
      </button>
      <button type="button" role="tab" className={css.tab} aria-selected={tab === 'permissions'}
        onClick={() => { setTab('permissions') }}>
        {t('adminTabPermissions')}
      </button>
    </nav>
    {notice !== undefined && <p className={css.status} data-error="true" role="alert">{notice}</p>}
    {tab === 'users'
      ? <UsersPanel t={t} state={state} accounts={pageAccounts} page={currentPage} totalPages={totalPages}
        onPage={setPage} onCreate={() => { setDialog({ kind: 'create' }) }}
        onEdit={(account) => { setDialog({ kind: 'edit', account }) }}
        onDelete={(account) => { setDialog({ kind: 'delete', account }) }}
        onPermissions={(account) => { setDialog({ kind: 'permissions', account }) }} />
      : tab === 'roles'
        ? <RolesPanel t={t} state={state} />
        : <PermissionsPanel t={t} state={state} onAct={act} />}
    {dialog !== undefined && <DialogLayer t={t} state={state} dialog={dialog} onAct={act} onClose={closeDialog} />}
  </div>
}

/** User-list tab: toolbar, the current page of accounts, and its pagination bar. */
function UsersPanel({ t, state, accounts, page, totalPages, onPage, onCreate, onEdit, onDelete, onPermissions }: {
  t: AdminWorkbenchProps['t']
  state: LocalAdminState
  accounts: readonly Account[]
  page: number
  totalPages: number
  onPage: (page: number) => void
  onCreate: () => void
  onEdit: (account: Account) => void
  onDelete: (account: Account) => void
  onPermissions: (account: Account) => void
}): ReactNode {
  return <section className={css.card}>
    <div className={css.toolbar}>
      <h2 className={css.cardTitle}>{t('adminTabUsers')}</h2>
      <span className={css.muted}>{t('adminAccountCount', { count: state.accounts.length })}</span>
      <button type="button" className={css.button} data-primary="true" onClick={onCreate}>{t('adminAddUser')}</button>
    </div>
    <table className={css.table}>
      <thead><tr>
        <th>{t('adminUsername')}</th><th>{t('adminDisplayName')}</th><th>{t('adminAdministrator')}</th><th>{''}</th>
      </tr></thead>
      <tbody>
        {accounts.map((account) => {
          const grantCount = state.grants.filter(grant => grant.userId === account.id).length
          return <tr key={account.id}>
            <td>{account.username}</td>
            <td>{account.displayName}</td>
            <td>{account.roles.includes('admin')
              ? t('adminAdministrator')
              : <span className={css.muted}>{t('adminNotAdministrator')}</span>}</td>
            <td>
              <div className={css.actions}>
                <button type="button" className={css.button}
                  onClick={() => { onPermissions(account) }}>
                  {t('adminPermissions')}{grantCount > 0 ? ` (${grantCount})` : ''}
                </button>
                <button type="button" className={css.button} onClick={() => { onEdit(account) }}>{t('adminEdit')}</button>
                <button type="button" className={css.button} data-danger="true"
                  onClick={() => { onDelete(account) }}>{t('adminDelete')}</button>
              </div>
            </td>
          </tr>
        })}
      </tbody>
    </table>
    <div className={css.pagination}>
      <button type="button" className={css.button} disabled={page <= 1} onClick={() => { onPage(page - 1) }}>
        {t('adminPrevious')}
      </button>
      <span className={css.muted}>{t('adminPage', { page, total: totalPages })}</span>
      <button type="button" className={css.button} disabled={page >= totalPages} onClick={() => { onPage(page + 1) }}>
        {t('adminNext')}
      </button>
    </div>
  </section>
}

/** Roles tab: one row per role with its scope and holder count. */
function RolesPanel({ t, state }: {
  t: AdminWorkbenchProps['t']
  state: LocalAdminState
}): ReactNode {
  const totalHolders = new Set(state.grants.map(grant => grant.userId)).size
    + state.accounts.filter(account => account.roles.includes('admin')).length
  return <section className={css.card}>
    <div className={css.toolbar}>
      <h2 className={css.cardTitle}>{t('adminTabRoles')}</h2>
      <span className={css.muted}>{t('adminAccountCount', { count: totalHolders })}</span>
    </div>
    <table className={css.table}>
      <thead><tr>
        <th>{t('adminRoles')}</th><th>{t('adminRoleScope')}</th><th>{''}</th>
      </tr></thead>
      <tbody>
        {ROLE_ROWS.map(role => <tr key={role.id}>
          <td>
            <span className={css.roleBadge}>{role.id === 'admin' ? t('adminAdministrator') : role.id}</span>
          </td>
          <td>
            {role.scope === 'global' ? t('adminRoleScopeGlobal') : t('adminRoleScopeResource')}
          </td>
          <td>{t('adminAccountCount', { count: roleHolderCount(state, role.id) })}</td>
        </tr>)}
      </tbody>
    </table>
  </section>
}

/** Permissions tab: the grant form and the full grant table. */
function PermissionsPanel({ t, state, onAct }: {
  t: AdminWorkbenchProps['t']
  state: LocalAdminState
  onAct: FormAction
}): ReactNode {
  return <section className={css.card}>
    <div className={css.toolbar}>
      <h2 className={css.cardTitle}>{t('adminTabPermissions')}</h2>
      <span className={css.muted}>{t('adminGrants')}: {state.grants.length}</span>
    </div>
    <GrantForm t={t} accounts={state.accounts} dictionary={dictionaryOf(state)} onAct={onAct} />
    {state.grants.length === 0
      ? <p className={css.status}>{t('adminEmpty')}</p>
      : <table className={css.table}>
        <thead><tr>
          <th>{t('adminGrantTo')}</th><th>{t('adminResourceKind')}</th><th>{t('adminResourceId')}</th><th>{t('adminRoles')}</th><th>{''}</th>
        </tr></thead>
        <tbody>
          {state.grants.map(grant => <GrantRow key={`${grant.userId}/${grant.resourceKind}/${grant.resourceId}`}
            t={t} grant={grant} state={state} onAct={onAct} />)}
        </tbody>
      </table>}
  </section>
}

/** Number of accounts holding one role: the admin flag, or any grant carrying the resource role. */
function roleHolderCount(state: LocalAdminState, roleId: string): number {
  if (roleId === 'admin') return state.accounts.filter(account => account.roles.includes('admin')).length
  const holders = new Set(state.grants.filter(grant => grant.roles.includes(roleId)).map(grant => grant.userId))
  return holders.size
}

/** One grant row: its account, resource, role set, and the revoke button. */
function GrantRow({ t, grant, state, onAct }: {
  t: AdminWorkbenchProps['t']
  grant: Grant
  state: LocalAdminState
  onAct: FormAction
}): ReactNode {
  const name = state.accounts.find(account => account.id === grant.userId)?.username ?? grant.userId
  return <tr>
    <td>{name}</td>
    <td>{grant.resourceKind}</td>
    <td className={css.muted}>{grant.resourceId}</td>
    <td>{grant.roles.join(', ')}</td>
    <td>
      <button type="button" className={css.button} data-danger="true"
        onClick={() => { void onAct('admin/grant/delete', {
          userId: grant.userId, resourceKind: grant.resourceKind, resourceId: grant.resourceId,
        }) }}>
        {t('adminDelete')}
      </button>
    </td>
  </tr>
}

/** The one dialog surface, dispatching on its kind. */
function DialogLayer({ t, state, dialog, onAct, onClose }: {
  t: AdminWorkbenchProps['t']
  state: LocalAdminState
  dialog: Dialog
  onAct: FormAction
  onClose: () => void
}): ReactNode {
  const label = dialog.kind === 'create'
    ? t('adminAddUser')
    : dialog.kind === 'edit' ? t('adminEditUser')
      : dialog.kind === 'delete' ? t('adminDeleteUser', { name: dialog.account.username })
        : t('adminUserPermissions', { name: dialog.account.username })
  return <div className={css.overlay} role="presentation"
    onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
    <div className={css.dialog} role="dialog" aria-modal="true" aria-label={label}>
      {dialog.kind === 'delete'
        ? <DeleteDialog t={t} account={dialog.account} onAct={onAct} onClose={onClose} />
        : dialog.kind === 'permissions'
          ? <PermissionsDialog t={t} state={state} account={dialog.account} onAct={onAct} onClose={onClose} />
          : <AccountDialog t={t} account={dialog.kind === 'edit' ? dialog.account : undefined}
            onAct={onAct} onClose={onClose} />}
    </div>
  </div>
}

/** Create or edit dialog: the same fields, with the username fixed while editing. */
function AccountDialog({ t, account, onAct, onClose }: {
  t: AdminWorkbenchProps['t']
  account: Account | undefined
  onAct: FormAction
  onClose: () => void
}): ReactNode {
  const creating = account === undefined
  const [username, setUsername] = useState(account?.username ?? '')
  const [displayName, setDisplayName] = useState(account?.displayName ?? '')
  const [password, setPassword] = useState('')
  const [admin, setAdmin] = useState(account?.roles.includes('admin') ?? false)
  const canSubmit = username.trim() !== '' && (!creating || password !== '')
  const submit = (): Promise<boolean> => account === undefined
    ? onAct('admin/user/create', { username, displayName, password, admin: admin ? '1' : '0' })
    : onAct('admin/user/update', {
      userId: account.id,
      admin: admin ? '1' : '0',
      displayName,
      ...(password === '' ? {} : { password }),
    })
  return <form className={css.dialogBody} onSubmit={(event) => {
    event.preventDefault()
    if (!canSubmit) return
    void submit().then((ok) => { if (ok) onClose() })
  }}>
    <h2 className={css.dialogTitle}>{creating ? t('adminAddUser') : t('adminEditUser')}</h2>
    {creating
      ? <label className={css.field}><span>{t('adminUsername')}</span>
        <input className={css.input} value={username} required autoFocus
          onChange={(event) => { setUsername(event.target.value) }} />
      </label>
      : <div className={css.field}><span>{t('adminUsername')}</span>
        <span className={css.muted}>{username}</span>
      </div>}
    <label className={css.field}><span>{t('adminDisplayName')}</span>
      <input className={css.input} value={displayName}
        onChange={(event) => { setDisplayName(event.target.value) }} />
    </label>
    <label className={css.field}><span>{creating ? t('adminPassword') : t('adminNewPassword')}</span>
      <input className={css.input} type="password" value={password} required={creating}
        placeholder={t('adminPasswordHint')}
        onChange={(event) => { setPassword(event.target.value) }} />
    </label>
    <label className={css.checkbox}>
      <input type="checkbox" checked={admin} onChange={(event) => { setAdmin(event.target.checked) }} />
      <span>{t('adminAdministrator')}</span>
    </label>
    <div className={css.dialogActions}>
      <button type="button" className={css.button} onClick={onClose}>{t('adminCancel')}</button>
      <button type="submit" className={css.button} data-primary="true" disabled={!canSubmit}>
        {creating ? t('adminCreate') : t('adminSave')}
      </button>
    </div>
  </form>
}

/** Delete confirmation: names the account and states the consequence. */
function DeleteDialog({ t, account, onAct, onClose }: {
  t: AdminWorkbenchProps['t']
  account: Account
  onAct: FormAction
  onClose: () => void
}): ReactNode {
  return <div className={css.dialogBody}>
    <h2 className={css.dialogTitle}>{t('adminDeleteUser', { name: account.username })}</h2>
    <p className={css.description}>{t('adminDeleteHint')}</p>
    <div className={css.dialogActions}>
      <button type="button" className={css.button} onClick={onClose}>{t('adminCancel')}</button>
      <button type="button" className={css.button} data-danger="true"
        onClick={() => {
          void onAct('admin/user/delete', { userId: account.id }).then((ok) => { if (ok) onClose() })
        }}>
        {t('adminDelete')}
      </button>
    </div>
  </div>
}

/**
 * The resource half of a grant form: a kind select filled from the Host's
 * dictionary, and an id select for whatever that kind can enumerate.
 *
 * Both fields keep an explicit "custom" option, because a resource created a
 * minute ago — or in a package that has no dictionary — is still legitimate.
 * The point of the dictionary is that the common case never asks an operator to
 * retype an id, not that an unknown id becomes impossible.
 * @param props - copy, current values, and the dictionary.
 * @returns the kind and id fields.
 */
function GrantFields({ t, dictionary, kind, resourceId, onKind, onId }: {
  t: AdminWorkbenchProps['t']
  dictionary: LocalAdminResourceDictionary
  kind: string
  resourceId: string
  onKind: (kind: string) => void
  onId: (id: string) => void
}): ReactNode {
  const [typedKind, setTypedKind] = useState(false)
  const [typedId, setTypedId] = useState(false)
  const entries = dictionary.resources[kind] ?? []
  return <>
    <label className={css.field}><span>{t('adminResourceKind')}</span>
      {typedKind
        ? <div className={css.inlineField}>
          <input className={css.input} value={kind} onChange={(event) => { onKind(event.target.value) }} />
          <button type="button" className={css.button}
            onClick={() => { setTypedKind(false); onKind(''); onId(''); setTypedId(false) }}>
            {t('adminResourcePickKind')}
          </button>
        </div>
        : <select className={css.input} value={kind} onChange={(event) => {
          if (event.target.value === CUSTOM_OPTION) {
            setTypedKind(true)
            onKind('')
            onId('')
            setTypedId(false)
            return
          }
          onKind(event.target.value)
          onId('')
          setTypedId(false)
        }}>
          <option value="">{t('adminResourcePickKind')}</option>
          {dictionary.kinds.map(entry => <option key={entry.kind} value={entry.kind}>{entry.label}</option>)}
          <option value={CUSTOM_OPTION}>{t('adminResourceCustom')}</option>
        </select>}
    </label>
    <label className={css.field}><span>{t('adminResourceId')}</span>
      {typedId || entries.length === 0
        ? <input className={css.input} value={resourceId} aria-label={t('adminResourceId')}
          placeholder={entries.length === 0 ? t('adminResourceNoIds') : undefined}
          onChange={(event) => { onId(event.target.value) }} />
        : <select className={css.input} value={resourceId} onChange={(event) => {
          if (event.target.value === CUSTOM_OPTION) {
            setTypedId(true)
            onId('')
            return
          }
          onId(event.target.value)
        }}>
          <option value="">{t('adminResourcePickId')}</option>
          {entries.map(entry => <option key={entry.id} value={entry.id}>{entry.label ?? entry.id}</option>)}
          <option value={CUSTOM_OPTION}>{t('adminResourceCustom')}</option>
        </select>}
    </label>
  </>
}

/**
 * Per-user permissions dialog: lists the account's existing grants with revoke
 * buttons, and a compact grant form below (userId pre-filled) to add new ones.
 */
function PermissionsDialog({ t, state, account, onAct, onClose }: {
  t: AdminWorkbenchProps['t']
  state: LocalAdminState
  account: Account
  onAct: FormAction
  onClose: () => void
}): ReactNode {
  const [resourceKind, setResourceKind] = useState('')
  const [resourceId, setResourceId] = useState('')
  const [roles, setRoles] = useState<readonly string[]>([])
  const userGrants = state.grants.filter(grant => grant.userId === account.id)
  const canAddGrant = resourceKind.trim() !== '' && resourceId.trim() !== '' && roles.length > 0
  return <div className={css.dialogBody}>
    <h2 className={css.dialogTitle}>{t('adminUserPermissions', { name: account.username })}</h2>
    <p className={css.status} data-error={false}>{account.roles.includes('admin') ? t('adminAdministrator') : t('adminNotAdministrator')}</p>
    {userGrants.length === 0
      ? <p className={css.status}>{t('adminNoGrants')}</p>
      : <table className={css.table}>
        <thead><tr>
          <th>{t('adminResourceKind')}</th><th>{t('adminResourceId')}</th><th>{t('adminRoles')}</th><th>{''}</th>
        </tr></thead>
        <tbody>
          {userGrants.map(grant => <tr key={`${grant.resourceKind}/${grant.resourceId}`}>
            <td>{grant.resourceKind}</td>
            <td className={css.muted}>{grant.resourceId}</td>
            <td>{grant.roles.join(', ')}</td>
            <td>
              <button type="button" className={css.button} data-danger="true"
                onClick={() => { void onAct('admin/grant/delete', {
                  userId: account.id, resourceKind: grant.resourceKind, resourceId: grant.resourceId,
                }) }}>
                {t('adminDelete')}
              </button>
            </td>
          </tr>)}
        </tbody>
      </table>}
    <form className={css.inlineForm} onSubmit={(event) => {
      event.preventDefault()
      if (!canAddGrant) return
      void onAct('admin/grant/set', { userId: account.id, resourceKind, resourceId, roles })
      setResourceKind(''); setResourceId(''); setRoles([])
    }}>
      <GrantFields t={t} dictionary={dictionaryOf(state)} kind={resourceKind} resourceId={resourceId}
        onKind={(next) => { setResourceKind(next) }}
        onId={(next) => { setResourceId(next) }} />
      <fieldset className={css.field}><span>{t('adminRoles')}</span>
        <div className={css.roles}>
          {GRANT_ROLES.map(role => <label key={role} className={css.checkbox}>
            <input type="checkbox" checked={roles.includes(role)}
              onChange={(event) => { setRoles(event.target.checked ? [...roles, role] : roles.filter(other => other !== role)) }} />
            <span>{role}</span>
          </label>)}
        </div>
      </fieldset>
      <button type="submit" className={css.button} data-primary="true" disabled={!canAddGrant}>{t('adminSetGrant')}</button>
    </form>
    <div className={css.dialogActions}>
      <button type="button" className={css.button} onClick={onClose}>{t('adminCancel')}</button>
    </div>
  </div>
}

/** Set-grant form: one account, one resource, and the role set replacing its previous grant. */
function GrantForm({ t, accounts, dictionary, onAct }: {
  t: AdminWorkbenchProps['t']
  accounts: LocalAdminState['accounts']
  dictionary: LocalAdminResourceDictionary
  onAct: FormAction
}): ReactNode {
  const [userId, setUserId] = useState('')
  const [resourceKind, setResourceKind] = useState('')
  const [resourceId, setResourceId] = useState('')
  const [roles, setRoles] = useState<readonly string[]>([])
  return <form className={css.inlineForm} onSubmit={(event) => {
    event.preventDefault()
    if (userId === '' || resourceKind.trim() === '' || resourceId.trim() === '' || roles.length === 0) return
    void onAct('admin/grant/set', { userId, resourceKind, resourceId, roles })
    setResourceKind(''); setResourceId(''); setRoles([])
  }}>
    <label className={css.field}><span>{t('adminGrantTo')}</span>
      <select className={css.input} value={userId} onChange={(event) => { setUserId(event.target.value) }}>
        <option value=""></option>
        {accounts.map(account => <option key={account.id} value={account.id}>{account.username}</option>)}
      </select>
    </label>
    <GrantFields t={t} dictionary={dictionary} kind={resourceKind} resourceId={resourceId}
      onKind={(next) => { setResourceKind(next) }}
      onId={(next) => { setResourceId(next) }} />
    <fieldset className={css.field}><span>{t('adminRoles')}</span>
      <div className={css.roles}>
        {GRANT_ROLES.map(role => <label key={role} className={css.checkbox}>
          <input type="checkbox" checked={roles.includes(role)}
            onChange={(event) => { setRoles(event.target.checked ? [...roles, role] : roles.filter(other => other !== role)) }} />
          <span>{role}</span>
        </label>)}
      </div>
    </fieldset>
    <button type="submit" className={css.button} data-primary="true">{t('adminSetGrant')}</button>
  </form>
}
