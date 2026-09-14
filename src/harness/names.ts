/**
 * The name rules the harness shares between the declared side (`collect.ts`) and the observed side
 * (`crosswalk.ts`). Every join in the crosswalk is only as good as the identity it joins on, so each rule
 * lives here once and each arm calls it instead of hand-rolling its own.
 *
 * Pure: no filesystem, no clock, no node import beyond `path.basename`.
 */
import { basename } from 'node:path'

/** `superpowers@superpowers-marketplace` → `superpowers`: the name part of a marketplace-qualified plugin key */
export function pluginName(key: string): string {
  return key.split('@')[0] ?? key
}

/**
 * Resolve an observed name onto the declared entry it names.
 *
 * Claude Code reports a plugin skill or agent under the plugin-qualified name (`superpowers:brainstorming`,
 * `nisso-dev:backend`) while the inventory holds the bare one, so the raw string would split ONE thing into
 * two contradictory rows: an `idle` declaration and an `undeclared` observation. Exact first, then the
 * `<plugin>:<bare>` suffix, and ONLY when the declared entry's plugin name equals the observed prefix: two
 * plugins may ship the same bare name, and a naive strip would credit the wrong one. A qualified name that
 * nothing declares stays as observed.
 */
export function canonicalName(observed: string, declared: ReadonlyMap<string, { plugin?: string }>): string {
  if (declared.has(observed)) return observed
  const colon = observed.lastIndexOf(':')
  if (colon > 0) {
    const bare = observed.slice(colon + 1)
    const entry = declared.get(bare)
    // the inventory records the marketplace-qualified key (`superpowers@superpowers-marketplace`) while the
    // observation carries the bare plugin name (`superpowers:brainstorming`), so compare the name part
    if (entry && (entry.plugin === undefined || pluginName(entry.plugin) === observed.slice(0, colon))) return bare
  }
  return observed
}

/**
 * Interpreters a hook command may start with. Plugin hooks ship as `bash "${CLAUDE_PLUGIN_ROOT}/hooks/x.sh"`,
 * and a dozen of them would otherwise collapse onto the one key `bash` and inherit each other's event.
 */
const INTERPRETERS: ReadonlySet<string> = new Set(['env', 'bash', 'sh', 'zsh', 'dash', 'fish', 'python', 'python3', 'node', 'npx', 'bun', 'deno', 'tsx', 'ts-node', 'ruby', 'perl', 'pwsh', 'powershell'])

const unquote = (t: string): string => t.replace(/^['"]|['"]$/g, '')
const pathLike = (t: string): boolean => t.includes('/') || t.includes('\\') || /\.[A-Za-z0-9]+$/.test(t)

/**
 * The basename that names a hook command: `basename(argv0)`, or, when argv0 is an interpreter, the basename
 * of the first script-like token after it (flags skipped, chained interpreters walked). Arguments carry
 * secrets and never enter a report; the argument that IS the hook is the script, and it is a path, not a secret.
 * Nothing after the interpreter looks like a script (`bash -c "echo hi"`) → the interpreter's own name.
 */
export function argv0Basename(command: string): string {
  const tokens = command.trim().split(/\s+/).map(unquote)
  const argv0 = basename(tokens[0] ?? '')
  if (!INTERPRETERS.has(argv0)) return argv0
  for (const t of tokens.slice(1)) {
    if (t.startsWith('-')) continue
    if (INTERPRETERS.has(basename(t))) continue
    return pathLike(t) ? basename(t) : argv0
  }
  return argv0
}
