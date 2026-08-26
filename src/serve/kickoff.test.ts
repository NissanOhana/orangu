import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { suggestionIdV2, suggestionKey } from '../suggest/id.js'
import {
  TRANSITIONS,
  type Finding,
  type KickoffResponse,
  type SuggestionRecord,
  type SuggestionSource,
  type SuggestionStatus,
  type SuggestionStoreLike,
} from '../suggest/types.js'
import { kickoffRoutes, parseKickoffRequest } from './kickoff.js'
import { extraRoutes } from './routes-extra.js'
import type { Route, RouteMatch, ServeContext, ServeEvent, ServeOptions } from './types.js'

class MemStore implements SuggestionStoreLike {
  records = new Map<string, SuggestionRecord>()
  private clock = 1_000

  async all(): Promise<SuggestionRecord[]> {
    return [...this.records.values()]
  }

  async get(id: string): Promise<SuggestionRecord | undefined> {
    return this.records.get(id)
  }

  async upsertNew(finding: Finding, source: SuggestionSource): Promise<{ record: SuggestionRecord; created: boolean }> {
    const key = suggestionKey(finding, source)
    const id = suggestionIdV2(key)
    const existing = this.records.get(id)
    if (existing) return { record: existing, created: false }
    const record: SuggestionRecord = {
      id,
      v: 2,
      key,
      createdAt: this.clock,
      source,
      scope: finding.scope,
      sessionIds: key.sessionIds,
      ruleId: finding.ruleId,
      title: finding.title,
      evidence: finding.evidence,
      status: 'new',
      statusAt: this.clock++,
    }
    this.records.set(id, record)
    return { record, created: true }
  }

  async transition(
    id: string,
    to: SuggestionStatus,
    patch?: Partial<Pick<SuggestionRecord, 'proposal' | 'application' | 'verificationReceipt' | 'kickoff' | 'effect'>>,
  ): Promise<SuggestionRecord> {
    const current = this.records.get(id)
    if (!current) throw new Error(`not found: ${id}`)
    if (!(TRANSITIONS[current.status] ?? []).includes(to)) throw new Error(`illegal transition ${current.status} → ${to}`)
    const next = { ...current, ...patch, status: to, statusAt: this.clock++ }
    this.records.set(id, next)
    return next
  }
}

function makeContext(): { ctx: ServeContext; store: MemStore; events: ServeEvent[]; spawnCalls: unknown[] } {
  const store = new MemStore()
  const events: ServeEvent[] = []
  const spawnCalls: unknown[] = []
  const opts: ServeOptions = { open: false, includeText: false, noCache: true, version: 'test' }
  const ctx = {
    opts,
    registry: { list: () => [], analysis: async () => undefined, pin: () => {} },
    store,
    emit: (event: ServeEvent) => events.push(event),
    noteSuggestion: (record: SuggestionRecord) => events.push({ type: 'suggestion-updated', id: record.id, status: record.status }),
    now: () => 7_000,
    spawn: (...args: unknown[]) => {
      spawnCalls.push(args)
      throw new Error('copy-only route must never spawn')
    },
  } as unknown as ServeContext
  return { ctx, store, events, spawnCalls }
}

function fakeResponse(): { res: ServerResponse; state: { status: number; headers: Record<string, string>; body: string } } {
  const state = { status: 0, headers: {} as Record<string, string>, body: '' }
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      state.status = status
      Object.assign(state.headers, headers ?? {})
      return res
    },
    end(chunk?: string | Buffer) {
      if (chunk) state.body += chunk.toString()
      return res
    },
  }
  return { res: res as unknown as ServerResponse, state }
}

const request = {} as IncomingMessage

async function post(route: Route, body: unknown): Promise<{ status: number; json: KickoffResponse & { error?: string } }> {
  const { res, state } = fakeResponse()
  const match: RouteMatch = { params: {}, query: new URLSearchParams(), body }
  await route.handler(match, request, res)
  return { status: state.status, json: JSON.parse(state.body) as KickoffResponse & { error?: string } }
}

function routeFor(ctx: ServeContext): Route {
  const route = kickoffRoutes(ctx).find((candidate) => candidate.method === 'POST' && candidate.path === '/api/kickoff')
  if (!route) throw new Error('POST /api/kickoff not registered')
  return route
}

