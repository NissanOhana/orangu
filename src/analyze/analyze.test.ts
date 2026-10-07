import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from './analyze.js'
import { aggregate } from './aggregate.js'
import type { Rule } from './insights.js'
import { buildCanonicalSession, fakeToolUseId, SessionBuilder } from '../../test/fixtures/session-builder.js'

async function canonicalAnalysis() {
  const b = buildCanonicalSession()
  const s = await parseClaudeCodeSession({ records: b.toRecords(), path: '/tmp/x/' + b.sessionId + '.jsonl', noSidecar: true })
  return analyzeSession(s, { version: 'test', now: 0 })
}

describe('analyzeSession', () => {
  it('produces a schema-versioned analysis with summary KPIs that reconcile', async () => {
    const a = await canonicalAnalysis()
    expect(a.schemaVersion).toBe('2')
    expect(a.summary.turns).toBe(2)
    expect(a.summary.humanTurns).toBe(2)
    expect(a.summary.toolCalls).toBe(6)
    expect(a.summary.toolErrors).toBe(1)
    expect(a.summary.agents).toBe(1)
    expect(a.parse.reconciliation.ok).toBe(true)
    expect(a.summary.totalTokens).toBeGreaterThan(0)
    expect(a.summary.totalTokens).toBe(a.tokens.totalTokens)
    expect(a.summary.narrative).toContain('2 requests')
    // STE: no semicolon. The busy time is its own sentence, and each top finding title is its own sentence in a
    // second paragraph, after one blank line.
    expect(a.summary.narrative).not.toContain(';')
    expect(a.summary.narrative).toContain('. The agent was busy for ')
    const titles = a.insights.slice(0, 2).map((i) => i.title)
    expect(titles).toHaveLength(2)
    const [facts, first, ...more] = a.summary.narrative.split('\n\n')
    expect(more).toEqual([])
    expect(facts).toMatch(/^In “Fix foo test”, [^\n]+ Orangu found these outcomes: [^\n]+\.$/)
    expect(first).toBe(`Look at these first. ${titles.map((title) => `${title}.`).join(' ')}`)
    expect(a.summary.narrative).not.toContain(' · ')
  })
  it('puts the top finding titles in a paragraph of their own, each title its own sentence with a period only where it has no end mark', async () => {
    // 0.9.0 joined the top titles into one list sentence ("Look at these first: <title> · <title>."), and two
    // long titles made a sentence of 31 words. Each title is now a sentence of its own, and no title word changes.
    // The titles are a second paragraph, so that each paragraph has 6 sentences or fewer (STE rule 3).
    const b = buildCanonicalSession()
    const s = await parseClaudeCodeSession({ records: b.toRecords(), path: '/tmp/x/' + b.sessionId + '.jsonl', noSidecar: true })
    const finding = (title: string): Rule => () => [
      { id: '', ruleId: 'test', severity: 'high', axis: 'time', title, detail: '', recommendation: '', improvement: '', evidence: {}, turnIndexes: [], personas: [] },
    ]
    const cases: Array<[string[], string]> = [
      [['Ends with no mark', 'Ends with a question?'], 'Look at these first. Ends with no mark. Ends with a question?'],
      [['Ends with a period.', 'Ends with a bang!'], 'Look at these first. Ends with a period. Ends with a bang!'],
      [['The only finding (1 of 1)'], 'Look at these first. The only finding (1 of 1).'],
    ]
    for (const [titles, paragraph] of cases) {
      const a = analyzeSession(s, { version: 'test', now: 0, rules: titles.map(finding) })
      expect(a.summary.narrative.split('\n\n'), titles.join(' | ')).toEqual([expect.stringMatching(/ Orangu found these outcomes: [^\n]+\.$/), paragraph])
    }
    // with no finding the narrative is one paragraph and ends at the outcomes, as before
    const none = analyzeSession(s, { version: 'test', now: 0, rules: [] }).summary.narrative
    expect(none).toMatch(/ Orangu found these outcomes: [^.]+\.$/)
    expect(none).not.toContain('\n')
  })
  it('keeps the session title on one line, so the only blank line in the narrative is the paragraph break', async () => {
    // A custom or AI title is not a prompt preview, and it can hold line breaks. The report splits the
    // narrative into paragraphs at a blank line, so a blank line in the title would cut the first paragraph.
    const b = buildCanonicalSession()
    const s = await parseClaudeCodeSession({ records: b.toRecords(), path: '/tmp/x/' + b.sessionId + '.jsonl', noSidecar: true })
    s.meta.title = 'Fix the\n\nflaky   test\n'
    const a = analyzeSession(s, { version: 'test', now: 0 })
    expect(a.summary.narrative).toMatch(/^In “Fix the flaky test”, you made 2 requests /)
    expect(a.summary.narrative.split('\n\n')).toHaveLength(2)
    expect(a.summary.narrative.split('\n')).toHaveLength(3)
  })
  it('writes the narrative in STE: the reader is "you", the actor is named, every part is a full sentence', async () => {
    // The narrative is the first prose on every session report ("What happened") and on the public sample.
    // The checker cannot see a passive, a telegram or "the human", so these frames are pinned here.
    const a = await canonicalAnalysis()
    expect(a.summary.narrative).toMatch(/^In “Fix foo test”, you made 2 requests over [^.]+\. The agent was busy for [^.]+ of that\. /)
    expect(a.summary.narrative).toContain(' Orangu found these outcomes: 1 file changed, 2 test runs (1 failed).\n\nLook at these first. ')
    // every narrative the golden corpus emits, in each of its forms (a title or none, commands and automation
    // counted or not, outcomes or none, findings or none)
    const golden = join(process.cwd(), 'test/golden')
    const files = readdirSync(golden).filter((file) => file.endsWith('.analysis.json'))
    expect(files.length).toBeGreaterThanOrEqual(7)
    for (const file of files) {
      const n = (JSON.parse(readFileSync(join(golden, file), 'utf8')) as { summary: { narrative: string } }).summary.narrative
      expect(n, file).toMatch(/^In (“[\s\S]*?”|this session), you made \d+ requests?( \(\d+ turns including commands and automation\))? over /)
      expect(n, file).toMatch(/ Orangu found (these outcomes: [^.]+|no commits, PRs or test runs)\.(\n\nLook at these first\.( \S.*[.!?])+)?$/)
      // each top title is its own sentence in a second paragraph: no list separator, no colon after "Look at
      // these first", and no line break other than the one blank line between the 2 paragraphs
      expect(n, file).not.toContain(' · ')
      expect(n, file).not.toContain('Look at these first:')
      expect(n.replace('\n\n', ' '), file).not.toContain('\n')
      for (const old of ['incl.', 'the human', 'were detected', 'Visible outcomes', 'Biggest things']) expect(n, `${file}: ${old}`).not.toContain(old)
      expect(n, `${file}: one tool call is singular`).not.toMatch(/\b1 tool calls\b/)
    }
    // live-partial makes exactly 1 tool call
    expect((JSON.parse(readFileSync(join(golden, 'live-partial.analysis.json'), 'utf8')) as { summary: { narrative: string } }).summary.narrative).toContain('It made 1 tool call, and processed ')
  })
  it('computes tool stats, quality signals and outcomes deterministically', async () => {
    const a = await canonicalAnalysis()
    const bash = a.tools.byName.find((t) => t.name === 'Bash')!
    expect(bash.count).toBe(3)
    expect(bash.errors).toBe(1)
    expect(a.quality.testRuns.length).toBe(2)
    expect(a.quality.testRuns[0]!.ok).toBe(false)
    expect(a.quality.testRuns[1]!.ok).toBe(true)
    expect(a.summary.outcomes.filesEdited).toBe(1)
    expect(a.quality.signals.find((s) => s.id === 'tests')!.tone).toBe('good')
  })
  it('attributes tokens per model, per kind and per turn', async () => {
    const a = await canonicalAnalysis()
    expect(a.tokens.byModel.map((m) => m.model).sort()).toEqual(['claude-opus-5', 'claude-sonnet-5'])
    expect(a.tokens.byModel.reduce((s, m) => s + m.totalTokens, 0)).toBe(a.tokens.totalTokens)
    expect(a.tokens.byTurn.length).toBe(2)
    // the cumulative curve ends at the session total (turn tokens include the agents they spawned)
    expect(a.tokens.byTurn[1]!.cumulativeTokens).toBe(a.tokens.totalTokens)
    expect(a.tokens.mainThread + a.tokens.agents).toBe(a.tokens.totalTokens)
    const k = a.tokens.byKind
    expect(k.input + k.output + k.cacheRead + k.cacheWrite5m + k.cacheWrite1h).toBe(a.tokens.totalTokens)
    expect(a.tokens.byModel.every((m) => !m.estimatedMatch)).toBe(true)
  })
  it('builds the context series and cache metrics', async () => {
    const a = await canonicalAnalysis()
    expect(a.context.series.filter((p) => !p.agentId).length).toBe(8)
    expect(a.context.baseline).toBe(12_004)
    expect(a.context.peak).toBeGreaterThan(a.context.baseline)
    expect(a.context.cacheHitRatio).toBeGreaterThan(0.5)
  })
  it('fires the re-read rule with a savings estimate and anchors it to turns', async () => {
    const b = new SessionBuilder()
    b.userPrompt('look at foo repeatedly')
    for (let i = 0; i < 4; i++) b.toolCall('Read', { file_path: '/Users/test/Code/demo/src/foo.ts' }, 'x'.repeat(8000), { usage: { cache_read_input_tokens: 5000 + i * 2000, output_tokens: 20 } })
    b.assistant([{ type: 'text', text: 'done' }])
    const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
    const a = analyzeSession(s)
    const ins = a.insights.find((i) => i.ruleId === 'reread-files')!
    expect(ins).toBeDefined()
    expect(ins.savings?.tokens).toBeGreaterThan(0)
    expect(ins.turnIndexes).toContain(0)
    expect(a.turns[0]!.insightIds).toContain(ins.id)
    expect(a.files.mostReRead[0]!.path).toBe('src/foo.ts')
  })
})

