import { describe, it, expect, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, rename, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newTailState, tailOnce, sessionFromTail } from './tail.js'
import { readJsonlFile } from '../adapters/claude-code/jsonl.js'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import type { SessionRef } from '../discover/discover.js'
import { SessionBuilder, buildCanonicalSession, resetIds } from '../../test/fixtures/session-builder.js'
import {
  MAX_EVIDENCE_META_BYTES,
  MAX_EVIDENCE_SESSION_RECORDS,
  MAX_LOCAL_SESSION_BYTES,
} from '../adapters/claude-code/evidence-input.js'

function refFor(path: string, subagentFiles: string[] = []): SessionRef {
  return { sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', path, projectSlug: 'demo', projectPath: join(path, '..'), sizeBytes: 0, mtimeMs: 0, hasSidecarDir: subagentFiles.length > 0, subagentFiles }
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'orangu-tail-'))
}

describe('tailOnce (incremental byte-offset reader)', () => {
  it('appended records are read from fromByte > 0 and the tail parse equals a full re-parse', async () => {
    resetIds()
    const lines = buildCanonicalSession().toJsonl().split('\n').filter(Boolean)
    const dir = await tmp()
    const path = join(dir, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl')
    const half = Math.floor(lines.length / 2)
    await writeFile(path, lines.slice(0, half).join('\n') + '\n')

    const read = vi.fn(readJsonlFile)
    const st = newTailState(path)
    const first = await tailOnce(st, refFor(path), read)
    expect(first.changed).toBe(true)
    expect(read.mock.calls[0]![1]?.fromByte ?? 0).toBe(0)

    await appendFile(path, lines.slice(half).join('\n') + '\n')
    const second = await tailOnce(st, refFor(path), read)
    expect(second.changed).toBe(true)
    expect(second.fullReparse).toBe(false)
    const lastCall = read.mock.calls[read.mock.calls.length - 1]!
    expect(lastCall[1]?.fromByte ?? 0).toBeGreaterThan(0)

    const tailed = analyzeSession(await sessionFromTail(st), { version: 't', now: 0 })
    const full = analyzeSession(await parseClaudeCodeSession({ path }), { version: 't', now: 0 })
    expect(tailed.summary.turns).toBe(full.summary.turns)
    expect(tailed.summary.toolCalls).toBe(full.summary.toolCalls)
    expect(tailed.parse.totalLines).toBe(full.parse.totalLines)
  })

  it('a shrunken file forces a full re-parse from byte 0', async () => {
    resetIds()
    const lines = buildCanonicalSession().toJsonl().split('\n').filter(Boolean)
    const dir = await tmp()
    const path = join(dir, 's.jsonl')
    await writeFile(path, lines.join('\n') + '\n')
    const st = newTailState(path)
    await tailOnce(st, refFor(path))
    // resumed/forked: file is rewritten shorter
    await writeFile(path, lines.slice(0, 3).join('\n') + '\n')
    const r = await tailOnce(st, refFor(path))
    expect(r.fullReparse).toBe(true)
    expect(st.records.length).toBe(3)
  })

  it('a trailing partial line is flagged, then consumed once completed', async () => {
    resetIds()
    const lines = buildCanonicalSession().toJsonl().split('\n').filter(Boolean)
    const dir = await tmp()
    const path = join(dir, 's.jsonl')
    await writeFile(path, lines.slice(0, 4).join('\n') + '\n')
    const st = newTailState(path)
    await tailOnce(st, refFor(path))
    const nextLine = lines[4]!
    await appendFile(path, nextLine.slice(0, 20)) // unterminated partial write
    await tailOnce(st, refFor(path))
    expect(st.trailingPartial).toBe(true)
    const nRecords = st.records.length
    await appendFile(path, nextLine.slice(20) + '\n')
    await tailOnce(st, refFor(path))
    expect(st.trailingPartial).toBe(false)
    expect(st.records.length).toBe(nRecords + 1)
    expect(st.badLines).toBe(0)
  })

  it('a newly appearing agent sidecar is picked up and included in the session', async () => {
    resetIds()
    const dir = await tmp()
    const id = 'aaaaaaaa-0000-4000-8000-000000000001'
    const path = join(dir, `${id}.jsonl`)
    resetIds()
    await writeFile(path, buildCanonicalSession().toJsonl())
    const st = newTailState(path)
    await tailOnce(st, refFor(path))
    const before = (await sessionFromTail(st)).agents.length

    const scDir = join(dir, id, 'subagents')
    await mkdir(scDir, { recursive: true })
    const agentPath = join(scDir, 'agent-tail01.jsonl')
    const ab = new SessionBuilder({ sessionId: id })
    ab.sidechain('tail01')
    ab.userPrompt('subtask')
    ab.assistant([{ type: 'text', text: 'done' }], { usage: { input_tokens: 5, output_tokens: 5 } })
    await writeFile(agentPath, ab.toJsonl())
    await writeFile(agentPath.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ taskKind: 'subagent', agentType: 'worker' }))

    const r = await tailOnce(st, refFor(path, [agentPath]))
    expect(r.changed).toBe(true)
    const s = await sessionFromTail(st)
    expect(s.agents.length).toBeGreaterThan(before)
  })

  it('rejects a sidecar swapped to a symlink instead of following it', async () => {
    const dir = await tmp()
    const path = join(dir, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl')
    const outside = join(dir, 'outside.jsonl')
    const sidecar = join(dir, 'agent-link.jsonl')
    await writeFile(path, buildCanonicalSession().toJsonl())
    await writeFile(outside, buildCanonicalSession().toJsonl())
    await symlink(outside, sidecar)
    await expect(tailOnce(newTailState(path), refFor(path, [sidecar]))).rejects.toThrow(/could not be read safely/)
  })

  it('enforces shared retained byte and record caps across live main and sidecars', async () => {
    const dir = await tmp()
    const byteMain = join(dir, 'bytes.jsonl')
    const byteSidecar = join(dir, 'agent-bytes.jsonl')
    const mainText = buildCanonicalSession().toJsonl()
    await writeFile(byteMain, mainText)
    await writeFile(byteSidecar, '')
    await truncate(byteSidecar, MAX_LOCAL_SESSION_BYTES - Buffer.byteLength(mainText) + 1)
    await expect(tailOnce(newTailState(byteMain), refFor(byteMain, [byteSidecar]))).rejects.toThrow(/file budget/)

    const recordMain = join(dir, 'records.jsonl')
    const recordSidecar = join(dir, 'agent-records.jsonl')
    await writeFile(recordMain, '{}\n'.repeat(60_000))
    await writeFile(recordSidecar, '{}\n'.repeat(MAX_EVIDENCE_SESSION_RECORDS - 60_000 + 1))
    await expect(tailOnce(newTailState(recordMain), refFor(recordMain, [recordSidecar]))).rejects.toThrow(/exceeds 40000 records/)
  })

  it('rejects oversized live sidecar metadata before allocation', async () => {
    const dir = await tmp()
    const path = join(dir, 'meta.jsonl')
    const sidecar = join(dir, 'agent-meta.jsonl')
    const meta = sidecar.replace(/\.jsonl$/, '.meta.json')
    await writeFile(path, buildCanonicalSession().toJsonl())
    await writeFile(sidecar, buildCanonicalSession().toJsonl())
    await writeFile(meta, '')
    await truncate(meta, MAX_EVIDENCE_META_BYTES + 1)
    await expect(tailOnce(newTailState(path), refFor(path, [sidecar]))).rejects.toThrow(/metadata exceeds/)
  })

  it('refreshes replaced sidecar metadata and clears metadata that disappears', async () => {
    const dir = await tmp()
    const path = join(dir, 'meta-refresh.jsonl')
    const sidecar = join(dir, 'agent-meta-refresh.jsonl')
    const meta = sidecar.replace(/\.jsonl$/, '.meta.json')
    await writeFile(path, buildCanonicalSession().toJsonl())
    await writeFile(sidecar, buildCanonicalSession().toJsonl())
    await writeFile(meta, JSON.stringify({ agentType: 'first' }))
    const state = newTailState(path)
    await tailOnce(state, refFor(path, [sidecar]))
    const firstIdentity = state.sidecars.get(sidecar)?.metaIdentity

    await rename(meta, `${meta}.old`)
    await writeFile(meta, JSON.stringify({ agentType: 'later' }))
    const replaced = await tailOnce(state, refFor(path, [sidecar]))
    expect(replaced.changed).toBe(true)
    expect(state.sidecars.get(sidecar)?.meta).toEqual({ agentType: 'later' })
    expect(state.sidecars.get(sidecar)?.metaIdentity?.inode).not.toBe(firstIdentity?.inode)

    await rename(meta, `${meta}.removed`)
    const removed = await tailOnce(state, refFor(path, [sidecar]))
    expect(removed.changed).toBe(true)
    expect(state.sidecars.get(sidecar)?.meta).toBeUndefined()
    expect(state.sidecars.get(sidecar)?.metaBytes).toBe(0)
  })

  it('marks sidecar removal changed and drops its retained records', async () => {
    const dir = await tmp()
    const path = join(dir, 'remove.jsonl')
    const sidecar = join(dir, 'agent-remove.jsonl')
    await writeFile(path, buildCanonicalSession().toJsonl())
    await writeFile(sidecar, buildCanonicalSession().toJsonl())
    const state = newTailState(path)
    await tailOnce(state, refFor(path, [sidecar]))
    expect(state.sidecars.size).toBe(1)
    const removed = await tailOnce(state, refFor(path))
    expect(removed.changed).toBe(true)
    expect(state.sidecars.size).toBe(0)
  })

  it('fully reparses when the main path is replaced by a same-or-larger regular file', async () => {
    const dir = await tmp()
    const path = join(dir, 'replace-main.jsonl')
    const original = buildCanonicalSession().toJsonl()
    const replacement = original + `${JSON.stringify({ type: 'progress', replacement: true })}\n`
    await writeFile(path, original)
    const state = newTailState(path)
    await tailOnce(state, refFor(path))
    await rename(path, `${path}.old`)
    await writeFile(path, replacement)

    const result = await tailOnce(state, refFor(path))
    expect(result).toEqual({ changed: true, fullReparse: true })
    expect(state.records).toHaveLength((await readJsonlFile(path)).records.length)
  })

  it('fully reparses a replaced sidecar instead of appending from the prior inode offset', async () => {
    const dir = await tmp()
    const path = join(dir, 'replace-side.jsonl')
    const sidecar = join(dir, 'agent-replaced.jsonl')
    const original = buildCanonicalSession().toJsonl()
    const replacement = original + `${JSON.stringify({ type: 'progress', replacement: true })}\n`
    await writeFile(path, original)
    await writeFile(sidecar, original)
    const state = newTailState(path)
    await tailOnce(state, refFor(path, [sidecar]))
    await rename(sidecar, `${sidecar}.old`)
    await writeFile(sidecar, replacement)

    const result = await tailOnce(state, refFor(path, [sidecar]))
    expect(result.fullReparse).toBe(true)
    expect(state.sidecars.get(sidecar)?.records).toHaveLength((await readJsonlFile(sidecar)).records.length)
  })

  it('fails closed if a previously bound transcript reader stops returning file identity', async () => {
    const dir = await tmp()
    const path = join(dir, 'missing-identity.jsonl')
    await writeFile(path, buildCanonicalSession().toJsonl())
    const state = newTailState(path)
    await tailOnce(state, refFor(path))
    await appendFile(path, '{}\n')

    await expect(tailOnce(state, refFor(path), async (readPath, options) => {
      const { fileIdentity: _fileIdentity, ...result } = await readJsonlFile(readPath, options)
      return result
    })).rejects.toThrow(/identity became unavailable/)
  })
})
