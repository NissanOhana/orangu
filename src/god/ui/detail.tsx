// The drawing of the detail of the god pane (src/god/view/detail-pane.ts) as engine elements, with no rule of its own.
// - The title and facts lines, the context bar and the flag lines are Texts.
// - Each tab of the tab row is 1 plain Button keyed tab:<tab>, after the space that the view gives: a press on it
//   opens that tab.
// - Each option line of the open question is 1 plain Button keyed option:<n>, with no hotkey: the digits come with
//   the answer path, and until then a press on an option does nothing.
// - Each count line of the window over the tab content is the hotkey Button of its key (w above, z below): a press
//   goes to the scroll that the view gave for the key.
// - With no selected session, or a detail that the rows cannot hold, the lines of the view are Texts.
import type { RenderElement } from 'claude-code'

import type { DetailTab } from '../types.js'
import { tabGap, type TabCell } from '../view/detail.js'
import type { PaneDetail } from '../view/detail-pane.js'
import type { Line } from '../view/types.js'
import { drawLine, segmentText, type KeyActions, type PaneElements } from './line.js'
import type { ThemeSet } from './theme.js'

/** What the presses of the detail do. */
export type DetailActions = {
  /** a press on a tab of the tab row */
  onTab: (tab: DetailTab) => void
  /** w or z: the scroll that the view gave for the key */
  onScroll: (scroll: number) => void
  /** a press on the option line with this digit */
  onOption: (digit: number) => void
}

/** The rows of the detail, top to bottom: 1 element for each line of the view. */
export function detailRows(ui: PaneElements, detail: PaneDetail, theme: ThemeSet, actions: DetailActions): RenderElement[] {
  const { Box, Text, Button } = ui
  const text = (line: Line): RenderElement => drawLine(ui, line, theme, () => undefined, {})
  if (detail.kind === 'none') return detail.lines.map(text)
  const view = detail.view
  if (view.kind === 'too-short') return view.lines.map(text)

  const scrollKeys: KeyActions = Object.fromEntries(
    Object.entries(detail.scrollTo).flatMap(([hotkey, scroll]) => (scroll === undefined ? [] : [[hotkey, () => actions.onScroll(scroll)]])),
  )
  const digits = new Map(view.options.map((option) => [option.key, option.digit]))
  const onOption = (key: string): void => {
    const digit = digits.get(key)
    if (digit !== undefined) actions.onOption(digit)
  }
  const tabRow = (row: readonly TabCell[]): RenderElement => (
    <Box flexDirection="row">
      {row.flatMap((cell, index) => [
        <Text>{tabGap(index)}</Text>,
        <Button key={cell.key} plain onPress={() => actions.onTab(cell.tab)}>
          {cell.segments.map((segment) => segmentText(ui, segment, theme))}
        </Button>,
      ])}
    </Box>
  )
  return [...view.head.map(text), ...view.tabRows.map(tabRow), ...view.body.map((line) => drawLine(ui, line, theme, onOption, scrollKeys)), ...view.foot.map(text)]
}
