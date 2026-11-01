import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
    // the card counts the skills that the build mirrors (4 since the interview got its mirror, 2026-10-24)
    expect(manifest.interface?.longDescription).toContain('Orangu bundles four skills of its own.')
    // the profile interview (2026-11-01): the card names no question count
    expect(manifest.interface?.longDescription).toContain('One asks about your role and your work, and keeps your answers.')
    expect(manifest.interface?.longDescription).not.toMatch(/outside options|one suggestion|\d+ questions/)
    expect(manifest.mcpServers).toBeUndefined()
    expect(manifest.apps).toBeUndefined()
    for (const asset of [manifest.interface?.composerIcon, manifest.interface?.logo]) {
      expect(asset).toMatch(/^\.\/assets\//)
      expect(existsSync(join(root, 'plugins/orangu', asset))).toBe(true)
    }
  })

  it('bundles Orangu improve, interview, apply, and feedback as its own Codex skills', () => {
    const names = readdirSync(join(root, 'plugins/orangu/skills'))
      .filter((name) => existsSync(join(root, 'plugins/orangu/skills', name, 'SKILL.md')))
      .sort()
    expect(names).toEqual(['orangu-apply', 'orangu-feedback', 'orangu-improve', 'orangu-interview'])

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
      const others = ['improve', 'apply', 'feedback', 'interview'].filter((other) => other !== self)
      if (new RegExp(`/orangu:(${others.join('|')})\\b`).test(readText(`plugin/skills/${self}/SKILL.md`)))
        expect(skill, `${name} routes with Codex names`).toContain('$orangu-')
      // Codex ships only these four skills: a pointer to an unmirrored skill must name the CLI verb,
      // never a `$orangu-<n>` the host cannot resolve
      expect(skill, `${name} routes to no unmirrored Codex skill`).not.toMatch(/\$orangu-(analyze|harness)\b/)
      expect(skill).toMatch(new RegExp(`^# ${name}$`, 'm'))
    }
    // C13 (2026-11-01): improve took in the review of a whole harness, so no mirror points at a CLI verb in place of a
    // retired skill. feedback routes a session question to improve by its Codex name.
    expect(readText('plugins/orangu/skills/orangu-feedback/SKILL.md')).toContain('Not for anything about a session: $orangu-improve.')
    for (const path of filesUnder('plugins/orangu/skills').filter((p) => p.endsWith('.md')))
      expect(readText(path), `${path} points at no CLI verb for a retired skill`).not.toMatch(/the `orangu (?:analyze|harness)` command|belongs to `orangu harness`/)
    // the review of improve rides with improve, and the brain rules ride in shared/, in both trees
    for (const tree of ['plugins/orangu/skills', '.agents/skills']) {
      expect(readText(`${tree}/orangu-improve/references/review.md`), `${tree} mirrors the review`).toContain('# The review of a whole harness')
      expect(readText(`${tree}/shared/brain.md`), `${tree} carries the brain rules as they are`).toBe(readText('plugin/skills/shared/brain.md'))
      expect(readText(`${tree}/orangu-improve/references/review.md`), `${tree}: the review applies through the Codex apply skill`).toContain('$orangu-apply <id>')
    }
    // The profile interview (2026-11-01): improve hands no id to it, it routes a change proposal to improve by its Codex
    // name, and it searches in no host. Its question and profile rules ride along in shared/.
    for (const tree of ['plugins/orangu/skills', '.agents/skills']) {
      const improve = readText(`${tree}/orangu-improve/SKILL.md`)
      expect(improve).not.toContain('$orangu-interview <id>')
      const interview = readText(`${tree}/orangu-interview/SKILL.md`)
      expect(interview).toContain('Not for a change proposal: $orangu-improve.')
      expect(interview).toContain('Otherwise name `$orangu-improve` as the next step')
      expect(interview).toContain('Do no research, and start no agent.')
      expect(interview, `${tree} interview searches in no host`).not.toMatch(/search yourself|search terms|page text/)
      expect(interview).toContain('](../shared/profile.md)')
      expect(readText(`${tree}/shared/profile.md`)).toBe(readText('plugin/skills/shared/profile.md'))
      expect(readText(`${tree}/shared/research-sources.md`), 'no host fallback for an interview search').not.toMatch(/approved terms/)
    }
    // the skill stays model-invocable in both hosts, so improve can invoke it on its first run
    const yaml = readText('plugin/codex/interview/openai.yaml')
    expect(yaml).toContain('allow_implicit_invocation: true')
    // the Codex card of the skill describes the profile interview (C13), with no question count
    expect(yaml).toContain('short_description: "Ask about your role and your work, and keep the answers"')
    expect(yaml).toContain('default_prompt: "Use $orangu-interview to ask me about my role, my work and how I run agents. Then keep my answers as my Orangu profile."')
    expect(yaml, 'the yaml names no suggestion job').not.toMatch(/suggestion|research|second opinion|proposal|\d+ questions/i)
    for (const path of filesUnder('plugins/orangu/skills').filter((p) => p.endsWith('.md'))) {
      expect(readText(path), `${path} routes to no unmirrored Codex skill`).not.toMatch(/\$orangu-(analyze|harness)\b/)
      // the CLI-verb rewrite must never nest one code span inside another (`the `orangu harness` command`)
      expect(readText(path), `${path} has no nested backticks`).not.toMatch(/`[^`\n]*`[^`\n]*` command|`the `/)
    }
  })

  it('generates the mirror from plugin/skills instead of hand-writing it', () => {
    // C13 (2026-11-01): the build knows only the skills that plugin/skills ships, so no Claude-only skill name is left
    // for the mirror to turn into a CLI verb
    expect(readText('scripts/build.mjs')).toContain("const CLAUDE_SKILLS = ['improve', 'apply', 'feedback', 'interview']")
    // The invariant that matters: every non-frontmatter line of the Claude skill that carries no
    // host-specific token appears verbatim in the mirror, so prose edits are one-file edits.
    for (const name of ['improve', 'apply', 'feedback', 'interview']) {
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
    for (const ref of ['shared/artifact-contract.md', 'shared/research-sources.md', 'orangu-apply/references/application-contract.md', 'shared/untrusted-input.md', 'shared/interview.md', 'shared/ste.md', 'shared/loop.md', 'shared/profile.md', 'shared/brain.md', 'orangu-improve/references/review.md']) {
      expect(existsSync(join(root, 'plugins/orangu/skills', ref)), ref).toBe(true)
      expect(readText(`plugins/orangu/skills/${ref}`)).not.toMatch(/\/orangu:|CLAUDE_PLUGIN_ROOT/)
    }
  })

  // A mirror copies only each skill's own folder and shared/ (scripts/build.mjs). A link into another skill's folder,
  // or to a file that the mirror does not carry, breaks only in Codex, so each relative link must resolve in each tree.
  it('resolves every relative Markdown link inside each Codex mirror', () => {
    for (const tree of ['.agents/skills', 'plugins/orangu/skills']) {
      let links = 0
      for (const path of filesUnder(tree).filter((p) => p.endsWith('.md'))) {
        const text = readText(path).replace(/```[\s\S]*?```/g, '')
        for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
          const target = match[1]!.split('#')[0]!
          if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
          links++
          expect(existsSync(join(root, dirname(path), target)), `${path} links ${target}`).toBe(true)
          expect(join(dirname(path), target).startsWith(`${tree}/`), `${path} links ${target} inside ${tree}`).toBe(true)
        }
      }
      expect(links, `${tree} has relative links to check`).toBeGreaterThan(10)
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
