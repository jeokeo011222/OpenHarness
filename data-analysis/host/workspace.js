/** Workspace scoping: every dataset artifact lives under `<session cwd>/.analysis`. */
import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { AnalysisError } from './util.js'

/** Directory, relative to the session workspace, that owns all analysis artifacts. */
export const ANALYSIS_DIR = '.analysis'

/** Harness-home subdirectory that owns analysis artifacts for folder-less Sessions. */
export const SESSION_STORE_DIR = 'data-analysis'

/**
 * Resolve the workspace root of the session that issued a tool call.
 *
 * A conversation without a folder is analysed in the same private store the
 * workbench uses, so a dataset handed from the page to the model stays readable.
 * Only a caller with no session at all falls back to the process directory.
 * @param exec - Tool execution context supplied by the host.
 * @returns Absolute workspace path.
 */
export function sessionCwd(exec) {
  const session = exec?.agent?.session
  const cwd = session?.header?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) return path.resolve(cwd)
  const id = session?.header?.id ?? session?.id
  if (typeof id === 'string' && id.length > 0) return sessionStoreRoot(id)
  return process.cwd()
}

/**
 * Resolve the analysis root for a workspace.
 * @param cwd - Absolute workspace path.
 * @returns Absolute `<cwd>/.analysis` path.
 */
export function analysisRoot(cwd) {
  return path.join(cwd, ANALYSIS_DIR)
}

/**
 * Resolve the analysis root of a Session that has no workspace directory.
 *
 * A conversation can exist without a folder: a preset shell, a project entry, or
 * a Session whose cwd was never bound. Its workbench still has to work, so those
 * artifacts live under the harness home, keyed by Session id. The returned path
 * is a workspace root like any other, so every downstream path stays unchanged —
 * the Session simply gets a private one instead of the project directory.
 * @param sessionId - Session identity.
 * @returns Absolute `<dsh home>/data-analysis/sessions/<sessionId>` path.
 */
export function sessionStoreRoot(sessionId) {
  const configured = (process.env.DSH_HOME ?? '').trim()
  const home = configured.length > 0 ? path.resolve(configured) : path.join(homedir(), '.dsh')
  // The id comes from the browser, so it is reduced to one safe path segment:
  // a `..` or a separator would otherwise walk out of the store.
  const safe = String(sessionId ?? '').replace(/[^A-Za-z0-9._-]/g, '_')
  return path.join(home, SESSION_STORE_DIR, 'sessions', safe.length > 0 ? safe : 'unknown')
}

/**
 * Resolve a user-supplied path and reject anything outside the workspace.
 * @param cwd - Absolute workspace path.
 * @param input - Path as written by the user or model.
 * @returns Absolute path proven to sit inside the workspace.
 */
export function resolveInsideWorkspace(cwd, input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new AnalysisError('path is required and must name a file inside the workspace.', 'bad_path')
  }
  const absolute = path.resolve(cwd, input)
  const relative = path.relative(cwd, absolute)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AnalysisError(`Path "${input}" is outside the workspace. Only files under ${cwd} can be imported.`, 'path_outside_workspace')
  }
  return absolute
}

/**
 * Ensure the analysis directories exist.
 * @param cwd - Absolute workspace path.
 * @returns The analysis root path.
 */
export async function ensureAnalysisDirs(cwd) {
  const root = analysisRoot(cwd)
  await mkdir(path.join(root, 'datasets'), { recursive: true })
  await mkdir(path.join(root, 'charts'), { recursive: true })
  await mkdir(path.join(root, 'tmp'), { recursive: true })
  return root
}

/**
 * Describe a file for dataset metadata.
 * @param absolutePath - File to inspect.
 * @returns Size in bytes and modification time.
 */
export async function fileFacts(absolutePath) {
  const info = await stat(absolutePath)
  if (!info.isFile()) throw new AnalysisError(`"${absolutePath}" is not a regular file.`, 'not_a_file')
  return { sizeBytes: info.size, mtime: info.mtime.toISOString() }
}
