// @vitest-environment jsdom
/** Admin-console entry in the sidebar account menu, driven by the local account-directory probe. */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { AccountMenuProps } from '../src/client/AccountMenu.tsx'
import type {} from '../src/client/index.ts'
import { en, type AccountKey } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const themeOf = (): ThemeSnapshot => ({
  preference: 'light', fontSizes: { text: 14, code: 11, terminal: 13 }, fontFamilies: { text: '', code: '', terminal: '' },
  active: { id: 'light', colorScheme: 'light', tokens: {} }, themes: [], revision: 0,
})

const stateResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })

function renderMenu(): void {
  render(<AccountMenu {...({} as GlobalStandardProps)} settingsOpen={false}
    useAccount={selector => (selector as (snapshot: object) => object)({})}
    useTheme={selector => selector(themeOf())}
    wide openSettings={() => {}} openOnboarding={() => {}} refreshAccount={async () => {}}
    t={key => en[key as AccountKey]} />) 
}

/** Opens the launcher menu after local-admin probe effects have settled. */
async function openMenu(): Promise<void> {
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: en.menu }))
}

it('offers user management when the local session holds the admin role', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => stateResponse({
    signedIn: true, account: { username: 'admin', roles: ['admin'] },
  })))
  const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
  renderMenu()
  await openMenu()
  const item = screen.getByText(en.userManagement)
  fireEvent.click(item)
  expect(openSpy).toHaveBeenCalledWith('/admin', '_blank', 'noopener')
})

it('leaves the menu unchanged when the local probe finds no admin session', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => stateResponse({ signedIn: false })))
  renderMenu()
  await openMenu()
  expect(screen.queryByText(en.userManagement)).toBeNull()
})

// Component under test, imported late so the props cast stays local to this file.
import { AccountMenu } from '../src/client/AccountMenu.tsx'
