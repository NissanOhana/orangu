/**
 * The 1-line summary of 1 session, from rules only: the question or the permission request while the session
 * waits, the current activity while it works, else the first sentence of the last reply.
 */
import { describe, expect, it } from 'vitest'
import { MINUTE, NOW, busy, idle, transcript, waiting } from '../../../test/fixtures/god/sessions.js'
import type { AgentTask, OpenQuestion, ToolActivity } from '../types.js'
import { NO_REPLY, NO_TRANSCRIPT, WAITS, firstSentence, oneLine, summaryOf } from './summary.js'

const question = (text: string): OpenQuestion => ({
  toolUseId: 'toolu_q1',
  askedAt: NOW - 5 * MINUTE,
  questions: [{ text, header: 'Budget', multiSelect: false, options: [{ label: 'Small' }, { label: 'Large' }] }],
})

const tool = (text: string, isOpen: boolean, toolUseId = 'toolu_t1'): ToolActivity => ({ toolUseId, tool: text.split(' ')[0] ?? text, text, isOpen, at: NOW - MINUTE })

const subagent = (toolUseId: string, isRunning: boolean): AgentTask => ({ toolUseId, kind: 'subagent', text: `Agent Check ${toolUseId}`, isRunning })

describe('summary: the session waits', () => {
  it('is the question text of the open question, on 1 line', () => {
    const session = waiting('w1', { transcript: transcript({ openQuestion: question('Which budget\ndo you approve?'), activity: tool('AskUserQuestion', true) }) })
    expect(summaryOf(session, 'needs-you')).toBe('Which budget do you approve?')
  })

  it('is the first question when the dialog has more than 1', () => {
    const open = question('Which budget do you approve?')
    const two: OpenQuestion = { ...open, questions: [...open.questions, { text: 'Which model?', header: 'Model', multiSelect: false, options: [] }] }
    expect(summaryOf(waiting('w2', { transcript: transcript({ openQuestion: two }) }), 'needs-you')).toBe('Which budget do you approve?')
  })

  it('is the permission tool and its command for a permission prompt', () => {
    const session = waiting('w3', { waitingFor: 'permission prompt', transcript: transcript({ activity: tool('Bash npm test', true) }) })
    expect(summaryOf(session, 'needs-you')).toBe('Bash npm test')
  })

  it('is the reason of the wait when the transcript part holds no open call', () => {
    const session = waiting('w4', { waitingFor: 'sandbox request', transcript: transcript({ activity: tool('Read a.ts', false) }) })
    expect(summaryOf(session, 'needs-you')).toBe('sandbox request')
  })

  it('is the wait line when nothing names the reason', () => {
    const { waitingFor: _dropped, ...session } = waiting('w5')
    expect(summaryOf(session, 'needs-you')).toBe(WAITS)
  })
})

describe('summary: the session works', () => {
  it('is the current activity', () => {
    expect(summaryOf(busy('b1', { transcript: transcript({ activity: tool('Edit parse.ts', true) }) }), 'working')).toBe('Edit parse.ts')
  })

  it('is the last tool when no call is open', () => {
    expect(summaryOf(busy('b2', { transcript: transcript({ activity: tool('Read a.ts', false) }) }), 'working')).toBe('Read a.ts')
  })

  it('counts the running subagents when the open call starts 1 of them', () => {
    const agents = [subagent('toolu_a1', true), subagent('toolu_a2', true), subagent('toolu_a3', true), subagent('toolu_a0', false)]
    const three = busy('b3', { transcript: transcript({ agents, activity: tool('Agent Check toolu_a3', true, 'toolu_a3') }) })
    expect(summaryOf(three, 'working')).toBe('3 subagents')
    const one = busy('b4', { transcript: transcript({ agents: [subagent('toolu_a1', true)], activity: tool('Agent Check toolu_a1', true, 'toolu_a1') }) })
    expect(summaryOf(one, 'working')).toBe('1 subagent')
  })

  it('is the activity when a subagent runs in the background and the session does other work', () => {
    const session = busy('b5', { transcript: transcript({ agents: [subagent('toolu_a1', true)], activity: tool('Edit parse.ts', true) }) })
    expect(summaryOf(session, 'working')).toBe('Edit parse.ts')
  })

  it('is the error when a stuck session ends with an API error, else the last tool', () => {
    const failed = busy('b6', { transcript: transcript({ activity: tool('Edit parse.ts', true), errorTail: { kind: 'api-retry', text: 'The API is overloaded.\nRetry 3 of 10.' } }) })
    expect(summaryOf(failed, 'stuck')).toBe('The API is overloaded. Retry 3 of 10.')
    expect(summaryOf(busy('b7', { transcript: transcript({ activity: tool('Bash npm test', true) }) }), 'stuck')).toBe('Bash npm test')
  })

  it('falls back to the last reply when the transcript part holds no tool call', () => {
    expect(summaryOf(busy('b8', { transcript: transcript({ lastReply: 'I read the plan. Then I start.' }) }), 'working')).toBe('I read the plan.')
  })
})

