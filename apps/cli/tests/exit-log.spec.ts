import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { recordExit } from '../src/exit-log.ts'

describe('exit log', () => {
  it('appends one line per event with reason, label, pid, and detail', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-exit-log-'))
    recordExit(home, 'shutdown', 'SIGTERM')
    recordExit(home, 'fatal', 'fatal uncaught exception', new Error('boom\nsecond line'))
    const lines = (await readFile(join(home, 'logs', 'exit.log'), 'utf8')).trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('\tshutdown\tSIGTERM\t')
    expect(lines[0]).toContain(`pid=${process.pid}`)
    expect(lines[1]).toContain('\tfatal\tfatal uncaught exception\t')
    expect(lines[1]).toContain('boom second line')
    // One event stays one line: a multi-line error must not forge a second event.
    expect(lines[1]!.split('\n')).toHaveLength(1)
  })

  it('swallows a home that cannot be written instead of cancelling the exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-exit-log-'))
    const notADirectory = join(directory, 'home')
    await writeFile(notADirectory, 'not a directory')
    expect(() => { recordExit(notADirectory, 'fatal', 'boom', 'detail') }).not.toThrow()
  })
})
