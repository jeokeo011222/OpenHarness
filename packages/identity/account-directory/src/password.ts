/**
 * Password verifiers: scrypt hashes with per-account salts, stored as a
 * self-describing string so a future parameter change can verify old accounts.
 * @module @deepseek-ai/dsh-account-directory/src/password
 */

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

const SCHEME = 'scrypt'
const SALT_BYTES = 16
const KEY_BYTES = 64
const COST = 16384
const BLOCK_SIZE = 8
const PARALLELIZATION = 1
const MAX_MEMORY = 64 * 1024 * 1024

function derive(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derived) => {
      if (error !== null) reject(error)
      else resolve(derived)
    })
  })
}

/**
 * Derive the stored verifier for one password.
 * @param password - Plain password supplied by the operator.
 * @returns a `scrypt$N$r$p$salt$hash` string safe to persist.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await derive(password, salt, KEY_BYTES, { N: COST, r: BLOCK_SIZE, p: PARALLELIZATION, maxmem: MAX_MEMORY })
  return [SCHEME, COST, BLOCK_SIZE, PARALLELIZATION, salt.toString('base64url'), hash.toString('base64url')].join('$')
}

/**
 * Check one password against a stored verifier in constant time.
 * @param password - Plain password supplied by the operator.
 * @param stored - Verifier produced by {@link hashPassword}.
 * @returns whether the password matches; malformed verifiers never match.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== SCHEME) return false
  const cost = Number(parts[1])
  const blockSize = Number(parts[2])
  const parallelization = Number(parts[3])
  const salt = Buffer.from(parts[4] ?? '', 'base64url')
  const expected = Buffer.from(parts[5] ?? '', 'base64url')
  if (!Number.isSafeInteger(cost) || !Number.isSafeInteger(blockSize) || !Number.isSafeInteger(parallelization)) return false
  if (salt.byteLength === 0 || expected.byteLength === 0) return false
  const actual = await derive(password, salt, expected.byteLength, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: MAX_MEMORY,
  })
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}
