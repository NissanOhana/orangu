// The drawing of the god pane: 1 PaneView (src/god/view/pane.ts) as engine elements, with no rule of its own.
// - Each line is 1 row. A line with a key is 1 plain Button with that key (a session row, or a heading that opens
//   and closes), so the arrows walk the rows and `ui.focus` names the selected row. Its segments are Texts inside it.
// - A segment with a press is 1 plain hotkey Button when the pane has an action for its key, else a Text of the
//   same painted text: the engine paints the Button as `j: jump`, and the view counts that width.
// - Any other line is 1 Text of its segments. A token resolves to a color of the session theme (src/god/ui/theme.ts).
// - In the wide layout, the body is 3 columns side by side: the board, the column rule and the detail column.
import type { ElementTable, RenderElement } from 'claude-code'

import { detailPlaceholder, wideColumns } from '../view/frame.js'
import type { Line, PaneView, Segment } from '../view/types.js'
import { colorOf, type ThemeSet } from './theme.js'

/** The elements that the pane draws with, from `$.ui.resolve(e)`. */
export type PaneElements = Pick<ElementTable, 'Box' | 'Text' | 'Button'>

/** What the presses of the pane do. */
export type PaneActions = {
  /** a press on a row: a click on it, or Enter while the ring is on it */
  onRow: (key: string) => void
  /** the action of each hotkey that the pane has; a key with none draws as text */
  keys: Readonly<Partial<Record<string, () => void>>>
}

/** The pane of 1 view. */
export function drawPane(ui: PaneElements, view: PaneView, theme: ThemeSet, actions: PaneActions): RenderElement {
  const { Box, Text, Button } = ui

  const styled = (segment: Segment): RenderElement => (
    <Text {...(segment.token === undefined ? {} : { color: colorOf(segment.token, theme) })} {...(segment.bold ? { bold: true } : {})} {...(segment.dim ? { dimColor: true } : {})}>
      {segment.text}
    </Text>
  )

  const keyButton = (segment: Segment): RenderElement => {
    const action = segment.press === undefined ? undefined : actions.keys[segment.press.hotkey]
    if (segment.press === undefined || action === undefined) return styled(segment)
    return <Button key={`key:${segment.press.hotkey}`} hotkey={segment.press.hotkey} plain label={segment.press.label} {...(segment.dim ? { dimColor: true } : {})} onPress={action} />
  }

  const row = (line: Line): RenderElement => {
    const key = line.key
    if (key !== undefined) {
      return (
        <Button key={key} plain onPress={() => actions.onRow(key)}>
          {line.segments.map(styled)}
        </Button>
      )
    }
    if (line.segments.some((segment) => segment.press !== undefined)) return <Box flexDirection="row">{line.segments.map(keyButton)}</Box>
    return <Text>{line.segments.map(styled)}</Text>
  }

  if (view.kind === 'cannot-draw') return <Box flexDirection="column">{view.lines.map(row)}</Box>
  if (view.kind === 'message') {
    const after = [...(view.bottomRule === undefined ? [] : [view.bottomRule]), ...(view.keys ?? [])]
    return <Box flexDirection="column">{[...view.header, view.topRule, ...view.body, ...after].map(row)}</Box>
  }

  const { layout } = view
  const columns = layout.kind === 'wide' ? wideColumns(view.body, detailPlaceholder(layout.detailColumns)) : undefined
  const body =
    layout.kind === 'wide' && columns !== undefined ? (
      <Box flexDirection="row">
        <Box flexDirection="column" width={layout.boardColumns}>
          {columns.board.map(row)}
        </Box>
        <Box flexDirection="column" width={1}>
          {columns.rule.map(row)}
        </Box>
        <Box flexDirection="column" width={layout.detailColumns}>
          {columns.detail.map(row)}
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
