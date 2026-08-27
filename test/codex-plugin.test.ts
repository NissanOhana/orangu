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
