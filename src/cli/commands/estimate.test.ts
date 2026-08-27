import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCanonicalSession } from '../../../test/fixtures/session-builder.js'
import { cmdEstimate } from './estimate.js'
import { cmdEvidence } from './evidence.js'
import { runHarness } from './harness.js'
import { cmdSuggest } from './suggest.js'
import { CONFIRMATION_PUBLIC_KEY_ENV, generateConfirmationKeyPair, issueConfirmationReceipt } from '../../suggest/receipt.js'
import { SuggestionStore } from '../../suggest/store.js'

let home: string
let fixturePath: string
let out: string[]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orangu-est-'))
  process.env['ORANGU_HOME'] = home
  const dir = mkdtempSync(join(tmpdir(), 'orangu-sess-'))
  fixturePath = join(dir, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl')
  writeFileSync(fixturePath, buildCanonicalSession().toJsonl())
  out = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk))
    return true
  })
})
afterEach(() => {
  delete process.env['ORANGU_HOME']
  delete process.env[CONFIRMATION_PUBLIC_KEY_ENV]
  vi.restoreAllMocks()
})

const stdout = () => out.join('')

describe('orangu estimate (in-process)', () => {
  it('emits the Estimate contract for a session path: ceil(bytes/4) tokens', async () => {
    await cmdEstimate([fixturePath], { json: true })
    const est = JSON.parse(stdout())
    expect(est.sessions).toBe(1)
    expect(est.bytes).toBeGreaterThan(1000)
    expect(est.approxTokens).toBe(Math.ceil(est.bytes / 4))
    expect(est.overThreshold).toBe(est.approxTokens > 5000)
    expect(est.files).toBeGreaterThanOrEqual(1)
  })

  it('sizes exactly what `orangu evidence --estimate` sizes: the same bytes for the same session', async () => {
    await cmdEstimate([fixturePath], { json: true })
    const est = JSON.parse(stdout())
    out = []
    await cmdEvidence([fixturePath], { estimate: true, json: true })
    const evidence = JSON.parse(stdout())
    expect(est.bytes).toBe(evidence.bytes)
    expect(est.approxTokens).toBe(evidence.approxTokens)
    expect(est.overThreshold).toBe(evidence.overThreshold)
  })

  it('--slim sizes the larger `analyze --json --slim` read and says so', async () => {
    await cmdEstimate([fixturePath], { json: true })
    const evidence = JSON.parse(stdout())
    out = []
    await cmdEstimate([fixturePath], { json: true, slim: true })
    const slim = JSON.parse(stdout())
    expect(slim.sessions).toBe(evidence.sessions)
    expect(slim.files).toBe(evidence.files)
    expect(slim.bytes).not.toBe(evidence.bytes)
    expect(slim.approxTokens).toBe(Math.ceil(slim.bytes / 4))
    out = []
    await cmdEstimate([fixturePath], { slim: true })
    expect(stdout()).toContain('estimate (slim)')
    out = []
    await cmdEstimate([fixturePath], {})
    expect(stdout()).toContain('estimate (evidence)')
  })

  it('rejects --depth with the retirement message', async () => {
    await expect(cmdEstimate([fixturePath], { depth: 'quick' })).rejects.toThrow(/--depth was retired/)
    await expect(cmdEstimate([fixturePath], { depth: 'ultra' })).rejects.toThrow(/one canonical projection/)
  })

  it('--suggestion <id> sizes the record\'s evidence sessions', async () => {
    await cmdSuggest([], { rule: 'reread-files', scope: 'session', session: fixturePath, json: true })
    const id = JSON.parse(stdout()).record.id
    out = []
    await cmdEstimate([], { suggestion: id, json: true })
    const est = JSON.parse(stdout())
    expect(est.sessions).toBe(1)
  })

  it('resolves a canonical Cowork session id across multiple roots for suggestion estimates', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'orangu-est-cowork-home-'))
    mkdirSync(join(fakeHome, '.claude', 'projects'), { recursive: true })
    const coworkRoot = join(
      fakeHome,
      'Library',
      'Application Support',
      'Claude',
      'local-agent-mode-sessions',
      'account-a',
      'workspace-b',
      'local_estimate',
      '.claude',
    )
    const project = join(coworkRoot, 'projects', '-cowork-estimate')
    mkdirSync(project, { recursive: true })
    const sessionId = 'aaaaaaaa-0000-4000-8000-000000000001'
    writeFileSync(join(project, `${sessionId}.jsonl`), buildCanonicalSession().toJsonl())
    const previous = {
      HOME: process.env['HOME'],
      USERPROFILE: process.env['USERPROFILE'],
      CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'],
      ORANGU_CLAUDE_ROOTS: process.env['ORANGU_CLAUDE_ROOTS'],
    }
    process.env['HOME'] = fakeHome
    process.env['USERPROFILE'] = fakeHome
    delete process.env['CLAUDE_CONFIG_DIR']
    delete process.env['ORANGU_CLAUDE_ROOTS']
    try {
      await cmdSuggest([], { rule: 'reread-files', scope: 'session', session: sessionId, json: true })
      const id = JSON.parse(stdout()).record.id
      out = []
      await cmdEstimate([], { suggestion: id, json: true })
      expect(JSON.parse(stdout())).toMatchObject({ sessions: 1 })
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('verifies a server-issued receipt against a fresh over-threshold suggestion estimate', async () => {
    const manyDir = mkdtempSync(join(tmpdir(), 'orangu-est-many-'))
    const selectors = Array.from({ length: 40 }, (_, i) => {
      const path = join(manyDir, `${String(i).padStart(2, '0')}-aaaaaaaa-0000-4000-8000-000000000001.jsonl`)
      writeFileSync(path, buildCanonicalSession().toJsonl())
      return path
    })
    await cmdSuggest([], { rule: 'large-finding', scope: 'repo', session: selectors.join(','), cohort: '1111111111111111', json: true })
    const record = JSON.parse(stdout()).record
    out = []
    await cmdEstimate([], { suggestion: record.id, json: true })
    const fresh = JSON.parse(stdout())
    expect(fresh.overThreshold).toBe(true)

    const keys = generateConfirmationKeyPair()
    const persisted = (await new SuggestionStore().get(record.id))!
    const token = issueConfirmationReceipt({ record: persisted, estimate: fresh, privateKey: keys.privateKey, now: Date.now() })
    process.env[CONFIRMATION_PUBLIC_KEY_ENV] = keys.publicKey
    out = []
    await cmdEstimate([], { suggestion: record.id, receipt: token, json: true })
    expect(JSON.parse(stdout()).confirmationReceipt).toMatchObject({ valid: true })
  })

  it('reports an invalid receipt without treating it as confirmation', async () => {
    await cmdSuggest([], { rule: 'reread-files', scope: 'session', session: fixturePath, json: true })
    const id = JSON.parse(stdout()).record.id
    process.env[CONFIRMATION_PUBLIC_KEY_ENV] = generateConfirmationKeyPair().publicKey
    out = []
    await cmdEstimate([], { suggestion: id, receipt: 'not-a-receipt', json: true })
    expect(JSON.parse(stdout()).confirmationReceipt).toMatchObject({ valid: false })
  })

  it('human output prints the token line and the gate hint, and never a currency figure', async () => {
    await cmdEstimate([fixturePath], {})
    const text = stdout()
    expect(text).toContain('≈ tokens')
    expect(text).toContain('4 bytes/token')
    expect(text).toMatch(/gate/)
    // Tokens are the whole answer; never print a price or currency figure.
    expect(text).not.toContain('$')
    expect(text).not.toMatch(/list price|cost/i)
  })

  /**
   * Pins BOTH the config dir AND $HOME to synthetic temp dirs.
   *
   * `CLAUDE_CONFIG_DIR` alone is not enough: `runHarness` passes `homedir()` to `collectInventory`, which
   * probes `join(home, '.claude.json')`. `os.homedir()` honours `$HOME` on POSIX and `%USERPROFILE%`
   * on win32, so both are set to keep the test hermetic.
   *
   * These cases also stay REPO-scoped: `claudeRoots()` unconditionally appends `~/.claude`, so an in-process
   * `--global` would walk the user's configured sessions. The global path is covered hermetically by the built-CLI e2e,
   * which overrides HOME in the child process (src/cli/commands/harness.e2e.test.ts).
   */
  async function withSyntheticHome<T>(fn: (repo: string) => Promise<T>): Promise<T> {
    const cfg = mkdtempSync(join(tmpdir(), 'orangu-harness-cfg-'))
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ model: 'claude-opus-5', permissions: { allow: ['Read'] } }))
    const fakeHome = mkdtempSync(join(tmpdir(), 'orangu-harness-home-'))
    const repo = mkdtempSync(join(tmpdir(), 'orangu-harness-cwd-'))
    const prev = { cfg: process.env['CLAUDE_CONFIG_DIR'], home: process.env['HOME'], profile: process.env['USERPROFILE'] }
    process.env['CLAUDE_CONFIG_DIR'] = cfg
    process.env['HOME'] = fakeHome
    process.env['USERPROFILE'] = fakeHome
    try {
      return await fn(repo)
    } finally {
      for (const [k, v] of [['CLAUDE_CONFIG_DIR', prev.cfg], ['HOME', prev.home], ['USERPROFILE', prev.profile]] as Array<[string, string | undefined]>) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  it("scope keywords: 'estimate harness' sizes the harness report, in tokens and with no currency figure", async () => {
    await withSyntheticHome(async (repo) => {
      await cmdEstimate(['harness'], { json: true, cwd: repo, quiet: true })
      const est = JSON.parse(stdout())
      // the Estimate contract, unchanged — and it is the harness payload that was sized
      expect(Object.keys(est).sort()).toEqual(['approxTokens', 'bytes', 'files', 'overThreshold', 'sessions'])
      expect(est.bytes).toBeGreaterThan(0)
      expect(est.approxTokens).toBe(Math.ceil(est.bytes / 4))
      expect(est.overThreshold).toBe(est.approxTokens > 5000)
      // EXACTLY the one synthetic settings.json. `>= 1` also passed when the collector reached the real
      // ~/.claude.json (it reported 2), so it would have hidden a --root/home wiring regression.
      expect(est.files).toBe(1)
      expect(stdout()).not.toContain('$')

      // hermeticity, proven rather than assumed: the same run through runHarness yields a report with the
      // one synthetic settings file and NO usageCounters — the real ~/.claude.json would have populated
      // them — and its serialization is byte-for-byte the payload the estimate sized.
      const report = await runHarness({ cwd: repo, quiet: true })
      expect(report.inventory.settings).toHaveLength(1)
      expect(report.inventory.usageCounters).toBeUndefined()
      expect(report.inventory.totals.filesRead).toBe(1)
      expect(Buffer.byteLength(JSON.stringify(report))).toBe(est.bytes)
    })
  })

  it("'estimate harness' human output quotes tokens and never a currency figure", async () => {
    await withSyntheticHome(async (repo) => {
      await cmdEstimate(['harness'], { cwd: repo, quiet: true })
      const text = stdout()
      expect(text).toContain('estimate (harness)')
      expect(text).toContain('≈ tokens')
      expect(text).not.toContain('$')
      expect(text).not.toContain('list price')
    })
  })

  it("scope keywords: 'estimate global' sizes every session in the config dir (not a session id)", async () => {
    const { makeFixtureHome } = await import('../../../test/fixtures/home.js')
    const { mkdtempSync } = await import('node:fs')
    const fh = await makeFixtureHome(mkdtempSync(join(tmpdir(), 'orangu-cfg-')))
    process.env['CLAUDE_CONFIG_DIR'] = fh.configDir
    try {
      await cmdEstimate(['global'], { json: true })
      const est = JSON.parse(stdout())
      expect(est.sessions).toBeGreaterThan(1) // all fixture sessions, not "global" as an id
    } finally {
      delete process.env['CLAUDE_CONFIG_DIR']
    }
  })

  it("'estimate latest' resolves the newest session instead of sizing nothing", async () => {
    const { makeFixtureHome } = await import('../../../test/fixtures/home.js')
    const fh = await makeFixtureHome(mkdtempSync(join(tmpdir(), 'orangu-latest-est-')))
    process.env['CLAUDE_CONFIG_DIR'] = fh.configDir
    try {
      await cmdEstimate(['latest'], { json: true })
      const est = JSON.parse(stdout())
      expect(est.sessions).toBe(1)
      expect(est.bytes).toBeGreaterThan(0)
    } finally {
      delete process.env['CLAUDE_CONFIG_DIR']
    }
  })

  it("scope keyword 'estimate repo' honours the explicit --cwd target", async () => {
    const { makeFixtureHome } = await import('../../../test/fixtures/home.js')
    const fh = await makeFixtureHome(mkdtempSync(join(tmpdir(), 'orangu-repo-est-')))
    process.env['CLAUDE_CONFIG_DIR'] = fh.configDir
    try {
      await cmdEstimate(['repo'], { cwd: '/Users/test/Code/demo', json: true })
      expect(JSON.parse(stdout()).sessions).toBe(3)
    } finally {
      delete process.env['CLAUDE_CONFIG_DIR']
    }
  })
})
