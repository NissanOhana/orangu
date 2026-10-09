import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyPrompt, sessionTitle } from './prompt-kind.js'
import { classifyPrompt as classifyPromptFromParse } from './parse.js'
import { projectSlug } from '../../discover/slug.js'
import { projectSlug as projectSlugFromDiscover } from '../../discover/discover.js'

describe('classifyPrompt', () => {
  it('reads an interrupt marker in the first 200 characters before any other signal', () => {
    expect(classifyPrompt({ origin: { kind: 'human' } }, '[Request interrupted by user for tool use]', false)).toBe('interrupt')
    expect(classifyPrompt({}, '[request INTERRUPTED by user]', true)).toBe('interrupt')
    expect(classifyPrompt({}, `${'x'.repeat(200)}[Request interrupted by user]`, false)).toBe('human')
  })

  it('takes a transcript-only record as meta', () => {
    expect(classifyPrompt({ isVisibleInTranscriptOnly: true, origin: { kind: 'human' } }, 'go', false)).toBe('meta')
  })

  it('takes a human origin or a typed prompt as human, or as command when it names a command', () => {
    expect(classifyPrompt({ origin: { kind: 'human' } }, 'fix the test', false)).toBe('human')
    expect(classifyPrompt({ promptSource: 'typed' }, 'fix the test', true)).toBe('human')
    expect(classifyPrompt({ promptSource: 'typed' }, '<command-name>/review</command-name>', false)).toBe('command')
  })

  it('maps the origin kinds of notifications and peers', () => {
    expect(classifyPrompt({ origin: { kind: 'task-notification' } }, 'done', false)).toBe('notification')
    for (const kind of ['peer', 'teammate', 'cross-session']) expect(classifyPrompt({ origin: { kind } }, 'hello', false)).toBe('peer')
  })

  it('falls back to the content after the leading system reminders', () => {
    expect(classifyPrompt({}, '<command-message>review</command-message>', false)).toBe('command')
    expect(classifyPrompt({}, '<system-reminder>a</system-reminder>\n <system-reminder>b</system-reminder>  <command-name>/x</command-name>', false)).toBe('command')
    for (const tag of ['<local-command-stdout>', '<local-command-caveat>', '<local-command-stderr>']) expect(classifyPrompt({}, `${tag}out`, false)).toBe('local_output')
    expect(classifyPrompt({}, '<task-notification><task-id>t</task-id></task-notification>', false)).toBe('notification')
    for (const text of ['<teammate-message teammate_id="a">go</teammate-message>', '<cross-session-message>go', 'Another Claude session sent a message: go']) {
      expect(classifyPrompt({}, text, false)).toBe('peer')
    }
  })

  it('takes a meta record from the system as scheduled, and any other meta record as meta', () => {
    expect(classifyPrompt({ promptSource: 'system' }, 'a timer fired', true)).toBe('scheduled')
    expect(classifyPrompt({}, 'a timer fired', true)).toBe('meta')
  })

  it('takes the known injected wrappers as meta and keeps pasted markup as human', () => {
    const wrappers = ['<user-prompt-submit-hook>', '<system-reminder>', '<budget:', '<total_tokens>', '<user-memory-input>', '<important_context>', '<function_results>', '<returned-by-']
    for (const tag of wrappers) expect(classifyPrompt({}, `${tag}x`, false)).toBe('meta')
    expect(classifyPrompt({}, '<div>pasted markup</div>', false)).toBe('human')
    expect(classifyPrompt({}, 'plain words', false)).toBe('human')
  })
})

describe('sessionTitle', () => {
  it('takes the custom title first, then the AI title, then the first prompt', () => {
    expect(sessionTitle('Custom', 'AI', 'first prompt', undefined)).toBe('Custom')
    expect(sessionTitle(undefined, 'AI', 'first prompt', undefined)).toBe('AI')
    expect(sessionTitle(undefined, undefined, 'first prompt', undefined)).toBe('first prompt')
    expect(sessionTitle(undefined, undefined, undefined, '/x')).toBeUndefined()
  })

  it('keeps an empty title, because only a missing value falls through', () => {
    expect(sessionTitle('', 'AI', 'first prompt', undefined)).toBe('')
  })

  it('titles a command envelope by its command and its arguments', () => {
    const envelope = '<command-message>review</command-message> <command-name>/review</command-name> <command-args> src/a.ts </command-args>'
    expect(sessionTitle(undefined, undefined, envelope, undefined)).toBe('/review src/a.ts')
    expect(sessionTitle(undefined, undefined, '  <command-name>/compact</command-name>', undefined)).toBe('/compact')
    expect(sessionTitle(undefined, undefined, '<command-name>/x</command-name><command-args>a</command-args>', '/y')).toBe('/y a')
    expect(sessionTitle(undefined, undefined, '<command-message>review</command-message>', undefined)).toBe('<command-message>review</command-message>')
    expect(sessionTitle('<command-name>/x</command-name>', 'AI', 'first prompt', undefined)).toBe('/x')
  })
})

describe('the old import paths re-export the moved code', () => {
  it('parse.ts gives the classifyPrompt of prompt-kind.ts', () => {
    expect(classifyPromptFromParse).toBe(classifyPrompt)
  })

  it('discover.ts gives the projectSlug of slug.ts', () => {
    expect(projectSlugFromDiscover).toBe(projectSlug)
  })
})

const here = dirname(fileURLToPath(import.meta.url))
const SPECIFIER_RE = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]/g

/** Every module specifier in the import graph of `entry`, as `file -> specifier`. Follows relative imports only. */
function importGraph(entry: string): string[] {
  const edges: string[] = []
  const seen = new Set<string>()
  const visit = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER_RE)) {
      const spec = (match[1] ?? match[2]) as string
      edges.push(`${file} -> ${spec}`)
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')))
    }
  }
  visit(entry)
  return edges
}

describe('the moved modules stay pure', () => {
  for (const entry of [resolve(here, 'prompt-kind.ts'), resolve(here, '../../discover/slug.ts')]) {
    it(`${entry.slice(entry.indexOf('src/'))} imports no Node module, no package, and neither jsonl.ts nor parse.ts`, () => {
      const edges = importGraph(entry)
      const bad = edges.filter((edge) => {
        const spec = edge.slice(edge.indexOf(' -> ') + 4)
        return !spec.startsWith('.') || /(?:^|\/)(?:jsonl|parse)\.js$/.test(spec)
      })
      expect(bad).toEqual([])
    })
  }
})
