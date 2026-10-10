/**
 * The jump of the god pane: j shows the cmux tab of the selected session with exactly 2 cmux calls in order
 * (select the workspace, then focus the panel in it), or it is off with its reason and runs nothing. The argv holds
 * only the 2 refs of the mapped tab, and only in the forms that the key guard takes.
 */
import { describe, expect, it } from 'vitest'
import { detailSnapshot } from '../../../test/fixtures/god/detail.js'
import { degradedSnapshot } from '../../../test/fixtures/god/snapshots.js'
import type { Host, RunResult } from '../host.js'
import type { BoardSnapshot, TabRef } from '../types.js'
import { STALE_GROUP_KEY } from '../view/board.js'
import { jumpNoteOf, jumpPlan, jumpedSessionOf, runJump, tabRefs } from './jump.js'

const UUID_WS = '0f8e2c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const UUID_SF = '9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d'

const tab = (workspaceRef: string, surfaceRef: string): TabRef => ({ pid: 4200, tty: 'ttys009', workspaceRef, surfaceRef, workspaceTitle: 'Eval set' })

/** the detail snapshot with the tab of the waiting session set to `next` (or removed) */
function withTab(next: TabRef | undefined): BoardSnapshot {
  const snapshot = detailSnapshot()
  return {
    ...snapshot,
    sessions: snapshot.sessions.map((session) => {
      if (session.sessionId !== 's-wait') return session
      const { tab: _tab, ...rest } = session
      return next === undefined ? rest : { ...rest, tab: next }
    }),
  }
}

/** A host that records each argv and answers each one with the next exit code (0 when none is left), or a reject. */
function hostOf(answers: Array<number | 'reject'> = []) {
  const runs: Array<{ argv: readonly string[]; hasOptions: boolean }> = []
  const host: Host = {
    run: async (argv, options) => {
      runs.push({ argv: [...argv], hasOptions: options !== undefined })
      const answer = answers.shift() ?? 0
      if (answer === 'reject') throw new Error('timed out')
      const result: RunResult = { exitCode: answer, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      return result
    },
    list: async () => [],
    read: async () => '',
    stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0, isLink: false }),
    now: async () => 0,
  }
  return { host, runs }
}

describe('tabRefs', () => {
  it('takes workspace:N with surface:N, and UUIDs', () => {
    expect(tabRefs(tab('workspace:7', 'surface:12'))).toEqual({ workspaceRef: 'workspace:7', surfaceRef: 'surface:12' })
    expect(tabRefs(tab(UUID_WS, UUID_SF))).toEqual({ workspaceRef: UUID_WS, surfaceRef: UUID_SF })
  })

  it('refuses a bare index, a flag, a ref with more text, a ref of the wrong kind, and no tab', () => {
    for (const [workspaceRef, surfaceRef] of [
      ['3', 'surface:12'],
      ['workspace:7', '12'],
      ['--window', 'surface:12'],
      ['workspace:7', '--surface'],
      ['workspace:7 --window window:1', 'surface:12'],
      ['workspace:7', 'surface:12\nsurface:13'],
      ['surface:7', 'workspace:12'],
      ['workspace:-1', 'surface:12'],
      ['workspace:', 'surface:12'],
      ['', ''],
    ]) {
      expect(tabRefs(tab(workspaceRef!, surfaceRef!)), `${workspaceRef} ${surfaceRef}`).toBeUndefined()
    }
    expect(tabRefs(undefined)).toBeUndefined()
  })
})

