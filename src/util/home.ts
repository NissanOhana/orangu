/**
 * Where orangu keeps its own state (cache, suggestions, proposals).
 * Precedence: $ORANGU_HOME → $XDG_DATA_HOME/orangu → ~/.orangu. Empty values are ignored.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export function oranguHome(env: Record<string, string | undefined> = process.env): string {
  const explicit = env['ORANGU_HOME']
  if (explicit) return explicit
  const xdg = env['XDG_DATA_HOME']
  if (xdg) return join(xdg, 'orangu')
  return join(homedir(), '.orangu')
}
