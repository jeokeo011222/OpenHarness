/** Registration behavior of the local account feature in a client composition. */
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { AccountMenu } from '../src/client/AccountMenu.tsx'
import { AdminWorkbench } from '../src/client/AdminWorkbench.tsx'
import { AdminIcon } from '../src/client/AdminIcon.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => { vi.unstubAllGlobals() })

/** One recorded slot registration. */
interface Recorded { options: Record<string, unknown>; component: unknown; dispose: ReturnType<typeof vi.fn> }

const stateResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })

const adminSession = {
  signedIn: true, account: { username: 'admin', displayName: 'Admin', roles: ['admin'] },
}

/** A client context stub mirroring the framework's effect-tracked slot injections. */
function harness(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): {
  ctx: object
  registers: Recorded[]
  effects: (() => void)[]
  localeRegister: ReturnType<typeof vi.fn>
  localeUnregister: ReturnType<typeof vi.fn>
} {
  const registers: Recorded[] = []
  const effects: (() => void)[] = []
  const localeUnregister = vi.fn()
  const ctxEffect = (install: () => (() => void) | undefined): (() => void) => {
    const dispose = install()
    let done = false
    const disposer = (): void => { if (done) return; done = true; dispose?.() }
    effects.push(disposer)
    return disposer
  }
  const ctx = {
    effect: ctxEffect,
    locale: {
      register: vi.fn(() => localeUnregister),
      bind: () => (key: string) => key,
    },
    slots: {
      inject: (_name: string, install: () => (() => void) | undefined): (() => void) =>
        ctxEffect(() => { const dispose = install(); return () => { dispose?.() } }),
      register: (entry: Record<string, unknown>, component: unknown): (() => void) => {
        const dispose = vi.fn()
        registers.push({ options: entry, component, dispose })
        return dispose
      },
    },
  }
  vi.stubGlobal('fetch', vi.fn(fetchImpl))
  return { ctx, registers, effects, localeRegister: ctx.locale.register, localeUnregister }
}

/** Flushes the probe's async registration. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

it('registers the dictionaries and the launcher, and reverses both on disposal', () => {
  const { ctx, registers, effects, localeRegister, localeUnregister } = harness(async () => stateResponse({ signedIn: false }))
  apply(ctx as never)
  expect(localeRegister).toHaveBeenCalledOnce()
  const [namespace, dictionaries] = localeRegister.mock.calls[0]! as [string, Record<string, unknown>]
  expect(namespace).toBe('settings.account')
  expect(dictionaries.en).toBe(en)
  expect(dictionaries.zh).toBe(zh)
  expect(registers).toHaveLength(1)
  expect(registers[0]!.options.name).toBe('settings.launcher')
  expect(registers[0]!.options.locale).toBe('settings.account')
  expect(registers[0]!.component).toBe(AccountMenu)
  for (const dispose of [...effects].reverse()) dispose()
  expect(localeUnregister).toHaveBeenCalledOnce()
  expect(registers[0]!.dispose).toHaveBeenCalledOnce()
})

it('registers the admin workbench surfaces for an admin session and reverses them on disposal', async () => {
  const { ctx, registers, effects } = harness(async () => stateResponse(adminSession))
  apply(ctx as never)
  await settle()
  expect(registers.map(register => register.options.name)).toEqual(['settings.launcher', 'main', 'sidebar.panellist'])
  const main = registers[1]!
  expect(main.options.key).toBe('admin')
  expect(main.component).toBe(AdminWorkbench)
  const injected = (main.options.inject as () => { t: (key: string) => string })()
  expect(injected.t('adminTitle')).toBe('adminTitle')
  const row = registers[2]!
  expect(row.options.id).toBe('admin')
  expect(row.options.order).toBe(95)
  expect(row.component).toBe(AdminIcon)
  expect((row.options.label as () => string)()).toBe('userManagement')
  for (const dispose of [...effects].reverse()) dispose()
  for (const register of registers) expect(register.dispose).toHaveBeenCalledOnce()
})

it('registers no admin surfaces for a non-admin or unreadable session', async () => {
  for (const body of [{ signedIn: true, account: { username: 'ada', displayName: 'Ada', roles: [] } }, 'not-json']) {
    const { ctx, registers } = harness(async () => stateResponse(body))
    apply(ctx as never)
    await settle()
    expect(registers.map(register => register.options.name)).toEqual(['settings.launcher'])
  }
})

it('drops the admin probe when disposal wins the race', async () => {
  let resolveFetch: ((value: Response) => void) | undefined
  const { ctx, registers, effects } = harness(() => new Promise<Response>((resolve) => { resolveFetch = resolve }))
  apply(ctx as never)
  for (const dispose of [...effects].reverse()) dispose()
  resolveFetch!(stateResponse(adminSession))
  await settle()
  expect(registers.map(register => register.options.name)).toEqual(['settings.launcher'])
})
