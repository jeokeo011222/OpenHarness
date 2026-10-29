#!/usr/bin/env node
/**
 * Replace all Web app icons with the provided logo image, auto-resizing.
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..', '..')
const sourcePath = process.argv[2] ?? join(repoRoot, 'images', 'logo1.png')
const publicDir = resolve(process.argv[3] ?? join(repoRoot, 'apps', 'web', 'public'))

mkdirSync(publicDir, { recursive: true })

const jobs = [
  { out: 'favicon.png', size: 32 },
  { out: 'favicon-dark.png', size: 32 },
  { out: 'apple-touch-icon.png', size: 180 },
  { out: 'icon-192.png', size: 192 },
  { out: 'icon-512.png', size: 512 },
  { out: 'icon-maskable-512.png', size: 512 },
]

async function main() {
  console.log('Source:', sourcePath)
  console.log('Public:', publicDir)
  for (const job of jobs) {
    const outPath = join(publicDir, job.out)
    await sharp(sourcePath)
      .resize(job.size, job.size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(outPath)
    console.log('  ✓', job.out, `(${job.size}×${job.size})`)
  }
  console.log('\nDone.')
}
await main()
