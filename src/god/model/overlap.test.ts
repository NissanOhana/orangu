/**
 * The 3 overlap flags of 2 live sessions, each on both rows: the same worktree on the same branch, the same file
 * written in the last 2 h, and the same repo in different worktrees.
 */
import { describe, expect, it } from 'vitest'
import { HOUR, MINUTE, NOW, busy, idle, repo, transcript } from '../../../test/fixtures/god/sessions.js'
import type { FileTouch, SessionFacts } from '../types.js'
import { SAME_FILES_WINDOW_MS, overlapFlags } from './overlap.js'

const inTree = (id: string, name: string, topLevel: string, branch?: string, files: readonly FileTouch[] = []): SessionFacts =>
  busy(id, { name, cwd: topLevel, repo: repo('api', topLevel), transcript: transcript({ ...(branch === undefined ? {} : { branch }), filesTouched: files }) })

const wrote = (path: string, at: number): FileTouch => ({ path, tool: 'Edit', at })

describe('SAME TREE: 2 live sessions in the same worktree path on the same branch', () => {
  it('puts the flag on both rows, each naming the other', () => {
    const flags = overlapFlags([inTree('a', 'api-1', '/work/api', 'main'), inTree('b', 'api-2', '/work/api', 'main')], NOW)
    expect(flags.get('a')).toEqual([{ kind: 'same-tree', otherId: 'b', otherName: 'api-2' }])
    expect(flags.get('b')).toEqual([{ kind: 'same-tree', otherId: 'a', otherName: 'api-1' }])
  })

  it('gives no flag on 2 branches, or when a row has no known branch', () => {
    expect(overlapFlags([inTree('a', 'api-1', '/work/api', 'main'), inTree('b', 'api-2', '/work/api', 'fix')], NOW).get('a')).toEqual([])
    expect(overlapFlags([inTree('a', 'api-1', '/work/api', 'main'), inTree('b', 'api-2', '/work/api')], NOW).get('b')).toEqual([])
  })

  it('gives no flag to a session with no repo', () => {
    const plain = (id: string) => busy(id, { cwd: '/work/notes', transcript: transcript({ branch: 'main' }) })
    expect(overlapFlags([plain('a'), plain('b')], NOW).get('a')).toEqual([])
  })
})

describe('SAME FILES: 2 sessions wrote the same file in the last 2 h', () => {
  it('puts the flag on both rows with the file', () => {
    const a = inTree('a', 'api-1', '/work/api', 'main', [wrote('/work/api/src/parse.ts', NOW - 10 * MINUTE)])
    const b = inTree('b', 'api-2', '/work/api-wt', 'fix', [wrote('/work/api/src/parse.ts', NOW - 20 * MINUTE)])
    const flags = overlapFlags([a, b], NOW)
    expect(flags.get('a')).toContainEqual({ kind: 'same-files', otherId: 'b', otherName: 'api-2', file: '/work/api/src/parse.ts' })
    expect(flags.get('b')).toContainEqual({ kind: 'same-files', otherId: 'a', otherName: 'api-1', file: '/work/api/src/parse.ts' })
  })

  it('names the file with the newest write when the 2 sessions share more files', () => {
    const shared = ['/work/api/src/a.ts', '/work/api/src/b.ts']
    const a = inTree('a', 'api-1', '/work/api', 'main', [wrote(shared[0]!, NOW - 50 * MINUTE), wrote(shared[1]!, NOW - 40 * MINUTE)])
    const b = inTree('b', 'api-2', '/work/api', 'fix', [wrote(shared[0]!, NOW - 5 * MINUTE), wrote(shared[1]!, NOW - 30 * MINUTE)])
    expect(overlapFlags([a, b], NOW).get('a')).toEqual([{ kind: 'same-files', otherId: 'b', otherName: 'api-2', file: shared[0] }])
  })

  it('counts a write at exactly 2 h, and not 1 ms before it', () => {
    expect(SAME_FILES_WINDOW_MS).toBe(2 * HOUR)
    const file = '/work/api/src/parse.ts'
    const pair = (oldest: number) => [
      inTree('a', 'api-1', '/work/api', 'main', [wrote(file, NOW - MINUTE)]),
      inTree('b', 'api-2', '/work/api', 'fix', [wrote(file, oldest)]),
    ]
    expect(overlapFlags(pair(NOW - 2 * HOUR), NOW).get('a')).toEqual([{ kind: 'same-files', otherId: 'b', otherName: 'api-2', file }])
    expect(overlapFlags(pair(NOW - 2 * HOUR - 1), NOW).get('a')).toEqual([])
  })

  it('gives no flag when only 1 session wrote the file, or a session wrote it twice', () => {
    const file = '/work/api/src/parse.ts'
    const a = inTree('a', 'api-1', '/work/api', 'main', [wrote(file, NOW - MINUTE), wrote(file, NOW - 2 * MINUTE)])
    expect(overlapFlags([a, inTree('b', 'api-2', '/work/api', 'fix')], NOW).get('a')).toEqual([])
  })
})

describe('SAME REPO: the same git common dir, different worktrees', () => {
  it('puts the flag on both rows, and not on 2 sessions in the same worktree', () => {
    const main = inTree('a', 'api-1', '/work/api', 'main')
    const linked = inTree('b', 'api-2', '/work/api-wt', 'fix')
    const flags = overlapFlags([main, linked], NOW)
    expect(flags.get('a')).toEqual([{ kind: 'same-repo', otherId: 'b', otherName: 'api-2' }])
    expect(flags.get('b')).toEqual([{ kind: 'same-repo', otherId: 'a', otherName: 'api-1' }])
    expect(overlapFlags([main, inTree('c', 'api-3', '/work/api', 'fix')], NOW).get('a')).toEqual([])
  })

  it('gives no flag across 2 repos', () => {
    const other = busy('w', { name: 'web-1', cwd: '/work/web', repo: repo('web'), transcript: transcript({ branch: 'main' }) })
    expect(overlapFlags([inTree('a', 'api-1', '/work/api', 'main'), other], NOW).get('a')).toEqual([])
  })
})

describe('the flags of 1 row', () => {
  it('gives every session an entry, and orders the flags by kind, then by the other name', () => {
    const file = '/work/api/src/parse.ts'
    const sessions = [
      inTree('a', 'api-1', '/work/api', 'main', [wrote(file, NOW - MINUTE)]),
      inTree('c', 'api-3', '/work/api-wt', 'fix'),
      inTree('b', 'api-2', '/work/api', 'main', [wrote(file, NOW - MINUTE)]),
      idle('z', { name: 'solo', cwd: '/work/solo' }),
    ]
    const flags = overlapFlags(sessions, NOW)
    expect(flags.get('z')).toEqual([])
    expect(flags.get('a')?.map((flag) => `${flag.kind} ${flag.otherName}`)).toEqual(['same-tree api-2', 'same-files api-2', 'same-repo api-3'])
    expect(flags.get('c')?.map((flag) => `${flag.kind} ${flag.otherName}`)).toEqual(['same-repo api-1', 'same-repo api-2'])
  })

  it('is plain JSON data with no absent field set', () => {
    const flags = overlapFlags([inTree('a', 'api-1', '/work/api', 'main'), inTree('b', 'api-2', '/work/api', 'main')], NOW)
    for (const flag of flags.get('a') ?? []) expect(Object.keys(flag)).not.toContain('file')
  })
})
