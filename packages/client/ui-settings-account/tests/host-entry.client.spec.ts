/** The host face is a deliberate no-op: the client speaks to the Host auth routes directly. */
import { expect, it } from 'vitest'
import { apply } from '../src/index.ts'

it('performs no host-side registration', () => {
  expect(() => { apply() }).not.toThrow()
})
