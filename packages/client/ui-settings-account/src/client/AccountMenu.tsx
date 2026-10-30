/** Sidebar account launcher for the local account-directory session. */
import { useEffect, useRef, useState } from 'react'
import { Menu, IconEllipsisOutlineMedium, IconSettingsOutlineMedium, IconShieldOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { fetchLocalAccount, isAdminState, type LocalAccountState } from './local-admin.ts'
import { LogoutIcon } from './LogoutIcon.tsx'
import css from './AccountMenu.module.css'

/** Account launcher composed by the settings shell. */
export type AccountMenuProps = PropsRuntime<'settings.launcher'> & PropsLocale<'settings.account'>

/**
 * The signed-in label is the local account's display name; the menu offers
 * Settings, the admin console, and sign-out against the Host's own auth routes.
 * @param props - sidebar geometry, settings navigation, and copy.
 * @returns account menu launcher.
 */
export function AccountMenu({ wide, settingsShortcut, openSettings, t }: AccountMenuProps) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  // The local account-directory session is browser-only state, so one probe per
  // mount decides the label, the admin entry, and the sign-out action.
  const [state, setState] = useState<LocalAccountState | undefined>(undefined)
  useEffect(() => {
    let live = true
    void fetchLocalAccount().then((value) => { if (live) setState(value) })
    return () => { live = false }
  }, [])
  const account = state !== undefined && state.signedIn && state.account !== undefined ? state.account : undefined
  const initial = account === undefined ? '' : account.displayName.trim().charAt(0).toUpperCase() || account.username.charAt(0).toUpperCase()
  return <div className={css.root} data-inset={account !== undefined && wide}>
    <Menu open={open} side="top" portal autoFocus className={css.anchor} listClassName={account === undefined ? css.signedOutMenu : undefined}
      anchor={<button ref={trigger} type="button" className={css.trigger} data-collapsed={!wide} data-signed-out={account === undefined} aria-label={t('menu')}
        aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        <span className={css.avatar} aria-hidden="true">
          {account === undefined ? <IconEllipsisOutlineMedium size={14} /> : initial}
        </span>
        {wide && <span className={css.label}>{account === undefined ? t('more') : account.displayName}</span>}
      </button>}
      items={[
        { id: 'settings', label: t('settings'), icon: <IconSettingsOutlineMedium size={16} />,
          ...(settingsShortcut === undefined ? {} : { shortcut: settingsShortcut }) },
        ...(state !== undefined && isAdminState(state) ? [{ id: 'admin', label: t('userManagement'), icon: <IconShieldOutlineMedium size={16} /> }] : []),
        ...(account === undefined ? [] : [{ id: 'signout', label: t('signOut'), icon: <LogoutIcon /> }]),
      ]}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        if (id === 'settings') { setOpen(false); trigger.current?.focus(); openSettings() }
        else if (id === 'admin') { setOpen(false); window.open('/admin', '_blank', 'noopener') }
        else {
          setOpen(false)
          void signOut()
        }
      }} />
  </div>
}

/** Clear the local session cookie and land on the login page. */
async function signOut(): Promise<void> {
  try {
    const response = await fetch('auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    })
    if (response.ok) { window.location.assign('/login'); return }
  } catch {
    // The navigation below still moves the browser to the login page.
  }
  window.location.assign('/login')
}