describe('privacy and structural rollups', () => {
  it('never promotes a transcript-authored agent display name into the structural by-type rollup', async () => {
    const marker = 'private-agent-display-name-9073'
    const b = new SessionBuilder()
    b.userPrompt('delegate')
    const id = fakeToolUseId()
    b.assistant([{ type: 'tool_use', id, name: 'Agent', input: { name: marker, description: marker, prompt: marker } }])
    b.toolResult(id, 'done', { toolUseResult: { status: 'completed', agentId: 'agent-1' } })
    const a = analyzeSession(await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true }))
    expect(a.agents.runs[0]!.name).toBe(marker)
    expect(a.agents.byType).toEqual([{ agentType: 'unknown', count: 1, tokens: 0, avgDurationMs: 0 }])
    expect(aggregate([a], 'global', 0).byAgentType).toEqual([{ key: 'unknown', count: 1, tokens: 0, extra: { runs: 1 } }])
    expect(JSON.stringify(aggregate([a], 'global', 0))).not.toContain(marker)
  })

  it('command classifier excludes cat/grep/sed of config files, counts real runs', async () => {
    const b = new SessionBuilder()
    b.userPrompt('work')
    for (const cmd of ['cat vitest.config.ts', 'grep -n jest src', 'sed -i pytest.ini x', 'npm test', 'npx vitest run', 'npm run build', 'tsc --noEmit', 'cat Makefile']) b.toolCall('Bash', { command: cmd }, 'ok')
    b.assistant([{ type: 'text', text: 'd' }])
    const a = analyzeSession(await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true }))
    expect(a.quality.testRuns.map((t) => t.command)).toEqual(['npm test', 'npx vitest run'])
    expect(a.quality.buildRuns.map((t) => t.command)).toEqual(['npm run build', 'tsc --noEmit'])
  })
  it('re-reads across different subagents are not counted as redundant', async () => {
    const b = new SessionBuilder()
    b.userPrompt('spawn agents that each read the same file once')
    // main reads foo twice (redundant), then two agents each read foo once (not redundant)
    b.toolCall('Read', { file_path: '/p/foo.ts' }, 'x'.repeat(2000))
    b.toolCall('Read', { file_path: '/p/foo.ts' }, 'x'.repeat(2000))
    b.sidechain('agentA')
    b.toolCall('Read', { file_path: '/p/foo.ts' }, 'x'.repeat(2000))
    b.sidechain('agentA', false)
    b.sidechain('agentB')
    b.toolCall('Read', { file_path: '/p/foo.ts' }, 'x'.repeat(2000))
    b.sidechain('agentB', false)
    b.assistant([{ type: 'text', text: 'd' }])
    const a = analyzeSession(await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true }))
    const foo = a.files.files.find((f) => f.path.endsWith('foo.ts'))!
    expect(foo.reads).toBe(4)
    expect(foo.redundantReads).toBe(1) // only the one extra main-thread read
  })
  it('no savings estimate exceeds the tokens the session actually moved', async () => {
    const a = analyzeSession(await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true }))
    for (const ins of a.insights) if (ins.savings?.tokens) expect(ins.savings.tokens).toBeLessThanOrEqual(a.summary.totalTokens)
  })
  it('cache-write with an all-zero TTL split is still counted (attributed to 1h)', async () => {
    const b = new SessionBuilder()
    b.userPrompt('x')
    b.assistant([{ type: 'text', text: 'y' }], { usage: { input_tokens: 2, output_tokens: 10, cache_creation_input_tokens: 40000 } })
    // force the nested split to all-zero by pushing a raw record
    const recs = b.toRecords()
    const last = recs[recs.length - 1] as { message: { usage: Record<string, unknown> } }
    last.message.usage['cache_creation'] = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }
    const a = analyzeSession(await parseClaudeCodeSession({ records: recs, noSidecar: true }))
    expect(a.tokens.byKind.cacheWrite1h).toBeGreaterThan(0)
  })
})

