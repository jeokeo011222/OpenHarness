/** Local account menu and admin workbench registration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { AccountMenu } from './AccountMenu.tsx'
import { AdminIcon } from './AdminIcon.tsx'
import { AdminWorkbench } from './AdminWorkbench.tsx'
import { fetchLocalAccount, isAdminState } from './local-admin.ts'
import { de, en, es, fr, ja, pt, ru, zh, type AccountKey } from './locales.ts'
export type { AccountMenuProps } from './AccountMenu.tsx'
export type { AccountKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.account': AccountKey }
}

/** Services required by the account feature: the slot registry and locale. */
export const inject = ['slots', 'locale']

/** Panel id kept as plain string so it matches the sidebar row it drives. */
const ADMIN_PANEL_ID = 'admin'

/** Register account UI in Desktop and plain Web clients. @param ctx - client plugin context. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('settings.account', { en, zh, ja, es, fr, de, ru, pt }), 'account: dictionaries')
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({
    name: 'settings.launcher', locale: 'settings.account',
  }, AccountMenu))
  // The sidebar workbench is an administrator affordance; the local session is
  // browser state, so one probe per mount decides whether the row registers.
  ctx.effect(() => {
    let unregister: (() => void) | undefined
    let live = true
    void fetchLocalAccount().then((state) => {
      if (!live || state === undefined || !isAdminState(state)) return
      const t = ctx.locale.bind('settings.account')
      const disposeMain = ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: ADMIN_PANEL_ID, locale: 'settings.account',
        inject: () => ({ t }),
      }, AdminWorkbench))
      const disposeRow = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: ADMIN_PANEL_ID, order: 95, locale: 'settings.account',
        label: () => t('userManagement'),
      }, AdminIcon))
      unregister = () => { disposeMain(); disposeRow() }
    })
    return () => { live = false; unregister?.() }
  }, 'account: admin workbench')
}
