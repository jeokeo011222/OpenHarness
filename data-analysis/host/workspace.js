/** Workspace scoping: every dataset artifact lives under `<session cwd>/.analysis`. */
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { AnalysisError } from './util.js'

/** Directory, relative to the session workspace, that owns all analysis artifacts. */
export const ANALYSIS_DIR = '.analysis'

/**
 * Resolve the workspace root of the session that issued a tool call.
 * @param exec - Tool execution context supplied by the host.
 * @returns Absolute workspace path, falling back to the process directory.
 */
export function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? path.resolve(cwd) : process.cwd()
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
