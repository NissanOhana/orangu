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

/** extensions a hook script ships with; a bare token needs one of these, or a path separator, to count as the script */
const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|mts|cts|rb|pl|ps1|cmd|bat)$/i
const pathLike = (t: string): boolean => t.includes('/') || t.includes('\\') || SCRIPT_EXT.test(t)
/** `NAME=value`, the way `env` reads one: the value is an argument, and arguments carry secrets */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** the characters that a backslash escapes inside double quotes, as the shell reads them: another pair keeps its backslash */
const DOUBLE_QUOTE_ESCAPES = '"\\$`'
/** a command substitution or an ANSI-C quote: the shell runs or decodes code there, so no word of the command is a safe name */
const SUBSTITUTION = /\$\(|`|\$'/

/**
 * The words of a command as the shell splits them, read 1 time: a word ends at whitespace outside quotes, `'…'` is
 * literal text, and `\"` (with `\\`, `\$` and `` \` ``) in `"…"` and `\x` outside quotes are 1 character each. Null
 * when a quote does not close, or when a word holds `$(`, a backtick or `$'`.
 */
function shellWords(command: string): string[] | null {
  const words: string[] = []
  let i = 0
  for (;;) {
    while (i < command.length && /\s/.test(command[i]!)) i++
    if (i >= command.length) return words
    const start = i
    let word = ''
    while (i < command.length && !/\s/.test(command[i]!)) {
      const c = command[i]!
      if (c === '\\') {
        word += command[i + 1] ?? ''
        i += 2
      } else if (c === "'") {
        const close = command.indexOf("'", i + 1)
        if (close === -1) return null
        word += command.slice(i + 1, close)
        i = close + 1
      } else if (c === '"') {
        let j = i + 1
        while (j < command.length && command[j] !== '"') {
          const next = command[j + 1]
          const escaped = command[j] === '\\' && next !== undefined && DOUBLE_QUOTE_ESCAPES.includes(next)
          word += escaped ? next : command[j]
          j += escaped ? 2 : 1
        }
        if (j >= command.length) return null
        i = j + 1
      } else {
        word += c
        i++
      }
    }
    if (SUBSTITUTION.test(command.slice(start, i))) return null
    words.push(word)
  }
}

/**
 * The basename that names a hook command: `basename(argv0)`, or, when argv0 is an interpreter, the basename
 * of the first script-like token after it (flags skipped, chained interpreters walked). Arguments carry
 * secrets and never enter a report; the argument that IS the hook is the script, and it is a path, not a secret.
 * Nothing after the interpreter looks like a script (`bash -c "echo hi"`) → the interpreter's own name.
 *
 * The command is read 1 time as shell words (`shellWords`), so a quoted value or an escaped space stays inside its
 * word. The `NAME=value` assignments in front of argv0 are skipped, as the shell reads them
 * (`AUTH="Bearer x" ~/hooks/post.sh` runs `post.sh`), so a value never names a hook. After an interpreter, the word
 * that follows a flag with no `=` is the value of that flag (`node --key <v> x.js`), unless it has a script extension.
 * A command of assignments only names nothing: ''. So does a command with a quote that does not close, or with a word
 * that holds `$(`, a backtick or `$'`.
 */
export function argv0Basename(command: string): string {
  const words = shellWords(command)
  if (!words) return ''
  const first = words.findIndex((word) => !ENV_ASSIGNMENT.test(word))
  if (first === -1) return ''
  const argv0 = basename(words[first]!)
  if (!INTERPRETERS.has(argv0)) return argv0
  let afterFlag = false
  for (const t of words.slice(first + 1)) {
    if (t.startsWith('-')) {
      afterFlag = !t.includes('=')
      continue
    }
    const flagValue = afterFlag
    afterFlag = false
    if (ENV_ASSIGNMENT.test(t)) continue
    if (INTERPRETERS.has(basename(t))) continue
    if (flagValue && !SCRIPT_EXT.test(t)) continue
    return pathLike(t) ? basename(t) : argv0
  }
  return argv0
}
