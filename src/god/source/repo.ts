/**
 * The git identity of each cwd for orangu god: 1 `git rev-parse` in each new cwd, cached by cwd. A worktree maps to
 * the common dir of its repo, so the board can group a repo with its worktrees. A cwd in no repo is no repo.
 *
 * The read never throws. A cwd that git answered for stays in the cache: its repo, or null for no repo. A cwd where
 * git did not run, or gave an answer that does not parse, stays out of the cache, so the next read asks again, and
 * the read gives a failure for the source chip.
 */
import type { Host } from '../host.js'
import type { RepoRef } from '../types.js'
import { formReason, notRunReason, off, tryRun, type SourceFailure } from './agents.js'

/**
 * The command that names the repo of a cwd. The paths must be absolute: with no path format, git writes the common
 * dir of the main worktree relative to the cwd (`.git`, `../.git`), so a worktree would not match its repo. The git
 * dir tells a linked worktree (its git dir is not its common dir) from a main worktree and from a submodule.
 */
export const GIT_IDENTITY_ARGV: readonly string[] = ['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel']

/** The repo of each cwd that git answered for: null when the cwd is in no repo. The collector keeps it between reads. */
export type RepoCache = { readonly [cwd: string]: RepoRef | null }

/** 1 read: the cache for the next read, and a failure when git did not answer for 1 or more cwds. */
export type RepoRead = { cache: RepoCache; failure?: SourceFailure }

const withoutTrailingSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'))

/**
 * The repo name that `/god repos <name>` matches: the folder name of the main worktree. A linked worktree names the
 * folder that holds its common dir `.git`, and the worktree of a bare repo names the bare folder without `.git`.
 */
function repoName(commonDir: string, topLevel: string, isWorktree: boolean): string {
  if (!isWorktree) return baseName(topLevel)
  if (baseName(commonDir) === '.git') return baseName(parentOf(commonDir))
  return baseName(commonDir).replace(/\.git$/, '') || baseName(commonDir)
}

/** The repo from the 3 absolute lines of GIT_IDENTITY_ARGV, or nothing when the answer has another form. */
export function parseRevParse(stdout: string): RepoRef | undefined {
  const lines = stdout.replace(/\n$/, '').split('\n')
  if (lines.length !== 3 || !lines.every((line) => line.startsWith('/'))) return undefined
  const [gitDir = '', commonDir = '', topLevel = ''] = lines.map(withoutTrailingSlash)
  const isWorktree = gitDir !== commonDir
  return { commonDir, topLevel, name: repoName(commonDir, topLevel, isWorktree), isWorktree }
}

/** True when the path is a folder. A path that is gone (a removed worktree) or that is not a folder is false. */
async function isFolder(host: Host, path: string): Promise<boolean> {
  try {
    return (await host.stat(path)).kind === 'dir'
  } catch {
    return false
  }
}

/**
 * Asks git once for each absolute cwd that the cache does not hold. A cwd that is not a folder (a removed worktree)
 * is no repo, not a failure, and git does not run there.
 */
export async function readRepos(host: Host, cwds: readonly string[], cache: RepoCache): Promise<RepoRead> {
  const next: Record<string, RepoRef | null> = { ...cache }
  let failure: SourceFailure | undefined
  for (const cwd of cwds) {
    if (!cwd.startsWith('/') || Object.hasOwn(next, cwd)) continue
    if (!(await isFolder(host, cwd))) {
      next[cwd] = null
      continue
    }
    const result = await tryRun(host, GIT_IDENTITY_ARGV, { cwd })
    if (!result) {
      failure = off(notRunReason('git'))
      continue
    }
    if (result.exitCode !== 0) {
      next[cwd] = null // not a git repository
      continue
    }
    const repo = parseRevParse(result.stdout)
    if (repo) next[cwd] = repo
    else failure = off(formReason('git rev-parse'))
  }
  return failure ? { cache: next, failure } : { cache: next }
}

/** The repo of 1 cwd from the cache: absent when the cwd is in no repo or git has not answered for it. */
export function repoOf(cache: RepoCache, cwd: string): RepoRef | undefined {
  return Object.hasOwn(cache, cwd) ? (cache[cwd] ?? undefined) : undefined
}
