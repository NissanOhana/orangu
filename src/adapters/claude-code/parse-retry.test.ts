/**
 * The one-shot read of a LIVE transcript: a write landing between prevalidation and the read used to
 * hard-fail report / analyze / evidence / estimate with "session input changed ...". The pair is now
 * retried a bounded number of times for exactly that class of error, and for nothing else.
 *
 * The race is injected deterministically: evidence-input.js is mocked so the read step can append to
 * the fixture AFTER the manifest was taken and BEFORE the real read runs. Synthetic fixture only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { appendFileSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCanonicalSession } from '../../../test/fixtures/session-builder.js'
import * as evidenceInput from './evidence-input.js'
import { isTransientInputChange, parseClaudeCodeSession, readStableEvidenceSession, STABLE_READ_ATTEMPTS, STILL_WRITING_HINT } from './parse.js'
import { analyzeRefCached } from '../../cache/index.js'

vi.mock('./evidence-input.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./evidence-input.js')>()
  return { ...actual, prevalidateEvidenceSession: vi.fn(actual.prevalidateEvidenceSession), readEvidenceSessionManifest: vi.fn(actual.readEvidenceSessionManifest) }
})

const actual = await vi.importActual<typeof import('./evidence-input.js')>('./evidence-input.js')
const prevalidate = vi.mocked(evidenceInput.prevalidateEvidenceSession)
const read = vi.mocked(evidenceInput.readEvidenceSessionManifest)

function fixture(): { dir: string; path: string; lines: number } {
  const dir = mkdtempSync(join(tmpdir(), 'orangu-parse-retry-'))
  const path = join(dir, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl')
  const jsonl = buildCanonicalSession().toJsonl()
  writeFileSync(path, jsonl)
  return { dir, path, lines: jsonl.split('\n').filter(Boolean).length }
}

const appendedPrompt = 'one more turn landed while orangu was reading'
const appendedLine =
  JSON.stringify({ type: 'user', uuid: 'ffffffff-0000-4000-8000-00000000ffff', sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', timestamp: '2026-08-14T11:00:00.000Z', message: { role: 'user', content: appendedPrompt } }) + '\n'

beforeEach(() => {
  prevalidate.mockReset().mockImplementation(actual.prevalidateEvidenceSession)
  read.mockReset().mockImplementation(actual.readEvidenceSessionManifest)
})

describe('parseClaudeCodeSession: bounded retry when the transcript is appended mid-read', () => {
  it('re-runs the prevalidate + read pair and returns the appended session', async () => {
    const { path, lines } = fixture()
    // attempt 1: the manifest is taken, then a line lands, then the real read sees a changed inode
    read.mockImplementationOnce(async (manifest) => {
      appendFileSync(path, appendedLine)
      return actual.readEvidenceSessionManifest(manifest)
    })
    const session = await parseClaudeCodeSession({ path })
    expect(prevalidate).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenCalledTimes(2)
    expect(session.parseReport.totalLines).toBe(lines + 1)
    expect(session.turns.some((t) => t.promptPreview.includes(appendedPrompt))).toBe(true)
  })

  it('gives up after the bounded attempts, keeps the error, and appends the still-writing hint', async () => {
    const { path } = fixture()
    read.mockImplementation(async (manifest) => {
      throw new Error(`session input changed while it was being read: ${manifest.main.requestedPath}`)
    })
    await expect(parseClaudeCodeSession({ path })).rejects.toThrow(
      new RegExp(`^session input changed while it was being read: .*; ${STILL_WRITING_HINT.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`),
    )
    expect(prevalidate).toHaveBeenCalledTimes(STABLE_READ_ATTEMPTS)
    expect(read).toHaveBeenCalledTimes(STABLE_READ_ATTEMPTS)
  })

  it('retries the "changed before it was read" form as well', async () => {
    const { path } = fixture()
    read.mockImplementationOnce(async (manifest) => {
      throw new Error(`session input changed before it was read: ${manifest.main.requestedPath}`)
    })
    await expect(parseClaudeCodeSession({ path })).resolves.toBeTruthy()
    expect(prevalidate).toHaveBeenCalledTimes(2)
  })
})

describe('parseClaudeCodeSession: every other prevalidation error stays fail-closed', () => {
  it('does not retry a symbolic link', async () => {
    const { dir, path } = fixture()
    const link = join(dir, 'link.jsonl')
    symlinkSync(path, link)
    const failure = parseClaudeCodeSession({ path: link })
    await expect(failure).rejects.toThrow(/must not include symbolic links/)
    await expect(failure).rejects.not.toThrow(STILL_WRITING_HINT)
    expect(prevalidate).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
  })

  it('does not retry the byte cap, a non-regular file, or a change caught during prevalidation', async () => {
    const { path } = fixture()
    for (const message of [
      'session input exceeds 1 bytes',
      `session input must contain only regular files: ${path}`,
      `session input changed during prevalidation: ${path}`,
      `session sidecar escapes its canonical root: ${path}`,
    ]) {
      prevalidate.mockReset().mockImplementation(async () => {
        throw new Error(message)
      })
      read.mockClear()
      await expect(parseClaudeCodeSession({ path })).rejects.toThrow(message)
      expect(prevalidate, message).toHaveBeenCalledTimes(1)
      expect(read, message).not.toHaveBeenCalled()
    }
  })

  it('classifies exactly the two transient forms', () => {
    expect(isTransientInputChange(new Error('session input changed before it was read: /x'))).toBe(true)
    expect(isTransientInputChange(new Error('session input changed while it was being read: /x'))).toBe(true)
    expect(isTransientInputChange(new Error('session sidecar tree changed while it was being read: /x'))).toBe(true)
    expect(isTransientInputChange(new Error('session sidecar directory changed while it was being read: /x'))).toBe(true)
    expect(isTransientInputChange(new Error('session input changed during prevalidation: /x'))).toBe(false)
    expect(isTransientInputChange(new Error('session input must not include symbolic links: /x'))).toBe(false)
    expect(isTransientInputChange(new Error('session input exceeds 64 bytes'))).toBe(false)
    expect(isTransientInputChange(new Error('proposal changed while it was being read'))).toBe(false)
    expect(isTransientInputChange('session input changed before it was read')).toBe(false)
  })
})

describe('the retry lives at the seams the verbs actually use', () => {
  const ref = (path: string) => ({
    sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
    path,
    projectSlug: '-tmp-fixture',
    projectPath: '',
    sizeBytes: 0,
    mtimeMs: 0,
    hasSidecarDir: false,
    subagentFiles: [] as string[],
  })

  it('report / analyze (analyzeRefCached) survive one append during the read', async () => {
    const { path } = fixture()
    read.mockImplementationOnce(async (manifest) => {
      appendFileSync(path, appendedLine)
      return actual.readEvidenceSessionManifest(manifest)
    })
    const a = await analyzeRefCached(ref(path), { cache: null, version: 'test', now: 0 })
    expect(prevalidate).toHaveBeenCalledTimes(2)
    expect(a.turns.some((t) => t.promptPreview.includes(appendedPrompt))).toBe(true)
  })

  it('evidence / estimate (readStableEvidenceSession) survive one append during the read', async () => {
    const { path, lines } = fixture()
    read.mockImplementationOnce(async (manifest) => {
      appendFileSync(path, appendedLine)
      return actual.readEvidenceSessionManifest(manifest)
    })
    const loaded = await readStableEvidenceSession(path)
    expect(prevalidate).toHaveBeenCalledTimes(2)
    expect(loaded.parseInput.totalLines ?? loaded.parseInput.records?.length).toBe(lines + 1)
  })

  it('a symlinked transcript still fails closed on the first attempt at those seams', async () => {
    const { dir, path } = fixture()
    const link = join(dir, 'link.jsonl')
    symlinkSync(path, link)
    await expect(analyzeRefCached(ref(link), { cache: null, version: 'test', now: 0 })).rejects.toThrow()
    await expect(readStableEvidenceSession(link)).rejects.toThrow()
    expect(prevalidate).toHaveBeenCalledTimes(2)
  })
})
