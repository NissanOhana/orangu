/**
 * orangu-improve.zip (E6, and the zip half of E9): the portable skill that a Claude chat outside Claude Code runs on an
 * uploaded orangu-export.json. `orangu export` writes it beside the export, from the module that the build makes from
 * plugin/portable/orangu-improve/SKILL.md and the 2 shared brain files. The build checks the package and stops on a
 * failure (scripts/build.mjs). This test reads the zip with its own reader, from the ZIP format note as zip.test.ts reads
 * it, and checks each row again: claude.ai and the API refuse a package that breaks one.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { PORTABLE_SKILL_ENTRIES } from './generated/portable-skill.js'
import { SKILL_ZIP_FILE, portableSkillZip } from './write.js'

const root = process.cwd()
const read = (rel: string): Buffer => readFileSync(join(root, rel))
/** The 6 frontmatter keys that claude.ai and the API accept, less `allowed-tools`: the portable skill grants no tool. */
const KEYS = ['name', 'description', 'license', 'compatibility', 'metadata']
/** The source of each file in the zip. The skill is hand-written, and the brain rules and the profile rules are copies. */
const SOURCES: Readonly<Record<string, string>> = {
  'orangu-improve/SKILL.md': 'plugin/portable/orangu-improve/SKILL.md',
  'orangu-improve/references/brain.md': 'plugin/skills/shared/brain.md',
  'orangu-improve/references/profile.md': 'plugin/skills/shared/profile.md',
}

/** Each entry of a stored zip, name to bytes: the end record, then each central header, its local header and its data. */
function unzip(zip: Uint8Array): Map<string, Buffer> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const end = zip.byteLength - 22
  expect(view.getUint32(end, true), 'end record signature').toBe(0x06054b50)
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  const entries = new Map<string, Buffer>()
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true), 'central header signature').toBe(0x02014b50)
    expect(view.getUint16(at + 10, true), 'a stored entry, with no compression').toBe(0)
    const nameLength = view.getUint16(at + 28, true)
    const size = view.getUint32(at + 24, true)
    const local = view.getUint32(at + 42, true)
    const name = Buffer.from(zip.subarray(at + 46, at + 46 + nameLength)).toString('utf8')
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    entries.set(name, Buffer.from(zip.subarray(dataStart, dataStart + size)))
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
  }
  return entries
}

const entries = (): Map<string, Buffer> => unzip(portableSkillZip())
const files = (): string[] => [...entries().keys()].filter((name) => !name.endsWith('/'))
const text = (name: string): string => entries().get(name)!.toString('utf8')

/** The frontmatter of SKILL.md as `key: value` lines, 1 key on each line. */
function frontmatter(skill: string): Array<[string, string]> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(skill)
  expect(block, 'SKILL.md opens with a frontmatter block').toBeTruthy()
  return block![1]!.split('\n').map((line): [string, string] => {
    const pair = /^([a-z][a-z-]*): (.*)$/.exec(line)
    expect(pair, `1 key and its value on 1 line: ${line}`).toBeTruthy()
    return [pair![1]!, pair![2]!]
  })
}

