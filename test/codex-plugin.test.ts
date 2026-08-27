import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'))
const readText = (path: string): string => readFileSync(join(root, path), 'utf8')

function filesUnder(dir: string): string[] {
  const files: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(join(root, current))) {
      const path = `${current}/${entry}`
      if (statSync(join(root, path)).isDirectory()) walk(path)
      else files.push(path)
    }
  }
  walk(dir)
  return files.sort()
}

describe('Codex plugin packaging', () => {
  it('publishes an installable Orangu marketplace entry', () => {
    const marketplace = readJson('.agents/plugins/marketplace.json')
    expect(marketplace.name).toBe('orangu')
    expect(marketplace.interface?.displayName).toBe('Orangu')
    expect(marketplace.plugins).toEqual([
      {
        name: 'orangu',
        source: { source: 'local', path: './plugins/orangu' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      },
    ])
  })

  it('uses a branded skills-only manifest with the repository version', () => {
    const manifest = readJson('plugins/orangu/.codex-plugin/plugin.json')
    const pkg = readJson('package.json')
    expect(manifest.name).toBe('orangu')
    expect(manifest.version).toBe(pkg.version)
    expect(manifest.skills).toBe('./skills/')
    expect(manifest.interface?.displayName).toBe('Orangu')
    expect(manifest.interface?.developerName).toBe('Nissan Ohana')
    expect(manifest.interface?.defaultPrompt).toHaveLength(3)
    expect(manifest.mcpServers).toBeUndefined()
    expect(manifest.apps).toBeUndefined()
    for (const asset of [manifest.interface?.composerIcon, manifest.interface?.logo]) {
      expect(asset).toMatch(/^\.\/assets\//)
      expect(existsSync(join(root, 'plugins/orangu', asset))).toBe(true)
    }
  })

  it('bundles Orangu improve, apply, and feedback as its own Codex skills', () => {
    const names = readdirSync(join(root, 'plugins/orangu/skills'))
      .filter((name) => existsSync(join(root, 'plugins/orangu/skills', name, 'SKILL.md')))
      .sort()
    expect(names).toEqual(['orangu-apply', 'orangu-feedback', 'orangu-improve'])

    for (const name of names) {
      const skill = readText(`plugins/orangu/skills/${name}/SKILL.md`)
      expect(skill).toMatch(new RegExp(`^name:\\s*${name}$`, 'm'))
      expect(skill).toContain('../../bin/orangu.cli.mjs')
      expect(skill).not.toContain('Claude Code /insights')
      expect(skill).not.toContain('Codex commands')
      // Codex has no allowed-tools key, no plugin root variable, and no slash commands
      expect(skill, `${name} drops allowed-tools`).not.toContain('allowed-tools')
      expect(skill, `${name} drops the Claude plugin root`).not.toContain('${CLAUDE_PLUGIN_ROOT}')
      expect(skill, `${name} has no Claude slash command`).not.toMatch(/\/orangu:/)
      // routes to another mirrored skill keep the Codex name; feedback routes only to the CLI and carries none
      const self = name.replace('orangu-', '')
      const others = ['improve', 'apply', 'feedback'].filter((other) => other !== self)
      if (new RegExp(`/orangu:(${others.join('|')})\\b`).test(readText(`plugin/skills/${self}/SKILL.md`)))
        expect(skill, `${name} routes with Codex names`).toContain('$orangu-')
      // Codex ships only these three skills: a pointer to an unmirrored skill must name the CLI verb,
      // never a `$orangu-<n>` the host cannot resolve
      expect(skill, `${name} routes to no unmirrored Codex skill`).not.toMatch(/\$orangu-(analyze|harness)\b/)
      expect(skill).toMatch(new RegExp(`^# ${name}$`, 'm'))
    }
    expect(readText('plugins/orangu/skills/orangu-feedback/SKILL.md')).toContain('Not for anything about a session: the `orangu analyze` command.')
    expect(readText('plugins/orangu/skills/orangu-improve/SKILL.md')).toContain('Not for a repo or global harness review: the `orangu harness` command.')
    expect(readText('plugins/orangu/skills/orangu-improve/SKILL.md')).toContain('belongs to `orangu harness`.')
    for (const path of filesUnder('plugins/orangu/skills').filter((p) => p.endsWith('.md')))
      expect(readText(path), `${path} routes to no unmirrored Codex skill`).not.toMatch(/\$orangu-(analyze|harness)\b/)
  })

  it('generates the mirror from plugin/skills instead of hand-writing it', () => {
    // The invariant that matters: every non-frontmatter line of the Claude skill that carries no
    // host-specific token appears verbatim in the mirror, so prose edits are one-file edits.
    for (const name of ['improve', 'apply', 'feedback']) {
      const claude = readText(`plugin/skills/${name}/SKILL.md`)
      const codex = readText(`plugins/orangu/skills/orangu-${name}/SKILL.md`)
      const body = claude.split('\n---\n', 2)[1] ?? ''
      const lines = body.split('\n').filter((line) => line.trim() !== '' && !line.includes('/orangu:') && !line.includes('CLAUDE_PLUGIN_ROOT'))
      expect(lines.length).toBeGreaterThan(5)
      for (const line of lines) expect(codex, `orangu-${name} keeps: ${line.slice(0, 60)}`).toContain(line)
      // the Codex-only inputs live beside the source, not in the generated tree
      expect(existsSync(join(root, `plugin/codex/${name}/openai.yaml`))).toBe(true)
      expect(readText(`plugins/orangu/skills/orangu-${name}/agents/openai.yaml`)).toBe(readText(`plugin/codex/${name}/openai.yaml`))
    }
    // references and the shared rules ride along so relative links resolve in both hosts
    for (const ref of ['orangu-improve/references/artifact-contract.md', 'orangu-apply/references/application-contract.md', 'shared/untrusted-input.md']) {
      expect(existsSync(join(root, 'plugins/orangu/skills', ref)), ref).toBe(true)
      expect(readText(`plugins/orangu/skills/${ref}`)).not.toMatch(/\/orangu:|CLAUDE_PLUGIN_ROOT/)
    }
  })

  it('keeps the installable skills byte-identical to the repo-discovered skills', () => {
    const repoFiles = filesUnder('.agents/skills')
    const pluginFiles = filesUnder('plugins/orangu/skills')
    expect(pluginFiles.map((path) => path.replace('plugins/orangu/skills/', '')))
      .toEqual(repoFiles.map((path) => path.replace('.agents/skills/', '')))

    for (const repoPath of repoFiles) {
      const relative = repoPath.replace('.agents/skills/', '')
      expect(readFileSync(join(root, `plugins/orangu/skills/${relative}`)), relative)
        .toEqual(readFileSync(join(root, repoPath)))
    }
  })

  it('bundles the same offline CLI and Orangu brand assets as the product', () => {
    expect(readFileSync(join(root, 'plugins/orangu/bin/orangu.cli.mjs')))
      .toEqual(readFileSync(join(root, 'plugin/bin/orangu.cli.mjs')))
    expect(readFileSync(join(root, 'plugins/orangu/assets/icon.png')))
      .toEqual(readFileSync(join(root, 'design/brand/favicon-64.png')))
    expect(readFileSync(join(root, 'plugins/orangu/assets/logo.png')))
      .toEqual(readFileSync(join(root, 'design/brand/mascot-main-transparent.png')))
  })
})