const finding: Finding = {
  ruleId: 'context-rereads',
  title: 'Re-read files pinned to CLAUDE.md',
  scope: 'session',
  sessionIds: ['session-1'],
  evidence: { estimated: true, savingsTokens: 12_000 },
}

describe('POST /api/kickoff copy-only boundary', () => {
  it('creates a deterministic record and returns the interactive handoff without spawning', async () => {
    const { ctx, store, spawnCalls } = makeContext()
    const response = await post(routeFor(ctx), { finding, mode: 'copy' })
    const id = suggestionIdV2(suggestionKey(finding, 'report'))

    expect(response.status).toBe(200)
    expect(response.json).toMatchObject({
      spawned: false,
      commands: { claude: `claude "/orangu:improve ${id}"`, codex: `$orangu-improve ${id}` },
      command: `claude "/orangu:improve ${id}"`,
    })
    expect(response.json.record).toMatchObject({ id, status: 'new', kickoff: { mode: 'serve' } })
    expect((await store.get(id))?.status).toBe('new')
    expect(spawnCalls).toHaveLength(0)
  })

  it('rejects run mode unconditionally', async () => {
    const { ctx, store, spawnCalls } = makeContext()
    const response = await post(routeFor(ctx), { finding, mode: 'run', confirm: true })

    expect(response.status).toBe(403)
    expect(response.json).toMatchObject({ spawned: false })
    expect(response.json.error).toMatch(/automatic model launch is disabled/)
    expect(response.json.command).toContain('/orangu:improve')
    expect((await store.get(response.json.record.id))?.status).toBe('new')
    expect(spawnCalls).toHaveLength(0)
  })

  it('scrubs suggestion fields before returning them to the browser', async () => {
    const { ctx, store } = makeContext()
    const secret = 'sk-ant-api03-abc123def456ghi789'
    const response = await post(routeFor(ctx), { finding: { ...finding, title: `Finding ${secret}` }, mode: 'copy' })
    expect(JSON.stringify(response.json)).not.toContain(secret)
    expect(JSON.stringify(response.json)).toContain('‹anthropic-key›')
    expect(JSON.stringify(await store.all())).toContain(secret)
  })

  it('rejects mismatched ids and malformed request shapes', async () => {
    const { ctx, spawnCalls } = makeContext()
    const route = routeFor(ctx)
    const badBodies = [
      undefined,
      { mode: 'copy' },
      { finding, mode: 'zap' },
      { finding, mode: 'copy', suggestionId: 'sg_wrong0000000' },
      { finding: { ...finding, sessionIds: [] }, mode: 'copy' },
      { finding: { ...finding, sessionIds: ['  '] }, mode: 'copy' },
      { finding: { ...finding, scope: 'planet' }, mode: 'copy' },
      { finding: { ...finding, insightId: 42 }, mode: 'copy' },
      { finding: { ...finding, ruleId: 'sk-ant-api03-abc123def456ghi789' }, mode: 'copy' },
      { finding: { ...finding, sessionIds: ['sk-ant-api03-abc123def456ghi789'] }, mode: 'copy' },
      { finding: { ...finding, cohortFingerprint: 'not-a-fingerprint' }, mode: 'copy' },
      { finding: { ...finding, cohortFingerprint: '1111111111111111' }, mode: 'copy' },
      { finding: { ...finding, scope: 'repo' }, mode: 'copy' },
      { finding: { ...finding, evidence: [] }, mode: 'copy' },
      { finding, mode: 'copy', confirm: 'yes' },
    ]
    for (const body of badBodies) expect((await post(route, body)).status).toBe(400)
    expect(spawnCalls).toHaveLength(0)
  })

  it('is registered through routes-extra', async () => {
    const { ctx } = makeContext()
    const route = extraRoutes.flatMap((factory) => factory(ctx)).find((candidate) => candidate.method === 'POST' && candidate.path === '/api/kickoff')
    expect(route).toBeDefined()
    expect((await post(route!, { finding, mode: 'copy' })).status).toBe(200)
  })
})

describe('parseKickoffRequest', () => {
  it('accepts only the bounded copy/run request contract', () => {
    expect(parseKickoffRequest({ finding, mode: 'copy' })).toMatchObject({ mode: 'copy', finding })
    expect(parseKickoffRequest({ finding, mode: 'run', confirm: true })).toMatchObject({ mode: 'run', confirm: true })
    expect(parseKickoffRequest({ finding: { ...finding, evidence: { estimated: 'yes' } }, mode: 'copy' })).toBeNull()
  })
})
