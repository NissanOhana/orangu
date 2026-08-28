import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, truncateSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeRoots,
  findLatestSession,
  listProjects,
  listSessions,
  peekCwd,
  peekHead,
  projectSlug,
  readBoundedDiscoveryDirectory,
  resolveSession,
} from './discover.js'

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'orangu-home-'))
  const projects = join(home, 'projects')
  const p1 = join(projects, '-Users-me-Code-alpha')
  const p2 = join(projects, '-Users-me-Code-beta')
  mkdirSync(p1, { recursive: true })
  mkdirSync(p2, { recursive: true })
  const rec = (sid: string, cwd: string) =>
    JSON.stringify({ type: 'user', sessionId: sid, cwd, timestamp: '2026-08-01T00:00:00Z', message: { role: 'user', content: 'hi' } }) + '\n'
  writeFileSync(join(p1, 'aaaaaaaa-1111-4111-8111-111111111111.jsonl'), rec('aaaaaaaa-1111-4111-8111-111111111111', '/Users/me/Code/alpha'))
  writeFileSync(join(p1, 'aaaaaaaa-2222-4222-8222-222222222222.jsonl'), rec('aaaaaaaa-2222-4222-8222-222222222222', '/Users/me/Code/alpha'))
  writeFileSync(join(p2, 'bbbbbbbb-3333-4333-8333-333333333333.jsonl'), rec('bbbbbbbb-3333-4333-8333-333333333333', '/Users/me/Code/beta'))
  // subagent dir for one session
  mkdirSync(join(p1, 'aaaaaaaa-1111-4111-8111-111111111111', 'subagents'), { recursive: true })
  writeFileSync(join(p1, 'aaaaaaaa-1111-4111-8111-111111111111', 'subagents', 'agent-x-abc.jsonl'), rec('aaaaaaaa-1111-4111-8111-111111111111', '/Users/me/Code/alpha'))
  // make beta the most recent
  const old = new Date('2026-07-01T00:00:00Z')
  utimesSync(join(p1, 'aaaaaaaa-1111-4111-8111-111111111111.jsonl'), old, old)
  utimesSync(join(p1, 'aaaaaaaa-2222-4222-8222-222222222222.jsonl'), old, old)
  return home
}

describe('projectSlug', () => {
  it('maps a cwd to the ~/.claude/projects directory name', () => {
    expect(projectSlug('/Users/me/Code/alpha')).toBe('-Users-me-Code-alpha')
    expect(projectSlug('/Users/me/Code/acme/.claude/worktrees/x')).toBe('-Users-me-Code-acme--claude-worktrees-x')
    expect(projectSlug('C:\\Users\\me\\proj')).toBe('C--Users-me-proj')
  })
})

describe('claudeRoots', () => {
  it('discovers Claude Code plus Cowork/Desktop local session roots hermetically', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'orangu-roots-'))
    const claudeCode = join(homeDir, '.claude')
    const localSession = join(
      homeDir,
      'Library',
      'Application Support',
      'Claude',
      'local-agent-mode-sessions',
      'account-a',
      'workspace-b',
      'local_session-c',
      '.claude',
    )
    mkdirSync(join(claudeCode, 'projects'), { recursive: true })
    mkdirSync(join(localSession, 'projects'), { recursive: true })

    expect(await claudeRoots(undefined, homeDir, {})).toEqual([claudeCode, localSession])
  })

  it('an explicit --root replaces the automatic roots instead of widening them', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'orangu-roots-explicit-'))
    mkdirSync(join(homeDir, '.claude', 'projects'), { recursive: true })
    const one = mkdtempSync(join(tmpdir(), 'orangu-root-one-'))
    const two = mkdtempSync(join(tmpdir(), 'orangu-root-two-'))
    const env = { ORANGU_CLAUDE_ROOTS: mkdtempSync(join(tmpdir(), 'orangu-root-env-')) }
    // one root, several roots, and whitespace/duplicates: only what was named, in order, once
    expect(await claudeRoots(one, homeDir, env)).toEqual([one])
    expect(await claudeRoots(`${one}, ${two},${one}`, homeDir, env)).toEqual([one, two])
    // an empty explicit value is no override
    expect(await claudeRoots(' , ', homeDir, {})).toEqual([join(homeDir, '.claude')])
  })

  it('does not enroll Cowork roots through symlinked local-session ancestors', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'orangu-roots-link-'))
    const base = join(homeDir, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')
    const outside = mkdtempSync(join(tmpdir(), 'orangu-roots-outside-'))
    mkdirSync(base, { recursive: true })
    mkdirSync(join(outside, 'workspace', 'local_escape', '.claude', 'projects'), { recursive: true })
    symlinkSync(outside, join(base, 'account-link'))
    expect(await claudeRoots(undefined, homeDir, {})).toEqual([])
  })

  it('rejects a symlink in the automatic Cowork base parent chain', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'orangu-roots-parent-link-'))
    const support = join(homeDir, 'Library', 'Application Support')
    const outsideClaude = mkdtempSync(join(tmpdir(), 'orangu-roots-parent-outside-'))
    const localSession = join(
      outsideClaude,
      'local-agent-mode-sessions',
      'account-a',
      'workspace-b',
      'local_escape',
      '.claude',
    )
    mkdirSync(support, { recursive: true })
    mkdirSync(join(localSession, 'projects'), { recursive: true })
    symlinkSync(outsideClaude, join(support, 'Claude'))
    expect(await claudeRoots(undefined, homeDir, {})).toEqual([])
  })
})