/** The orangu commands in the code of a Markdown file: each fenced block and each code span (test/plugin.test.ts:266-270). */
const fences = /^```[^\n]*\n([\s\S]*?)^```/gm
const commandVerbs = (markdown: string): string[] =>
  [...[...markdown.matchAll(fences)].map((m) => m[1]!), ...[...markdown.replace(fences, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!)].flatMap((code) =>
    [...code.matchAll(/(?:^|[\s$(|;&])orangu ([a-z][a-z-]*)|orangu\.cli\.mjs"? ([a-z][a-z-]*)/gm)].map((m) => (m[1] ?? m[2])!),
  )

describe('orangu-improve.zip', () => {
  it('holds 1 top folder, orangu-improve/, with SKILL.md at its root and the 2 references (E6)', () => {
    expect(SKILL_ZIP_FILE).toBe('orangu-improve.zip')
    expect([...entries().keys()]).toEqual([
      'orangu-improve/',
      'orangu-improve/SKILL.md',
      'orangu-improve/references/',
      'orangu-improve/references/brain.md',
      'orangu-improve/references/profile.md',
    ])
    expect(new Set([...entries().keys()].map((name) => name.split('/')[0])), 'only 1 top folder').toEqual(new Set(['orangu-improve']))
    for (const folder of ['orangu-improve/', 'orangu-improve/references/']) expect(entries().get(folder)!.length, `${folder} holds no data`).toBe(0)
  })

  it('has a frontmatter of the accepted keys, a name of the folder with no reserved word, and a short description (E6)', () => {
    const pairs = frontmatter(text('orangu-improve/SKILL.md'))
    const keys = pairs.map(([key]) => key)
    for (const key of keys) expect(KEYS, `${key} is a key that claude.ai and the API accept`).toContain(key)
    expect(new Set(keys).size, 'no key 2 times').toBe(keys.length)
    const value = (key: string): string => pairs.find(([k]) => k === key)?.[1] ?? ''
    expect(value('name')).toBe('orangu-improve')
    expect(value('name')).toMatch(/^[a-z0-9-]{1,64}$/)
    expect(value('name')).not.toMatch(/claude|anthropic/i)
    expect(value('description').length, 'a description').toBeGreaterThan(0)
    expect(value('description').length, 'the description has 200 characters or fewer').toBeLessThanOrEqual(200)
    expect(value('description'), 'no XML tag').not.toMatch(/[<>]/)
    // a strict YAML parser reads each value as the same string: a plain value with ": " or " #" in it is a parse error
    for (const [key, v] of pairs) expect(v, `${key} is a plain YAML value`).toMatch(/^[A-Za-z0-9](?:(?!: | #).)*[^\s:]$/)
  })

  it('names no grant, no plugin root, no bin/ path and no orangu command but the 1 line that makes the export (E6)', () => {
    for (const name of files()) {
      const content = text(name)
      expect(content, `${name} holds no grant key`).not.toContain('allowed-tools')
      expect(content, `${name} holds no plugin root`).not.toContain('CLAUDE_PLUGIN_ROOT')
      expect(content, `${name} holds no bin/ path`).not.toMatch(/\bbin\//)
      expect(content, `${name} holds no bundled CLI`).not.toContain('orangu.cli.mjs')
      // the 1 orangu command: the line that asks the user to make the export on their machine
      expect(commandVerbs(content), `${name} runs no orangu command`).toEqual(name === 'orangu-improve/SKILL.md' ? ['export'] : [])
      expect(content.match(/npx orangu/g) ?? [], `${name}: npx orangu`).toEqual(name === 'orangu-improve/SKILL.md' ? ['npx orangu'] : [])
    }
    expect(text('orangu-improve/SKILL.md')).toContain('`npx orangu export`')
  })

  it('resolves each relative link inside the zip (E6)', () => {
    let links = 0
    for (const name of files()) {
      for (const m of text(name).matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1]!
        if (/^(?:https?:|mailto:|#)/.test(target)) continue
        links++
        const resolved = posix.normalize(posix.join(posix.dirname(name), target.split('#')[0]!))
        expect(files(), `${name} links ${target}`).toContain(resolved)
      }
    }
    expect(links, 'the brain rules link the profile rules').toBeGreaterThanOrEqual(1)
  })

  it('resolves each references/ path that SKILL.md names inside the zip (E6)', () => {
    // SKILL.md names its references as code-span paths, because verify:public resolves each Markdown link in the repository
    const named = [...text('orangu-improve/SKILL.md').matchAll(/`(references\/[^`\s]+)`/g)].map((m) => `orangu-improve/${m[1]}`)
    expect(named).toEqual(['orangu-improve/references/brain.md', 'orangu-improve/references/profile.md'])
    for (const name of named) expect(files(), name).toContain(name)
  })

  it('names claude "/orangu:improve as the command that saves a change in Claude Code (E6)', () => {
    expect(text('orangu-improve/SKILL.md')).toContain('claude "/orangu:improve')
  })

  it('holds the skill and byte-identical copies of shared/brain.md and shared/profile.md (E9)', () => {
    expect(files()).toEqual(Object.keys(SOURCES))
    for (const [name, source] of Object.entries(SOURCES)) expect(entries().get(name)!.equals(read(source)), `${name} is ${source}, byte for byte`).toBe(true)
  })

  it('gives the same bytes on each run', () => {
    expect(Buffer.from(portableSkillZip()).equals(Buffer.from(portableSkillZip()))).toBe(true)
  })

  const unzipTool = spawnSync('unzip', ['-v'], { encoding: 'utf8' })
  it.skipIf(unzipTool.status !== 0)('passes the archive test of unzip, and unzip lists the same names', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orangu-portable-')), SKILL_ZIP_FILE)
    writeFileSync(path, portableSkillZip())
    const run = spawnSync('unzip', ['-t', path], { encoding: 'utf8' })
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(run.stdout).toContain('No errors detected')
    expect(spawnSync('unzip', ['-Z1', path], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)).toEqual([...entries().keys()])
  })
})

// The CLI writes the zip from a generated module, so no input names a skill path at run time. The module must hold the
// same bytes as the sources that the build checks (as test/show-me-templates.test.ts holds the show-me module).
describe('orangu-improve.zip: embedded in the CLI build', () => {
  it('the generated module holds each source file byte for byte', () => {
    const embedded = PORTABLE_SKILL_ENTRIES.filter((entry) => !entry.name.endsWith('/'))
    expect(embedded.map((entry) => entry.name)).toEqual(Object.keys(SOURCES))
    for (const entry of embedded) expect(Buffer.from(entry.data as string, 'utf8').equals(read(SOURCES[entry.name]!)), `${entry.name} bytes`).toBe(true)
  })

  it('verify:generated compares the module, and the build writes it before the CLI bundle', () => {
    expect(read('scripts/assert-generated.mjs').toString('utf8')).toContain("'src/export/generated/portable-skill.ts'")
    const build = read('scripts/build.mjs').toString('utf8')
    const moduleAt = build.indexOf("join(root, 'src/export/generated/portable-skill.ts')")
    const cliAt = build.indexOf("entryPoints: [join(root, 'src/cli/main.ts')]")
    expect(moduleAt, 'the build writes the module').toBeGreaterThan(-1)
    expect(cliAt, 'the build bundles the CLI').toBeGreaterThan(-1)
    expect(moduleAt, 'the module is written before the CLI bundle').toBeLessThan(cliAt)
  })
})
