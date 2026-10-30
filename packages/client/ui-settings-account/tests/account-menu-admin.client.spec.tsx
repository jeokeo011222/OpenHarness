// @vitest-environment jsdom
/** Sidebar account launcher over the local account-directory probe: entries, admin console, sign-out. */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { AccountMenu } from '../src/client/AccountMenu.tsx'
import { en, type AccountKey } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const stateResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })

/** Renders the launcher with one fetch stub answering the session probe and the logout route. */
function renderMenu(fetchMock: (input: string, init?: { method?: string; body?: string }) => Promise<Response>, wide = true): void {
  vi.stubGlobal('fetch', vi.fn(fetchMock))
  render(<AccountMenu {...({} as GlobalStandardProps)} wide={wide} settingsOpen={false}
    openSettings={() => {}} openOnboarding={() => {}} t={key => en[key as AccountKey]} />)
}

/** Opens the launcher menu after the session probe effect has settled. */
async function openMenu(): Promise<void> {
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: en.menu }))
}

it('offers settings, user management, and sign-out for an admin session, opening the console in a new tab', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
  renderMenu(async () => stateResponse({
    signedIn: true, account: { username: 'admin', displayName: 'Admin', roles: ['admin'] },
  }))
  await screen.findByText('Admin')
  await openMenu()
  expect(screen.getByText(en.settings)).toBeDefined()
  expect(screen.getByText(en.signOut)).toBeDefined()
  fireEvent.click(screen.getByText(en.userManagement))
  expect(openSpy).toHaveBeenCalledExactlyOnceWith('/admin', '_blank', 'noopener')
})

it('signs a non-admin session out through the Host logout route onto the login page', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const assign = vi.fn()
  vi.stubGlobal('location', { assign })
  const fetchMock = vi.fn(async (input: string): Promise<Response> => {
    if (input === 'auth/logout') return stateResponse({ ok: true })
    return stateResponse({ signedIn: true, account: { username: 'bob', displayName: '', roles: [] } })
  })
  renderMenu(fetchMock)
  await openMenu()
  expect(screen.queryByText(en.userManagement)).toBeNull()
  fireEvent.click(screen.getByText(en.signOut))
  await vi.waitFor(() => { expect(assign).toHaveBeenCalledExactlyOnceWith('/login') })
  expect(fetchMock).toHaveBeenCalledWith('auth/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
  })
})

it('still lands on the login page when the logout request fails', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const assign = vi.fn()
  vi.stubGlobal('location', { assign })
  renderMenu(async (input) => {
    if (input === 'auth/logout') return new Response('', { status: 500 })
    return stateResponse({ signedIn: true, account: { username: 'bob', displayName: 'Bob', roles: [] } })
  })
  await openMenu()
  fireEvent.click(screen.getByText(en.signOut))
  await vi.waitFor(() => { expect(assign).toHaveBeenCalledExactlyOnceWith('/login') })
})

it('lands on the login page when the logout request cannot be sent', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const assign = vi.fn()
  vi.stubGlobal('location', { assign })
  renderMenu(async (input) => {
    if (input === 'auth/logout') throw new TypeError('offline')
    return stateResponse({ signedIn: true, account: { username: 'bob', displayName: 'Bob', roles: [] } })
  })
  await openMenu()
  fireEvent.click(screen.getByText(en.signOut))
  await vi.waitFor(() => { expect(assign).toHaveBeenCalledExactlyOnceWith('/login') })
})

it('closes the open menu on Escape without navigating', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  renderMenu(async () => stateResponse({
    signedIn: true, account: { username: 'admin', displayName: 'Admin', roles: ['admin'] },
  }))
  await openMenu()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.getByRole('button', { name: en.menu }).getAttribute('aria-expanded')).toBe('false')
})

it('opens settings from the menu, showing the configured shortcut', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const openSettings = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => stateResponse({ signedIn: false })))
  render(<AccountMenu {...({} as GlobalStandardProps)} wide
    settingsShortcut={{ keys: ['Ctrl', ','], aria: 'Control+,' }} settingsOpen={false}
    openSettings={openSettings} openOnboarding={() => {}} t={key => en[key as AccountKey]} />)
  await openMenu()
  fireEvent.click(screen.getByText(en.settings))
  expect(openSettings).toHaveBeenCalledExactlyOnceWith()
})

it('ignores a probe answer that arrives after unmount', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  let settle: (response: Response) => void = () => {}
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { settle = resolve })))
  const { unmount } = render(<AccountMenu {...({} as GlobalStandardProps)} wide settingsOpen={false}
    openSettings={() => {}} openOnboarding={() => {}} t={key => en[key as AccountKey]} />)
  unmount()
  settle(stateResponse({ signedIn: false }))
  await act(async () => {})
  expect(document.body.querySelector('button')).toBeNull()
})

it('renders the signed-out More launcher with settings only', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  renderMenu(async () => stateResponse({ signedIn: false }))
  await openMenu()
  expect(screen.getByText(en.more)).toBeDefined()
  expect(screen.queryByText(en.userManagement)).toBeNull()
  expect(screen.queryByText(en.signOut)).toBeNull()
  expect(screen.getByText(en.settings)).toBeDefined()
})

it('collapses to an icon-only trigger on the rail', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  renderMenu(async () => stateResponse({ signedIn: false }), false)
  await act(async () => {})
  expect(screen.queryByText(en.more)).toBeNull()
})
