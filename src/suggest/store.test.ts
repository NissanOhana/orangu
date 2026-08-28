import { describe, it, expect, beforeEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SuggestionStore } from './store.js'
import { suggestionId, suggestionIdV2, suggestionKey } from './id.js'
import type { Finding, SuggestionApplicationReceipt, SuggestionProposal, SuggestionRecord } from './types.js'

interface StoreWorkerMessage {
  type: string
  ok?: boolean
  error?: string
}

function waitForWorkerMessage(child: ChildProcess, type: string, timeoutMs = 8_000): Promise<StoreWorkerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for child message ${type}`))
    }, timeoutMs)
    const onMessage = (value: unknown): void => {
      if (!value || typeof value !== 'object' || (value as StoreWorkerMessage).type !== type) return
      cleanup()
      resolve(value as StoreWorkerMessage)
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      reject(new Error(`child exited before ${type}: ${code ?? signal ?? 'unknown'}`))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    child.on('message', onMessage)
    child.on('error', onError)
    child.on('exit', onExit)
  })
}

function waitForWorkerExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

const finding = (over: Partial<Finding> = {}): Finding => ({
  ruleId: 'reread-files',
  title: 'The same file was re-read 14 times',
  scope: 'session',
  sessionIds: ['sess-b', 'sess-a'],
  evidence: { savingsTokens: 12_000, estimated: true },
  ...over,
})

function structuredProposal(id: string, files = ['src/a.ts']): SuggestionProposal {
  return {
    v: 1,
    title: 'Reviewed change',
    change: 'Change only reviewed files.',
    effort: 'S',
    files,
    proposalPath: join(home, 'proposals', `${id}.md`),
    manifestPath: join(home, 'proposals', `${id}.json`),
    changeClass: 'script-cli',
    evidence: 'A supported baseline exposed the issue.',
    expectedEffect: 'A later supported session improves.',
    risk: 'The change may need maintenance.',
    verification: 'Compare supported later sessions.',
    verificationChecks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
    workspace: { cwd: '/workspace/project', device: '1', inode: '2' },
  }
}

function applicationReceipt(id: string, files = ['src/a.ts']): SuggestionApplicationReceipt {
  return {
    v: 1,
    summary: 'Changed the reviewed files.',
    files,
    checks: [{ name: 'tests', ok: true }],
    receiptPath: join(home, 'proposals', `${id}.applied.json`),
  }
}

let home: string
let clock: number
let store: SuggestionStore

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orangu-store-'))
  clock = 1_000
  store = new SuggestionStore({ home, now: () => ++clock })
})

describe('SuggestionStore', () => {
  it('creates a new record with a stable id regardless of session order', async () => {
    const a = await store.upsertNew(finding({ sessionIds: ['sess-b', 'sess-a'] }), 'report')
    const b = new SuggestionStore({ home: mkdtempSync(join(tmpdir(), 'orangu-store2-')), now: () => 99 })
    const other = await b.upsertNew(finding({ sessionIds: ['sess-a', 'sess-b'] }), 'report')
    expect(a.created).toBe(true)
    expect(a.record.id).toBe(other.record.id)
    expect(a.record.status).toBe('new')
    expect(a.record.v).toBe(2)
    expect(a.record.key).toEqual(suggestionKey(finding(), 'report'))
    expect(a.record.sessionIds).toEqual(['sess-a', 'sess-b'])
  })

  it('v2 scope and insight identity cannot collide', async () => {
    const session = await store.upsertNew(finding({ scope: 'session', insightId: 'i-1' }), 'report')
    const repo = await store.upsertNew(finding({ scope: 'repo', insightId: 'i-1', cohortFingerprint: '1111111111111111' }), 'report')
    const otherInsight = await store.upsertNew(finding({ scope: 'session', insightId: 'i-2' }), 'report')
    expect(new Set([session.record.id, repo.record.id, otherInsight.record.id]).size).toBe(3)
  })

  it('binds recurring records to the full aggregate cohort and disables lossy legacy ids', async () => {
    const firstFinding = finding({ scope: 'repo', cohortFingerprint: '1111111111111111' })
    const grownFinding = finding({ scope: 'repo', cohortFingerprint: '2222222222222222' })
    const first = await store.upsertNew(firstFinding, 'report')
    const grown = await store.upsertNew(grownFinding, 'report')
    expect(first.record.id).not.toBe(grown.record.id)
    expect(first.record.cohortFingerprint).toBe(firstFinding.cohortFingerprint)
    const lossyLegacy = suggestionId('report', firstFinding.ruleId, firstFinding.sessionIds)
    await expect(store.upsertNew(firstFinding, 'report', lossyLegacy)).rejects.toThrow(/identity mismatch/)
  })

  it('rejects secrets in canonical identity fields before hashing or persistence', async () => {
    await expect(store.upsertNew(finding({ ruleId: 'sk-ant-api03-abc123def456ghi789' }), 'report')).rejects.toThrow(/sensitive material/)
    await expect(store.upsertNew(finding({ sessionIds: ['sk-ant-api03-abc123def456ghi789'] }), 'report')).rejects.toThrow(/sensitive material/)
    expect(existsSync(join(home, 'suggestions.jsonl'))).toBe(false)
  })

  it('is append-only: every mutation adds a line and the last line per id wins', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    await store.transition(record.id, 'kicked-off', { kickoff: { mode: 'serve', command: 'claude "/orangu:suggest x"' } })
    await store.transition(record.id, 'proposed', { proposal: { title: 't', change: 'c', effort: 'S', proposalPath: join(home, 'proposals', record.id + '.md') } })
    const lines = readFileSync(join(home, 'suggestions.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    const current = await store.get(record.id)
    expect(current!.status).toBe('proposed')
    expect(current!.kickoff?.mode).toBe('serve')
    expect(current!.proposal?.effort).toBe('S')
  })

  it('separates an unterminated crash-tail before appending and replays the next transition', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    appendFileSync(store.path, '{"crash_partial":')

    const kicked = await store.transition(record.id, 'kicked-off')
    expect(kicked.status).toBe('kicked-off')
    const lines = readFileSync(store.path, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe('{"crash_partial":')
    expect(JSON.parse(lines[0]!).status).toBe('new')
    expect(JSON.parse(lines[2]!).status).toBe('kicked-off')

    const fresh = new SuggestionStore({ home, now: () => 9_000 })
    await expect(fresh.get(record.id)).resolves.toMatchObject({ status: 'kicked-off' })
  })

  it('re-click refreshes a new finding but preserves a lifecycle transition timestamp', async () => {
    const first = await store.upsertNew(finding(), 'report')
    const refreshedFinding = finding({ title: 'Updated live finding', evidence: { estimated: true, sessions: 4, live: true } })
    const refreshed = await store.upsertNew(refreshedFinding, 'report')
    expect(refreshed.record.statusAt).toBeGreaterThan(first.record.statusAt)
    expect(refreshed.record.title).toBe('Updated live finding')
    expect(refreshed.record.evidence).toEqual({ estimated: true, sessions: 4, live: true })
    await store.transition(first.record.id, 'kicked-off')
    const transitionedAt = (await store.get(first.record.id))!.statusAt
    const again = await store.upsertNew(finding({ title: 'Must not replace started work', evidence: { estimated: true, sessions: 99 } }), 'report')
    expect(again.created).toBe(false)
    expect(again.record.status).toBe('kicked-off')
    expect(again.record.createdAt).toBe(first.record.createdAt)
    expect(again.record.statusAt).toBe(transitionedAt)
    expect(again.record.title).toBe('Updated live finding')
    expect(again.record.evidence).toEqual({ estimated: true, sessions: 4, live: true })
  })

  it('an identical re-upsert of a new record appends nothing (orangu report twice = one line)', async () => {
    const first = await store.upsertNew(finding(), 'report')
    expect(first.created).toBe(true)
    // same title, same evidence entries in another key order: still the same finding
    const again = await store.upsertNew(finding({ evidence: { estimated: true, savingsTokens: 12_000 } }), 'report')
    expect(again.created).toBe(false)
    expect(again.record).toEqual(first.record)
    expect(readFileSync(store.path, 'utf8').trim().split('\n')).toHaveLength(1)
    // a changed title still refreshes (and appends)
    const changed = await store.upsertNew(finding({ title: 'Read 15 times now' }), 'report')
    expect(changed.record.title).toBe('Read 15 times now')
    expect(changed.record.statusAt).toBeGreaterThan(first.record.statusAt)
    expect(readFileSync(store.path, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('throws on illegal transitions (new → verified) and unknown ids', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    await expect(store.transition(record.id, 'verified')).rejects.toThrow(/illegal transition new → verified/)
    await expect(store.transition('sg_nope', 'rejected')).rejects.toThrow(/not found/)
  })

  it('rejected is terminal; failed can be re-kicked', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    await store.transition(record.id, 'kicked-off')
    await store.transition(record.id, 'failed', { kickoff: { mode: 'serve', command: 'x', exitCode: 1 } })
    const rekicked = await store.transition(record.id, 'kicked-off')
    expect(rekicked.status).toBe('kicked-off')
    await store.transition(record.id, 'rejected')
    await expect(store.transition(record.id, 'kicked-off')).rejects.toThrow(/illegal/)
  })

  it('skips corrupt lines and keeps going', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    appendFileSync(join(home, 'suggestions.jsonl'), '{ this is not json\n')
    appendFileSync(join(home, 'suggestions.jsonl'), JSON.stringify({ ...record, id: '$(untrusted)', status: 'new' }) + '\n')
    await store.transition(record.id, 'kicked-off')
    const all = await store.all()
    expect(all).toHaveLength(1)
    expect(all[0]!.status).toBe('kicked-off')
  })

  it('skips structurally malformed records before indexing legacy ids', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    appendFileSync(store.path, JSON.stringify({ ...record, legacyIds: 1, statusAt: record.statusAt + 1 }) + '\n')

    await expect(store.all()).resolves.toEqual([record])
    await expect(store.transition(record.id, 'kicked-off')).resolves.toMatchObject({ status: 'kicked-off' })
  })

  it('upsertNew honours only the matching legacy report id (file-mode kickoff parity)', async () => {
    const legacyId = suggestionId('report', finding().ruleId, finding().sessionIds)
    const first = await store.upsertNew(finding(), 'report', legacyId)
    expect(first.created).toBe(true)
    expect(first.record.id).toBe(legacyId)
    expect(first.record.v).toBe(1)
    const again = await store.upsertNew(finding(), 'report', legacyId)
    expect(again.created).toBe(false)
    expect(again.record.id).toBe(legacyId)
    await expect(store.upsertNew(finding(), 'report', 'sg_0123456789ab')).rejects.toThrow(/identity mismatch/)
    await expect(store.upsertNew(finding(), 'skill', legacyId)).rejects.toThrow(/identity mismatch/)
  })

  it('migrates a matching v1 record to v2 without losing lifecycle state and keeps the old id addressable', async () => {
    const f = finding()
    const oldId = suggestionId('report', f.ruleId, f.sessionIds)
    const proposal = { title: 'Existing proposal', change: 'Keep this', effort: 'S' as const, proposalPath: join(home, 'proposals', `${oldId}.md`) }
    const legacy: SuggestionRecord = {
      id: oldId,
      v: 1,
      createdAt: 10,
      source: 'report',
      scope: f.scope,
      sessionIds: [...f.sessionIds].sort(),
      ruleId: f.ruleId,
      title: 'Lossy legacy title',
      evidence: { estimated: true },
      proposal,
      status: 'proposed',
      statusAt: 20,
    }
    appendFileSync(join(home, 'suggestions.jsonl'), JSON.stringify(legacy) + '\n')

    const migrated = await store.upsertNew(f, 'report')
    const expectedId = suggestionIdV2(suggestionKey(f, 'report'))
    expect(migrated.created).toBe(false)
    expect(migrated.record).toMatchObject({ id: expectedId, v: 2, status: 'proposed', proposal, title: f.title, evidence: f.evidence })
    expect(migrated.record.statusAt).toBe(20)
    expect(migrated.record.legacyIds).toContain(oldId)
    expect((await store.get(oldId))?.id).toBe(expectedId)
    expect((await store.all()).map((r) => r.id)).toEqual([expectedId])

    await expect(store.transition(oldId, 'applied')).rejects.toThrow(/structured proposal/)
    const rejected = await store.transition(oldId, 'rejected')
    expect(rejected.id).toBe(expectedId)
    expect((await store.get(oldId))?.status).toBe('rejected')
  })

  it('does not migrate a v1 scope collision into a different v2 finding', async () => {
    const sessionFinding = finding({ scope: 'session' })
    const legacyId = suggestionId('report', sessionFinding.ruleId, sessionFinding.sessionIds)
    await store.upsertNew(sessionFinding, 'report', legacyId)
    await store.transition(legacyId, 'rejected')

    const repoFinding = finding({ scope: 'repo', cohortFingerprint: '1111111111111111' })
    const repo = await store.upsertNew(repoFinding, 'report')
    expect(repo.created).toBe(true)
    expect(repo.record.status).toBe('new')
    expect(repo.record.id).not.toBe(legacyId)
    expect((await store.get(legacyId))?.status).toBe('rejected')
    expect(await store.all()).toHaveLength(2)
  })

  it('honours ORANGU_HOME layout: suggestions.jsonl + proposals/ under home', async () => {
    await store.upsertNew(finding(), 'skill')
    expect(store.path).toBe(join(home, 'suggestions.jsonl'))
    expect(store.proposalsDir).toBe(join(home, 'proposals'))
  })

  it('checks every existing-record identity field before refreshing it', async () => {
    const f = finding({ insightId: 'expected-insight' })
    const mismatches: Array<[string, Partial<SuggestionRecord>]> = [
      ['source', { source: 'skill' }],
      ['scope', { scope: 'global' }],
      ['rule', { ruleId: 'other-rule' }],
      ['sessions', { sessionIds: ['other-session'] }],
      ['insight', { insightId: 'other-insight' }],
    ]
    for (const [label, mismatch] of mismatches) {
      const isolatedHome = mkdtempSync(join(tmpdir(), `orangu-identity-${label}-`))
      const isolatedStore = new SuggestionStore({ home: isolatedHome, now: () => 99 })
      const id = suggestionIdV2(suggestionKey(f, 'report'))
      const hijacked: SuggestionRecord = {
        id,
        v: 2,
        key: suggestionKey(f, 'report'),
        createdAt: 10,
        source: 'report',
        scope: f.scope,
        sessionIds: f.sessionIds,
        ruleId: f.ruleId,
        title: 'Attacker-controlled record',
        insightId: f.insightId,
        evidence: { estimated: true },
        status: 'new',
        statusAt: 20,
        ...mismatch,
      }
      appendFileSync(join(isolatedHome, 'suggestions.jsonl'), JSON.stringify(hijacked) + '\n')

      await expect(isolatedStore.upsertNew(f, 'report'), label).rejects.toThrow(/belongs to a different finding/)
      const lines = readFileSync(join(isolatedHome, 'suggestions.jsonl'), 'utf8').trim().split('\n')
      expect(lines, label).toHaveLength(1)
      expect(JSON.parse(lines[0]!).statusAt, label).toBe(20)
    }
  })

  it('rejects unsafe Windows aliases and missing or duplicate verification plans at the store boundary', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    await store.transition(record.id, 'kicked-off')
    for (const unsafe of [
      'src/file.',
      'src/file ',
      'src/data:stream',
      'src/.git.',
      'src/CON',
      'src/prn.txt',
      'src/COM1.log',
      'src/LPT9',
      'src//a.ts',
      'src/./a.ts',
      './src/a.ts',
      'src/a.ts/',
      'src/a\n.ts',
      'src\\a.ts',
    ]) {
      await expect(
        store.transition(record.id, 'proposed', { proposal: structuredProposal(record.id, [unsafe]) }),
        unsafe,
      ).rejects.toThrow(/structured proposal/)
    }

    const missingChecks = structuredProposal(record.id)
    delete missingChecks.verificationChecks
    await expect(store.transition(record.id, 'proposed', { proposal: missingChecks })).rejects.toThrow(/verificationChecks/)
    await expect(
      store.transition(record.id, 'proposed', {
        proposal: {
          ...structuredProposal(record.id),
          verificationChecks: [
            { metric: 'avgToolCalls', comparison: 'decreased' },
            { metric: 'avgToolCalls', comparison: 'decreased' },
          ],
        },
      }),
    ).rejects.toThrow(/verificationChecks/)
    await expect(
      store.transition(record.id, 'proposed', { proposal: structuredProposal(record.id, ['SRC/a.ts', 'src/a.ts']) }),
    ).rejects.toThrow(/structured proposal/)
  })

  it('accepts only canonical catalog/research/inference provenance at the store boundary', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    await store.transition(record.id, 'kicked-off')
    const spoofed = structuredProposal(record.id)
    spoofed.sources = [
      {
        kind: 'catalog',
        label: 'catalog: fix-reread-files',
        url: 'https://evil.example/source',
        verifiedAt: '2026-08-23',
      },
    ]
    await expect(store.transition(record.id, 'proposed', { proposal: spoofed })).rejects.toThrow(/structured proposal/)

    const canonical = structuredProposal(record.id)
    canonical.sources = [
      {
        kind: 'catalog',
        label: 'catalog: fix-reread-files',
        url: 'https://code.claude.com/docs/en/memory.md',
        verifiedAt: '2026-08-23',
      },
      { kind: 'research', label: 'Checked guide', url: 'https://example.com/guide', verifiedAt: '2026-08-26' },
      { kind: 'inference', label: 'Reasoned from bounded evidence' },
    ]
    await expect(store.transition(record.id, 'proposed', { proposal: canonical })).resolves.toMatchObject({ status: 'proposed' })
  })

  it('enforces global apply and aggregate verification scope contracts in direct store use', async () => {
    const global = await store.upsertNew(finding({ scope: 'global', cohortFingerprint: '1111111111111111' }), 'report')
    await store.transition(global.record.id, 'kicked-off')
    await store.transition(global.record.id, 'proposed', { proposal: structuredProposal(global.record.id) })
    await expect(
      store.transition(global.record.id, 'applied', { application: applicationReceipt(global.record.id) }),
    ).rejects.toThrow(/global suggestions cannot be applied.*repo- or session-scoped/)

    const repo = await store.upsertNew(finding({ scope: 'repo', cohortFingerprint: '2222222222222222' }), 'report')
    await store.transition(repo.record.id, 'kicked-off')
    await store.transition(repo.record.id, 'proposed', { proposal: structuredProposal(repo.record.id) })
    await store.transition(repo.record.id, 'applied', { application: applicationReceipt(repo.record.id) })
    await expect(store.transition(repo.record.id, 'verified')).rejects.toThrow(/repo\/global suggestions cannot be verified.*session-scoped/)
  })

  it.skipIf(process.platform === 'win32')('hardens Orangu state directories and JSONL to private POSIX modes', async () => {
    await store.upsertNew(finding(), 'report')
    chmodSync(home, 0o777)
    chmodSync(store.proposalsDir, 0o777)
    chmodSync(store.path, 0o666)

    await store.all()

    expect(statSync(home).mode & 0o777).toBe(0o700)
    expect(statSync(store.proposalsDir).mode & 0o777).toBe(0o700)
    expect(statSync(store.path).mode & 0o777).toBe(0o600)

    chmodSync(home, 0o777)
    chmodSync(store.proposalsDir, 0o777)
    chmodSync(store.path, 0o666)
    await store.upsertNew(finding({ title: 'Refresh and harden' }), 'report')
    expect(statSync(home).mode & 0o777).toBe(0o700)
    expect(statSync(store.proposalsDir).mode & 0o777).toBe(0o700)
    expect(statSync(store.path).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked state root without changing its target', async () => {
    const container = mkdtempSync(join(tmpdir(), 'orangu-store-root-link-'))
    const outside = join(container, 'outside')
    const linkedHome = join(container, 'linked-home')
    mkdirSync(outside, { mode: 0o755 })
    chmodSync(outside, 0o755)
    const marker = join(outside, 'keep.txt')
    writeFileSync(marker, 'outside bytes stay unchanged')
    symlinkSync(outside, linkedHome, 'dir')
    const before = readFileSync(marker)
    const beforeMode = statSync(outside).mode & 0o777

    const linked = new SuggestionStore({ home: linkedHome })
    await expect(linked.upsertNew(finding(), 'report')).rejects.toThrow(/suggestion store directory must be a real directory/)

    expect(readFileSync(marker)).toEqual(before)
    expect(statSync(outside).mode & 0o777).toBe(beforeMode)
    expect(existsSync(join(outside, 'suggestions.jsonl'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked JSONL without changing its target bytes or mode', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'orangu-store-file-link-'))
    const outside = join(outsideDir, 'outside.jsonl')
    writeFileSync(outside, 'outside bytes stay unchanged\n')
    chmodSync(outside, 0o644)
    symlinkSync(outside, store.path)
    const before = readFileSync(outside)
    const beforeMode = statSync(outside).mode & 0o777

    await expect(store.upsertNew(finding(), 'report')).rejects.toThrow(/suggestion store must not be a symbolic link/)

    expect(readFileSync(outside)).toEqual(before)
    expect(statSync(outside).mode & 0o777).toBe(beforeMode)
    expect(lstatSync(store.path).isSymbolicLink()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('rejects a hard-linked JSONL without changing its target bytes or mode', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'orangu-store-file-hardlink-'))
    const outside = join(outsideDir, 'outside.jsonl')
    writeFileSync(outside, 'outside hard-link bytes stay unchanged\n')
    chmodSync(outside, 0o644)
    linkSync(outside, store.path)
    const before = readFileSync(outside)
    const beforeMode = statSync(outside).mode & 0o777

    await expect(store.upsertNew(finding(), 'report')).rejects.toThrow(/suggestion store must have exactly one hard link/)

    expect(readFileSync(outside)).toEqual(before)
    expect(statSync(outside).mode & 0o777).toBe(beforeMode)
    expect(statSync(outside).nlink).toBe(2)
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked lock without changing its target', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'orangu-store-lock-link-'))
    const marker = join(outside, 'keep.txt')
    writeFileSync(marker, 'outside lock bytes stay unchanged')
    chmodSync(outside, 0o755)
    const lock = `${store.path}.lock`
    symlinkSync(outside, lock, 'dir')
    const before = readFileSync(marker)
    const beforeMode = statSync(outside).mode & 0o777

    await expect(store.upsertNew(finding(), 'report')).rejects.toThrow(/suggestion store lock must be a real directory/)

    expect(readFileSync(marker)).toEqual(before)
    expect(statSync(outside).mode & 0o777).toBe(beforeMode)
    expect(lstatSync(lock).isSymbolicLink()).toBe(true)
  })

  it('rejects a non-regular or oversized suggestion store instead of replaying it', async () => {
    mkdirSync(store.path)
    await expect(store.all()).rejects.toThrow(/suggestion store must be a regular file/)

    const lockHome = mkdtempSync(join(tmpdir(), 'orangu-store-lock-file-'))
    const lockStore = new SuggestionStore({ home: lockHome })
    writeFileSync(`${lockStore.path}.lock`, 'not a directory')
    await expect(lockStore.upsertNew(finding(), 'report')).rejects.toThrow(/suggestion store lock must be a real directory/)

    const otherHome = mkdtempSync(join(tmpdir(), 'orangu-store-oversized-'))
    const oversized = new SuggestionStore({ home: otherHome })
    writeFileSync(oversized.path, '')
    truncateSync(oversized.path, 64 * 1024 * 1024 + 1)
    await expect(oversized.all()).rejects.toThrow(/suggestion store exceeds 67108864 bytes/)

    const tooManyLinesHome = mkdtempSync(join(tmpdir(), 'orangu-store-lines-'))
    const tooManyLines = new SuggestionStore({ home: tooManyLinesHome })
    writeFileSync(tooManyLines.path, Buffer.alloc(100_001, 0x0a))
    await expect(tooManyLines.all()).rejects.toThrow(/suggestion store exceeds 100000 lines/)

    const longRecordHome = mkdtempSync(join(tmpdir(), 'orangu-store-record-'))
    const longRecord = new SuggestionStore({ home: longRecordHome })
    writeFileSync(longRecord.path, '')
    truncateSync(longRecord.path, 4 * 1024 * 1024 + 1)
    await expect(longRecord.all()).rejects.toThrow(/suggestion store record exceeds 4194304 bytes/)
  })

  it('enforces lifecycle artifacts and rejects unrelated patch fields inside the lock', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    await store.transition(record.id, 'kicked-off')
    await expect(store.transition(record.id, 'proposed')).rejects.toThrow(/proposal is required/)
    await expect(
      store.transition(record.id, 'proposed', { kickoff: { mode: 'serve', command: 'not a proposal' } } as never),
    ).rejects.toThrow(/not valid for this transition/)

    const proposalPath = join(home, 'proposals', `${record.id}.md`)
    const manifestPath = join(home, 'proposals', `${record.id}.json`)
    await expect(
      store.transition(record.id, 'proposed', {
        proposal: {
          v: 1,
          title: 'Unsafe change',
          change: 'Modify repository metadata.',
          effort: 'S',
          files: ['.GiT/config'],
          proposalPath,
          manifestPath,
          changeClass: 'script-cli',
          evidence: 'Unsafe input.',
          expectedEffect: 'None.',
          risk: 'Repository compromise.',
          verification: 'Do not run.',
          verificationChecks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
        },
      }),
    ).rejects.toThrow(/structured proposal/)
    await store.transition(record.id, 'proposed', {
      proposal: {
        v: 1,
        title: 'Reviewed change',
        change: 'Change only the two named files.',
        effort: 'S',
        files: ['src/a.ts', 'src/b.ts'],
        proposalPath,
        manifestPath,
        changeClass: 'script-cli',
        evidence: 'The baseline repeated an unreliable operation.',
        expectedEffect: 'The next run uses the deterministic path.',
        risk: 'The script may need maintenance.',
        verification: 'Compare supported later sessions.',
        verificationChecks: [{ metric: 'avgToolCalls', comparison: 'decreased' }],
        workspace: { cwd: '/workspace/project', device: '1', inode: '2' },
      },
    })
    await expect(store.transition(record.id, 'applied')).rejects.toThrow(/application receipt is required/)
    await expect(
      store.transition(record.id, 'applied', {
        application: {
          v: 1,
          summary: 'Changed one unreviewed file.',
          files: ['src/a.ts', 'src/c.ts'],
          checks: [{ name: 'tests', ok: true }],
          receiptPath: join(home, 'proposals', `${record.id}.applied.json`),
        },
      }),
    ).rejects.toThrow(/exactly match/)

    await store.transition(record.id, 'applied', {
      application: {
        v: 1,
        summary: 'Changed the reviewed files.',
        files: ['src/b.ts', 'src/a.ts'],
        checks: [{ name: 'tests', ok: true }],
        receiptPath: join(home, 'proposals', `${record.id}.applied.json`),
      },
    })
    await expect(store.transition(record.id, 'verified')).rejects.toThrow(/verification receipt is required/)
    await expect(
      store.transition(record.id, 'verified', {
        application: {
          v: 1,
          summary: 'Replacement receipt',
          files: ['src/a.ts', 'src/b.ts'],
          checks: [{ name: 'tests', ok: true }],
          receiptPath: '/tmp/replacement.json',
        },
      } as never),
    ).rejects.toThrow(/not valid for this transition/)
    const verificationReceipt = {
      v: 1 as const,
      summary: 'Later-session comparison passed: avgToolCalls decreased.',
      measuredSessionIds: ['later-session'],
      checks: [
        {
          name: 'avgToolCalls decreased',
          metric: 'avgToolCalls' as const,
          comparison: 'decreased' as const,
          before: 12,
          after: 8,
          evidence: 'avgToolCalls: 12 → 8 (decreased)',
          ok: true as const,
        },
      ],
      receiptPath: join(home, 'proposals', `${record.id}.verified.json`),
    }
    await expect(store.transition(record.id, 'verified', { verificationReceipt })).rejects.toThrow(/effect is required/)
    await expect(
      store.transition(record.id, 'verified', {
        verificationReceipt,
        effect: { before: { avgToolCalls: 999 }, after: { avgToolCalls: 0 }, measuredSessionIds: ['later-session'] },
      }),
    ).rejects.toThrow(/must exactly match/)
    const movedGoalposts = {
      ...verificationReceipt,
      summary: 'Later-session comparison passed: avgToolCalls not-increased.',
      checks: [
        {
          ...verificationReceipt.checks[0]!,
          name: 'avgToolCalls not-increased',
          comparison: 'not-increased' as const,
        },
      ],
    }
    await expect(
      store.transition(record.id, 'verified', {
        verificationReceipt: movedGoalposts,
        effect: { before: { avgToolCalls: 12 }, after: { avgToolCalls: 8 }, measuredSessionIds: ['later-session'] },
      }),
    ).rejects.toThrow(/exactly match the reviewed proposal verificationChecks/)
    const verified = await store.transition(record.id, 'verified', {
      verificationReceipt,
      effect: { before: { avgToolCalls: 12 }, after: { avgToolCalls: 8 }, measuredSessionIds: ['later-session'] },
    })
    expect(verified.status).toBe('verified')
    expect(verified.verificationTrust).toBe('computed-v1')
  })

  it('does not allow a patch object to overwrite record identity or status', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    await expect(store.transition(record.id, 'rejected', { id: 'sg_000000000000', status: 'verified' } as never)).rejects.toThrow(
      /field "id" is not a lifecycle artifact/,
    )
    await expect(store.transition(record.id, 'rejected', { verificationTrust: 'computed-v1' } as never)).rejects.toThrow(
      /field "verificationTrust" is not a lifecycle artifact/,
    )
    expect((await store.get(record.id))?.status).toBe('new')
  })

  it('does not retrofit the computed verification marker onto replayed legacy records', async () => {
    const f = finding()
    const id = suggestionIdV2(suggestionKey(f, 'report'))
    const legacyVerified: SuggestionRecord = {
      id,
      v: 2,
      key: suggestionKey(f, 'report'),
      createdAt: 10,
      source: 'report',
      ...f,
      status: 'verified',
      statusAt: 20,
    }
    appendFileSync(join(home, 'suggestions.jsonl'), `${JSON.stringify(legacyVerified)}\n`)
    expect((await store.get(id))?.verificationTrust).toBeUndefined()
  })
})

describe('SuggestionStore write serialization', () => {
  it('two concurrent transitions from the same state append exactly once', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    // both are new → rejected; without serialization both replay `new` and both append
    const results = await Promise.allSettled([store.transition(record.id, 'rejected'), store.transition(record.id, 'rejected')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    const lines = readFileSync(join(home, 'suggestions.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2) // create + the single winning transition
    expect((await store.get(record.id))!.status).toBe('rejected')
  })

  it('a rejected suggestion cannot be resurrected by a concurrent kicked-off transition', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    // FIFO queue: rejected runs first, so kicked-off must re-replay and see the terminal state
    const results = await Promise.allSettled([store.transition(record.id, 'rejected'), store.transition(record.id, 'kicked-off')])
    expect(results[0]!.status).toBe('fulfilled')
    expect(results[1]!.status).toBe('rejected')
    expect((await store.get(record.id))!.status).toBe('rejected')
  })

  it('two store instances on the same home (two writers) are serialized by the lockfile', async () => {
    const other = new SuggestionStore({ home, now: () => 9_000 })
    const { record } = await store.upsertNew(finding(), 'report')
    const results = await Promise.allSettled([store.transition(record.id, 'rejected'), other.transition(record.id, 'rejected')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const lines = readFileSync(join(home, 'suggestions.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect((await store.get(record.id))!.status).toBe('rejected')
  })

  it('a stale lock (dead writer) is broken instead of deadlocking', async () => {
    const { record } = await store.upsertNew(finding(), 'report')
    const lock = join(home, 'suggestions.jsonl.lock')
    mkdirSync(lock)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    const rec = await store.transition(record.id, 'kicked-off')
    expect(rec.status).toBe('kicked-off')
    expect(existsSync(lock)).toBe(false) // released after the write
  })

  it('does not break a live stale lock and refuses a paused writer after ownership loss', async () => {
    const moduleUrl = new URL('./store.ts', import.meta.url).href
    const sharedFinding = JSON.stringify(finding())
    const pausedScript = `
      import { SuggestionStore } from ${JSON.stringify(moduleUrl)}
      const store = new SuggestionStore({ home: ${JSON.stringify(home)}, now: () => 2_000 })
      const acquire = store.acquireLock.bind(store)
      store.acquireLock = async () => {
        const guard = await acquire()
        process.send?.({ type: 'locked' })
        await new Promise((resolve) => process.once('message', resolve))
        return guard
      }
      try {
        await store.upsertNew(${sharedFinding}, 'report')
        process.send?.({ type: 'result', ok: true })
      } catch (error) {
        process.send?.({ type: 'result', ok: false, error: error instanceof Error ? error.message : String(error) })
      } finally {
        process.disconnect?.()
      }
    `
    const contenderScript = `
      import { SuggestionStore } from ${JSON.stringify(moduleUrl)}
      const store = new SuggestionStore({ home: ${JSON.stringify(home)}, now: () => 3_000 })
      const acquire = store.acquireLock.bind(store)
      store.acquireLock = async () => {
        const guard = await acquire()
        process.send?.({ type: 'acquired' })
        await new Promise((resolve) => process.once('message', resolve))
        return guard
      }
      process.send?.({ type: 'started' })
      try {
        await store.upsertNew(${sharedFinding}, 'report')
        process.send?.({ type: 'result', ok: true })
      } catch (error) {
        process.send?.({ type: 'result', ok: false, error: error instanceof Error ? error.message : String(error) })
      } finally {
        process.disconnect?.()
      }
    `
    const spawnWorker = (script: string): ChildProcess => spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    )

    const paused = spawnWorker(pausedScript)
    let contender: ChildProcess | undefined
    try {
      const pausedResult = waitForWorkerMessage(paused, 'result')
      await waitForWorkerMessage(paused, 'locked')
      const lock = `${store.path}.lock`
      const ownerPath = join(lock, 'owner.json')
      const old = new Date(Date.now() - 60_000)
      utimesSync(lock, old, old)

      contender = spawnWorker(contenderScript)
      const contenderAcquired = waitForWorkerMessage(contender, 'acquired')
      const contenderResult = waitForWorkerMessage(contender, 'result')
      await waitForWorkerMessage(contender, 'started')
      let contenderAcquiredEarly = false
      void contenderAcquired.then(
        () => { contenderAcquiredEarly = true },
        () => { contenderAcquiredEarly = true },
      )
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(contenderAcquiredEarly).toBe(false)
      expect(existsSync(store.path)).toBe(false)

      const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { v: number; pid: number; createdAt: number }
      expect(owner.pid).toBe(paused.pid)
      writeFileSync(ownerPath, `${JSON.stringify({ ...owner, token: '0'.repeat(64) })}\n`)
      paused.send?.('continue')

      await expect(pausedResult).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/lock ownership lost/) })
      await waitForWorkerExit(paused)
      await expect(contenderAcquired).resolves.toMatchObject({ type: 'acquired' })
      expect(existsSync(store.path)).toBe(false)
      contender.send?.('continue')
      await expect(contenderResult).resolves.toMatchObject({ ok: true })
      await waitForWorkerExit(contender)

      const records = await new SuggestionStore({ home }).all()
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ status: 'new', createdAt: 3_000 })
    } finally {
      if (paused.exitCode === null && paused.signalCode === null) paused.kill('SIGKILL')
      if (contender && contender.exitCode === null && contender.signalCode === null) contender.kill('SIGKILL')
    }
  }, 12_000)
})
