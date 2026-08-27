/** `orangu feedback`: an isolated loopback form; it never discovers session data. */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { flagBool, flagStr } from '../args.js'
import { openInBrowser } from '../open-browser.js'
import { startServe } from '../../serve/server.js'
import type { Finding, SuggestionRecord, SuggestionSource, SuggestionStatus, SuggestionStoreLike } from '../../suggest/types.js'
import { FEEDBACK_CONTEXTS, isFeedbackContext, type FeedbackContext } from '../../feedback/model.js'
import { VERSION } from '../../version.js'

class EmptySuggestionStore implements SuggestionStoreLike {
  async all(): Promise<SuggestionRecord[]> {
    return []
  }
  async get(_id: string): Promise<SuggestionRecord | undefined> {
    return undefined
  }
  async upsertNew(_finding: Finding, _source: SuggestionSource, _id?: string): Promise<{ record: SuggestionRecord; created: boolean }> {
    throw new Error('suggestion mutations are unavailable in feedback-only mode')
  }
  async transition(_id: string, _to: SuggestionStatus): Promise<SuggestionRecord> {
    throw new Error('suggestion mutations are unavailable in feedback-only mode')
  }
}

export function feedbackContext(flags: Record<string, string | boolean>): FeedbackContext {
  if (flags['context'] === true) throw new Error(`--context requires one of: ${FEEDBACK_CONTEXTS.join('|')}`)
  const raw = flagStr(flags, 'context') ?? 'app'
  if (!isFeedbackContext(raw)) throw new Error(`--context must be one of: ${FEEDBACK_CONTEXTS.join('|')}`)
  return raw
}

function feedbackPort(flags: Record<string, string | boolean>): number | undefined {
  if (flags['port'] === true) throw new Error('--port requires an integer 0–65535')
  const raw = flagStr(flags, 'port')
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) throw new Error('--port must be an integer 0–65535')
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('--port must be an integer 0–65535')
  return port
}

export function feedbackOptions(flags: Record<string, string | boolean>): { context: FeedbackContext; port?: number } {
  const allowed = new Set(['context', 'port', 'no-open'])
  const unsupported = Object.keys(flags).find((name) => !allowed.has(name))
  if (unsupported) throw new Error(`unsupported feedback option --${unsupported}`)
  if (flags['no-open'] !== undefined && flags['no-open'] !== true) throw new Error('--no-open does not accept a value')
  const context = feedbackContext(flags)
  const port = feedbackPort(flags)
  return port === undefined ? { context } : { context, port }
}

export async function cmdFeedback(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  if (positionals.length) throw new Error('usage: orangu feedback --context session|repo|global|report|app [--port <n>] [--no-open]')
  const { context, port } = feedbackOptions(flags)
  // This process-specific path is deliberately never created. An explicit configDir overrides
  // CLAUDE_CONFIG_DIR, so even a populated user configuration cannot enter feedback-only AppData.
  const emptyConfigDir = join(tmpdir(), `orangu-feedback-empty-${process.pid}-${Date.now()}`)
  const server = await startServe(
    {
      port,
      open: false,
      includeText: false,
      configDir: emptyConfigDir,
      noCache: true,
      version: VERSION,
      maxLive: 1,
    },
    { cache: null, quiet: true, store: new EmptySuggestionStore() },
  )
  const url = `${server.url}/#feedback?context=${encodeURIComponent(context)}`
  process.stderr.write(`orangu feedback (beta) · ${url}\n  loopback + private capability · no sessions attached · ctrl-c stops\n`)
  if (!flagBool(flags, 'no-open')) openInBrowser(url)

  await new Promise<void>((resolve) => {
    let closing = false
    const close = (): void => {
      if (closing) return
      closing = true
      void server.close().finally(resolve)
    }
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
  })
  process.stderr.write('  stopped.\n')
}
