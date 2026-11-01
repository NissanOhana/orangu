import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KickoffRequest, KickoffResponse, SuggestionRecord } from '../../suggest/types.js'
import { remoteBasePath, remoteSource } from './data-remote.js'

const request: KickoffRequest = {
  mode: 'copy',
  suggestionId: 'sg_test',
  finding: { ruleId: 'repeat', title: 'Repeated work', scope: 'repo', sessionIds: ['s1'], evidence: { estimated: false } },
}

const record = {
  id: 'sg_test',
  v: 2,
  createdAt: 0,
  source: 'report',
  scope: 'repo',
  sessionIds: ['s1'],
  ruleId: 'repeat',
  title: 'Repeated work',
  evidence: { estimated: false },
  status: 'new',
  statusAt: 0,
} as SuggestionRecord

const commands = { claude: 'claude "/orangu:improve sg_test"', codex: '$orangu-improve sg_test' }
const response = (over: Partial<KickoffResponse> = {}): KickoffResponse => ({ record, commands, command: commands.claude, spawned: false, ...over })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('remote kickoff transport', () => {
  it('derives an appendable authenticated base from the served shell path', () => {
    expect(remoteBasePath('/_orangu/token')).toBe('/_orangu/token')
    expect(remoteBasePath('/_orangu/token/')).toBe('/_orangu/token')
  })

  it('returns a successful copy handoff', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(response())))
    const result = await remoteSource('/local').kickoff(request)
    expect(result).toEqual({ ok: true, response: response() })
  })

  it('rejects a response that claims the localhost app spawned work', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...response(), spawned: true })))
    expect(await remoteSource().kickoff(request)).toMatchObject({ ok: false, kind: 'protocol' })
  })

  it('rejects missing or inconsistent host handoffs', async () => {
    const missing = response()
    delete (missing as Partial<KickoffResponse>).commands
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(missing)))
    expect(await remoteSource().kickoff(request)).toMatchObject({ ok: false, kind: 'protocol' })
    vi.mocked(fetch).mockResolvedValueOnce(json(response({ command: 'different' })))
    expect(await remoteSource().kickoff(request)).toMatchObject({ ok: false, kind: 'protocol' })
  })

  it('preserves a structured non-2xx body and status', async () => {
    const denied = response({ error: 'automatic model launch is disabled' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(denied, 403)))
    expect(await remoteSource().kickoff(request)).toEqual({ ok: false, kind: 'http', status: 403, message: denied.error, response: denied })
  })

  it('keeps a network failure distinct and never invents a command', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('loopback connection closed')))
    expect(await remoteSource().kickoff(request)).toEqual({ ok: false, kind: 'network', message: 'loopback connection closed' })
  })
})

// The app never sends a path: the read of this workspace names no cwd, so the route takes the --cwd of serve, and the
// read of every workspace sends only all=1.
describe('remote queue read', () => {
  const queue = { v: 1, scope: '~/code/demo', now: 0, globalOpen: 0, counts: {}, groups: {} }

  it('reads this workspace with no cwd, and every workspace with all=1 only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json(queue)))
    const source = remoteSource('/local')
    expect(await source.queue!()).toEqual(queue)
    expect(await source.queue!(true)).toEqual(queue)
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url))
    expect(urls).toEqual(['/local/api/queue', '/local/api/queue?all=1'])
    for (const url of urls) expect(url).not.toContain('cwd')
  })

  it('gives null for a failed read, so the app keeps its last good list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'the read failed' }, 500)))
    expect(await remoteSource('/local').queue!()).toBeNull()
  })
})

// The History and Lessons reads follow the same rule: no cwd for this workspace, and only all=1 for every workspace.
describe('remote history and lesson reads', () => {
  const history = [{ id: 'sg_0000000000c7', title: 'Read each file once' }]
  const lessons = { v: 1, scope: '~/code/demo', maxBytes: null, omitted: 0, lessons: [] }

  it('reads this workspace with no cwd, and every workspace with all=1 only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => json(url.includes('/api/history') ? history : lessons)))
    const source = remoteSource('/local')
    expect(await source.history!()).toEqual(history)
    expect(await source.history!(true)).toEqual(history)
    expect(await source.lessons!()).toEqual(lessons)
    expect(await source.lessons!(true)).toEqual(lessons)
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url))
    expect(urls).toEqual(['/local/api/history', '/local/api/history?all=1', '/local/api/lessons', '/local/api/lessons?all=1'])
    for (const url of urls) expect(url).not.toContain('cwd')
  })

  it('gives null for a failed read, so the app keeps its last good read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'the read failed' }, 500)))
    expect(await remoteSource('/local').history!()).toBeNull()
    expect(await remoteSource('/local').lessons!()).toBeNull()
  })
})

