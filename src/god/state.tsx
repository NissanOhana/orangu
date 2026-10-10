// The engine state of orangu god: the named values that the pane draws from. The engine keeps them for the
// session and through a reload of the code. The pane reads them while it draws, and each write draws the readers
// again. The choices that live past the session are in the engine store (src/god/control.ts, STORE_KEYS).
// - board: the last board snapshot that the loop wrote, null before the first one;
// - selected: the key of the selected row (a session id or a group key), '' for none;
// - openGroups: the keys of the groups that the person opened (the stale group starts closed);
// - theme: the color set of the session theme (src/god/ui/theme.ts);
// - detail: the open tab of the detail, the first line of its content, and whether the narrow pane shows the detail
//   in place of the board (src/god/view/detail-pane.ts);
// - screen: the screen state of the Screen tab, null before its first read (src/god/screen-loop.ts);
// - jump: the note of the last j that did not jump, null for none (src/god/act/jump.ts);
// - deliver: the key path: the intent of the confirm bar, its scroll, the draft of r or m, the last outcome, the
//   check of the refreshes after a send, and the mark while the keys go out (src/god/view/bar.ts);
// - alerts: the times of the last alert and the last done tone of each session in the last 5 min, so a reload of the
//   code keeps the limit of 1 alert in 5 min (src/god/act/alert-policy.ts). No pane draws it;
// - recap: the last Recap, of any session, null before the first x (src/god/act/recap.ts).
import { atom } from 'claude-code'

import { NO_ALERTS, type AlertState } from './act/alert-policy.js'
import type { JumpNote } from './act/jump.js'
import type { ScreenState } from './source/screen.js'
import type { BoardSnapshot, RecapState } from './types.js'
import type { ThemeSet } from './ui/theme.js'
import { NO_DELIVERY, type DeliverState } from './view/bar.js'
import { DEFAULT_DETAIL, type DetailState } from './view/detail-pane.js'

declare module 'claude-code' {
  interface PluginState {
    'orangu-god': {
      board: BoardSnapshot | null
      selected: string
      openGroups: readonly string[]
      theme: ThemeSet
      detail: DetailState
      screen: ScreenState | null
      jump: JumpNote | null
      deliver: DeliverState
      alerts: AlertState
      recap: RecapState | null
    }
  }
}

export const BOARD = atom({ plugin: 'orangu-god', key: 'board' } as const, null)
export const SELECTED = atom({ plugin: 'orangu-god', key: 'selected' } as const, '')
export const OPEN_GROUPS = atom({ plugin: 'orangu-god', key: 'openGroups' } as const, [])
export const THEME = atom({ plugin: 'orangu-god', key: 'theme' } as const, 'dark')
export const DETAIL = atom({ plugin: 'orangu-god', key: 'detail' } as const, DEFAULT_DETAIL)
export const SCREEN = atom({ plugin: 'orangu-god', key: 'screen' } as const, null)
export const JUMP = atom({ plugin: 'orangu-god', key: 'jump' } as const, null)
export const DELIVER = atom({ plugin: 'orangu-god', key: 'deliver' } as const, NO_DELIVERY)
export const ALERTS = atom({ plugin: 'orangu-god', key: 'alerts' } as const, NO_ALERTS)
export const RECAP = atom({ plugin: 'orangu-god', key: 'recap' } as const, null)
