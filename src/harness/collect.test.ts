/**
 * Collector tests. Everything is synthetic: temp dirs built here, never the real ~/.claude.
 * The point of most of these is drift: the collector must resolve on a broken
 * harness and say what it could not read, never throw.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectInventory } from './collect.js'

async function tmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'orangu-harness-'))
}
async function write(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body, 'utf8')
}
/** a home with no .claude.json, so the probe misses and the counters stay undefined */
async function bareHome(): Promise<string> {
  return await tmp()
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

describe('collectInventory: drift never throws', () => {
  it('case 1 — a config root that does not exist is reported as enoent, not a crash', async () => {
    const base = await tmp()
    const home = await bareHome()
    const inv = await collectInventory({ cwd: base, roots: [join(base, 'no-such-root')], home })
    expect(inv.unreadable.some((u) => u.reason === 'enoent' && u.path.includes('no-such-root'))).toBe(true)
    expect(inv.totals.skills).toBe(0)
  })

  it.skipIf(isRoot)('case 2 — a file with mode 0o000 is reported as eacces, not a crash', async () => {
    const root = await tmp()
    const home = await bareHome()
    const f = join(root, 'settings.json')
    await writeFile(f, '{"model":"claude-opus-5"}', 'utf8')
    await chmod(f, 0o000)
    const inv = await collectInventory({ cwd: await tmp(), roots: [root], home })
    expect(inv.unreadable.find((u) => u.path.endsWith('settings.json'))?.reason).toBe('eacces')
    expect(inv.settings).toHaveLength(0)
  })

  it('case 3 — a malformed JSON settings file is reported as bad-json, not a crash', async () => {
    const root = await tmp()
    const home = await bareHome()
    await writeFile(join(root, 'settings.json'), '{ this is not json', 'utf8')
    const inv = await collectInventory({ cwd: await tmp(), roots: [root], home })
    expect(inv.unreadable.find((u) => u.path.endsWith('settings.json'))?.reason).toBe('bad-json')
    expect(inv.settings).toHaveLength(0)
  })

  it('case 4 — a file over maxFileBytes is reported as too-large and is never read', async () => {
    const cwd = await tmp()
    const home = await bareHome()
    await writeFile(join(cwd, 'CLAUDE.md'), 'x'.repeat(5000), 'utf8')
    const inv = await collectInventory({ cwd, roots: [], home, maxFileBytes: 100 })
    expect(inv.unreadable.find((u) => u.path.endsWith('CLAUDE.md'))?.reason).toBe('too-large')
    expect(inv.claudeMd).toHaveLength(0)
    expect(inv.totals.claudeMdBytes).toBe(0)
  })

  it('case 5 — an empty .claude/ produces a clean, empty report with no unreadable rows', async () => {
    const cwd = await tmp()
    const root = await tmp()
    const home = await bareHome()
    await mkdir(join(cwd, '.claude'), { recursive: true })
    const inv = await collectInventory({ cwd, roots: [root], home })
    expect(inv.unreadable).toEqual([])
    expect(inv.skills).toEqual([])
    expect(inv.agents).toEqual([])
    expect(inv.settings).toEqual([])
    expect(inv.totals.filesRead).toBe(0)
  })

  // the notes[] entry that accompanies this miss is asserted in report.test.ts, where notes are built
  it('case 6 — an absent ~/.claude.json leaves usageCounters undefined and is not an unreadable row', async () => {
    const home = await bareHome()
    const inv = await collectInventory({ cwd: await tmp(), roots: [], home })
    expect(inv.usageCounters).toBeUndefined()
    expect(inv.unreadable.some((u) => u.path.endsWith('.claude.json'))).toBe(false)
  })
})

describe('collectInventory: the collection boundary', () => {
  it('records env NAMES only — a value never enters the report', async () => {
    const root = await tmp()
    const home = await bareHome()
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        model: 'claude-opus-5',
        effortLevel: 'high',
        env: { ANTHROPIC_AUTH_TOKEN: 'sk-ant-thisisthesecretvalue0123456789', PLAIN: 'hello-world' },
        permissions: { allow: ['Bash(ls:*)', 'Read'], deny: ['Bash(rm:*)'], defaultMode: 'acceptEdits' },
        statusLine: { type: 'command', command: 'x' },
        cleanupPeriodDays: 30,
        enabledPlugins: { 'demo@market': true, 'off@market': false },
      }),
      'utf8',
    )
    const inv = await collectInventory({ cwd: await tmp(), roots: [root], home })
    const s = inv.settings[0]!
    expect(s.env.names).toEqual(['ANTHROPIC_AUTH_TOKEN', 'PLAIN'])
    expect(s.env.count).toBe(2)
    const serialized = JSON.stringify(inv)
    expect(serialized).not.toContain('thisisthesecretvalue')
    expect(serialized).not.toContain('hello-world')
    expect(s.permissions).toEqual({ allow: 2, deny: 1, ask: 0, defaultMode: 'acceptEdits' })
    expect(s.model).toBe('claude-opus-5')
    expect(s.effortLevel).toBe('high')
    expect(s.statusLine).toBe(true)
    expect(s.cleanupPeriodDays).toBe(30)
    expect(s.enabledPlugins).toEqual(['demo@market'])
    expect(s.keys).toContain('permissions')
  })

  it('reduces a hook command to basename(argv0) — arguments never enter the report', async () => {
    const root = await tmp()
    const home = await bareHome()
    await writeFile(
      join(root, 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: '/opt/tools/notify.sh --token sk-ant-leakedsecret012345678' }] }],
        },
      }),
      'utf8',
    )
    const inv = await collectInventory({ cwd: await tmp(), roots: [root], home })
    const h = inv.settings[0]!.hooks[0]!
    expect(h.event).toBe('Stop')
    expect(h.matchers).toBe(1)
    expect(h.commands).toBe(1)
    expect(h.commandBasenames).toEqual(['notify.sh'])
    expect(JSON.stringify(inv)).not.toContain('leakedsecret')
    expect(inv.totals.hookCommands).toBe(1)
  })

  it('reads exactly the five allowlisted keys of ~/.claude.json and nothing else', async () => {
    const home = await tmp()
    const cwd = await tmp()
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'someone@example.com', accountUuid: 'uuid-leak-0001' },
        history: [{ display: 'a private prompt' }],
        tipsHistory: { x: 1 },
        mcpServers: { chrome: { type: 'stdio', command: '/usr/local/bin/chrome-mcp', args: ['--secret', 'abc'] } },
        projects: {
          [cwd]: { mcpServers: { local: { type: 'http', url: 'https://x' } }, enabledMcpjsonServers: ['on'], disabledMcpjsonServers: ['off'] },
        },
        skillUsage: { brainstorming: { usageCount: 7, lastUsedAt: 1000 } },
        pluginUsage: { 'demo@market': { usageCount: 3, lastUsedAt: 2000, lastUsedNumStartups: 4 } },
      }),
      'utf8',
    )
    const inv = await collectInventory({ cwd, roots: [], home })
    const serialized = JSON.stringify(inv)
    expect(serialized).not.toContain('oauthAccount')
    expect(serialized).not.toContain('uuid-leak-0001')
    expect(serialized).not.toContain('a private prompt')
    expect(serialized).not.toContain('tipsHistory')
    expect(inv.usageCounters?.skills).toEqual([{ name: 'brainstorming', usageCount: 7, lastUsedAt: 1000 }])
    expect(inv.usageCounters?.plugins).toEqual([{ key: 'demo@market', usageCount: 3, lastUsedAt: 2000 }])
    const chrome = inv.mcpServers.find((m) => m.name === 'chrome')!
    expect(chrome.scope).toBe('global')
    expect(chrome.transport).toBe('stdio')
    expect(chrome.commandBasename).toBe('chrome-mcp')
    expect(serialized).not.toContain('--secret')
    expect(inv.mcpServers.find((m) => m.name === 'local')?.scope).toBe('project')
    expect(inv.mcpServers.find((m) => m.name === 'off')?.enabled).toBe(false)
    expect(inv.mcpServers.find((m) => m.name === 'on')?.enabled).toBe(true)
  })
})

