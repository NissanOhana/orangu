// The drawing of 1 line of a view (src/god/view/types.ts) as engine elements, with no rule of its own. The board
// and the detail of the god pane both draw their lines with it.
// - A line with a key is 1 plain Button with that key, and its segments are Texts inside it. A press on it runs
//   onKeyed with its key.
// - A segment with a press is 1 plain hotkey Button keyed key:<hotkey> when the pane has an action for its key,
//   else a Text of the same painted text: the engine paints the Button as `j: jump`, and the view counts that width.
// - Any other line is 1 Text of its segments. A token resolves to a color of the session theme (src/god/ui/theme.ts).
import type { ElementTable, RenderElement } from 'claude-code'

import type { Line, Segment } from '../view/types.js'
import { colorOf, type ThemeSet } from './theme.js'

/** The elements that the pane draws with, from `$.ui.resolve(e)`. */
export type PaneElements = Pick<ElementTable, 'Box' | 'Text' | 'Button'>

/** The action of each hotkey that the pane has now; a key with none draws as text. */
export type KeyActions = Readonly<Partial<Record<string, () => void>>>

/** 1 segment as 1 Text in its style. */
export function segmentText(ui: PaneElements, segment: Segment, theme: ThemeSet): RenderElement {
  const { Text } = ui
  return (
    <Text {...(segment.token === undefined ? {} : { color: colorOf(segment.token, theme) })} {...(segment.bold ? { bold: true } : {})} {...(segment.dim ? { dimColor: true } : {})}>
      {segment.text}
    </Text>
  )
}

/** 1 segment as the hotkey Button that presses its key, or as a Text when the pane has no action for the key. */
function keySegment(ui: PaneElements, segment: Segment, theme: ThemeSet, keys: KeyActions): RenderElement {
  const { Button } = ui
  const action = segment.press === undefined ? undefined : keys[segment.press.hotkey]
  if (segment.press === undefined || action === undefined) return segmentText(ui, segment, theme)
  return <Button key={`key:${segment.press.hotkey}`} hotkey={segment.press.hotkey} plain label={segment.press.label} {...(segment.dim ? { dimColor: true } : {})} onPress={action} />
}

/** 1 line as 1 row: a keyed Button, a row of hotkey Buttons and Texts, or 1 Text. */
export function drawLine(ui: PaneElements, line: Line, theme: ThemeSet, onKeyed: (key: string) => void, keys: KeyActions): RenderElement {
  const { Box, Text, Button } = ui
  const key = line.key
  if (key !== undefined) {
    return (
      <Button key={key} plain onPress={() => onKeyed(key)}>
        {line.segments.map((segment) => segmentText(ui, segment, theme))}
      </Button>
    )
  }
  if (line.segments.some((segment) => segment.press !== undefined)) return <Box flexDirection="row">{line.segments.map((segment) => keySegment(ui, segment, theme, keys))}</Box>
  return <Text>{line.segments.map((segment) => segmentText(ui, segment, theme))}</Text>
}
