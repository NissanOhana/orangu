/**
 * The git identity of each cwd: 1 `git rev-parse` per new cwd, cached by cwd. A worktree maps to the common dir of
 * its repo, and a cwd in no repo is no repo. The fake-host cases use synthetic paths. The last case runs the real
 * git in a temp folder, because the main worktree prints a relative common dir unless the paths are absolute.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Host, RunOptions, RunResult } from '../host.js'
import { GIT_IDENTITY_ARGV, parseRevParse, readRepos, repoOf, type RepoCache } from './repo.js'

const refuse = async (): Promise<never> => {
  throw new Error('this test gives no such call')
}
const result = (stdout: string, exitCode = 0): RunResult => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
const lines = (...paths: string[]): string => `${paths.join('\n')}\n`

const MAIN = '/Users/test/code/alpha'
const WORKTREE = '/Users/test/code/alpha-wt/feature'
const PLAIN = '/Users/test/notes'

/** git as it answers in each synthetic cwd: git dir, common dir and top level, absolute. */
const ANSWERS: Readonly<Record<string, RunResult>> = {
  [MAIN]: result(lines(`${MAIN}/.git`, `${MAIN}/.git`, MAIN)),
  [`${MAIN}/src`]: result(lines(`${MAIN}/.git`, `${MAIN}/.git`, MAIN)),
  [WORKTREE]: result(lines(`${MAIN}/.git/worktrees/feature`, `${MAIN}/.git`, WORKTREE)),
  [PLAIN]: { ...result('', 128), stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' },
}

function gitHost(answers: Readonly<Record<string, RunResult | Error>> = ANSWERS): { host: Host; calls: { argv: readonly string[]; options?: RunOptions }[] } {
  const calls: { argv: readonly string[]; options?: RunOptions }[] = []
  const host: Host = {
    run: async (argv, options) => {
      calls.push({ argv, ...(options ? { options } : {}) })
      const answer = answers[options?.cwd ?? '']
      if (answer === undefined || answer instanceof Error) throw answer ?? new Error('no answer for this cwd')
      return answer
    },
    list: refuse,
    read: refuse,
    stat: refuse,
    now: refuse,
  }
  return { host, calls }
}

describe('readRepos: git rev-parse in each cwd, cached by cwd', () => {
  it('a worktree cwd gives the common dir of its repo', async () => {
    const read = await readRepos(gitHost().host, [MAIN, WORKTREE], {})
    expect(read.failure).toBeUndefined()
    expect(repoOf(read.cache, MAIN)).toEqual({ commonDir: `${MAIN}/.git`, topLevel: MAIN, name: 'alpha', isWorktree: false })
    expect(repoOf(read.cache, WORKTREE)).toEqual({ commonDir: `${MAIN}/.git`, topLevel: WORKTREE, name: 'alpha', isWorktree: true })
  })

  it('runs git rev-parse with absolute paths, in the cwd, by argv', async () => {
    const { host, calls } = gitHost()
    await readRepos(host, [WORKTREE], {})
    expect(GIT_IDENTITY_ARGV).toEqual(['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'])
    expect(calls).toEqual([{ argv: GIT_IDENTITY_ARGV, options: { cwd: WORKTREE } }])
  })

  it('maps a subfolder to the top level of its worktree', async () => {
    const read = await readRepos(gitHost().host, [`${MAIN}/src`], {})
    expect(repoOf(read.cache, `${MAIN}/src`)).toEqual({ commonDir: `${MAIN}/.git`, topLevel: MAIN, name: 'alpha', isWorktree: false })
  })

  it('a cwd in no repo is no repo, and the cache keeps that answer', async () => {
    const first = gitHost()
    const read = await readRepos(first.host, [PLAIN], {})
    expect(read.failure).toBeUndefined()
    expect(read.cache).toEqual({ [PLAIN]: null })
    expect(repoOf(read.cache, PLAIN)).toBeUndefined()
    const again = gitHost()
    await readRepos(again.host, [PLAIN], read.cache)
    expect(again.calls).toEqual([])
  })

  it('asks git once per cwd: a cached cwd and a repeated cwd run nothing more', async () => {
    const first = gitHost()
    const read = await readRepos(first.host, [MAIN, MAIN, WORKTREE], {})
    expect(first.calls.map((call) => call.options?.cwd)).toEqual([MAIN, WORKTREE])
    const second = gitHost()
    const again = await readRepos(second.host, [MAIN, WORKTREE, PLAIN], read.cache)
    expect(second.calls.map((call) => call.options?.cwd)).toEqual([PLAIN])
    expect(Object.keys(again.cache).sort()).toEqual([PLAIN, WORKTREE, MAIN].sort())
  })

  it('a git that does not run is a failure: the other cwds keep their answer, and that cwd is asked again on the next read', async () => {
    const answers = { ...ANSWERS, [WORKTREE]: new Error('spawn git ETIMEDOUT') }
    const read = await readRepos(gitHost(answers).host, [MAIN, WORKTREE], {})
    expect(read.failure).toEqual({ ok: false, status: 'off', reason: expect.stringMatching(/^The .+\.$/) })
    expect(read.failure?.reason).not.toMatch(/ETIMEDOUT|Users/)
    expect(Object.keys(read.cache)).toEqual([MAIN])
    const next = gitHost()
    await readRepos(next.host, [MAIN, WORKTREE], read.cache)
    expect(next.calls.map((call) => call.options?.cwd)).toEqual([WORKTREE])
  })

  it('an answer with a relative path, from a git that has no absolute path format, is a failure and not a repo', async () => {
    const old = { [MAIN]: result(lines('--path-format=absolute', '.git', '.git', MAIN)) }
    const read = await readRepos(gitHost(old).host, [MAIN], {})
    expect(read.failure).toEqual({ ok: false, status: 'off', reason: expect.stringMatching(/^The .+\.$/) })
    expect(read.cache).toEqual({})
  })

  it('asks nothing and caches nothing for a cwd that is not an absolute path', async () => {
    const { host, calls } = gitHost()
    const read = await readRepos(host, ['', 'relative/path', '__proto__'], {})
    expect(calls).toEqual([])
    expect(read.cache).toEqual({})
    expect(Object.getPrototypeOf(read.cache)).toBe(Object.prototype)
    expect(repoOf(read.cache, 'relative/path')).toBeUndefined()
  })

  it('keeps the cache plain JSON data', async () => {
    const read = await readRepos(gitHost().host, [MAIN, PLAIN], {})
    const cache: RepoCache = read.cache
    expect(JSON.parse(JSON.stringify(cache))).toEqual(cache)
  })
})

describe('parseRevParse: the repo name and the worktree flag', () => {
  it('names a bare repo by its folder without .git, and its worktree is a worktree', () => {
    expect(parseRevParse(lines('/srv/alpha.git/worktrees/feature', '/srv/alpha.git', '/srv/feature'))).toEqual({
      commonDir: '/srv/alpha.git',
      topLevel: '/srv/feature',
      name: 'alpha',
      isWorktree: true,
    })
  })

  it('a submodule is not a worktree, and has the name of its own folder', () => {
    const modules = `${MAIN}/.git/modules/vendor`
    expect(parseRevParse(lines(modules, modules, `${MAIN}/vendor`))).toEqual({ commonDir: modules, topLevel: `${MAIN}/vendor`, name: 'vendor', isWorktree: false })
  })

  it('reads a path with a space, and removes a trailing slash', () => {
    expect(parseRevParse(lines('/srv/my repo/.git/', '/srv/my repo/.git/', '/srv/my repo/'))).toEqual({ commonDir: '/srv/my repo/.git', topLevel: '/srv/my repo', name: 'my repo', isWorktree: false })
  })

  it('gives nothing for an answer with the wrong line count or a relative path', () => {
    expect(parseRevParse('')).toBeUndefined()
    expect(parseRevParse(lines(`${MAIN}/.git`, MAIN))).toBeUndefined()
    expect(parseRevParse(lines('.git', '.git', MAIN))).toBeUndefined()
  })
})

describe('readRepos against the real git', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'god-repo-')))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, GIT_INDEX_FILE: _index, ...outer } = process.env
  const env = { ...outer, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: root }
  const git = (cwd: string, ...args: string[]): void => {
    const run = spawnSync('git', ['-c', 'init.defaultBranch=main', '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, env, encoding: 'utf8' })
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`)
  }
  const nodeHost: Host = {
    run: async (argv, options) => {
      const run = spawnSync(argv[0] ?? '', argv.slice(1), { cwd: options?.cwd, env, encoding: 'utf8' })
      return { exitCode: run.status ?? -1, stdout: run.stdout, stderr: run.stderr, isStdoutTruncated: false, isStderrTruncated: false }
    },
    list: refuse,
    read: refuse,
    stat: refuse,
    now: refuse,
  }

  it('a worktree and its repo share 1 absolute common dir; a plain folder is no repo', async () => {
    const main = join(root, 'alpha')
    const worktree = join(root, 'alpha-wt')
    const plain = join(root, 'plain')
    mkdirSync(join(main, 'src'), { recursive: true })
    mkdirSync(plain)
    git(main, 'init', '-q')
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init')
    git(main, 'worktree', 'add', '-q', worktree)

    const read = await readRepos(nodeHost, [main, join(main, 'src'), worktree, plain], {})
    expect(read.failure).toBeUndefined()
    const expected = { commonDir: join(main, '.git'), topLevel: main, name: basename(main), isWorktree: false }
    expect(repoOf(read.cache, main)).toEqual(expected)
    expect(repoOf(read.cache, join(main, 'src'))).toEqual(expected)
    expect(repoOf(read.cache, worktree)).toEqual({ commonDir: join(main, '.git'), topLevel: worktree, name: 'alpha', isWorktree: true })
    expect(read.cache[plain]).toBeNull()
  })
})
