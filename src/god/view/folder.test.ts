/**
 * The folder line of the detail: it names the other sessions in the folder of the session that work now, only when
 * 2 or more sessions of that folder work now, each by the name of its row, with a count past 5 names.
 */
import { describe, expect, it } from 'vitest'
import { MINUTE, busy, idle, repo, transcript, waiting } from '../../../test/fixtures/god/sessions.js'
import { NOW, snapshotOf } from '../../../test/fixtures/god/snapshots.js'
import type { GodSession, SessionFacts } from '../types.js'
import { cellWidth } from './cells.js'
import { folderLines } from './folder.js'
import type { Line } from './types.js'

const text = (line: Line): string => line.segments.map((segment) => segment.text).join('')
const api = repo('api')
const board = (sessions: readonly SessionFacts[]): readonly GodSession[] => snapshotOf(sessions).sessions
const of = (sessions: readonly GodSession[], id: string): GodSession => sessions.find((session) => session.sessionId === id)!
const lineOf = (sessions: readonly GodSession[], id: string, width = 79): string[] => folderLines(of(sessions, id), sessions, width).map(text)

describe('the folder line', () => {
  it('names the other working sessions of the folder, by the name of the row, when 2 or more of them work now', () => {
    const sessions = board([
      waiting('s-ask', { name: 'api-1', repo: api }),
      busy('s-one', { name: 'api-2', repo: api, statusSince: NOW - 9 * MINUTE }),
      busy('s-two', { name: 'api-3', repo: api, transcript: transcript({ title: 'Fix the parser' }), statusSince: NOW - 5 * MINUTE }),
      busy('s-far', { name: 'web-1', cwd: '/work/web' }),
    ])
    expect(lineOf(sessions, 's-ask')).toEqual([' Shares its folder with 2 working sessions: api-2, Fix the parser'])
    expect(lineOf(sessions, 's-one')).toEqual([' Shares its folder with 1 working session: Fix the parser'])
    expect(lineOf(sessions, 's-far')).toEqual([])
  })

  it('shows no line when fewer than 2 sessions of the folder work now', () => {
    const sessions = board([waiting('s-ask', { name: 'api-1', repo: api }), busy('s-one', { name: 'api-2', repo: api }), idle('s-rest', { name: 'api-3', repo: api })])
    for (const id of ['s-ask', 's-one', 's-rest']) expect(lineOf(sessions, id), id).toEqual([])
  })

  it('takes the folder as the top level of the worktree, else the cwd: a linked worktree is another folder', () => {
    const sessions = board([
      busy('s-main', { name: 'api-1', repo: api, cwd: '/work/api/src' }),
      busy('s-root', { name: 'api-2', cwd: '/work/api' }),
      busy('s-tree', { name: 'api-3', repo: repo('api', '/work/api-fix') }),
      busy('s-tree-2', { name: 'api-4', repo: repo('api', '/work/api-fix') }),
    ])
    expect(lineOf(sessions, 's-main')).toEqual([' Shares its folder with 1 working session: api-2'])
    expect(lineOf(sessions, 's-tree')).toEqual([' Shares its folder with 1 working session: api-4'])
  })

  it('names 5 sessions at most and counts the rest, and wraps at whole words within the width', () => {
    const sessions = board(Array.from({ length: 9 }, (_, index) => busy(`s-${index}`, { name: `api-${index}`, repo: api, statusSince: NOW - (index + 1) * MINUTE })))
    const lines = lineOf(sessions, 's-0', 40)
    expect(lines.join(' ').replace(/\s+/g, ' ').trim()).toBe('Shares its folder with 8 working sessions: api-8, api-7, api-6, api-5, api-4 and 3 more')
    for (const line of lines) expect(cellWidth(line), line).toBeLessThanOrEqual(40)
  })
})