describe('summary.ending precedence: interrupted > failing > clean > unknown', () => {
  async function endingOf(b: SessionBuilder) {
    const a = analyzeSession(await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true }), { version: 't', now: 0 })
    return a.summary.ending
  }
  it('clean: last test run passed and the last turn was not interrupted', async () => {
    expect(await endingOf(buildCanonicalSession())).toBe('clean')
  })
  it('failing: the last test/build run did not pass', async () => {
    const b = new SessionBuilder()
    b.userPrompt('fix')
    b.toolCall('Bash', { command: 'npm test' }, 'PASS')
    b.toolCall('Bash', { command: 'npm run build' }, 'error TS2322', { isError: true })
    b.assistant([{ type: 'text', text: 'hmm' }])
    expect(await endingOf(b)).toBe('failing')
  })
  it('interrupted: the last turn was interrupted, even after a passing run', async () => {
    const b = buildCanonicalSession()
    b.userPrompt('one more thing')
    b.toolCall('Bash', { command: 'npm test' }, 'PASS')
    b.userPrompt('[Request interrupted by user]')
    expect(await endingOf(b)).toBe('interrupted')
  })
  it('unknown: no test or build run at all', async () => {
    const b = new SessionBuilder()
    b.userPrompt('hello')
    b.assistant([{ type: 'text', text: 'hi' }])
    expect(await endingOf(b)).toBe('unknown')
  })
})

describe('ParseInput file facts on the records path (tail reader seam)', () => {
  it('honours trailingPartial / bytes / badLines / totalLines and keeps the defaults otherwise', async () => {
    const records = buildCanonicalSession().toRecords()
    const a = analyzeSession(await parseClaudeCodeSession({ records, noSidecar: true, trailingPartial: true, bytes: 4321, badLines: 2, totalLines: records.length + 2 }), { version: 't', now: 0 })
    expect(a.session.live).toBe(true)
    expect(a.parse.bytes).toBe(4321)
    expect(a.parse.badLines).toBe(2)
    expect(a.parse.totalLines).toBe(records.length + 2)
    const d = analyzeSession(await parseClaudeCodeSession({ records, noSidecar: true }), { version: 't', now: 0 })
    expect(d.session.live).toBeFalsy()
    expect(d.parse.bytes).toBe(0)
    expect(d.parse.badLines).toBe(0)
    expect(d.parse.totalLines).toBe(records.length)
  })
})
