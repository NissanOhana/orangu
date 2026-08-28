import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseClaudeCodeSession } from '../../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../../analyze/analyze.js'
import type { TurnAnalysis } from '../../../model/analysis.js'
import type { AppData } from '../../../model/app-data.js'
import { buildCanonicalSession } from '../../../../test/fixtures/session-builder.js'
import type { Ctx } from '../app.js'
import { tok } from '../format.js'
import { promptText, renderTimeline } from './timeline.js'

let markup = ''

beforeEach(() => {
  const root = { querySelectorAll: () => [], querySelector: () => null } as unknown as HTMLElement
  vi.stubGlobal('document', {
    getElementById: () => ({ getAttribute: () => 'data:image/png;base64,aGVsbG8=' }),
    createElement: () => ({
      content: { firstElementChild: root },
      set innerHTML(value: string) { markup = value },
    }),
  })
})

afterEach(() => {
  markup = ''
  vi.unstubAllGlobals()
})

async function context(includeText: boolean): Promise<Ctx> {
  const session = await parseClaudeCodeSession({ records: buildCanonicalSession().toRecords(), noSidecar: true })
  const analysis = analyzeSession(session, { version: 'test', now: 0 })
  const data: AppData = {
    v: '1', mode: 'file', version: 'test', generatedAt: 0,
    capabilities: { live: false, aggregates: false, kickoffRun: false, exportHtml: true, includeText },
    selectedId: analysis.session.id, session: analysis, sessions: [], aggregates: {}, suggestions: [],
  }
  return { data, a: analysis, ds: {} as Ctx['ds'], state: { screen: 'timeline', s: analysis.session.id }, audience: 'dev', go: vi.fn() }
}

const turn = (over: Partial<TurnAnalysis>): TurnAnalysis => ({ index: 4, kind: 'human', isCommand: false, promptPreview: '', promptChars: 0, autoContinuations: 0, interrupted: false, toolCalls: 0, toolErrors: 0, toolMs: 0, agents: [], models: [], tokens: {} as TurnAnalysis['tokens'], totalTokens: 0, insightIds: [], activity: '', ...over })

describe('promptText (H1: the row under the default redaction)', () => {
  it('prefers the prompt, then the command name, then the row\'s own facts, and only then the notice', () => {
    expect(promptText(turn({ promptPreview: 'fix the build', promptChars: 13, activity: 'Bash×2' }), false)).toEqual({ text: 'fix the build', own: false })
    expect(promptText(turn({ kind: 'command', isCommand: true, commandName: '/login', activity: 'Bash' }), false)).toEqual({ text: '/login', own: false })
    expect(promptText(turn({ promptChars: 1234, activity: 'Read×3 Bash×2 Edit' }), false)).toEqual({ text: '1.2k-char prompt · Read×3 Bash×2 Edit', own: true })
    expect(promptText(turn({ promptChars: 60 }), false)).toEqual({ text: '60-char prompt', own: true })
    expect(promptText(turn({ activity: 'Bash' }), false)).toEqual({ text: 'Bash', own: true })
    expect(promptText(turn({}), false)).toEqual({ text: '(prompt text not included)', own: true })
    expect(promptText(turn({}), true)).toEqual({ text: '(no prompt)', own: true })
  })
})

describe('renderTimeline under the default redaction', () => {
  it('renders each turn\'s own facts instead of one notice per row, and the command name when the redactor kept it', async () => {
    const ctx = await context(false)
    const human = ctx.a!.turns.find((t) => t.kind === 'human' && t.toolCalls > 0)!
    expect(human).toBeDefined()
    for (const t of ctx.a!.turns) {
      t.promptPreview = ''
      t.commandName = t.isCommand ? '/login' : t.commandName
    }
    renderTimeline(ctx)
    expect(markup).not.toContain('(prompt text not included)')
    expect(markup).toContain(`${tok(human.promptChars)}-char prompt · ${human.activity}`)
    if (ctx.a!.turns.some((t) => t.isCommand)) expect(markup).toContain('<span class="kind kcmd">cmd</span>/login')
    // a command turn whose name was stripped as well (before the redaction change lands) still falls back gracefully
    for (const t of ctx.a!.turns) t.commandName = ''
    renderTimeline(ctx)
    expect(markup).not.toContain('(prompt text not included)')
    expect(markup).toContain('-char prompt')
  })

  it('keeps the prompt in cleartext when the report includes text', async () => {
    const ctx = await context(true)
    const human = ctx.a!.turns.find((t) => t.kind === 'human' && t.promptPreview)!
    renderTimeline(ctx)
    expect(markup).toContain(human.promptPreview.slice(0, 20))
    expect(markup).not.toContain('-char prompt')
  })
})
