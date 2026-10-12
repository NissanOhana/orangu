/**
 * The key row of the god pane: the keys of the board, each as its key and what it does, in lines of the pane
 * width (no key is cut). Each key with a hotkey is 1 segment that the engine shell draws as a plain hotkey Button,
 * and the engine paints that Button as `j: jump`, so the segment holds that form. The arrows walk the row Buttons
 * by themselves, and the digits belong to the option Buttons of the detail, so neither has a hotkey here.
 * - f shows the mode that it switches to: `f: repos` in the all mode, `f: all` in the repos mode. g groups the rows.
 *   s turns the tones off and on, and u mutes the selected session and unmutes it: the header and the facts line of
 *   the detail show their state, so their labels stay.
 * - The digits name the option Buttons that the detail draws (`1-3`, or `2-3` when its window cuts option 1), else
 *   `1-9`, dim where no digit Button shows (a draft of r or m, the narrow board, another tab, a detail too short).
 * - The header says who holds the keys and the key that hands them over (src/god/view/header.ts), so the row does not.
 * - With no cmux on the machine, j, the digits and r show dim, and 1 more line says why. r writes a prompt and m a
 *   peer note, so the 2 labels do not look like 1 action.
 * - A notice of the last key (why the last j did not jump) shows under the row in the warn color, wrapped, never cut.
 * - While the narrow pane shows the detail in place of the board, the row starts with b, which goes back to the
 *   board, in place of the arrows: the arrows select a session only on the board.
 */
import type { JumpNote } from '../act/jump.js'
import type { BoardMode } from '../types.js'
import { DIM } from '../ui/theme.js'
import { flowItems, wrapWords } from './cells.js'
import type { KeyHint, Line, Segment } from './types.js'

/** The line under the key row when cmux is not on the machine. */
export const KEY_ROW_NO_CMUX = 'The keys j, r and the digits are off: cmux is not on this machine.'

/** The line of the key row for each jump note: why the last j of the selected session did not jump. */
export const JUMP_NOTE: Readonly<Record<JumpNote['reason'], string>> = {
  'no-tab': 'This session has no cmux tab, so j cannot jump to it.',
  failed: 'The jump failed: cmux did not show the tab of this session. Press j to try again.',
}

/** What the key row reads. */
export type KeyRowInput = {
  width: number
  /** true when cmux is not on the machine: j, the digits and r need it */
  isCmuxMissing: boolean
  /** the digits of the option Buttons that the detail draws, in order: the open question or the Bash request of the selected session */
  answerDigits?: readonly number[]
  /** true where no digit Button shows: the digits do nothing there */
  isAnswerOff?: boolean
  /** the mode of the board: f switches to the other one */
  mode: BoardMode
  /** true while the narrow pane shows the detail in place of the board */
  isDetail?: boolean
  /** a line about the last key, under the row */
  notice?: string
}

/** What f does in each mode: it shows the other mode. */
export const MODE_KEY_LABEL: Readonly<Record<BoardMode, string>> = { all: 'repos', repos: 'all' }

/** What g does: it groups the rows by attention level or by repo. */
export const GROUP_KEY_LABEL = 'group'

/** The key row: the hints, and the lines that show them. */
export type KeyRow = { hints: KeyHint[]; lines: Line[] }

const answerKeys = (digits: readonly number[] | undefined): string => {
  const first = digits?.[0]
  const last = digits?.at(-1)
  if (first === undefined || last === undefined) return '1-9'
  return first === last ? String(first) : `${first}-${last}`
}

/** A key that 1 Button presses, in the form that the engine paints it: the key, a colon, a space, the label. */
export const pressSegment = (hotkey: string, label: string): Segment => ({ text: `${hotkey}: ${label}`, press: { hotkey, label } })

function hintItem(hint: KeyHint): Segment[] {
  if (hint.hotkey !== undefined) {
    const pressed = pressSegment(hint.hotkey, hint.label)
    return [hint.isOff ? { ...pressed, ...DIM } : pressed]
  }
  return hint.isOff ? [{ text: hint.keys, ...DIM }, { text: ` ${hint.label}`, ...DIM }] : [{ text: hint.keys, bold: true }, { text: ` ${hint.label}` }]
}

/** The key row of the board. */
export function keyRow(input: KeyRowInput): KeyRow {
  const off = input.isCmuxMissing
  const hints: KeyHint[] = [
    input.isDetail === true ? { keys: 'b', label: 'back', hotkey: 'b', isOff: false } : { keys: '↑↓', label: 'select', isOff: false },
    { keys: 'j', label: 'jump', hotkey: 'j', isOff: off },
    { keys: 'n', label: 'next', hotkey: 'n', isOff: false },
    { keys: answerKeys(input.answerDigits), label: 'answer', isOff: off || input.isAnswerOff === true },
    { keys: 'r', label: 'prompt', hotkey: 'r', isOff: off },
    { keys: 'm', label: 'peer note', hotkey: 'm', isOff: false },
    { keys: 't', label: 'tab', hotkey: 't', isOff: false },
    { keys: 's', label: 'sound', hotkey: 's', isOff: false },
    { keys: 'u', label: 'mute', hotkey: 'u', isOff: false },
    { keys: 'f', label: MODE_KEY_LABEL[input.mode], hotkey: 'f', isOff: false },
    { keys: 'g', label: GROUP_KEY_LABEL, hotkey: 'g', isOff: false },
  ]
  const items = hints.map(hintItem)
  const lines = flowItems(items, input.width)
  if (off) lines.push(...wrapWords(KEY_ROW_NO_CMUX, input.width - 1).map((text): Line => ({ segments: [{ text: ` ${text}` }] })))
  if (input.notice !== undefined) lines.push(...wrapWords(input.notice, input.width - 1).map((text): Line => ({ segments: [{ text: ' ' }, { text, token: '--warn' }] })))
  return { hints, lines }
}
