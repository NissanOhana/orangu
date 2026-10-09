/**
 * The transcript reader of orangu god, over a fake host: a file system in memory whose commands act as the
 * engine's do. `tail -c +N` and `head -c N` count bytes, `stat -f '%i %N'` names each file it found, standard
 * output stops at 4 MiB, and the text comes out as UTF-8: a cut character at the end drops, and each lone
 * continuation byte at the start becomes U+FFFD (or drops, in the second decoder mode that the tests also run).
 * Every record is synthetic.
 */
import { describe, expect, it } from 'vitest'
import type { DirEntry, FileStat, Host, RunResult } from '../host.js'
import {
  HEAD_BYTES,
  STDOUT_CAP_BYTES,
  TAIL_BYTES,
  listSubagents,
  readTranscripts,
  transcriptPath,
  type TranscriptCursor,
  type TranscriptRead,
} from './transcript.js'

const HOME = '/Users/test'
const CWD = '/Users/test/Code/demo'
const SID = 'aaaaaaaa-0000-4000-8000-000000000001'
const PROJECTS = `${HOME}/.claude/projects`
const PATH = `${PROJECTS}/-Users-test-Code-demo/${SID}.jsonl`

const encoder = new TextEncoder()
const size = (text: string): number => encoder.encode(text).length
const line = (n: number, fields: Record<string, unknown> = {}): string => `${JSON.stringify({ type: 'assistant', n, ...fields })}\n`
/** 1 record line of exactly `bytes` bytes, ASCII filler */
const lineOfSize = (n: number, bytes: number): string => line(n, { text: 'x'.repeat(bytes - size(line(n, { text: '' }))) })

type FakeFile = { bytes: Uint8Array; inode: number; mtimeMs: number; isLink: boolean }
type LeadMode = 'replace' | 'drop'

