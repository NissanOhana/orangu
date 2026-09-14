/**
 * Which settings file wins when several declare the same key: Claude Code's precedence, in one place, so the
 * crosswalk (`declared`) and retention (`computeRetention`) can never disagree about it.
 *
 * Scopes: managed policy above everything, then project local, shared project, user local, user. Within
 * managed policy Claude Code merges `managed-settings.json` first and then every `managed-settings.d/*.json`
 * in alphabetical order, and a later single value replaces an earlier one, so the rows are consulted in
 * REVERSE merge order: the alphabetically last drop-in first, `managed-settings.json` last.
 *
 * Pure; no node import, so it can be reached from any bundle that holds the types.
 */
import type { HarnessConfigScope, HarnessSettingsFile } from './types.js'

export const SCOPE_PRECEDENCE: readonly HarnessConfigScope[] = ['managed', 'repo-local', 'repo', 'global-local', 'global']

const isDropIn = (file: string): boolean => /[\\/]managed-settings\.d[\\/][^\\/]+$/.test(file)

/** managed rows in the order a reader should consult them: later drop-in first, then earlier ones, then the main file */
function managedOrder(rows: readonly HarnessSettingsFile[]): HarnessSettingsFile[] {
  const dropIns = rows.filter((r) => isDropIn(r.file)).sort((a, b) => (a.file < b.file ? 1 : a.file > b.file ? -1 : 0))
  return [...dropIns, ...rows.filter((r) => !isDropIn(r.file))]
}

/** every settings row, highest precedence first; rows of one non-managed scope keep the order they arrived in */
export function byPrecedence(settings: readonly HarnessSettingsFile[]): HarnessSettingsFile[] {
  return SCOPE_PRECEDENCE.flatMap((scope) => {
    const rows = settings.filter((s) => s.scope === scope)
    return scope === 'managed' ? managedOrder(rows) : rows
  })
}
