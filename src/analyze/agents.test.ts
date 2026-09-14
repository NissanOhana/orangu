import { describe, it, expect } from 'vitest'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { SessionBuilder, resetIds } from '../../test/fixtures/session-builder.js'
import { analyzeHooks } from './agents.js'

describe('analyzeHooks', () => {
  it('says what each byCommand key is: a command line, or only the name or event the transcript recorded', async () => {
    resetIds()
    const b = new SessionBuilder({ sessionId: 'dddddddd-0000-4000-8000-0000000000d1' })
    b.userPrompt('hi')
    b.stopHookSummary([{ command: '/opt/tools/notify.sh --loud', durationMs: 300 }])
    b.attachmentHook('SessionStart:startup', 'SessionStart', 'ok', { command: '/opt/tools/start.sh', durationMs: 75 })
    b.attachmentHook('PostToolUse:Edit', 'PostToolUse')
    const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
    const h = analyzeHooks(s)
    expect(h.runs).toBe(3)
    const by = new Map(h.byCommand.map((r) => [r.command, r]))
    expect(by.get('/opt/tools/notify.sh --loud')?.keyedBy).toBe('command')
    expect(by.get('/opt/tools/start.sh')).toMatchObject({ keyedBy: 'command', totalMs: 75, hookEvent: 'SessionStart' })
    expect(by.get('PostToolUse:Edit')).toMatchObject({ keyedBy: 'hookName', hookEvent: 'PostToolUse' })
  })

  it('counts runs per event for a command that fires on several, and names the busiest one', async () => {
    resetIds()
    const b = new SessionBuilder({ sessionId: 'dddddddd-0000-4000-8000-0000000000d2' })
    b.userPrompt('hi')
    // the PostToolUse run comes FIRST so first-seen and busiest disagree
    b.attachmentHook('PostToolUse:Bash', 'PostToolUse', 'ok', { command: '/opt/tools/notify.sh --loud', durationMs: 5 })
    b.stopHookSummary([{ command: '/opt/tools/notify.sh --loud', durationMs: 300 }])
    b.stopHookSummary([{ command: '/opt/tools/notify.sh --loud', durationMs: 300 }])
    const h = analyzeHooks(await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true }))
    expect(h.byCommand).toHaveLength(1)
    expect(h.byCommand[0]).toMatchObject({ command: '/opt/tools/notify.sh --loud', count: 3, events: { Stop: 2, PostToolUse: 1 }, hookEvent: 'Stop' })
  })
})
