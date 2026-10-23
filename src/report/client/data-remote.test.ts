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
