/** Admin workbench main page: accounts and resource grants of the local directory. */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { fetchAdminState, submitAdminForm, type LocalAdminState } from './local-admin.ts'
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

/** Role names a resource grant may hold, in display order. */
const GRANT_ROLES = ['owner', 'author', 'reviewer', 'publisher', 'viewer'] as const

/**
 * Two-card page over the Host's `/admin/state` JSON and form routes: the
 * account table with create/update/delete, and the grant table with set/revoke.
 * @param props - copy.
 * @returns the workbench page.
 */
export function AdminWorkbench({ t }: AdminWorkbenchProps): ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [notice, setNotice] = useState<string | undefined>(undefined)
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
  const act = async (path: string, fields: Record<string, string | readonly string[]>): Promise<void> => {
    setNotice(undefined)
    const ok = await submitAdminForm(path, fields)
    if (!ok) setNotice(t('adminError'))
    await reload()
  }
  return <div className={css.page}>
    <h1 className={css.title}>{t('adminTitle')}</h1>
    <p className={css.description}>{t('adminDescription')}</p>
    {notice !== undefined && <p className={css.status} data-error="true">{notice}</p>}
    <section className={css.card}>
      <h2 className={css.cardTitle}>{t('adminAccounts')}</h2>
      <CreateAccountForm t={t} onAct={act} />
      <table className={css.table}>
        <thead><tr>
          <th>{t('adminUsername')}</th><th>{t('adminDisplayName')}</th><th>{t('adminAdministrator')}</th><th>{t('adminNewPassword')}</th><th>{''}</th>
        </tr></thead>
        <tbody>
          {state.accounts.map(account => <AccountRow key={account.id} t={t} account={account} onAct={act} />)}
        </tbody>
      </table>
    </section>
    <section className={css.card}>
      <h2 className={css.cardTitle}>{t('adminGrants')}</h2>
      <GrantForm t={t} accounts={state.accounts} onAct={act} />
      {state.grants.length === 0
        ? <p className={css.status}>{t('adminEmpty')}</p>
        : <table className={css.table}>
          <thead><tr>
            <th>{t('adminGrantTo')}</th><th>{t('adminResourceKind')}</th><th>{t('adminResourceId')}</th><th>{t('adminRoles')}</th><th>{''}</th>
          </tr></thead>
          <tbody>
            {state.grants.map((grant) => {
              const name = state.accounts.find(account => account.id === grant.userId)?.username ?? grant.userId
              return <tr key={`${grant.userId}/${grant.resourceKind}/${grant.resourceId}`}>
                <td>{name}</td>
                <td>{grant.resourceKind}</td>
                <td className={css.muted}>{grant.resourceId}</td>
                <td>{grant.roles.join(', ')}</td>
                <td>
                  <button type="button" className={css.button} data-danger="true"
                    onClick={() => { void act('admin/grant/delete', {
                      userId: grant.userId, resourceKind: grant.resourceKind, resourceId: grant.resourceId,
                    }) }}>
                    {t('adminDelete')}
                  </button>
                </td>
              </tr>
            })}
          </tbody>
        </table>}
    </section>
  </div>
}

/** One account row: rename, toggle the admin role, reset the password, or delete. */
function AccountRow({ t, account, onAct }: {
  t: AdminWorkbenchProps['t']
  account: LocalAdminState['accounts'][number]
  onAct: (path: string, fields: Record<string, string | readonly string[]>) => Promise<void>
}): ReactNode {
  const [displayName, setDisplayName] = useState(account.displayName)
  const [admin, setAdmin] = useState(account.roles.includes('admin'))
  const [password, setPassword] = useState('')
  return <tr>
    <td>{account.username}</td>
    <td>
      <input className={css.input} value={displayName} aria-label={t('adminDisplayName')}
        onChange={(event) => { setDisplayName(event.target.value) }} />
    </td>
    <td>
      <input type="checkbox" checked={admin} aria-label={t('adminAdministrator')}
        onChange={(event) => { setAdmin(event.target.checked) }} />
    </td>
    <td>
      <input className={css.input} type="password" value={password} placeholder={t('adminPasswordHint')} aria-label={t('adminNewPassword')}
        onChange={(event) => { setPassword(event.target.value) }} />
    </td>
    <td>
      <div className={css.actions}>
        <button type="button" className={css.button}
          onClick={() => {
            void onAct('admin/user/update', {
              userId: account.id,
              admin: admin ? '1' : '0',
              displayName,
              ...(password === '' ? {} : { password }),
            })
            setPassword('')
          }}>
          {t('adminSave')}
        </button>
        <button type="button" className={css.button} data-danger="true"
          onClick={() => { void onAct('admin/user/delete', { userId: account.id }) }}>
          {t('adminDelete')}
        </button>
      </div>
    </td>
  </tr>
}

/** Create-account form. */
function CreateAccountForm({ t, onAct }: {
  t: AdminWorkbenchProps['t']
  onAct: (path: string, fields: Record<string, string | readonly string[]>) => Promise<void>
}): ReactNode {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [admin, setAdmin] = useState(false)
  return <form className={css.inlineForm} onSubmit={(event) => {
    event.preventDefault()
    if (username === '' || password === '') return
    void onAct('admin/user/create', { username, displayName, password, admin: admin ? '1' : '0' })
    setUsername(''); setDisplayName(''); setPassword(''); setAdmin(false)
  }}>
    <label className={css.field}><span>{t('adminUsername')}</span>
      <input className={css.input} value={username} required onChange={(event) => { setUsername(event.target.value) }} />
    </label>
    <label className={css.field}><span>{t('adminDisplayName')}</span>
      <input className={css.input} value={displayName} onChange={(event) => { setDisplayName(event.target.value) }} />
    </label>
    <label className={css.field}><span>{t('adminPassword')}</span>
      <input className={css.input} type="password" value={password} required onChange={(event) => { setPassword(event.target.value) }} />
    </label>
    <label className={css.checkbox}>
      <input type="checkbox" checked={admin} onChange={(event) => { setAdmin(event.target.checked) }} />
      <span>{t('adminAdministrator')}</span>
    </label>
    <button type="submit" className={css.button}>{t('adminCreate')}</button>
  </form>
}

/** Set-grant form: one account, one resource, and the role set replacing its previous grant. */
function GrantForm({ t, accounts, onAct }: {
  t: AdminWorkbenchProps['t']
  accounts: LocalAdminState['accounts']
  onAct: (path: string, fields: Record<string, string | readonly string[]>) => Promise<void>
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
    <label className={css.field}><span>{t('adminResourceKind')}</span>
      <input className={css.input} value={resourceKind} onChange={(event) => { setResourceKind(event.target.value) }} />
    </label>
    <label className={css.field}><span>{t('adminResourceId')}</span>
      <input className={css.input} value={resourceId} onChange={(event) => { setResourceId(event.target.value) }} />
    </label>
    <fieldset className={css.field}><span>{t('adminRoles')}</span>
      <div className={css.roles}>
        {GRANT_ROLES.map(role => <label key={role} className={css.checkbox}>
          <input type="checkbox" checked={roles.includes(role)}
            onChange={(event) => { setRoles(event.target.checked ? [...roles, role] : roles.filter(other => other !== role)) }} />
          <span>{role}</span>
        </label>)}
      </div>
    </fieldset>
    <button type="submit" className={css.button}>{t('adminSetGrant')}</button>
  </form>
}