describe('summary: the turn ended', () => {
  it('is the first sentence of the last reply on the your-turn and idle levels', () => {
    for (const level of ['your-turn', 'idle'] as const) expect(summaryOf(idle('i1'), level), level).toBe('Setup is done.')
  })

  it('is empty on the stale level, with or without a transcript', () => {
    const { transcript: _none, ...bare } = idle('i5')
    expect(summaryOf(idle('i1'), 'stale')).toBe('')
    expect(summaryOf(bare, 'stale')).toBe('')
  })

  it('is the title when the transcript part holds no reply, else the no-reply line', () => {
    expect(summaryOf(idle('i2', { transcript: transcript({ title: 'Fix the parser. Then ship.' }) }), 'idle')).toBe('Fix the parser.')
    expect(summaryOf(idle('i3', { transcript: transcript() }), 'idle')).toBe(NO_REPLY)
  })
})

describe('summary: no transcript', () => {
  it('is the no-transcript line on every level', () => {
    for (const [level, session] of [
      ['needs-you', waiting('w6')],
      ['working', busy('b9')],
      ['idle', idle('i4')],
    ] as const) {
      const { transcript: _none, ...bare } = session
      expect(summaryOf(bare, level), level).toBe(NO_TRANSCRIPT)
    }
  })
})

describe('firstSentence: the first sentence of a reply, whole', () => {
  it('ends at the first full stop, question mark or exclamation mark before a space or the end', () => {
    expect(firstSentence('Setup is done. The tests pass.')).toBe('Setup is done.')
    expect(firstSentence('Is it done? Yes.')).toBe('Is it done?')
    expect(firstSentence('It works! Ship it.')).toBe('It works!')
    expect(firstSentence('Version 1.2 of parse.ts is out. Next.')).toBe('Version 1.2 of parse.ts is out.')
  })

  it('keeps the whole first paragraph when it has no sentence end, and cuts nothing', () => {
    const long = 'All twelve checks pass on the new parser and the old one with the same output for each fixture'
    expect(firstSentence(`${long}\n\nNext part.`)).toBe(long)
  })

  it('joins the lines of the first paragraph', () => {
    expect(firstSentence('I fixed the bug in\nthe parser. Then I ran the tests.')).toBe('I fixed the bug in the parser.')
  })

  it('skips headings, rules and code blocks, and removes list, quote and bold marks', () => {
    expect(firstSentence('## Result\n\n---\n\n```ts\nconst a = 1. b\n```\n\n- **All tests pass.** Next.')).toBe('All tests pass.')
    expect(firstSentence('> 1. The build works. Then.')).toBe('The build works.')
  })

  it('falls back to the first heading, with no marks, when the text has only headings', () => {
    expect(firstSentence('## Result\n### Next')).toBe('Result')
  })

  it('gives an empty text for an empty reply', () => {
    expect(firstSentence('  \n \n')).toBe('')
  })
})

describe('oneLine', () => {
  it('puts a text on 1 line with single spaces', () => {
    expect(oneLine('  a\tb\n\nc  ')).toBe('a b c')
  })
})
