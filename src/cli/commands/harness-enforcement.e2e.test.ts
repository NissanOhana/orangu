/**
 * `orangu harness` end to end for the `enforcement` section, against the BUILT CLI, on a synthetic home.
 *
 * The story from the field, as a fixture: the project CLAUDE.md says "Never run `next build` bare" and the
 * session runs it anyway; a hook stops one try. The user complains, the agent saves a feedback note, and the same
 * complaint comes back. The memory index is over its 200-line load limit, and Claude Code said so at load.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionBuilder, resetIds } from '../../../test/fixtures/session-builder.js'
import type { HarnessReport } from '../../harness/types.js'

const CLI = join(process.cwd(), 'dist', 'orangu.js')
const SLUG = '-Users-test-Code-site'
const WARNING =
  '> WARNING: MEMORY.md is 230 lines (limit: 200). Only part of it was loaded: 30 of 230 lines were cut off, starting at line 201. Keep index entries to one line under ~200 chars; move detail into topic files.'

interface Fixture {
  home: string
  repo: string
}

async function makeFixture(): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), 'orangu-enforce-home-'))
  const configDir = join(home, '.claude')
  const project = join(configDir, 'projects', SLUG)
  const memoryDir = join(project, 'memory')
  await mkdir(memoryDir, { recursive: true })
  const index = Array.from({ length: 230 }, (_, i) => `- [Note ${i}](note_${i}.md) - entry ${i}`).join('\n') + '\n'
  await writeFile(join(memoryDir, 'MEMORY.md'), index, 'utf8')
  await writeFile(join(memoryDir, 'feedback_viewport.md'), '---\nname: viewport\ntype: feedback\n---\nCheck the desktop and the mobile layout before done.\n', 'utf8')

  resetIds()
  const b = new SessionBuilder({ sessionId: '77777777-0000-4000-8000-00000000aaaa', cwd: '/Users/test/Code/site', startAt: '2026-10-03T21:40:00.000Z' })
  b.attachment('instructions', {
    files: [
      { path: '/Users/test/Code/site/CLAUDE.md', type: 'Project', content: '# Rules\n- Never run `next build` bare. Set NODE_OPTIONS first.\n' },
      { path: join(memoryDir, 'MEMORY.md'), type: 'AutoMem', content: index.split('\n').slice(0, 200).join('\n') + '\n' + WARNING },
    ],
  })
  b.userPrompt('you are not checking every screen size!')
  b.toolCall('Write', { file_path: join(memoryDir, 'feedback_viewport.md'), content: '---\nname: viewport\ntype: feedback\n---\nCheck the desktop and the mobile layout before done.' }, 'ok')
  b.tick(60_000)
  b.toolCall('Bash', { command: 'next build' }, 'ok')
  b.toolCall('Bash', { command: 'next build' }, 'PreToolUse:Bash hook error: next build needs NODE_OPTIONS', { isError: true })
  b.tick(44 * 60_000)
  b.userPrompt('broken on desktop')
  b.turnDuration(3000, 5)
  await writeFile(join(project, '77777777-0000-4000-8000-00000000aaaa.jsonl'), b.toJsonl())

  const repo = await mkdtemp(join(tmpdir(), 'orangu-enforce-repo-'))
  return { home, repo }
}

let fx: Fixture
const run = (args: string[]) =>
  execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: fx.home, ORANGU_NO_CACHE: '1', ORANGU_HOME: join(fx.home, '.orangu'), ORANGU_CLAUDE_ROOTS: '', CLAUDE_CONFIG_DIR: '', ORANGU_CLAUDE_MANAGED_DIRS: '', CLAUDECODE: '' },
  })

describe.skipIf(!existsSync(CLI))('orangu harness: rules that did not hold (built CLI)', () => {
  beforeAll(async () => {
    fx = await makeFixture()
  })

  it('puts the broken rule, the cut memory index and the feedback note in --json', () => {
    const r = JSON.parse(run(['harness', '--global', '--cwd', fx.repo, '--json', '--quiet'])) as HarnessReport
    const e = r.enforcement
    expect(e.counts).toMatchObject({ sessionsWithRecord: 1, rulesInContext: 1, rulesBroken: 1, rulesEnforced: 0, feedbackNotes: 1, notesFollowedByComplaint: 1, memoryIndexesCut: 1 })
    expect(e.broken[0]).toMatchObject({ target: { kind: 'command', name: 'next build' }, calls: 2, blocked: 1, sessionsInContext: 1, sessionsBroken: 1, line: 2 })
    expect(e.memory[0]).toMatchObject({ lines: 230, linesPastLimit: 30, firstLinePastLimit: 201, sessionsLoaded: 1, sessionsCut: 1, maxLinesCut: 30 })
    expect(e.notes[0]).toMatchObject({ kind: 'memory', noteType: 'feedback', matchingComplaints: 1, sharedWords: ['desktop'] })
    // no prompt text without --include-text
    expect(JSON.stringify(e)).not.toContain('broken on desktop')
    expect(r.inventory.memoryIndexes[0]).toMatchObject({ lines: 230, linesPastLimit: 30 })
  })

  it('prints the block, and the complaint text only on request', () => {
    const text = run(['harness', '--global', '--cwd', fx.repo, '--quiet'])
    expect(text).toContain('rules that did not hold')
    expect(text).toMatch(/next build\s+2 calls in 1 of 1 session that had the rule/)
    expect(text).toContain('a hook or a deny rule stopped 1, and 1 ran')
    expect(text).toContain('cut in 1 of 1 session that loaded it')
    expect(text).toContain('1 of 1 came back as a complaint')
    expect(text).toContain('add --include-text to see the text of each complaint')
    // the block keeps the 80-column contract (a path line above it prints the temp dir whole, by design)
    for (const line of text.slice(text.indexOf('rules that did not hold')).split('\n')) expect(line.length, line).toBeLessThanOrEqual(80)
    const withText = JSON.parse(run(['harness', '--global', '--cwd', fx.repo, '--json', '--quiet', '--include-text'])) as HarnessReport
    expect(withText.enforcement.notes[0]!.examples[0]!.preview).toBe('broken on desktop')
  })
})