describe('listProjects / listSessions', () => {
  it('lists projects with session counts and sessions with sizes and mtimes', async () => {
    const home = fakeHome()
    const projects = await listProjects({ configDir: home })
    expect(projects.map((p) => p.slug).sort()).toEqual(['-Users-me-Code-alpha', '-Users-me-Code-beta'])
    const alpha = projects.find((p) => p.slug === '-Users-me-Code-alpha')!
    expect(alpha.sessionCount).toBe(2)
    const sessions = await listSessions({ configDir: home })
    expect(sessions.length).toBe(3)
    const s = sessions.find((x) => x.sessionId.startsWith('aaaaaaaa-1111'))!
    expect(s.hasSidecarDir).toBe(true)
    expect(s.subagentFiles.length).toBe(1)
    expect(s.sizeBytes).toBeGreaterThan(0)
  })

  it('rejects project-directory symlink escape outside canonical projects', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orangu-project-link-'))
    const projects = join(home, 'projects')
    const outside = mkdtempSync(join(tmpdir(), 'orangu-project-outside-'))
    mkdirSync(projects, { recursive: true })
    writeFileSync(join(outside, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl'), '{}\n')
    symlinkSync(outside, join(projects, '-escaped'))
    expect(await listSessions({ configDir: home })).toEqual([])
    expect(await listProjects({ configDir: home })).toEqual([])
  })

  it('counts every JSONL candidate against the cumulative early session cap', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orangu-session-cap-'))
    const project = join(home, 'projects', '-cap')
    mkdirSync(project, { recursive: true })
    for (const name of ['not-a-uuid-1.jsonl', 'not-a-uuid-2.jsonl', 'not-a-uuid-3.jsonl']) writeFileSync(join(project, name), '{}\n')
    await expect(listSessions({ configDir: home, maxSessions: 2 })).rejects.toThrow(/exceeds 2 sessions/)
  })

  it('bounds each directory before materializing an unbounded discovery list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-directory-cap-'))
    writeFileSync(join(dir, 'one'), '')
    writeFileSync(join(dir, 'two'), '')
    writeFileSync(join(dir, 'three'), '')
    await expect(readBoundedDiscoveryDirectory(dir, 2)).rejects.toThrow(/exceeds 2 entries/)
  })

  it('shares one cumulative entry budget across project fanout and junk-only directories', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orangu-cumulative-cap-'))
    const projects = join(home, 'projects')
    const first = join(projects, '-first')
    const second = join(projects, '-second')
    mkdirSync(first, { recursive: true })
    mkdirSync(second)
    for (const name of ['junk-a', 'junk-b', 'junk-c']) writeFileSync(join(first, name), '')
    await expect(listSessions({ configDir: home, maxEntries: 4 })).rejects.toThrow(/exceeds 4 cumulative directory entries/)
  })

  it('does not swallow cumulative entry overflow while inspecting sidecar junk', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orangu-sidecar-cumulative-cap-'))
    const id = 'aaaaaaaa-0000-4000-8000-000000000001'
    const project = join(home, 'projects', '-sidecar-cap')
    const sidecars = join(project, id, 'subagents')
    mkdirSync(sidecars, { recursive: true })
    writeFileSync(join(project, `${id}.jsonl`), '{}\n')
    for (const name of ['junk-a', 'junk-b', 'junk-c']) writeFileSync(join(sidecars, name), '')
    await expect(listSessions({ configDir: home, maxEntries: 5 })).rejects.toThrow(/exceeds 5 cumulative directory entries/)
  })
})

describe('peekCwd', () => {
  it('reads at most the first 64 KiB and refuses a transcript symlink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-peek-'))
    const large = join(dir, 'large.jsonl')
    const link = join(dir, 'link.jsonl')
    writeFileSync(large, `${JSON.stringify({ cwd: '/bounded' })}\n`)
    truncateSync(large, 128 * 1024 * 1024)
    symlinkSync(large, link)
    expect(await peekCwd(large)).toBe('/bounded')
    expect(await peekCwd(link)).toBeUndefined()
  })
})