describe('jumpPlan', () => {
  it('jumps to the mapped tab of the selected session: select-workspace, then focus-panel in that workspace', () => {
    expect(jumpPlan(detailSnapshot(), 's-wait')).toEqual({
      kind: 'jump',
      sessionId: 's-wait',
      steps: [
        ['cmux', 'select-workspace', '--workspace', 'workspace:7'],
        ['cmux', 'focus-panel', '--panel', 'surface:12', '--workspace', 'workspace:7'],
      ],
    })
  })

  it('puts no session text in an argv: only the 2 refs follow the flags', () => {
    const plan = jumpPlan(detailSnapshot(), 's-wait')
    if (plan.kind !== 'jump') throw new Error(plan.kind)
    const values = plan.steps.flatMap((argv) => argv.filter((word) => !word.startsWith('--') && word !== 'cmux' && word !== 'select-workspace' && word !== 'focus-panel'))
    expect(new Set(values)).toEqual(new Set(['workspace:7', 'surface:12']))
  })

  it('is off with no-cmux when cmux is not on the machine, before it reads the tab', () => {
    const snapshot = degradedSnapshot({ cmux: { status: 'missing', reason: 'The cmux command did not start.' } })
    expect(jumpPlan({ ...snapshot, sessions: detailSnapshot().sessions }, 's-wait')).toEqual({ kind: 'off', reason: 'no-cmux', sessionId: 's-wait' })
  })

  it('is off with no-tab when the session has no mapped tab, or its refs are not in a form that the key guard takes', () => {
    expect(jumpPlan(withTab(undefined), 's-wait')).toEqual({ kind: 'off', reason: 'no-tab', sessionId: 's-wait' })
    expect(jumpPlan(withTab(tab('3', 'surface:12')), 's-wait')).toEqual({ kind: 'off', reason: 'no-tab', sessionId: 's-wait' })
    expect(jumpPlan(withTab(tab('workspace:7', '--window')), 's-wait')).toEqual({ kind: 'off', reason: 'no-tab', sessionId: 's-wait' })
  })

  it('is off with no-tab while the last cmux read failed or no read ended yet: the tab map can be old', () => {
    for (const cmux of [{ status: 'off', reason: 'The cmux tree command exited 1.' }, { status: 'unread' }] as const) {
      const snapshot = degradedSnapshot({ cmux })
      expect(jumpPlan({ ...snapshot, sessions: detailSnapshot().sessions }, 's-wait'), cmux.status).toEqual({ kind: 'off', reason: 'no-tab', sessionId: 's-wait' })
    }
  })

  it('is off with no-session when no session is selected, a heading is selected, the session left, or no board exists', () => {
    expect(jumpPlan(detailSnapshot(), undefined)).toEqual({ kind: 'off', reason: 'no-session' })
    expect(jumpPlan(detailSnapshot(), STALE_GROUP_KEY)).toEqual({ kind: 'off', reason: 'no-session' })
    expect(jumpPlan(detailSnapshot(), 's-gone')).toEqual({ kind: 'off', reason: 'no-session' })
    expect(jumpPlan(undefined, 's-wait')).toEqual({ kind: 'off', reason: 'no-session' })
  })
})

describe('runJump', () => {
  it('runs exactly the 2 steps in order, each with no option, and says that it jumped', async () => {
    const { host, runs } = hostOf()
    expect(await runJump(host, jumpPlan(detailSnapshot(), 's-wait'))).toEqual({ result: 'jumped', sessionId: 's-wait' })
    expect(runs.map((run) => run.argv)).toEqual([
      ['cmux', 'select-workspace', '--workspace', 'workspace:7'],
      ['cmux', 'focus-panel', '--panel', 'surface:12', '--workspace', 'workspace:7'],
    ])
    expect(runs.every((run) => !run.hasOptions)).toBe(true)
  })

  it('stops at the first step that fails: a nonzero exit or a reject runs no step after it', async () => {
    const exit = hostOf([1])
    expect(await runJump(exit.host, jumpPlan(detailSnapshot(), 's-wait'))).toEqual({ result: 'failed', sessionId: 's-wait' })
    expect(exit.runs).toHaveLength(1)
    const reject = hostOf(['reject'])
    expect(await runJump(reject.host, jumpPlan(detailSnapshot(), 's-wait'))).toEqual({ result: 'failed', sessionId: 's-wait' })
    expect(reject.runs).toHaveLength(1)
    const second = hostOf([0, 2])
    expect(await runJump(second.host, jumpPlan(detailSnapshot(), 's-wait'))).toEqual({ result: 'failed', sessionId: 's-wait' })
    expect(second.runs).toHaveLength(2)
  })

  it('runs nothing for a plan that is off, and gives its reason', async () => {
    const { host, runs } = hostOf()
    expect(await runJump(host, { kind: 'off', reason: 'no-cmux', sessionId: 's-wait' })).toEqual({ result: 'no-cmux', sessionId: 's-wait' })
    expect(await runJump(host, { kind: 'off', reason: 'no-session' })).toEqual({ result: 'no-session' })
    expect(runs).toEqual([])
  })
})

describe('jumpNoteOf', () => {
  it('keeps a note for a session that has no tab or whose jump failed, and none for a jump, no cmux or no session', () => {
    expect(jumpNoteOf({ result: 'no-tab', sessionId: 's-wait' })).toEqual({ sessionId: 's-wait', reason: 'no-tab' })
    expect(jumpNoteOf({ result: 'failed', sessionId: 's-wait' })).toEqual({ sessionId: 's-wait', reason: 'failed' })
    expect(jumpNoteOf({ result: 'jumped', sessionId: 's-wait' })).toBeNull()
    expect(jumpNoteOf({ result: 'no-cmux', sessionId: 's-wait' })).toBeNull()
    expect(jumpNoteOf({ result: 'no-session' })).toBeNull()
  })
})

describe('jumpedSessionOf', () => {
  it('names the session that the jump showed, and none when it did not jump', () => {
    expect(jumpedSessionOf({ result: 'jumped', sessionId: 's-wait' })).toBe('s-wait')
    for (const result of ['failed', 'no-tab', 'no-cmux'] as const) expect(jumpedSessionOf({ result, sessionId: 's-wait' })).toBeUndefined()
    expect(jumpedSessionOf({ result: 'no-session' })).toBeUndefined()
  })
})

