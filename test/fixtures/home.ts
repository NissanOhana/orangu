/**
 * Fixture "Claude home": writes a fake `~/.claude/projects` tree from the synthetic
 * corpus fixtures so serve/registry tests run against temporary files with controlled mtimes — never a
 * real transcript. appendTurn() grows a transcript the way a live session does.
 */
import { mkdir, writeFile, appendFile, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { SessionBuilder, buildCanonicalSession, resetIds } from './session-builder.js'

export interface FixtureSession {
  id: string
  path: string
  /** what mtime the file was pinned to (drives the badge) */
  mtimeMs: number
}

export interface FixtureHome {
  /** pass as ServeOptions.configDir / DiscoverOptions.configDir */
  configDir: string
  sessions: FixtureSession[]
  liveId: string
  idleId: string
  endedId: string
}

const SLUG = '-Users-test-Code-demo'

async function pin(path: string, mtimeMs: number): Promise<void> {
  await utimes(path, new Date(mtimeMs), new Date(mtimeMs))
}

function liveBuilder(id: string, cwd?: string): SessionBuilder {
  const b = new SessionBuilder({ sessionId: id, startAt: '2026-08-19T16:45:00.000Z', cwd })
  b.userPrompt('My key is sk-ant-api03-FAKEFAKEFAKEFAKE — wire the client')
  b.tick(1100)
  b.assistant([{ type: 'text', text: 'Wiring the client now.' }], { usage: { input_tokens: 6, cache_read_input_tokens: 5000, output_tokens: 70 } })
  b.toolCall('Write', { file_path: '/Users/test/Code/demo/src/client.ts', content: 'export const client = 1' }, 'File created', {
    durationMs: 90,
    usage: { input_tokens: 3, cache_read_input_tokens: 5100, output_tokens: 45 },
  })
  return b
}

/**
 * Three sessions in one project dir: live (fresh mtime, planted secret, trailing partial),
 * idle (10 min old), ended (2 h old, has one agent sidecar).
 */
export async function makeFixtureHome(dir: string, o: { now?: number; cwd?: string } = {}): Promise<FixtureHome> {
  const now = o.now ?? Date.now()
  const proj = join(dir, 'projects', SLUG)
  await mkdir(proj, { recursive: true })
  const sessions: FixtureSession[] = []

  // live: secret in the prompt (redaction fixture) + unterminated trailing partial (possiblyLive)
  resetIds()
  const liveId = '11111111-0000-4000-8000-00000000aaaa'
  const livePath = join(proj, `${liveId}.jsonl`)
  await writeFile(livePath, liveBuilder(liveId, o.cwd).toJsonl() + '{"type":"assistant","mess') // partial last line, no newline
  await pin(livePath, now - 30_000)
  sessions.push({ id: liveId, path: livePath, mtimeMs: now - 30_000 })

  // idle: canonical content, 10 minutes old
  resetIds()
  const idleId = '22222222-0000-4000-8000-00000000bbbb'
  const idlePath = join(proj, `${idleId}.jsonl`)
  const idle = new SessionBuilder({ sessionId: idleId, startAt: '2026-08-14T10:00:00.000Z', cwd: o.cwd })
  idle.userPrompt('Refactor the config loader')
  idle.tick(900)
  idle.assistant([{ type: 'text', text: 'Refactored.' }], { usage: { input_tokens: 10, cache_creation_input_tokens: 3000, output_tokens: 90 } })
  idle.turnDuration(2_000, 2)
  await writeFile(idlePath, idle.toJsonl())
  await pin(idlePath, now - 10 * 60_000)
  sessions.push({ id: idleId, path: idlePath, mtimeMs: now - 10 * 60_000 })

  // ended: the canonical session, 2 hours old, with one agent sidecar
  resetIds()
  const endedId = 'aaaaaaaa-0000-4000-8000-000000000001'
  const endedPath = join(proj, `${endedId}.jsonl`)
  await writeFile(endedPath, buildCanonicalSession({ cwd: o.cwd }).toJsonl())
  const scDir = join(proj, endedId, 'subagents')
  await mkdir(scDir, { recursive: true })
  const agentPath = join(scDir, 'agent-fix01.jsonl')
  const ab = new SessionBuilder({ sessionId: endedId, cwd: o.cwd })
  ab.sidechain('fix01')
  ab.userPrompt('subtask: run the tests')
  ab.assistant([{ type: 'text', text: 'tests green' }], { usage: { input_tokens: 5, output_tokens: 9 } })
  await writeFile(agentPath, ab.toJsonl())
  await writeFile(join(scDir, 'agent-fix01.meta.json'), JSON.stringify({ taskKind: 'subagent', agentType: 'tester' }))
  await pin(agentPath, now - 2 * 3_600_000)
  await pin(endedPath, now - 2 * 3_600_000)
  sessions.push({ id: endedId, path: endedPath, mtimeMs: now - 2 * 3_600_000 })

  return { configDir: dir, sessions, liveId, idleId, endedId }
}

/** Append one human turn (prompt + assistant reply) to a transcript, like a live session growing. */
export async function appendTurn(path: string, sessionId: string, text = 'And one more thing…'): Promise<void> {
  const b = new SessionBuilder({ sessionId, startAt: new Date().toISOString() })
  b.userPrompt(text)
  b.tick(400)
  b.assistant([{ type: 'text', text: 'On it.' }], { usage: { input_tokens: 4, cache_read_input_tokens: 1000, output_tokens: 12 } })
  // leading \n terminates a pending partial fragment (blank lines are skipped by the reader)
  await appendFile(path, '\n' + b.toJsonl())
}
