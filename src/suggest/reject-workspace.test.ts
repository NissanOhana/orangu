import { describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRejectWorkspaceDeps, rejectWorkspaceCwd, type RejectWorkspaceDeps } from './reject-workspace.js'
import type { SuggestionRecord } from './types.js'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'

function record(over: Partial<SuggestionRecord> = {}): SuggestionRecord {
  return {
    id: 'sg_aaaaaaaaaaaa',
    v: 2,
    createdAt: 1,
    source: 'report',
    scope: 'session',
    sessionIds: [A],
    ruleId: 'reread-files',
    title: 'Re-read files',
    evidence: { estimated: true },
    status: 'new',
    statusAt: 1,
    ...over,
  }
}

/** Discovery over a fixed map of session id to the cwd in its transcript head, with each read counted. */
function fakeDeps(cwds: Record<string, string | undefined>, canonical: (path: string) => string = (path) => path): RejectWorkspaceDeps & { asked: string[][]; peeked: string[] } {
  const asked: string[][] = []
  const peeked: string[] = []
  return {
    asked,
    peeked,
    async findSessions(ids) {
      asked.push([...ids].sort())
      return Object.keys(cwds).filter((id) => ids.has(id)).map((id) => `/projects/-w/${id}.jsonl`)
    },
    async peekCwd(path) {
      peeked.push(path)
      return cwds[path.slice('/projects/-w/'.length, -'.jsonl'.length)]
    },
    async canonical(path) {
      return canonical(path)
    },
  }
}

describe('rejectWorkspaceCwd', () => {
  it('binds the canonical path when every evidence session that discovery finds gives the same one', async () => {
    const deps = fakeDeps({ [A]: '/Users/dev/project/', [B]: '/Users/dev/./project' }, () => '/Users/dev/project')
    expect(await rejectWorkspaceCwd(record({ scope: 'repo', sessionIds: [A, ` /some/where/${B.toUpperCase()}.jsonl `] }), deps)).toBe('/Users/dev/project')
    // A path selector names its session by the file name, and discovery decides which file is read.
    expect(deps.asked).toEqual([[A, B]])
    expect(deps.peeked).toEqual([`/projects/-w/${A}.jsonl`, `/projects/-w/${B}.jsonl`])
  })

  it('binds nothing when 2 sessions give 2 different paths', async () => {
    const deps = fakeDeps({ [A]: '/Users/dev/one', [B]: '/Users/dev/two' })
    expect(await rejectWorkspaceCwd(record({ sessionIds: [A, B] }), deps)).toBeUndefined()
  })

  it('binds nothing when no session gives a path', async () => {
    expect(await rejectWorkspaceCwd(record({ sessionIds: [A] }), fakeDeps({}))).toBeUndefined()
    expect(await rejectWorkspaceCwd(record({ sessionIds: [A] }), fakeDeps({ [A]: undefined }))).toBeUndefined()
    expect(await rejectWorkspaceCwd(record({ sessionIds: [A] }), fakeDeps({ [A]: 'relative/dir' }))).toBeUndefined()
    // 1 found session with a path and 1 with none: not every found session gives the same path.
    expect(await rejectWorkspaceCwd(record({ sessionIds: [A, B] }), fakeDeps({ [A]: '/Users/dev/one', [B]: undefined }))).toBeUndefined()
    // A selector that names no session id asks discovery nothing.
    const none = fakeDeps({ [A]: '/Users/dev/one' })
    expect(await rejectWorkspaceCwd(record({ sessionIds: ['latest', 'aaaaaaaa'] }), none)).toBeUndefined()
    expect(none.asked).toEqual([])
  })

  it('binds nothing for a global record or a record that a proposal workspace binds, and asks discovery nothing', async () => {
    const deps = fakeDeps({ [A]: '/Users/dev/one' })
    expect(await rejectWorkspaceCwd(record({ scope: 'global' }), deps)).toBeUndefined()
    const proposal = {
      v: 1 as const, title: 't', change: 'c', effort: 'S' as const, files: ['a'], proposalPath: '/p/a.md',
      workspace: { cwd: '/Users/dev/one', device: '1', inode: '2' },
    }
    expect(await rejectWorkspaceCwd(record({ proposal }), deps)).toBeUndefined()
    expect(deps.asked).toEqual([])
  })

  it('binds nothing, and never throws, when a read fails or the path fails the store form check', async () => {
    const failing = (step: keyof RejectWorkspaceDeps): RejectWorkspaceDeps => ({
      ...fakeDeps({ [A]: '/Users/dev/one' }),
      [step]: async () => {
        throw new Error(`${step} failed`)
      },
    })
    for (const step of ['findSessions', 'peekCwd', 'canonical'] as const) {
      expect(await rejectWorkspaceCwd(record(), failing(step)), step).toBeUndefined()
    }
    for (const resolved of ['/Users/dev/pro‮ject', '/Users/dev/one/', '//server/share', 'relative']) {
      expect(await rejectWorkspaceCwd(record(), fakeDeps({ [A]: '/Users/dev/one' }, () => resolved)), resolved).toBeUndefined()
    }
  })

  it('resolves the cwd of a transcript on disk through a symlink to its canonical directory, and refuses a file', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orangu-reject-ws-')))
    const link = join(mkdtempSync(join(tmpdir(), 'orangu-reject-link-')), 'project')
    symlinkSync(dir, link)
    const transcript = join(mkdtempSync(join(tmpdir(), 'orangu-reject-t-')), `${A}.jsonl`)
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: link, sessionId: A })}\n`)
    const real = createRejectWorkspaceDeps()
    const deps: RejectWorkspaceDeps = { ...real, findSessions: async () => [transcript] }
    expect(await rejectWorkspaceCwd(record(), deps)).toBe(dir)
    const file = join(dir, 'not-a-folder.txt')
    writeFileSync(file, 'x')
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: file, sessionId: A })}\n`)
    expect(await rejectWorkspaceCwd(record(), deps)).toBeUndefined()
  })
})
