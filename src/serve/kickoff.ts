/**
 * Copy-only proposal handoff for the loopback app.
 *
 * The browser may create a deterministic suggestion record and receive the exact
 * `/orangu:improve` command. It never launches a model process. Claude Code shell
 * permission patterns cannot provide an OS-level filesystem/network sandbox, so
 * an automatic headless launch would make the localhost UI a broader authority
 * boundary than the report it displays. Users run the copied command in their
 * normal interactive Claude Code or Codex session instead.
 */
import type { ServerResponse } from 'node:http'
import { redactValue } from '../redact/redact.js'
import { kickoffCommands, suggestionId, suggestionIdV2, suggestionKey } from '../suggest/id.js'
import type { Finding, KickoffRequest, KickoffResponse } from '../suggest/types.js'
import type { Route, RouteFactory } from './types.js'

const SCOPES = new Set(['session', 'repo', 'global'])
const MODES = new Set(['copy', 'run'])

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Parse + validate the request at the boundary; null = reject with 400. */
export function parseKickoffRequest(body: unknown): KickoffRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  if (typeof b.mode !== 'string' || !MODES.has(b.mode)) return null
  const f = b.finding
  if (typeof f !== 'object' || f === null) return null
  const fo = f as Record<string, unknown>
  if (typeof fo.ruleId !== 'string' || !fo.ruleId.trim()) return null
  if (typeof fo.title !== 'string' || !fo.title.trim()) return null
  if (typeof fo.scope !== 'string' || !SCOPES.has(fo.scope)) return null
  if (!Array.isArray(fo.sessionIds) || fo.sessionIds.length === 0 || !fo.sessionIds.every((s) => typeof s === 'string' && s.trim())) return null
  if (typeof fo.evidence !== 'object' || fo.evidence === null || Array.isArray(fo.evidence)) return null
  if (typeof (fo.evidence as Record<string, unknown>).estimated !== 'boolean') return null
  if (fo.insightId !== undefined && typeof fo.insightId !== 'string') return null
  if (
    fo.scope === 'session'
      ? fo.cohortFingerprint !== undefined
      : typeof fo.cohortFingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(fo.cohortFingerprint)
  ) return null
  const identityValues = [fo.ruleId, fo.insightId, ...fo.sessionIds].filter((value): value is string => typeof value === 'string')
  if (identityValues.some((value) => redactValue(value, { scrub: true }) !== value)) return null
  if (b.confirm !== undefined && typeof b.confirm !== 'boolean') return null
  if (b.suggestionId !== undefined && typeof b.suggestionId !== 'string') return null
  const finding: Finding = {
    ruleId: fo.ruleId,
    title: fo.title,
    scope: fo.scope as Finding['scope'],
    sessionIds: fo.sessionIds as string[],
    ...(typeof fo.insightId === 'string' ? { insightId: fo.insightId } : {}),
    ...(typeof fo.cohortFingerprint === 'string' ? { cohortFingerprint: fo.cohortFingerprint } : {}),
    evidence: fo.evidence as Finding['evidence'],
  }
  return {
    finding,
    mode: b.mode as KickoffRequest['mode'],
    ...(typeof b.confirm === 'boolean' ? { confirm: b.confirm } : {}),
    ...(typeof b.suggestionId === 'string' ? { suggestionId: b.suggestionId } : {}),
  }
}

export const kickoffRoutes: RouteFactory = (ctx): Route[] => [
  {
    method: 'POST',
    path: '/api/kickoff',
    handler: async (m, _req, res) => {
      const parsed = parseKickoffRequest(m.body)
      if (!parsed) {
        sendJson(res, 400, { error: 'invalid kickoff request: need { finding: { ruleId, title, scope, sessionIds[], evidence }, mode: "copy"|"run" }' })
        return
      }
      const id = suggestionIdV2(suggestionKey(parsed.finding, 'report'))
      const legacyId = suggestionId('report', parsed.finding.ruleId, parsed.finding.sessionIds)
      const acceptsLegacyId = !parsed.finding.cohortFingerprint && parsed.suggestionId === legacyId
      if (parsed.suggestionId && parsed.suggestionId !== id && !acceptsLegacyId) {
        sendJson(res, 400, { error: `suggestionId mismatch: finding hashes to ${id}` })
        return
      }
      const { record } = await ctx.store.upsertNew(parsed.finding, 'report')
      const commands = kickoffCommands(record, 'serve')
      const command = commands.claude
      const annotated = { ...record, kickoff: { mode: 'serve' as const, command } }
      const publicRecord = redactValue(annotated, { scrub: true })
      ctx.noteSuggestion?.(record)

      if (parsed.mode === 'run') {
        sendJson(res, 403, {
          record: publicRecord,
          commands,
          command,
          spawned: false,
          error: 'automatic model launch is disabled; copy the command into Claude Code or use $orangu-improve in Codex',
        } satisfies KickoffResponse)
        return
      }
      sendJson(res, 200, { record: publicRecord, commands, command, spawned: false } satisfies KickoffResponse)
    },
  },
]
