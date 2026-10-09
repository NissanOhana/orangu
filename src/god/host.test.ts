/**
 * The contract of orangu god: the commands that the host port may run, the time limit on each command, the
 * level order, and a compile-time check that each value the pane keeps in the engine state or the engine store
 * is plain JSON data (no Map, no Set, no function, no class instance).
 */
import { describe, expect, it } from 'vitest'
import { ALLOWED_COMMANDS, HOST_TIMEOUT_MS, isAllowedCommand } from './host.js'
import {
  LEVEL_ORDER,
  type AlertCounts,
  type BoardSnapshot,
  type DeliverIntent,
  type DeliverOutcome,
  type Facts,
  type RecapState,
  type ScreenRead,
  type Settings,
  type StoreState,
} from './types.js'

describe('isAllowedCommand: the host port runs only the read and cmux commands', () => {
  it('allows the 7 commands by their bare name', () => {
    expect(ALLOWED_COMMANDS).toEqual(['claude', 'cmux', 'ps', 'git', 'tail', 'head', 'stat'])
    for (const name of ALLOWED_COMMANDS) expect(isAllowedCommand([name, '--version']), name).toBe(true)
  })

  it('refuses an empty argv, a shell, a path, another case, a padded name and any other program', () => {
    const refused: string[][] = [
      [],
      [''],
      ['sh', '-c', 'cmux send x'],
      ['bash', '-lc', 'ps'],
      ['/usr/bin/git', 'status'],
      ['./cmux', 'tree'],
      ['Git', 'status'],
      ['git ', 'status'],
      [' git', 'status'],
      ['git\u0000', 'status'],
      ['node', '-e', '1'],
      ['osascript', '-e', 'x'],
      ['open', '.'],
      ['constructor'],
      ['toString'],
      ['__proto__'],
    ]
    for (const argv of refused) expect(isAllowedCommand(argv), JSON.stringify(argv)).toBe(false)
  })

  it('stops each host command after 5 s', () => {
    expect(HOST_TIMEOUT_MS).toBe(5000)
  })
})

describe('the contract constants', () => {
  it('orders the 6 attention levels from the one that needs the person most', () => {
    expect(LEVEL_ORDER).toEqual(['needs-you', 'your-turn', 'stuck', 'working', 'idle', 'stale'])
  })
})

/** JSON data, as the engine state and the engine store take it. An optional field is left out, never undefined. */
type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json | undefined }
/** A compile-time check: `npm run typecheck` fails when T is not plain JSON data. */
const plainData = <T extends Json>(name: string): string => name

describe('the values that the pane keeps are plain JSON data', () => {
  it('holds each kept value to JSON at compile time', () => {
    expect([
      plainData<BoardSnapshot>('BoardSnapshot'),
      plainData<Facts>('Facts'),
      plainData<StoreState>('StoreState'),
      plainData<Settings>('Settings'),
      plainData<DeliverIntent>('DeliverIntent'),
      plainData<DeliverOutcome>('DeliverOutcome'),
      plainData<ScreenRead>('ScreenRead'),
      plainData<RecapState>('RecapState'),
      plainData<AlertCounts>('AlertCounts'),
    ]).toHaveLength(9)
  })
})
