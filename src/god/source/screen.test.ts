/**
 * The screen read of the Screen tab: 1 `cmux read-screen` of the mapped tab of 1 session, its text sanitized and
 * redacted before it enters a ScreenRead. A failed read gives nothing, and a tab whose refs are not in a form that
 * the key guard takes runs no command. The escape byte is built from its code point, so this file spells no escape.
 */
import { describe, expect, it } from 'vitest'
import type { Host, RunResult } from '../host.js'
import { textCleaner } from '../sanitize.js'
import { SCREEN_LINES, readScreenOf, screenArgv, type ScreenTarget } from './screen.js'

const ESC = String.fromCharCode(0x1b)
const KEY = 'sk-ant-api03-FAKEFAKEFAKEFAKE'
const TARGET: ScreenTarget = { sessionId: 's-wait', workspaceRef: 'workspace:7', surfaceRef: 'surface:12' }
const clean = textCleaner('/Users/test')

/** A host that records each argv and answers with `answer`. */
function hostOf(answer: Partial<RunResult> | 'reject') {
  const runs: Array<readonly string[]> = []
  const host: Host = {
    run: async (argv) => {
      runs.push([...argv])
      if (answer === 'reject') throw new Error('timed out')
      return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...answer }
    },
    list: async () => [],
    read: async () => '',
    stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0, isLink: false }),
    now: async () => 0,
  }
  return { host, runs }
}

describe('screenArgv', () => {
  it('reads the last SCREEN_LINES rows of the workspace and the surface of the tab', () => {
    expect(SCREEN_LINES).toBe(40)
    expect(screenArgv(TARGET)).toEqual(['cmux', 'read-screen', '--workspace', 'workspace:7', '--surface', 'surface:12', '--lines', '40'])
  })
})

describe('readScreenOf', () => {
  it('gives the screen of the session, with no control character, its secrets masked and the home folder as ~', async () => {
    const { host, runs } = hostOf({ stdout: `${ESC}[31mred${ESC}[0m text\n> export KEY=${KEY}\n/Users/test/Code/demo\n` })
    const read = await readScreenOf(host, TARGET, clean, () => 1234)
    expect(runs).toEqual([screenArgv(TARGET)])
    expect(read).toEqual({ sessionId: 's-wait', workspaceRef: 'workspace:7', surfaceRef: 'surface:12', readAt: 1234, text: expect.any(String) })
    expect(read!.text).not.toContain(ESC)
    expect(read!.text).not.toContain(KEY)
    expect(read!.text).toContain('[31mred[0m text')
    expect(read!.text).toContain('~/Code/demo')
  })

  it('gives nothing for a read that exits nonzero or rejects', async () => {
    expect(await readScreenOf(hostOf({ exitCode: 1, stdout: 'old' }).host, TARGET, clean, () => 1)).toBeUndefined()
    expect(await readScreenOf(hostOf('reject').host, TARGET, clean, () => 1)).toBeUndefined()
  })

  it('runs no command for a tab whose refs the key guard does not take', async () => {
    for (const target of [{ ...TARGET, workspaceRef: '3' }, { ...TARGET, surfaceRef: '--window' }]) {
      const { host, runs } = hostOf({ stdout: 'screen' })
      expect(await readScreenOf(host, target, clean, () => 1)).toBeUndefined()
      expect(runs).toEqual([])
    }
  })
})
