// The drawing of the bar of the key path (src/god/view/bar.ts) as engine elements, with no rule of its own.
// - Each line is 1 row (src/god/ui/line.tsx). The keys of the bar are plain hotkey Buttons: y sends and c closes the
//   bar that this drawing shows while the bar is open, and w and z go to the scroll that the view gave for each count
//   line of the bar.
// - The draft of r or m draws 1 text field after its lines, with the focus ring on it when the pane takes the keys.
//   Its Enter gives the line that it holds. A surface with no text field draws the lines only, so c still closes it.
import type { RenderElement } from 'claude-code'

import type { DeliverIntent } from '../types.js'
import type { BarView } from '../view/bar.js'
import { drawLine, type KeyActions, type PaneElements } from './line.js'
import type { ThemeSet } from './theme.js'

/** What the presses of the bar do. */
export type BarActions = {
  /** y: the intent that the bar shows goes out */
  onSend: (shown: DeliverIntent | undefined) => void
  /** c: the bar that this drawing shows closes (its intent, or undefined for a draft) */
  onCancel: (shown: DeliverIntent | undefined) => void
  /** w or z: the scroll that the view gave for the key */
  onScroll: (scroll: number) => void
  /** Enter in the text field of the draft, with the line that it holds */
  onDraft: (value: string) => void
}

/** The rows of the bar, top to bottom: its lines, then the text field of a draft. */
export function barRows(ui: PaneElements, bar: BarView | undefined, theme: ThemeSet, actions: BarActions): RenderElement[] {
  if (bar === undefined) return []
  const scrollKeys = Object.entries(bar.scrollTo).flatMap(([hotkey, scroll]) => (scroll === undefined ? [] : [[hotkey, () => actions.onScroll(scroll)] as const]))
  const keys: KeyActions = { ...(bar.isOpen ? { y: () => actions.onSend(bar.intent), c: () => actions.onCancel(bar.intent) } : {}), ...Object.fromEntries(scrollKeys) }
  const rows = bar.lines.map((line) => drawLine(ui, line, theme, () => undefined, keys))
  const { Input } = ui
  const field = bar.field
  if (field === undefined || Input === undefined) return rows
  return [...rows, <Input key={field.key} label={field.label} placeholder={field.placeholder} submitLabel={field.submitLabel} autoFocus onSubmit={(value) => actions.onDraft(value)} />]
}