// The interview status of the start view: 1 GET with no query, and null when the read failed, so the app says so.
describe('remote profile read', () => {
  it('reads /api/profile with no query and gives its body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ exists: true, updatedAt: '2026-11-01' })))
    expect(await remoteSource('/local').profile!()).toEqual({ exists: true, updatedAt: '2026-11-01' })
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(['/local/api/profile'])
  })

  it('gives null for a failed read and for a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ error: 'the read failed' }, 500)))
    expect(await remoteSource('/local').profile!()).toBeNull()
    vi.mocked(fetch).mockRejectedValueOnce(new Error('loopback connection closed'))
    expect(await remoteSource('/local').profile!()).toBeNull()
  })
})

// The machine read of the start view: each 202 body reports how far the read is, and a read that stops says why.
describe('remote aggregate read with a watch', () => {
  it('reports the progress of each 202 body, then gives the 200 body', async () => {
    vi.useFakeTimers()
    try {
      const agg = { scope: 'global', sessionCount: 11 }
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(json({ progress: { done: 0, total: 11 } }, 202))
        .mockResolvedValueOnce(json({ progress: { done: 4, total: 11 } }, 202))
        .mockResolvedValueOnce(json(agg)))
      const progress = vi.fn()
      const failed = vi.fn()
      const read = remoteSource('/local').aggregate('global', undefined, { progress, failed })
      await vi.runAllTimersAsync()
      expect(await read).toEqual(agg)
      expect(progress.mock.calls).toEqual([[0, 11], [4, 11]])
      expect(failed).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says why a read stopped: the error of the server, its status, or a network failure', async () => {
    const failed = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ error: 'aggregate capacity reached' }, 503)))
    expect(await remoteSource('/local').aggregate('global', undefined, { failed })).toBeNull()
    vi.mocked(fetch).mockResolvedValueOnce(new Response('not json', { status: 500 }))
    expect(await remoteSource('/local').aggregate('global', undefined, { failed })).toBeNull()
    vi.mocked(fetch).mockRejectedValueOnce(new Error('loopback connection closed'))
    expect(await remoteSource('/local').aggregate('global', undefined, { failed })).toBeNull()
    expect(failed.mock.calls).toEqual([['aggregate capacity reached'], ['The server answered 500.'], ['The request to localhost failed.']])
  })

  it('reads as before with no watch: null on a failure, and no call of any watch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'aggregate capacity reached' }, 503)))
    expect(await remoteSource('/local').aggregate('repo', '~/w')).toBeNull()
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(['/local/api/repo?cwd=~%2Fw'])
  })
})

// The Dismiss write: the body holds the status and 1 reason code of the fixed list, or no reason. It holds no text of
// the person and no path, and a failed write gives null, so the app never shows it as done.
describe('remote status write', () => {
  const rejected = { ...record, status: 'rejected', reasonCode: 'wrong-cause' }

  it('posts the status and the reason code, and nothing else', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(rejected)))
    expect(await remoteSource('/local').setStatus('sg_test', 'rejected', 'wrong-cause')).toEqual(rejected)
    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe('/local/api/suggestions/sg_test/status')
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } })
    expect(JSON.parse(String(init?.body))).toEqual({ status: 'rejected', reason: 'wrong-cause' })
  })

  it('posts no reason key when no code is given', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(rejected)))
    await remoteSource('/local').setStatus('sg_test', 'rejected')
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({ status: 'rejected' })
  })

  it('gives null for a refused write, a broken body and a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ error: 'reason must be 1 of the codes' }, 400)))
    expect(await remoteSource('/local').setStatus('sg_test', 'rejected', 'other')).toBeNull()
    vi.mocked(fetch).mockResolvedValueOnce(new Response('not json', { status: 200 }))
    expect(await remoteSource('/local').setStatus('sg_test', 'rejected', 'other')).toBeNull()
    vi.mocked(fetch).mockRejectedValueOnce(new Error('loopback connection closed'))
    expect(await remoteSource('/local').setStatus('sg_test', 'rejected', 'other')).toBeNull()
  })
})
