/**
 * The key row of the god pane: the keys of the board, each as its key and what it does, in lines of the pane
 * width (no key is cut). Each hint carries the hotkey of its Button, so the engine shell draws a hotkey Button for
 * each letter. The arrows walk the row Buttons by themselves, and the digits belong to the option Buttons of the
 * detail, so neither has a hotkey here.
 * - The digits name the options of the open question of the selected session (`1-3`), else `1-9`.
 * - While the prompt holds the keys, the row ends with the key that gives them to the pane.
 * - With no cmux on the machine, jump, the digits and reply show dim, and 1 more line says why.
 */
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
}

/** The key row: the hints, and the lines that show them. */
export type KeyRow = { hints: KeyHint[]; lines: Line[] }

const answerKeys = (count: number | undefined): string => {
  if (count === undefined || count < 1) return '1-9'
  const last = Math.min(9, count)
  return last === 1 ? '1' : `1-${last}`
}

function hintItem(hint: KeyHint): Segment[] {
  return hint.isOff ? [{ text: hint.keys, ...DIM }, { text: ` ${hint.label}`, ...DIM }] : [{ text: hint.keys, bold: true }, { text: ` ${hint.label}` }]
}

/** The key row of the board. */
export function keyRow(input: KeyRowInput): KeyRow {
  const off = input.isCmuxMissing
  const hints: KeyHint[] = [
    { keys: '↑↓', label: 'select', isOff: false },
    { keys: 'j', label: 'jump', hotkey: 'j', isOff: off },
    { keys: 'n', label: 'next', hotkey: 'n', isOff: false },
    { keys: answerKeys(input.answerCount), label: 'answer', isOff: off },
    { keys: 'r', label: 'reply', hotkey: 'r', isOff: off },
    { keys: 'm', label: 'message', hotkey: 'm', isOff: false },
    { keys: 't', label: 'tab', hotkey: 't', isOff: false },
    { keys: 's', label: 'sound', hotkey: 's', isOff: false },
  ]
  const items = hints.map(hintItem)
  if (input.promptHoldsKeys) items.push([{ text: KEY_ROW_PROMPT, ...DIM }])
  const lines = flowItems(items, input.width)
  if (off) lines.push(...wrapWords(KEY_ROW_NO_CMUX, input.width - 1).map((text): Line => ({ segments: [{ text: ` ${text}` }] })))
  return { hints, lines }
}
