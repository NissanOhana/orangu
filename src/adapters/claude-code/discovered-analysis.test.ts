import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCanonicalSession } from '../../../test/fixtures/session-builder.js'
import {
  evidenceManifestLatestChangeMs,
  MAX_EVIDENCE_SESSION_BYTES,
  prevalidateEvidenceSession,
} from './evidence-input.js'
import {
  createDiscoveredClaudeAnalysisLoader,
  MIN_VERIFICATION_QUIET_MS,
} from './discovered-analysis.js'

let previousRoots: string | undefined
let previousConfig: string | undefined

beforeEach(() => {
  previousRoots = process.env['ORANGU_CLAUDE_ROOTS']
  previousConfig = process.env['CLAUDE_CONFIG_DIR']
})

afterEach(() => {
  if (previousRoots === undefined) delete process.env['ORANGU_CLAUDE_ROOTS']
  else process.env['ORANGU_CLAUDE_ROOTS'] = previousRoots
  if (previousConfig === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = previousConfig
})

function discoveredSession(): { root: string; project: string; id: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'orangu-settled-'))
  const project = join(root, 'projects', '-settled')
  const id = 'aaaaaaaa-0000-4000-8000-000000000001'
  const path = join(project, `${id}.jsonl`)
  mkdirSync(project, { recursive: true })
  writeFileSync(path, buildCanonicalSession().toJsonl())
  process.env['ORANGU_CLAUDE_ROOTS'] = root
  process.env['CLAUDE_CONFIG_DIR'] = root
  return { root, project, id, path }
}

describe('verification discovered-session quiet gate', () => {
  it('rejects less than 30 minutes quiet and accepts exactly 30 minutes', async () => {
    const session = discoveredSession()
    const manifest = await prevalidateEvidenceSession(session.path)
    const changedAt = evidenceManifestLatestChangeMs(manifest)!

    const tooSoon = createDiscoveredClaudeAnalysisLoader(MAX_EVIDENCE_SESSION_BYTES, {
      requireQuiet: true,
      now: () => changedAt + MIN_VERIFICATION_QUIET_MS - 1,
    })
    await expect(tooSoon(session.id)).resolves.toBeUndefined()

    const settled = createDiscoveredClaudeAnalysisLoader(MAX_EVIDENCE_SESSION_BYTES, {
      requireQuiet: true,
      now: () => changedAt + MIN_VERIFICATION_QUIET_MS,
    })
    await expect(settled(session.id)).resolves.toMatchObject({ session: { id: session.id, source: 'claude-code' } })
  })

  it('rejects an idle main transcript when a sidecar changed inside the quiet window', async () => {
    const session = discoveredSession()
    const mainOnly = await prevalidateEvidenceSession(session.path, { includeSidecars: false })
    const mainChangedAt = evidenceManifestLatestChangeMs(mainOnly)!
    const sidecarRoot = join(session.project, session.id, 'subagents')
    const sidecar = join(sidecarRoot, 'agent-active.jsonl')
    mkdirSync(sidecarRoot, { recursive: true })
    writeFileSync(sidecar, buildCanonicalSession().toJsonl())
    const newer = new Date(mainChangedAt + 60_000)
    utimesSync(sidecar, newer, newer)

    const load = createDiscoveredClaudeAnalysisLoader(MAX_EVIDENCE_SESSION_BYTES, {
      requireQuiet: true,
      now: () => mainChangedAt + MIN_VERIFICATION_QUIET_MS,
    })
    await expect(load(session.id)).resolves.toBeUndefined()
  })

  it('includes freshly changed sidecar directories in the whole-manifest quiet clock', async () => {
    const session = discoveredSession()
    const mainChangedAt = evidenceManifestLatestChangeMs(
      await prevalidateEvidenceSession(session.path, { includeSidecars: false }),
    )!
    await new Promise((resolve) => setTimeout(resolve, 10))
    mkdirSync(join(session.project, session.id, 'subagents'), { recursive: true })

    const load = createDiscoveredClaudeAnalysisLoader(MAX_EVIDENCE_SESSION_BYTES, {
      requireQuiet: true,
      now: () => mainChangedAt + MIN_VERIFICATION_QUIET_MS,
    })
    await expect(load(session.id)).resolves.toBeUndefined()
  })

  it('binds the containing project directory when a recently deleted sidecar tree is absent', async () => {
    const session = discoveredSession()
    const mainChangedAt = evidenceManifestLatestChangeMs(
      await prevalidateEvidenceSession(session.path, { includeSidecars: false }),
    )!
    await new Promise((resolve) => setTimeout(resolve, 10))
    const sidecarRoot = join(session.project, session.id, 'subagents')
    mkdirSync(sidecarRoot, { recursive: true })
    rmSync(join(session.project, session.id), { recursive: true })

    const load = createDiscoveredClaudeAnalysisLoader(MAX_EVIDENCE_SESSION_BYTES, {
      requireQuiet: true,
      now: () => mainChangedAt + MIN_VERIFICATION_QUIET_MS,
    })
    await expect(load(session.id)).resolves.toBeUndefined()
  })

  it('rejects a quiet-age-eligible main transcript with an unterminated partial record', async () => {
    const session = discoveredSession()
    appendFileSync(session.path, '{"partial":')
    const changedAt = evidenceManifestLatestChangeMs(await prevalidateEvidenceSession(session.path))!
    const load = createDiscoveredClaudeAnalysisLoader(MAX_EVIDENCE_SESSION_BYTES, {
      requireQuiet: true,
      now: () => changedAt + MIN_VERIFICATION_QUIET_MS,
    })
    await expect(load(session.id)).resolves.toBeUndefined()
  })

  it('rejects a quiet-age-eligible sidecar with an unterminated partial record', async () => {
    const session = discoveredSession()
    const sidecarRoot = join(session.project, session.id, 'subagents')
    const sidecar = join(sidecarRoot, 'agent-partial.jsonl')
    mkdirSync(sidecarRoot, { recursive: true })
    writeFileSync(sidecar, `${buildCanonicalSession().toJsonl()}{"partial":`)
    const changedAt = evidenceManifestLatestChangeMs(await prevalidateEvidenceSession(session.path))!
    const load = createDiscoveredClaudeAnalysisLoader(MAX_EVIDENCE_SESSION_BYTES, {
      requireQuiet: true,
      now: () => changedAt + MIN_VERIFICATION_QUIET_MS,
    })
    await expect(load(session.id)).resolves.toBeUndefined()
  })

  it('rejects an invalid or future verification clock', async () => {
    const session = discoveredSession()
    const changedAt = evidenceManifestLatestChangeMs(await prevalidateEvidenceSession(session.path))!
    for (const now of [Number.NaN, changedAt - 1]) {
      const load = createDiscoveredClaudeAnalysisLoader(MAX_EVIDENCE_SESSION_BYTES, { requireQuiet: true, now: () => now })
      await expect(load(session.id)).resolves.toBeUndefined()
    }
  })
})
