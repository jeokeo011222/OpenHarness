import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../src/password.ts'

describe('password verifiers', () => {
  it('accepts the password it hashed and rejects another', async () => {
    const stored = await hashPassword('correct horse')
    expect(stored.startsWith('scrypt$16384$8$1$')).toBe(true)
    expect(await verifyPassword('correct horse', stored)).toBe(true)
    expect(await verifyPassword('wrong horse', stored)).toBe(false)
  })

  it('salts every verifier so equal passwords differ', async () => {
    const first = await hashPassword('same password')
    const second = await hashPassword('same password')
    expect(first).not.toBe(second)
    expect(await verifyPassword('same password', second)).toBe(true)
  })

  it('rejects verifiers from another scheme or with unusable parameters', async () => {
    expect(await verifyPassword('secret', 'plaintext')).toBe(false)
    expect(await verifyPassword('secret', 'bcrypt$10$1$1$c2FsdA$aGFzaA')).toBe(false)
    expect(await verifyPassword('secret', 'scrypt$not-a-number$8$1$c2FsdA$aGFzaA')).toBe(false)
    expect(await verifyPassword('secret', 'scrypt$16384$8$1$$')).toBe(false)
  })
})
