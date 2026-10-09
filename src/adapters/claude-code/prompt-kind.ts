/**
 * Prompt kind and session title for Claude Code records.
 *
 * Pure by contract: this module imports no Node module, so a reader with no Node runtime (the god pane) can
 * use it. `parse.ts` imports it and re-exports `classifyPrompt`. `JsonObject`, `str` and `obj` repeat the
 * one-line forms of `jsonl.ts` and `parse.ts`, because those files import `node:fs` and `node:path`.
 */
import type { PromptKind } from '../../model/session.js'

type JsonObject = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const obj = (v: unknown): JsonObject | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : undefined)

export const COMMAND_RE = /<command-name>\s*([^<\s]+)\s*<\/command-name>/
const COMMAND_ARGS_RE = /<command-args>\s*([^<]*?)\s*<\/command-args>/
/** `<command-message>x</command-message> <command-name>/x</command-name> <command-args>a</command-args>` → `/x a` */
function commandEnvelopeTitle(envelope: string, commandName?: string): string {
  const name = commandName || COMMAND_RE.exec(envelope)?.[1] || envelope
  const args = COMMAND_ARGS_RE.exec(envelope)?.[1]
  return args ? `${name} ${args}` : name
}
export const INTERRUPT_RE = /\[Request interrupted by user/i
const LEADING_REMINDERS_RE = /^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*)+/

/** Classify a non-tool-result user message. Uses Claude Code's origin/promptSource when present, else content heuristics. */
export function classifyPrompt(r: JsonObject, text: string, isMeta: boolean): PromptKind {
  const origin = obj(r['origin'])
  const originKind = str(origin?.['kind'])
  const promptSource = str(r['promptSource'])
  if (INTERRUPT_RE.test(text.slice(0, 200))) return 'interrupt'
  if (r['isVisibleInTranscriptOnly'] === true) return 'meta'
  if (originKind === 'human' || promptSource === 'typed') return COMMAND_RE.test(text) ? 'command' : 'human'
  if (originKind === 'task-notification') return 'notification'
  if (originKind === 'peer' || originKind === 'teammate' || originKind === 'cross-session') return 'peer'
  const t = text.replace(LEADING_REMINDERS_RE, '').trimStart()
  if (t.startsWith('<command-name>') || t.startsWith('<command-message>')) return 'command'
  if (t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-caveat>') || t.startsWith('<local-command-stderr>')) return 'local_output'
  if (t.startsWith('<task-notification>')) return 'notification'
  if (t.startsWith('<teammate-message') || t.startsWith('<cross-session-message') || t.startsWith('Another Claude session sent a message')) return 'peer'
  if (isMeta && promptSource === 'system') return 'scheduled'
  if (isMeta) return 'meta'
  // known Claude Code injected wrappers → meta. Arbitrary pasted markup (<div>, <Component>, <xml>) is NOT
  // meta: a real human prompt can start with pasted code, and we must not lose that turn.
  const META_TAGS = ['<user-prompt-submit-hook>', '<system-reminder>', '<budget:', '<total_tokens>', '<user-memory-input>', '<important_context>', '<function_results>', '<returned-by-']
  if (META_TAGS.some((tag) => t.startsWith(tag))) return 'meta'
  return 'human'
}

/**
 * The session title: the custom title, else the AI title, else the first prompt preview. `firstCommandName` is
 * the command name of the first turn. Only a missing value falls through, so an empty title stays empty.
 */
export function sessionTitle(customTitle: string | undefined, aiTitle: string | undefined, firstPromptPreview: string | undefined, firstCommandName: string | undefined): string | undefined {
  const rawTitle = customTitle ?? aiTitle ?? firstPromptPreview
  // a first prompt that is a slash-command envelope titles the session by its command, not its markup
  return rawTitle !== undefined && /^\s*<command-(?:message|name)>/.test(rawTitle) ? commandEnvelopeTitle(rawTitle, firstCommandName) : rawTitle
}
