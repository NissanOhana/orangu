// The engine state of orangu god: the named values that the pane draws from. The engine keeps them for the
// session and through a reload of the code. The pane reads them while it draws, and each write draws the readers
// again. The choices that live past the session are in the engine store (src/god/control.ts, STORE_KEYS).
// - board: the last board snapshot that the loop wrote, null before the first one;
// - selected: the key of the selected row (a session id or a group key), '' for none;
// - openGroups: the keys of the groups that the person opened (the stale group starts closed);
// - theme: the color set of the session theme (src/god/ui/theme.ts).
import { atom } from 'claude-code'

import type { BoardSnapshot } from './types.js'
import type { ThemeSet } from './ui/theme.js'

declare module 'claude-code' {
  interface PluginState {
    'orangu-god': {
      board: BoardSnapshot | null
      selected: string
      openGroups: readonly string[]
      theme: ThemeSet
    }
  }
}

export const BOARD = atom({ plugin: 'orangu-god', key: 'board' } as const, null)
export const SELECTED = atom({ plugin: 'orangu-god', key: 'selected' } as const, '')
export const OPEN_GROUPS = atom({ plugin: 'orangu-god', key: 'openGroups' } as const, [])
export const THEME = atom({ plugin: 'orangu-god', key: 'theme' } as const, 'dark')