function fakeHost(lead: LeadMode = 'replace') {
  const files = new Map<string, FakeFile>()
  const calls: string[][] = []
  const failNext = new Set<string>()
  let inode = 500
  let clock = 1_000
  const decode = (bytes: Uint8Array): string => {
    let from = 0
    if (lead === 'drop') while (from < bytes.length && ((bytes[from] ?? 0) & 0xc0) === 0x80) from += 1
    return new TextDecoder().decode(bytes.subarray(from), { stream: true })
  }
  const output = (bytes: Uint8Array): RunResult => {
    const isCut = bytes.length > STDOUT_CAP_BYTES
    return { exitCode: 0, stdout: decode(isCut ? bytes.subarray(0, STDOUT_CAP_BYTES) : bytes), stderr: '', isStdoutTruncated: isCut, isStderrTruncated: false }
  }
  const missing: RunResult = { exitCode: 1, stdout: '', stderr: 'No such file or directory', isStdoutTruncated: false, isStderrTruncated: false }
  const run = (argv: readonly string[]): RunResult => {
    const [name, flag, arg = '', ...paths] = argv
    if (name !== undefined && failNext.delete(name)) return { ...missing, stderr: 'failed' }
    if (name === 'stat' && flag === '-f' && arg === '%i %N') {
      const found = paths.flatMap((path) => (files.has(path) ? [`${files.get(path)?.inode} ${path}\n`] : []))
      return { ...output(encoder.encode(found.join(''))), exitCode: found.length === paths.length ? 0 : 1 }
    }
    const file = files.get(paths[0] ?? '')
    if (paths.length !== 1 || flag !== '-c') throw new Error(`the fake host has no command ${argv.join(' ')}`)
    if (!file) return missing
    if (name === 'tail' && /^\+\d+$/.test(arg)) return output(file.bytes.subarray(Number(arg.slice(1)) - 1))
    if (name === 'head' && /^\d+$/.test(arg)) return output(file.bytes.subarray(0, Number(arg)))
    throw new Error(`the fake host has no command ${argv.join(' ')}`)
  }
  const children = (dir: string): DirEntry[] => {
    const entries = new Map<string, DirEntry>()
    for (const [path, file] of files) {
      if (!path.startsWith(`${dir}/`)) continue
      const [name = '', ...rest] = path.slice(dir.length + 1).split('/')
      entries.set(name, rest.length ? { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false } : { name, kind: 'file', size: file.bytes.length, mtimeMs: file.mtimeMs, isLink: file.isLink })
    }
    return [...entries.values()]
  }
  const host: Host = {
    run: async (argv) => (calls.push(['run', ...argv]), run(argv)),
    list: async (path) => {
      calls.push(['list', path])
      const entries = children(path)
      if (!entries.length) throw new Error('missing')
      return entries
    },
    read: async (path) => {
      calls.push(['read', path])
      const file = files.get(path)
      if (!file || file.bytes.length > STDOUT_CAP_BYTES) throw new Error('missing')
      return new TextDecoder().decode(file.bytes)
    },
    stat: async (path): Promise<FileStat> => {
      calls.push(['stat', path])
      const file = files.get(path)
      if (file) return { kind: 'file', size: file.bytes.length, mtimeMs: file.mtimeMs, isLink: file.isLink }
      if (children(path).length) return { kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
      throw new Error('missing')
    },
    now: async () => clock,
  }
  const fs = {
    /** a new file: a new inode */
    write: (path: string, data: string | Uint8Array, isLink = false) => {
      files.set(path, { bytes: typeof data === 'string' ? encoder.encode(data) : data, inode: (inode += 1), mtimeMs: (clock += 1), isLink })
    },
    /** the same file, more bytes or fewer: the inode stays */
    change: (path: string, data: string | Uint8Array, mode: 'append' | 'replace' = 'append') => {
      const file = files.get(path)
      if (!file) throw new Error(`no file ${path}`)
      const more = typeof data === 'string' ? encoder.encode(data) : data
      const bytes = mode === 'replace' ? more : new Uint8Array(file.bytes.length + more.length)
      if (mode === 'append') bytes.set(file.bytes), bytes.set(more, file.bytes.length)
      Object.assign(file, { bytes, mtimeMs: (clock += 1) })
    },
    size: (path: string): number => files.get(path)?.bytes.length ?? -1,
  }
  return { host, calls, fs, failNext }
}

type Fake = ReturnType<typeof fakeHost>
type ReadOk = Extract<TranscriptRead, { status: 'read' }>

/** 1 tick over 1 session: the read and the commands that it ran */
async function tick(fake: Fake, cursor?: TranscriptCursor, cwd = CWD, sessionId = SID): Promise<{ read: TranscriptRead; calls: string[][] }> {
  const before = fake.calls.length
  const [read] = await readTranscripts(fake.host, HOME, [{ sessionId, cwd, ...(cursor ? { cursor } : {}) }])
  if (!read) throw new Error('no read')
  return { read, calls: fake.calls.slice(before) }
}

function ok(read: TranscriptRead): ReadOk {
  if (read.status !== 'read') throw new Error(`expected a read, got ${read.status}`)
  return read
}

const runs = (calls: string[][]): string[] => calls.filter((call) => call[0] === 'run').map((call) => call.slice(1).join(' '))
const ns = (read: ReadOk): unknown[] => read.records.map((record) => record['n'])

describe('the transcript reader: the cases of the reader tests', () => {
  it('a partial last line waits for the next read', async () => {
    const fake = fakeHost()
    fake.fs.write(PATH, `${line(1)}${line(2)}{"type":"assistant","n":3`)
    const first = ok((await tick(fake)).read)
    expect(ns(first)).toEqual([1, 2])
    expect(first.parseErrors).toBe(0)
    expect(first.cursor.position?.offset).toBe(size(line(1) + line(2)))
    fake.fs.change(PATH, ',"done":true}\n')
    const next = await tick(fake, first.cursor)
    expect(ok(next.read).records).toEqual([{ type: 'assistant', n: 3, done: true }])
    expect(ok(next.read).isFresh).toBe(false)
    expect(runs(next.calls)).toContain(`tail -c +${size(line(1) + line(2)) + 1} ${PATH}`)
    expect(ok(next.read).cursor.position?.offset).toBe(fake.fs.size(PATH))
  })

  it('a smaller file reads again from the end', async () => {
    const fake = fakeHost()
    fake.fs.write(PATH, line(1) + line(2) + line(3))
    const first = ok((await tick(fake)).read)
    fake.fs.change(PATH, line(9), 'replace')
    const next = await tick(fake, first.cursor)
    expect(ok(next.read).isFresh).toBe(true)
    expect(ns(ok(next.read))).toEqual([9])
    expect(runs(next.calls)).toContain(`tail -c +1 ${PATH}`)
  })

  it('a new inode reads again from the end, though the file only grew', async () => {
    const fake = fakeHost()
    fake.fs.write(PATH, line(1) + line(2))
    const first = ok((await tick(fake)).read)
    fake.fs.write(PATH, line(1) + line(2) + line(3))
    const next = await tick(fake, first.cursor)
    expect(ok(next.read).isFresh).toBe(true)
    expect(ns(ok(next.read))).toEqual([1, 2, 3])
    expect(runs(next.calls)).toEqual([`stat -f %i %N ${PATH}`, `tail -c +1 ${PATH}`])
  })

  it('a bad line counts as a parse error, and the read goes on', async () => {
    const fake = fakeHost()
    fake.fs.write(PATH, `${line(1)}not json\n\n[1,2]\n${line(2)}{"cut":\n${line(3)}`)
    const read = ok((await tick(fake)).read)
    expect(ns(read)).toEqual([1, 2, 3])
    expect(read.parseErrors).toBe(3)
    expect(read.cursor.position?.offset).toBe(fake.fs.size(PATH))
  })

  it('a tail with no title record reads the first 64 KiB once', async () => {
    const fake = fakeHost()
    const head = line(1, { type: 'user', message: { role: 'user', content: 'First prompt' } })
    const body = Array.from({ length: 80 }, (_, i) => lineOfSize(i + 2, 8_000)).join('')
    fake.fs.write(PATH, head + body)
    const start = fake.fs.size(PATH) - TAIL_BYTES
    const first = await tick(fake)
    expect(runs(first.calls)).toEqual([`stat -f %i %N ${PATH}`, `tail -c +${start + 1} ${PATH}`, `head -c ${HEAD_BYTES} ${PATH}`])
    expect(ok(first.read).headRecords[0]).toEqual({ type: 'user', n: 1, message: { role: 'user', content: 'First prompt' } })
    expect(ok(first.read).records.some((record) => record['n'] === 1)).toBe(false)
    expect(ok(first.read).parseErrors).toBe(0)
    fake.fs.change(PATH, line(99))
    const next = await tick(fake, ok(first.read).cursor)
    expect(runs(next.calls).filter((call) => call.startsWith('head'))).toEqual([])
    expect(ok(next.read).headRecords).toEqual([])
    expect(ns(ok(next.read))).toEqual([99])
  })

  it('a tail that holds a title record reads no head, and a head never overlaps the tail', async () => {
    const titled = fakeHost()
    titled.fs.write(PATH, Array.from({ length: 80 }, (_, i) => lineOfSize(i + 1, 8_000)).join('') + line(81, { type: 'ai-title', aiTitle: 'Fix the tail' }))
    expect(runs((await tick(titled)).calls).filter((call) => call.startsWith('head'))).toEqual([])
    const short = fakeHost()
    short.fs.write(PATH, lineOfSize(1, 20_000) + Array.from({ length: 64 }, (_, i) => lineOfSize(i + 2, 8_192)).join(''))
    const start = short.fs.size(PATH) - TAIL_BYTES
    expect(start).toBeLessThan(HEAD_BYTES)
    expect(runs((await tick(short)).calls)).toContain(`head -c ${start} ${PATH}`)
  })
})

describe('the transcript reader: byte offsets and cuts', () => {
  it('counts UTF-8 bytes, not string length', async () => {
    const fake = fakeHost()
    const text = line(1, { text: 'Grüße, 日本語, 🙂' }) + line(2)
    fake.fs.write(PATH, text)
    const read = ok((await tick(fake)).read)
    expect(read.cursor.position?.offset).toBe(size(text))
    expect(read.cursor.position?.offset).not.toBe(text.length)
  })

  it('a character cut at the end of a read waits with its line', async () => {
    const fake = fakeHost()
    const second = encoder.encode(line(2, { text: '日本' }))
    const cutAt = second.indexOf(0xe6) + 1
    fake.fs.write(PATH, new Uint8Array([...encoder.encode(line(1)), ...second.subarray(0, cutAt)]))
    const first = ok((await tick(fake)).read)
    expect(ns(first)).toEqual([1])
    fake.fs.change(PATH, second.subarray(cutAt))
    const next = ok((await tick(fake, first.cursor)).read)
    expect(next.records).toEqual([{ type: 'assistant', n: 2, text: '日本' }])
    expect(next.parseErrors).toBe(0)
    expect(next.cursor.position?.offset).toBe(fake.fs.size(PATH))
  })

  it.each([
    ['replace', 1],
    ['replace', 2],
    ['drop', 1],
    ['drop', 2],
  ] as const)('a first read that starts inside a character loses no record (decoder %s, %i byte in)', async (mode, into) => {
    const fake = fakeHost(mode)
    const cut = line(2, { text: '日'.repeat(1_000) })
    const textAt = size(line(2, { text: '' })) - size('"}\n')
    const tailBytes = TAIL_BYTES - size(cut) + textAt + 3 * 500 + into
    fake.fs.write(PATH, line(1) + cut + lineOfSize(3, tailBytes))
    const first = ok((await tick(fake)).read)
    expect(ns(first)).toEqual([3])
    expect(first.parseErrors).toBe(0)
    fake.fs.change(PATH, line(4))
    const second = ok((await tick(fake, first.cursor)).read)
    fake.fs.change(PATH, line(5))
    const third = ok((await tick(fake, second.cursor)).read)
    expect([...ns(second), ...ns(third)]).toEqual([4, 5])
    expect(second.parseErrors + third.parseErrors).toBe(0)
    expect(third.cursor.position).toMatchObject({ offset: fake.fs.size(PATH), edge: 'line' })
  })

  it('a cut at 4 MiB takes only the whole lines, and the next tick reads on with no change in the file', async () => {
    const fake = fakeHost()
    fake.fs.write(PATH, line(0))
    const first = ok((await tick(fake)).read)
    const many = Array.from({ length: 600 }, (_, i) => line(i + 1, { text: '日'.repeat(3_300) })).join('')
    fake.fs.change(PATH, many)
    const second = ok((await tick(fake, first.cursor)).read)
    expect(second.cursor.position?.hasMore).toBe(true)
    expect(second.records.length).toBeGreaterThan(0)
    expect(second.records.length).toBeLessThan(600)
    const third = await tick(fake, second.cursor)
    expect(runs(third.calls)).toEqual([`tail -c +${(second.cursor.position?.offset ?? 0) + 1} ${PATH}`])
    expect([...ns(second), ...ns(ok(third.read))]).toEqual(Array.from({ length: 600 }, (_, i) => i + 1))
    expect(second.parseErrors + ok(third.read).parseErrors).toBe(0)
    expect(ok(third.read).cursor.position).toMatchObject({ offset: fake.fs.size(PATH), hasMore: false })
  })

  it('a line longer than 4 MiB counts once as a parse error, and the reader goes past it', async () => {
    const fake = fakeHost()
    fake.fs.write(PATH, line(1))
    const first = ok((await tick(fake)).read)
    fake.fs.change(PATH, lineOfSize(2, STDOUT_CAP_BYTES + 1_000_000) + line(3))
    const second = ok((await tick(fake, first.cursor)).read)
    expect(second.records).toEqual([])
    expect(second.parseErrors).toBe(1)
    expect(second.cursor.position?.offset).toBe(size(line(1)) + STDOUT_CAP_BYTES)
    const third = ok((await tick(fake, second.cursor)).read)
    expect(ns(third)).toEqual([3])
    expect(third.parseErrors).toBe(0)
    expect(third.cursor.position?.offset).toBe(fake.fs.size(PATH))
  })
})

describe('the transcript reader: the path, the search and the ticks', () => {
  it('reads <home>/.claude/projects/<projectSlug(cwd)>/<sessionId>.jsonl', () => {
    expect(transcriptPath(HOME, '/Users/test/Code/my.repo', SID)).toBe(`${PROJECTS}/-Users-test-Code-my-repo/${SID}.jsonl`)
  })

  it('a missing transcript gives the missing status, runs no read, and searches once', async () => {
    const fake = fakeHost()
    fake.fs.write(`${PROJECTS}/-Users-test-Code-other/${'b'.repeat(8)}.jsonl`, line(1))
    const first = await tick(fake)
    expect(first.read).toEqual({ status: 'missing', cursor: { sessionId: SID, isSearched: true } })
    expect(runs(first.calls)).toEqual([])
    expect(first.calls.filter((call) => call[0] === 'list')).toEqual([['list', PROJECTS]])
    const next = await tick(fake, first.read.cursor)
    expect(next.read.status).toBe('missing')
    expect(next.calls).toEqual([['stat', PATH]])
    fake.fs.write(PATH, line(1))
    expect(ns(ok((await tick(fake, next.read.cursor)).read))).toEqual([1])
  })

  it('finds the file by name when the path of the cwd has none, then keeps that path', async () => {
    const fake = fakeHost()
    const elsewhere = `${PROJECTS}/-Users-test-Code-demo-worktree/${SID}.jsonl`
    fake.fs.write(`${PROJECTS}/-Users-test-Code-zzz/other.jsonl`, line(0))
    fake.fs.write(elsewhere, line(1))
    const first = ok((await tick(fake)).read)
    expect(first.cursor).toMatchObject({ path: elsewhere, isSearched: true })
    expect(ns(first)).toEqual([1])
    fake.fs.change(elsewhere, line(2))
    const next = await tick(fake, first.cursor, '/Users/test/Code/moved')
    expect(ns(ok(next.read))).toEqual([2])
    expect(next.calls.filter((call) => call[0] === 'list')).toEqual([])
  })

  it('keeps the path that a stat found, though the cwd moves later', async () => {
    const fake = fakeHost()
    fake.fs.write(PATH, line(1))
    const first = ok((await tick(fake)).read)
    expect(first.cursor).toMatchObject({ path: PATH, isSearched: false })
    fake.fs.change(PATH, line(2))
    expect(ns(ok((await tick(fake, first.cursor, '/Users/test/Code/demo/.worktrees/x')).read))).toEqual([2])
  })

  it('an unchanged transcript runs no command', async () => {
    const fake = fakeHost()
    fake.fs.write(PATH, line(1))
    const first = ok((await tick(fake)).read)
    const next = await tick(fake, first.cursor)
    expect(next.read).toEqual({ status: 'unchanged', cursor: first.cursor, mtimeMs: first.mtimeMs })
    expect(runs(next.calls)).toEqual([])
  })

  it('checks the inodes of all changed transcripts with 1 stat command', async () => {
    const fake = fakeHost()
    const ids = ['a', 'b', 'c'].map((c) => `${c.repeat(8)}-0000-4000-8000-000000000001`)
    const paths = ids.map((id) => transcriptPath(HOME, CWD, id))
    for (const path of paths) fake.fs.write(path, line(1))
    const first = await readTranscripts(fake.host, HOME, ids.map((sessionId) => ({ sessionId, cwd: CWD })))
    fake.fs.change(paths[0] ?? '', line(2))
    fake.fs.change(paths[2] ?? '', line(2))
    const before = fake.calls.length
    const next = await readTranscripts(fake.host, HOME, ids.map((sessionId, i) => ({ sessionId, cwd: CWD, cursor: first[i]?.cursor })))
    const commands = runs(fake.calls.slice(before))
    expect(commands.filter((call) => call.startsWith('stat'))).toEqual([`stat -f %i %N ${paths[0]} ${paths[2]}`])
    expect(commands.filter((call) => call.startsWith('tail'))).toHaveLength(2)
    expect(next.map((read) => read.status)).toEqual(['read', 'unchanged', 'read'])
  })

  it('a failed command keeps the cursor, and the next tick reads again', async () => {
    const fake = fakeHost()
    fake.fs.write(PATH, line(1))
    const first = ok((await tick(fake)).read)
    fake.fs.change(PATH, line(2))
    fake.failNext.add('tail')
    const failed = await tick(fake, first.cursor)
    expect(failed.read).toMatchObject({ status: 'failed', failure: 'exit-code', cursor: first.cursor })
    expect(ns(ok((await tick(fake, failed.read.cursor)).read))).toEqual([2])
  })
})

describe('listSubagents: the subagent files of a session', () => {
  const dir = `${PATH.slice(0, -'.jsonl'.length)}/subagents`

  it('lists agent-<id>.jsonl, reads each meta file once, and skips links and other names', async () => {
    const fake = fakeHost()
    fake.fs.write(PATH, line(1))
    fake.fs.write(`${dir}/agent-a1.jsonl`, line(1) + line(2))
    fake.fs.write(`${dir}/agent-a1.meta.json`, JSON.stringify({ toolUseId: 'toolu_1', agentType: 'Explore', description: 'Find the tests', color: 'blue' }))
    fake.fs.write(`${dir}/agent-b2.jsonl`, line(1))
    fake.fs.write(`${dir}/agent-c3.jsonl`, line(1), true)
    fake.fs.write(`${dir}/notes.txt`, 'x')
    fake.fs.write(`${dir}/workflows/run.json`, '{}')
    const first = await listSubagents(fake.host, PATH)
    expect(first).toEqual([
      { agentId: 'a1', size: size(line(1) + line(2)), mtimeMs: expect.any(Number), meta: { toolUseId: 'toolu_1', agentType: 'Explore', rawDescription: 'Find the tests' } },
      { agentId: 'b2', size: size(line(1)), mtimeMs: expect.any(Number) },
    ])
    fake.fs.write(`${dir}/agent-b2.meta.json`, JSON.stringify({ agentType: 'Plan' }))
    const before = fake.calls.length
    const next = await listSubagents(fake.host, PATH, first)
    expect(fake.calls.slice(before).filter((call) => call[0] === 'read')).toEqual([['read', `${dir}/agent-b2.meta.json`]])
    expect(next[1]?.meta).toEqual({ agentType: 'Plan' })
  })

  it('gives none when the folder is missing, and reads a meta file that did not parse again later', async () => {
    const fake = fakeHost()
    expect(await listSubagents(fake.host, PATH)).toEqual([])
    fake.fs.write(`${dir}/agent-a1.jsonl`, line(1))
    fake.fs.write(`${dir}/agent-a1.meta.json`, '{"agentType":')
    const first = await listSubagents(fake.host, PATH)
    expect(first[0]?.meta).toBeUndefined()
    fake.fs.write(`${dir}/agent-a1.meta.json`, '{"agentType":"Explore"}')
    expect((await listSubagents(fake.host, PATH, first))[0]?.meta).toEqual({ agentType: 'Explore' })
  })
})