describe('collectInventory: what it inventories', () => {
  it('parses skill and agent frontmatter from repo and global trees', async () => {
    const cwd = await tmp()
    const root = await tmp()
    const home = await bareHome()
    await write(
      join(cwd, '.claude', 'skills', 'repo-skill', 'SKILL.md'),
      '---\nname: repo-skill\ndescription: does a repo thing\nallowed-tools: Read, Bash(orangu:*)\n---\n\n# Body\nline two\n',
    )
    await mkdir(join(cwd, '.claude', 'skills', 'repo-skill', 'references'), { recursive: true })
    await write(
      join(root, 'agents', 'roles', 'reviewer.md'),
      '---\nname: reviewer\ndescription: reviews\nmodel: opus\neffort: max\ntools: Read, Grep\ndisallowedTools: Edit, Write\n---\n\nbody\n',
    )
    await write(join(cwd, 'CLAUDE.md'), '# Title\n\ntext\n\n## Sub\n')
    const inv = await collectInventory({ cwd, roots: [root], home })

    const sk = inv.skills[0]!
    expect(sk.name).toBe('repo-skill')
    expect(sk.origin).toBe('repo')
    expect(sk.allowedTools).toEqual(['Read', 'Bash(orangu:*)'])
    expect(sk.descriptionChars).toBe('does a repo thing'.length)
    expect(sk.hasReferences).toBe(true)
    expect(sk.approxTokens).toBe(Math.ceil(sk.bytes / 4))

    const ag = inv.agents[0]!
    expect(ag.name).toBe('reviewer')
    expect(ag.origin).toBe('global')
    expect(ag.model).toBe('opus')
    expect(ag.effort).toBe('max')
    expect(ag.tools).toEqual(['Read', 'Grep'])
    expect(ag.disallowedTools).toEqual(['Edit', 'Write'])

    const md = inv.claudeMd[0]!
    expect(md.scope).toBe('repo')
    expect(md.headings).toBe(2)
    expect(md.lines).toBe(5)
    expect(inv.totals.claudeMdBytes).toBe(md.bytes)
  })

  it('walks each plugin installPath for its component counts', async () => {
    const root = await tmp()
    const home = await bareHome()
    const installPath = join(await tmp(), 'demo-plugin')
    await write(join(installPath, 'skills', 'one', 'SKILL.md'), '---\nname: one\ndescription: first\n---\nbody\n')
    await write(join(installPath, 'skills', 'two', 'SKILL.md'), '---\nname: two\ndescription: second\n---\nbody\n')
    await write(join(installPath, 'agents', 'helper.md'), '---\nname: helper\ndescription: helps\ntools: Read\n---\nbody\n')
    await write(join(installPath, 'commands', 'go.md'), '# go\n')
    await write(
      join(installPath, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/x/run-hook.cmd --arg' }] }] } }),
    )
    await write(join(installPath, '.mcp.json'), JSON.stringify({ mcpServers: { pserver: { type: 'stdio', command: '/bin/pserver' } } }))
    await write(
      join(root, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 1, plugins: { 'demo@market': [{ scope: 'user', installPath, version: '1.2.3' }] } }),
    )
    await writeFile(join(root, 'settings.json'), JSON.stringify({ enabledPlugins: { 'demo@market': true } }), 'utf8')

    const inv = await collectInventory({ cwd: await tmp(), roots: [root], home })
    const p = inv.plugins[0]!
    expect(p).toMatchObject({ key: 'demo@market', name: 'demo', marketplace: 'market', scope: 'user', version: '1.2.3', enabled: true })
    expect(p.skills).toBe(2)
    expect(p.agents).toBe(1)
    expect(p.commands).toBe(1)
    expect(p.hooks).toBe(1)
    expect(p.mcpServers).toBe(1)
    // the walk is what keeps `undeclared` from over-firing: plugin components are in the inventory
    expect(inv.skills.filter((s) => s.origin === 'plugin').map((s) => s.name)).toEqual(['one', 'two'])
    expect(inv.skills.find((s) => s.name === 'one')?.plugin).toBe('demo@market')
    expect(inv.agents.find((a) => a.name === 'helper')?.origin).toBe('plugin')
    expect(inv.mcpServers.find((m) => m.name === 'pserver')?.scope).toBe('plugin')
    expect(inv.totals.plugins).toBe(1)
  })

  // Enabled/disabled toggles name servers that `.mcp.json` may already declare. Reconcile them onto
  // the configured row so totals and state remain consistent.
  it('reconciles a disabled toggle onto the .mcp.json row instead of adding a second one', async () => {
    const cwd = await tmp()
    const home = await tmp()
    await write(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { octocode: { type: 'stdio', command: '/bin/octocode' } } }))
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ projects: { [cwd]: { disabledMcpjsonServers: ['octocode'] } } }),
      'utf8',
    )
    const inv = await collectInventory({ cwd, roots: [], home })
    const rows = inv.mcpServers.filter((m) => m.name === 'octocode')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.enabled).toBe(false)
    expect(rows[0]!.transport).toBe('stdio')
    expect(rows[0]!.commandBasename).toBe('octocode')
    expect(inv.totals.mcpServers).toBe(1)
  })

  it('keeps an enabled toggle on the .mcp.json row and still counts one server', async () => {
    const cwd = await tmp()
    const home = await tmp()
    await write(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { octocode: { type: 'stdio', command: '/bin/octocode' } } }))
    await writeFile(join(home, '.claude.json'), JSON.stringify({ projects: { [cwd]: { enabledMcpjsonServers: ['octocode'] } } }), 'utf8')
    const inv = await collectInventory({ cwd, roots: [], home })
    expect(inv.mcpServers.filter((m) => m.name === 'octocode')).toHaveLength(1)
    expect(inv.mcpServers.find((m) => m.name === 'octocode')?.enabled).toBe(true)
    expect(inv.totals.mcpServers).toBe(1)
  })

  it('still records a toggled server that no .mcp.json declares', async () => {
    const cwd = await tmp()
    const home = await tmp()
    await writeFile(join(home, '.claude.json'), JSON.stringify({ projects: { [cwd]: { disabledMcpjsonServers: ['ghost'] } } }), 'utf8')
    const inv = await collectInventory({ cwd, roots: [], home })
    expect(inv.mcpServers.filter((m) => m.name === 'ghost')).toHaveLength(1)
    expect(inv.mcpServers[0]!.enabled).toBe(false)
    expect(inv.totals.mcpServers).toBe(1)
  })

  it('is deterministic: two collections of the same tree serialize identically', async () => {
    const cwd = await tmp()
    const root = await tmp()
    const home = await bareHome()
    await write(join(cwd, '.claude', 'skills', 'b-skill', 'SKILL.md'), '---\nname: b-skill\ndescription: b\n---\nx\n')
    await write(join(cwd, '.claude', 'skills', 'a-skill', 'SKILL.md'), '---\nname: a-skill\ndescription: a\n---\nx\n')
    await write(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { zeta: { command: '/bin/z' }, alpha: { command: '/bin/a' } } }))
    const one = await collectInventory({ cwd, roots: [root], home })
    const two = await collectInventory({ cwd, roots: [root], home })
    expect(JSON.stringify(one)).toBe(JSON.stringify(two))
    expect(one.skills.map((s) => s.name)).toEqual(['a-skill', 'b-skill'])
    expect(one.mcpServers.map((m) => m.name)).toEqual(['alpha', 'zeta'])
  })
})
