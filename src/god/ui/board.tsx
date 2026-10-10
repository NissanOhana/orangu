// The drawing of the god pane: 1 PaneView (src/god/view/pane.ts) as engine elements, with no rule of its own.
// - Each line is 1 row (src/god/ui/line.tsx). A line with a key is 1 plain Button with that key (a session row, a
//   heading that opens and closes, or a count line of the board), so the arrows walk the rows and `ui.focus` names
//   the selected row. A press on a count line selects the row that the view names for it.
// - A segment with a press is 1 plain hotkey Button when the pane has an action for its key, else a Text of the
//   same painted text: the engine paints the Button as `j: jump`, and the view counts that width.
// - In the wide layout, the body is 3 columns side by side: the board, the column rule and the detail column
//   (src/god/ui/detail.tsx). In the narrow layout, the detail that the person opened takes the place of the board.
import type { RenderElement } from 'claude-code'

import { paneDetailLines } from '../view/detail-pane.js'
import { wideColumns } from '../view/frame.js'
import type { Line, PaneView } from '../view/types.js'
import { detailRows, type DetailActions } from './detail.js'
import { drawLine, type KeyActions, type PaneElements } from './line.js'
import type { ThemeSet } from './theme.js'

export type { PaneElements } from './line.js'

/** What the presses of the pane do. */
export type PaneActions = {
  /** a press on a row: a click on it, or Enter while the ring is on it */
  onRow: (key: string) => void
  /** a press on a count line of the board: select the row that the view names for it */
  onMore: (key: string) => void
  /** the action of each hotkey that the pane has; a key with none draws as text */
  keys: KeyActions
  /** the presses of the detail */
  detail: DetailActions
}

/** The pane of 1 view. */
export function drawPane(ui: PaneElements, view: PaneView, theme: ThemeSet, actions: PaneActions): RenderElement {
  const { Box } = ui
  const more = view.kind === 'board' ? view.more : {}
  const onKeyed = (key: string): void => {
    const target = more[key]
    if (target === undefined) actions.onRow(key)
    else actions.onMore(target)
  }
  const row = (line: Line): RenderElement => drawLine(ui, line, theme, onKeyed, actions.keys)

  if (view.kind === 'cannot-draw') return <Box flexDirection="column">{view.lines.map(row)}</Box>
  if (view.kind === 'message') {
    const after = [...(view.bottomRule === undefined ? [] : [view.bottomRule]), ...(view.keys ?? [])]
    return <Box flexDirection="column">{[...view.header, view.topRule, ...view.body, ...after].map(row)}</Box>
  }
  if (view.kind === 'detail') {
    return (
      <Box flexDirection="column">
        {view.header.map(row)}
        {row(view.topRule)}
        {detailRows(ui, view.detail, theme, actions.detail)}
        {row(view.bottomRule)}
        {view.keys.map(row)}
      </Box>
    )
  }

  const { layout, detail } = view
  const columns = layout.kind === 'wide' && detail !== undefined ? wideColumns(view.body, paneDetailLines(detail).length) : undefined
  const body =
    layout.kind === 'wide' && detail !== undefined && columns !== undefined ? (
      <Box flexDirection="row">
        <Box flexDirection="column" width={layout.boardColumns}>
          {columns.board.map(row)}
        </Box>
        <Box flexDirection="column" width={1}>
          {columns.rule.map(row)}
        </Box>
        <Box flexDirection="column" width={layout.detailColumns}>
          {[...detailRows(ui, detail, theme, actions.detail), ...columns.detailPad.map(row)]}
        </Box>
      </Box>
    ) : (
      view.body.map(row)
    )
  return (
    <Box flexDirection="column">
      {view.header.map(row)}
      {row(view.topRule)}
      {body}
      {row(view.bottomRule)}
      {view.keys.map(row)}
    </Box>
  )
}
