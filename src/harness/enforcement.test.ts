import { describe, expect, it } from 'vitest'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import { SessionBuilder } from '../../test/fixtures/session-builder.js'
import type { Analysis } from '../model/analysis.js'
import { buildEnforcement, loadedMemoryIndexPaths, ruleHome } from './enforcement.js'
import { memoryIndexCut } from './collect.js'

const MEM_DIR = '/Users/test/.claude/projects/-Users-test-Code-site/memory'
const RULE = '- **Never run `next build` bare.** Set NODE_OPTIONS first.'

async function analyze(b: SessionBuilder): Promise<Analysis> {
  return analyzeSession(await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true }), { version: 'test', now: 0 })
}

function loads(b: SessionBuilder, claudeMd: string, memory = '- [Screens](feedback_screens.md)'): SessionBuilder {
  return b.attachment('instructions', {
    files: [
      { path: claudeMd, type: 'Project', content: `# Rules\n${RULE}\n` },
      { path: `${MEM_DIR}/MEMORY.md`, type: 'AutoMem', content: memory },
    ],
  })
}

describe('buildEnforcement: rules', () => {
  it('sums one rule over its copies and sessions, and lists only rules that a call broke', async () => {
    const a = new SessionBuilder({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', cwd: '/Users/test/Code/site', startAt: '2026-10-01T10:00:00.000Z' })
    loads(a, '/Users/test/Code/site/CLAUDE.md').userPrompt('build it').tick(1000)
    a.toolCall('Bash', { command: 'next build' }, 'ok')
    a.toolCall('Bash', { command: 'npx next build' }, 'ok')
    const b = new SessionBuilder({ sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', cwd: '/Users/test/Code/site/.claude/worktrees/w1', startAt: '2026-10-02T10:00:00.000Z' })
    loads(b, '/Users/test/Code/site/.claude/worktrees/w1/CLAUDE.md').userPrompt('build it').tick(1000)
    b.toolCall('Bash', { command: 'NODE_OPTIONS=--max-old-space-size=8192 next build' }, 'ok')
    const e = buildEnforcement([await analyze(a), await analyze(b)])
    expect(e.counts).toMatchObject({ sessionsWithRecord: 2, rulesInContext: 1, rulesBroken: 1 })
    expect(e.broken).toEqual([
      expect.objectContaining({
        file: '/Users/test/Code/site/CLAUDE.md',
        files: 2,
        line: 2,
        target: { kind: 'command', name: 'next build' },
        sessionsInContext: 2,
        sessionsBroken: 1,
        calls: 2,
        agentCalls: 0,
        examples: ['next build', 'npx next build'],
        exampleSessionIds: ['aaaaaaaa-0000-4000-8000-000000000001'],
      }),
    ])
  })
})

describe('buildEnforcement: copies and projects', () => {
  it('counts a call once when one session carries 2 copies of the rule', async () => {
    const a = new SessionBuilder({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', cwd: '/Users/test/Code/site' })
    a.attachment('instructions', {
      files: [
        { path: '/Users/test/Code/site/CLAUDE.md', type: 'Project', content: `# Rules\n${RULE}\n` },
        { path: '/Users/test/Code/site/.claude/worktrees/w1/CLAUDE.md', type: 'Project', content: `# Rules\n${RULE}\n` },
      ],
    })
    a.userPrompt('go').tick(1000)
    for (let i = 0; i < 5; i++) a.toolCall('Bash', { command: 'next build' }, 'ok')
    const e = buildEnforcement([await analyze(a)])
    expect(e.broken).toEqual([expect.objectContaining({ calls: 5, sessionsInContext: 1, sessionsBroken: 1, files: 2, file: '/Users/test/Code/site/CLAUDE.md' })])
  })

  it('keeps the same line in 2 projects as 2 rules, and a sibling worktree copy as the same rule', async () => {
    const one = async (id: string, claudeMd: string) => {
      const b = new SessionBuilder({ sessionId: id, cwd: claudeMd.replace(/\/CLAUDE\.md$/, '') })
      loads(b, claudeMd).userPrompt('go').tick(1000)
      b.toolCall('Bash', { command: 'next build' }, 'ok')
      return analyze(b)
    }
    const e = buildEnforcement([
      await one('aaaaaaaa-0000-4000-8000-000000000001', '/Users/test/Code/site/CLAUDE.md'),
      await one('bbbbbbbb-0000-4000-8000-000000000002', '/Users/test/Code/site-worktrees/fix-a/CLAUDE.md'),
      await one('cccccccc-0000-4000-8000-000000000003', '/Users/test/Code/other/CLAUDE.md'),
    ])
    expect(e.broken.map((b) => [b.file, b.sessionsBroken])).toEqual([
      ['/Users/test/Code/site/CLAUDE.md', 2],
      ['/Users/test/Code/other/CLAUDE.md', 1],
    ])
    expect(ruleHome('/Users/test/Code/site/.claude/worktrees/w1/CLAUDE.md')).toBe('/Users/test/Code/site')
    expect(ruleHome('/Users/test/Code/site/.worktrees/w2/CLAUDE.md')).toBe('/Users/test/Code/site')
  })
})

describe('buildEnforcement: notes and complaints', () => {
  async function corpus(): Promise<Analysis[]> {
    // 21:44: the agent writes the note; 22:28 the same complaint comes back in the same session
    const a = new SessionBuilder({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', cwd: '/Users/test/Code/site', startAt: '2026-10-03T21:40:00.000Z' })
    loads(a, '/Users/test/Code/site/CLAUDE.md')
    a.userPrompt('you are not validating changes on all screen sizes!')
    a.tick(4 * 60_000)
    a.toolCall('Write', { file_path: `${MEM_DIR}/feedback_screens.md`, content: 'Before done, check every screen size: mobile, tablet and desktop.' }, 'ok')
    a.tick(44 * 60_000)
    a.userPrompt('broken on desktop')
    a.tick(2 * 60_000)
    a.userPrompt('still broken on desktop')
    // the next morning, a new session of the same project loads the same memory
    const b = new SessionBuilder({ sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', cwd: '/Users/test/Code/site', startAt: '2026-10-04T08:00:00.000Z' })
    loads(b, '/Users/test/Code/site/CLAUDE.md')
    b.userPrompt('the card is broken on mobile')
    b.userPrompt('the login does not work')
    // another project: its complaints are not about this note
    const c = new SessionBuilder({ sessionId: 'cccccccc-0000-4000-8000-000000000003', cwd: '/Users/test/Code/other', startAt: '2026-10-04T09:00:00.000Z' })
    c.userPrompt('broken on desktop again')
    return Promise.all([analyze(a), analyze(b), analyze(c)])
  }

  it('counts the complaints after a note in the same project, and the ones that share its words', async () => {
    const e = buildEnforcement(await corpus(), { includeText: true })
    expect(e.counts).toMatchObject({ notesWritten: 1, notesFollowedByComplaint: 1 })
    const note = e.notes[0]!
    expect(note).toMatchObject({ file: `${MEM_DIR}/feedback_screens.md`, kind: 'memory', writes: 1, writtenBy: 'aaaaaaaa-0000-4000-8000-000000000001', sessionsAfter: 2, complaintsAfter: 4, matchingComplaints: 3, firstMatchAfterMs: 44 * 60_000 + 800 })
    expect(note.sharedWords).toEqual(['desktop', 'mobile'])
    expect(note.examples.map((x) => x.sessionId)).toEqual(['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002'])
    expect(note.examples[0]).toHaveProperty('preview', 'broken on desktop')
  })

  it('carries no text that a person or a model wrote without --include-text', async () => {
    const e = buildEnforcement(await corpus(), { instructionWords: new Set(['desktop']) })
    expect(e.notes[0]).toMatchObject({ matchingComplaints: 3, sharedWords: [] })
    expect(e.notes[0]!.examples[0]).not.toHaveProperty('preview')
    expect(e.complaints).toEqual([])
    expect(e.counts).toMatchObject({ complaints: 6, recurringComplaintWords: 2 })
    // a path stays (it is in every harness row), a word from a prompt does not
    expect(JSON.stringify(e).replace(/"broken":/g, "")).not.toMatch(/"(?:desktop|broken|screen)"|broken on/)
  })

  it('lists only feedback notes: a feedback file, or a note written right after a complaint', async () => {
    const a = new SessionBuilder({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', cwd: '/Users/test/Code/site', startAt: '2026-10-03T10:00:00.000Z' })
    loads(a, '/Users/test/Code/site/CLAUDE.md')
    a.userPrompt('ship the release notes')
    a.toolCall('Write', { file_path: `${MEM_DIR}/project_release.md`, content: '---\ntype: project\n---\nRelease 1.2 shipped to the desktop app.' }, 'ok')
    a.userPrompt('the deploy is broken again, you forgot the smoke test')
    a.toolCall('Edit', { file_path: '/Users/test/Code/site/CLAUDE.md', old_string: 'x', new_string: 'Run the smoke test before every deploy.' }, 'ok')
    a.tick(60_000)
    a.userPrompt('the smoke test did not run, broken deploy')
    const e = buildEnforcement([await analyze(a)], { includeText: true })
    expect(e.counts).toMatchObject({ notesWritten: 2, feedbackNotes: 1, notesFollowedByComplaint: 1 })
    expect(e.notes).toEqual([
      expect.objectContaining({ file: '/Users/test/Code/site/CLAUDE.md', kind: 'claude-md', trigger: expect.objectContaining({ turnIndex: 1 }), matchingComplaints: 1, sharedWords: ['deploy', 'smoke', 'test'] }),
    ])
  })

  it('does not match on a word that most prompts use', async () => {
    const sessions: Analysis[] = []
    for (let i = 0; i < 4; i++) {
      const b = new SessionBuilder({ sessionId: `dddddddd-0000-4000-8000-00000000000${i}`, cwd: '/Users/test/Code/site', startAt: `2026-10-0${i + 1}T10:00:00.000Z` })
      loads(b, '/Users/test/Code/site/CLAUDE.md')
      b.userPrompt('open the acme dashboard')
      if (i === 0) b.toolCall('Write', { file_path: `${MEM_DIR}/feedback_layout.md`, content: 'The acme cards must fit the viewport.' }, 'ok')
      if (i === 3) b.userPrompt('the acme page is broken')
      sessions.push(await analyze(b))
    }
    const e = buildEnforcement(sessions, { includeText: true })
    expect(e.notes[0]).toMatchObject({ complaintsAfter: 1, matchingComplaints: 0, sharedWords: [] })
  })

  it('finds the words that recur in complaints, and says when a note already uses the word', async () => {
    const e = buildEnforcement(await corpus(), { instructionWords: new Set(['desktop', 'mobile', 'screen']), includeText: true })
    expect(e.counts.complaints).toBe(6)
    const broken = e.complaints.find((r) => r.word === 'broken')!
    expect(broken).toMatchObject({ prompts: 4, sessions: 3, inInstructions: false })
    expect(e.complaints.find((r) => r.word === 'desktop')).toMatchObject({ prompts: 3, sessions: 2, inInstructions: true })
    expect(e.complaints.every((r) => r.prompts >= 2)).toBe(true)
  })

  it('keeps the prompt text of an example only on request', async () => {
    const e = buildEnforcement(await corpus(), { includeText: true })
    expect(e.notes[0]!.examples[0]!.preview).toBe('broken on desktop')
  })
})

describe('buildEnforcement: memory', () => {
  it('joins the index on disk and the sessions that loaded or cut it, under one path form', async () => {
    const warning = 'x\n> WARNING: MEMORY.md is 25.1KB (limit: 24.4KB) — index entries are too long. Only part of it was loaded: 5 of 115 lines were cut off, starting at line 111 ("y"). Keep index entries to one line under ~200 chars; move detail into topic files.'
    const a = new SessionBuilder({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', cwd: '/Users/test/Code/site' })
    loads(a, '/Users/test/Code/site/CLAUDE.md', warning).userPrompt('go')
    const b = new SessionBuilder({ sessionId: 'bbbbbbbb-0000-4000-8000-000000000002', cwd: '/Users/test/Code/site' })
    loads(b, '/Users/test/Code/site/CLAUDE.md').userPrompt('go')
    const analyses = [await analyze(a), await analyze(b)]
    expect(loadedMemoryIndexPaths(analyses)).toEqual([`${MEM_DIR}/MEMORY.md`])
    const norm = (p: string) => p.replace('/Users/test', '~')
    const e = buildEnforcement(analyses, { norm, memoryIndexes: [{ file: norm(`${MEM_DIR}/MEMORY.md`), bytes: 26_000, chars: 25_600, approxTokens: 6_500, lines: 120, linesPastLimit: 6, firstLinePastLimit: 115 }] })
    expect(e.memory).toEqual([{ file: norm(`${MEM_DIR}/MEMORY.md`), lines: 120, bytes: 26_000, chars: 25_600, linesPastLimit: 6, firstLinePastLimit: 115, sessionsLoaded: 2, sessionsCut: 1, maxLinesCut: 5, lastCutAt: expect.any(Number) }])
    expect(e.counts.memoryIndexesCut).toBe(1)
  })
})

describe('memoryIndexCut', () => {
  it('keeps the whole lines that fit in 200 lines and 25,000 characters', () => {
    expect(memoryIndexCut('a\nb\n')).toMatchObject({ lines: 2, linesPastLimit: 0 })
    expect(memoryIndexCut(Array.from({ length: 230 }, (_, i) => `- line ${i}`).join('\n'))).toMatchObject({ lines: 230, linesPastLimit: 30, firstLinePastLimit: 201 })
    // 120 lines of 220 characters: 113 lines fit (113 x 221 = 24,973), the 114th goes over
    expect(memoryIndexCut(Array.from({ length: 120 }, () => 'x'.repeat(220)).join('\n'))).toMatchObject({ lines: 120, linesPastLimit: 7, firstLinePastLimit: 114 })
    expect(memoryIndexCut('')).toEqual({ lines: 0, chars: 0, linesPastLimit: 0 })
    // the limit counts characters: 120 lines of 220 two-byte letters hold 26,400 chars and 52,800 bytes
    expect(memoryIndexCut(Array.from({ length: 120 }, () => 'é'.repeat(220)).join('\n'))).toMatchObject({ linesPastLimit: 7, firstLinePastLimit: 114 })
    // 24,752 chars that are 25,024 bytes: Claude Code loads all of it
    const text = Array.from({ length: 112 }, (_, i) => (i < 136 ? 'é' : '') + 'x'.repeat(219)).join('\n')
    expect(memoryIndexCut(text).linesPastLimit).toBe(0)
  })
})
