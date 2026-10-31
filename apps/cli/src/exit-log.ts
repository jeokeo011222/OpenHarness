/**
 * Append-only record of why a long-lived launcher stopped.
 *
 * `dsh web` is often started detached, so the fail-loud diagnostic and the
 * shutdown signal reach a terminal nobody reads. Without a record, the next
 * boot can only report that a turn was open when the process vanished, and the
 * user sees "the DSH process exited before this turn finished" with no reason.
 * One line per event in `<home>/logs/exit.log` supplies that reason, and the
 * absence of any line is itself evidence of an unrequested kill.
 * @module
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { inspect } from 'node:util'

/** Why the process stopped: a fatal error, or a stop request it received. */
export type ExitLogReason = 'fatal' | 'shutdown'

/**
 * Render the one-line detail of an exit event.
 * @param detail - Error, string, or argument the caller wants recorded.
 * @returns A single-line, untruncated description.
 */
function detailOf(detail: unknown): string {
  if (detail === undefined) return ''
  if (typeof detail === 'string') return detail.replaceAll('\n', ' ')
  // `inspect` with a shallow depth keeps property chains a crash report needs
  // (`code`, `syscall`, `path`) without inlining an entire request payload.
  return inspect(detail, { depth: 4, breakLength: Infinity }).replaceAll('\n', ' ')
}

/**
 * Append one exit event to `<home>/logs/exit.log`.
 *
 * A recorded event must never cancel the exit it describes, so a home that
 * cannot be written (a read-only profile, a full disk, a path that is a file)
 * is swallowed: the caller already reported to stderr, and losing the log is
 * strictly better than losing the diagnosis or the teardown.
 * @param home - Resolved `DSH_HOME`.
 * @param reason - `fatal` for an uncaught failure, `shutdown` for a signal.
 * @param label - Stable verbatim label, such as the signal name.
 * @param detail - Optional error or payload for the same line.
 */
export function recordExit(home: string, reason: ExitLogReason, label: string, detail?: unknown): void {
  const line = `${new Date().toISOString()}\t${reason}\t${label}\tpid=${process.pid}\t${detailOf(detail)}\n`
  try {
    const directory = join(home, 'logs')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    appendFileSync(join(directory, 'exit.log'), line, { mode: 0o600 })
  } catch {
    // Intentionally silent: the exit already owns the outcome.
  }
}
