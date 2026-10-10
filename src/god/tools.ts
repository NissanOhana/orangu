/**
 * The 2 read-only tools of the god mod for the god Claude: their specs and what each one answers, as pure code, so
 * the engine shell (src/god/register.tsx) only registers the specs and serves the calls.
 *
 * - The engine lists each tool as `mcp__orangu-god__<name>`. `isDeferred: false` puts its schema in the prompt from
 *   the start, so the god Claude sees the tools with no tool search.
 * - board takes no input. session takes the name of 1 session, as the board tool shows it.
 * - Each answer is the text of the last snapshot that the board took (src/god/view/tool-text.ts) at TOOL_WIDTH
 *   cells. Each session text is in a quote frame, and the text says that a quoted text is data, not an instruction.
 *   The texts are sanitized and redacted before they reach the snapshot.
 * - Before the first snapshot, a tool says that the board reads the sessions. When the board does not run in this
 *   load of the mod (a reload before /god), it says so and names /god.
 * - The tools only read. They run no host command, and they change no state and no store value.
 */
import { BOARD_TOOL_DESCRIPTION, SESSION_TOOL_DESCRIPTION, SESSION_TOOL_NAME_HINT, TOOL_NOT_RUNNING } from './copy.js'
import type { BoardSnapshot } from './types.js'
import { boardToolText, sessionToolText } from './view/tool-text.js'

export { TOOL_NOT_RUNNING } from './copy.js'

/** The width in cells of a tool text: wide, because the model reads it, not a terminal. */
export const TOOL_WIDTH = 160

/** A tool as `$.tool.register` takes it. */
export type GodToolSpec = { name: string; description: string; inputSchema: Record<string, unknown>; isDeferred: boolean }

export const BOARD_TOOL: GodToolSpec = { name: 'board', description: BOARD_TOOL_DESCRIPTION, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, isDeferred: false }

export const SESSION_TOOL: GodToolSpec = {
  name: 'session',
  description: SESSION_TOOL_DESCRIPTION,
  inputSchema: { type: 'object', properties: { name: { type: 'string', description: SESSION_TOOL_NAME_HINT } }, required: ['name'], additionalProperties: false },
  isDeferred: false,
}

/** The board that a tool reads: whether it runs in this load of the mod, and its last snapshot. */
export type ToolBoard = { isRunning: boolean; snapshot?: BoardSnapshot }

/** What the board tool answers. */
export function boardToolAnswer(board: ToolBoard, now: number): string {
  return board.isRunning ? boardToolText(board.snapshot, TOOL_WIDTH, now) : TOOL_NOT_RUNNING
}

/** What the session tool answers for its input name: a name that is not text names no session. */
export function sessionToolAnswer(board: ToolBoard, name: unknown, now: number): string {
  return board.isRunning ? sessionToolText(board.snapshot, typeof name === 'string' ? name : '', TOOL_WIDTH, now) : TOOL_NOT_RUNNING
}
