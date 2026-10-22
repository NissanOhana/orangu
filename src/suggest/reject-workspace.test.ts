import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
    const deps = fakeDeps({ [A]: '/Users/dev/project', [B]: '/Users/dev/project' })
    expect(await rejectWorkspaceCwd(record({ scope: 'repo', sessionIds: [A, ` /some/where/${B.toUpperCase()}.jsonl `] }), deps)).toBe('/Users/dev/project')
    // A path selector names its session by the file name, and discovery decides which file is read.
    expect(deps.asked).toEqual([[A, B]])
    expect(deps.peeked).toEqual([`/projects/-w/${A}.jsonl`, `/projects/-w/${B}.jsonl`])
  })

  it('binds nothing when the recorded cwd is not its own canonical path, because the folder that it names now can differ', async () => {
    // The recorded path is not in normal form, or it goes through a link: realpath gives another string.
    for (const recorded of ['/Users/dev/project/', '/Users/dev/./project', '/Users/dev/w']) {
      const deps = fakeDeps({ [A]: recorded }, () => '/Users/dev/project')
      expect(await rejectWorkspaceCwd(record(), deps), recorded).toBeUndefined()
    }
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

  it('on disk: binds a canonical cwd, and binds nothing for a cwd through a link that now points to another folder, or for a file', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'orangu-reject-ws-')))
    const ranIn = join(base, 'a')
    const nowAt = join(base, 'b')
    mkdirSync(ranIn)
    mkdirSync(nowAt)
    const transcript = join(mkdtempSync(join(tmpdir(), 'orangu-reject-t-')), `${A}.jsonl`)
    const sessionIn = (cwd: string): void => writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd, sessionId: A })}\n`)
    const deps: RejectWorkspaceDeps = { ...createRejectWorkspaceDeps(), findSessions: async () => [transcript] }

    sessionIn(ranIn)
    expect(await rejectWorkspaceCwd(record(), deps)).toBe(ranIn)
    // The session ran in w while w linked to a. Now w links to b: the folder of the session is not w's folder now.
    const w = join(base, 'w')
    symlinkSync(ranIn, w)
    sessionIn(w)
    rmSync(w)
    symlinkSync(nowAt, w)
    expect(await rejectWorkspaceCwd(record(), deps)).toBeUndefined()
    const file = join(ranIn, 'not-a-folder.txt')
    writeFileSync(file, 'x')
    sessionIn(file)
    expect(await rejectWorkspaceCwd(record(), deps)).toBeUndefined()
  })
})