describe('peekHead', () => {
  it('a bare argument-less slash command yields the title to the next real prompt, else stands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-peek-cmd-'))
    const line = (content: string) => JSON.stringify({ type: 'user', cwd: '/w', message: { role: 'user', content } }) + '\n'
    const bare = '<command-message>model</command-message>\n<command-name>/model</command-name>'
    const withNext = join(dir, 'a.jsonl')
    writeFileSync(withNext, line(bare) + line('Fix the flaky test'))
    expect((await peekHead(withNext)).title).toBe('Fix the flaky test')
    const alone = join(dir, 'b.jsonl')
    writeFileSync(alone, line(bare))
    expect((await peekHead(alone)).title).toBe('/model')
    const withArgs = join(dir, 'c.jsonl')
    writeFileSync(withArgs, line('<command-name>/orangu:improve</command-name><command-args>sg_000000000000</command-args>') + line('later'))
    expect((await peekHead(withArgs)).title).toBe('/orangu:improve sg_000000000000')
  })

  const line = (r: Record<string, unknown>) => JSON.stringify(r) + '\n'
  it('takes the custom title over the AI title over the first human prompt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-peek-'))
    const p = join(dir, 'a.jsonl')
    writeFileSync(
      p,
      line({ type: 'user', cwd: '/w', isMeta: true, message: { role: 'user', content: 'meta prompt' } }) +
        line({ type: 'user', cwd: '/w', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }) +
        line({ type: 'user', cwd: '/w', message: { role: 'user', content: [{ type: 'text', text: '  Fix the   flaky\n test  ' }] } }) +
        line({ type: 'ai-title', aiTitle: 'AI says' }) +
        line({ type: 'custom-title', customTitle: 'Custom' }),
    )
    return peekHead(p).then((h) => expect(h).toEqual({ cwd: '/w', title: 'Custom' }))
  })
  it('falls back to the AI title, then to the one-line first prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-peek-'))
    const ai = join(dir, 'ai.jsonl')
    writeFileSync(ai, line({ type: 'user', message: { role: 'user', content: 'first' } }) + line({ type: 'ai-title', aiTitle: 'AI says' }))
    expect((await peekHead(ai)).title).toBe('AI says')
    const prompt = join(dir, 'prompt.jsonl')
    writeFileSync(prompt, line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '  Fix the   flaky\n test  ' }] } }))
    expect((await peekHead(prompt)).title).toBe('Fix the flaky test')
  })
  it('names a slash command by its command, skips notifications, and caps the title', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-peek-'))
    const cmd = join(dir, 'cmd.jsonl')
    writeFileSync(cmd, line({ type: 'user', message: { role: 'user', content: '<command-message>x</command-message><command-name>/review</command-name><command-args>pr 12</command-args>' } }))
    expect((await peekHead(cmd)).title).toBe('/review pr 12')
    const note = join(dir, 'note.jsonl')
    writeFileSync(note, line({ type: 'user', message: { role: 'user', content: '<task-notification>done</task-notification>' } }) + line({ type: 'user', message: { role: 'user', content: 'real' } }))
    expect((await peekHead(note)).title).toBe('real')
    const long = join(dir, 'long.jsonl')
    writeFileSync(long, line({ type: 'user', message: { role: 'user', content: 'y'.repeat(300) } }))
    const t = (await peekHead(long)).title!
    expect(t.length).toBe(120)
    expect(t.endsWith('…')).toBe(true)
  })
  it('returns nothing for a missing or symlinked file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orangu-peek-'))
    expect(await peekHead(join(dir, 'missing.jsonl'))).toEqual({})
  })
})

describe('resolveSession', () => {
  it('resolves by full id, by unique prefix, and by path', async () => {
    const home = fakeHome()
    const byId = await resolveSession('bbbbbbbb-3333-4333-8333-333333333333', { configDir: home })
    expect(byId?.projectSlug).toBe('-Users-me-Code-beta')
    const byPrefix = await resolveSession('bbbbbbbb', { configDir: home })
    expect(byPrefix?.sessionId).toBe('bbbbbbbb-3333-4333-8333-333333333333')
    const byPath = await resolveSession(byId!.path, { configDir: home })
    expect(byPath?.sessionId).toBe('bbbbbbbb-3333-4333-8333-333333333333')
  })
  it('returns null on ambiguous prefix and lists candidates', async () => {
    const home = fakeHome()
    const r = await resolveSession('aaaaaaaa', { configDir: home })
    expect(r).toBeNull()
  })
})

describe('findLatestSession', () => {
  it('returns the most recently modified session globally or per project', async () => {
    const home = fakeHome()
    const latest = await findLatestSession({ configDir: home })
    expect(latest?.sessionId.startsWith('bbbbbbbb')).toBe(true)
    const latestAlpha = await findLatestSession({ configDir: home, cwd: '/Users/me/Code/alpha' })
    expect(latestAlpha?.projectSlug).toBe('-Users-me-Code-alpha')
  })
})
