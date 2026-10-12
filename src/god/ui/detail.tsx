// The drawing of the detail of the god pane (src/god/view/detail-pane.ts) as engine elements, with no rule of its own.
// - The title and facts lines, the context bar and the flag lines are Texts.
// - Each tab of the tab row is 1 plain Button keyed tab:<tab>, after the space that the view gives: a press on it
//   opens that tab.
// - Each option line of the open question is 1 plain Button keyed option:<n> whose hotkey is its digit, and the Yes and
//   No of a Bash request are 2 such Buttons keyed permission:yes and permission:no. A press on one, or its digit,
//   opens the confirm bar for it: nothing goes out until y. With no cmux they have no hotkey, and a press does nothing.
// - Each count line of the window over the tab content is the hotkey Button of its key (w above, z below): a press
//   goes to the scroll that the view gave for the key.
// - The x key of the Recap tab is the hotkey Button that makes the Recap of the session of this detail. The view draws
//   it only while no Recap runs.
// - With no selected session, or a detail that the rows cannot hold, the lines of the view are Texts.
// - The help (h) is Texts too, but for the count lines of its window: each is the hotkey Button of its key.
import type { RenderElement } from 'claude-code'

import type { DetailTab } from '../types.js'
import { tabGap, type TabCell } from '../view/detail.js'
import type { PaneDetail } from '../view/detail-pane.js'
import { RECAP_KEY } from '../view/detail-tabs.js'
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
  /** a press on the Yes or the No of a Bash request */
  onPermission: (choice: 'yes' | 'no') => void
  /** x on the Recap tab: the Recap of the session of the detail */
  onRecap: (sessionId: string) => void
}

/** The action of each scroll key that the view gave: w or z goes to the scroll of its key. */
const scrollKeys = (scrollTo: Readonly<Partial<Record<string, number>>>, actions: DetailActions): KeyActions =>
  Object.fromEntries(Object.entries(scrollTo).flatMap(([hotkey, scroll]) => (scroll === undefined ? [] : [[hotkey, () => actions.onScroll(scroll)]])))

/** The rows of the detail, top to bottom: 1 element for each line of the view. */
export function detailRows(ui: PaneElements, detail: PaneDetail, theme: ThemeSet, actions: DetailActions): RenderElement[] {
  const { Box, Text, Button } = ui
  const text = (line: Line): RenderElement => drawLine(ui, line, theme, () => undefined, {})
  if (detail.kind === 'none') return detail.lines.map(text)
  if (detail.kind === 'help') return detail.lines.map((line) => drawLine(ui, line, theme, () => undefined, scrollKeys(detail.scrollTo, actions)))
  const view = detail.view
  if (view.kind === 'too-short') return view.lines.map(text)

  const sessionId = detail.sessionId
  const bodyKeys: KeyActions = { ...scrollKeys(detail.scrollTo, actions), [RECAP_KEY]: () => actions.onRecap(sessionId) }
  const picks = new Map(view.options.map((option) => [option.key, option]))
  const onOption = (key: string): void => {
    const pick = picks.get(key)
    if (pick === undefined) return
    if (pick.choice === undefined) actions.onOption(pick.digit)
    else actions.onPermission(pick.choice)
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
  return [...view.head.map(text), ...view.tabRows.map(tabRow), ...view.body.map((line) => drawLine(ui, line, theme, onOption, bodyKeys)), ...view.foot.map(text)]
}
