/**
 * The key row of the god pane: the keys of the board, each as its key and what it does, in lines of the pane
 * width (no key is cut). Each key with a hotkey is 1 segment that the engine shell draws as a plain hotkey Button,
 * and the engine paints that Button as `j: jump`, so the segment holds that form. The arrows walk the row Buttons
 * by themselves, and the digits belong to the option Buttons of the detail, so neither has a hotkey here.
 * - f shows the mode that it switches to: `f: repos` in the all mode, `f: all` in the repos mode. g groups the rows.
 * - The digits name the options of the open question of the selected session (`1-3`), else `1-9`.
 * - While the prompt holds the keys, the row ends with the key that gives them to the pane.
 * - With no cmux on the machine, jump, the digits and reply show dim, and 1 more line says why.
 * - While the narrow pane shows the detail in place of the board, the row starts with b, which goes back to the
 *   board, in place of the arrows: the arrows select a session only on the board.
 */
import type { BoardMode } from '../types.js'
import { DIM } from '../ui/theme.js'
import { flowItems, wrapWords } from './cells.js'
import type { KeyHint, Line, Segment } from './types.js'

/** The last item of the key row while the prompt holds the keys. */
export const KEY_ROW_PROMPT = 'ctrl+x tab: keys to the pane'

/** The line under the key row when cmux is not on the machine. */
export const KEY_ROW_NO_CMUX = 'Jump, answer and reply are off: cmux is not on this machine.'

/** What the key row reads. */
export type KeyRowInput = {
  width: number
  /** true when cmux is not on the machine: jump, answer and reply need it */
  isCmuxMissing: boolean
  /** true while the prompt holds the keys, not the pane */
  promptHoldsKeys: boolean
  /** the option count of the open question of the selected session, when it has 1 question with 1 choice */
  answerCount?: number
  /** the mode of the board: f switches to the other one */
  mode: BoardMode
  /** true while the narrow pane shows the detail in place of the board */
  isDetail?: boolean
}

/** What f does in each mode: it shows the other mode. */
export const MODE_KEY_LABEL: Readonly<Record<BoardMode, string>> = { all: 'repos', repos: 'all' }

/** What g does: it groups the rows by attention level or by repo. */
export const GROUP_KEY_LABEL = 'group'

/** The key row: the hints, and the lines that show them. */
export type KeyRow = { hints: KeyHint[]; lines: Line[] }

const answerKeys = (count: number | undefined): string => {
  if (count === undefined || count < 1) return '1-9'
  const last = Math.min(9, count)
  return last === 1 ? '1' : `1-${last}`
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
    { keys: answerKeys(input.answerCount), label: 'answer', isOff: off },
    { keys: 'r', label: 'reply', hotkey: 'r', isOff: off },
    { keys: 'm', label: 'message', hotkey: 'm', isOff: false },
    { keys: 't', label: 'tab', hotkey: 't', isOff: false },
    { keys: 's', label: 'sound', hotkey: 's', isOff: false },
    { keys: 'f', label: MODE_KEY_LABEL[input.mode], hotkey: 'f', isOff: false },
    { keys: 'g', label: GROUP_KEY_LABEL, hotkey: 'g', isOff: false },
  ]
  const items = hints.map(hintItem)
  if (input.promptHoldsKeys) items.push([{ text: KEY_ROW_PROMPT, ...DIM }])
  const lines = flowItems(items, input.width)
  if (off) lines.push(...wrapWords(KEY_ROW_NO_CMUX, input.width - 1).map((text): Line => ({ segments: [{ text: ` ${text}` }] })))
  return { hints, lines }
}
