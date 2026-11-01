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
/**
 * `NAME=value`, `NAME+=value` and `NAME[i]=value`, the way the shell and `env` read an assignment: the value is an
 * argument, and arguments carry secrets
 */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/
/** the characters that a backslash escapes inside double quotes, as the shell reads them: another pair keeps its backslash */
const DOUBLE_QUOTE_ESCAPES = '"\\$`'
/** a command substitution or an ANSI-C quote: the shell runs or decodes code there, so such a word up to the name is code */
const SUBSTITUTION = /\$\(|`|\$'/
/** a shell operator (a list, a pipe, a redirect, a subshell or an array): a word up to the program that holds one is code */
const OPERATOR = /[;&|<>()]/
/** the 3 characters at which the shell ends a word: a space, a tab and a newline. A non-breaking space is not 1 of them */
const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n'
const BLANK = /[ \t\n]/
/**
 * a Windows path (`C:\hooks\x.ps1`, `\\server\share\x.ps1`): its backslashes are separators, not escapes. Sticky, so
 * `shellWords` tests it at the start of a word in place: set `lastIndex` before each test
 */
const WINDOWS_PATH = /[A-Za-z]:\\|\\\\[^\\ \t\n]+\\/y

/** A shell word: its text with the quotes and escapes read, and whether its raw form holds a substitution. */
interface Word {
  text: string
  code: boolean
}

/**
 * The words of a command as the shell splits them, read 1 time: a word ends at a space, a tab or a newline outside
 * quotes, `'…'` is literal text, and `\"` (with `\\`, `\$` and `` \` ``) in `"…"` and `\x` outside quotes are 1
 * character each. A word that starts as a Windows path is read as it is written. Null when a quote does not close.
 */
function shellWords(command: string): Word[] | null {
  const words: Word[] = []
  let i = 0
  for (;;) {
    while (i < command.length && isBlank(command[i])) i++
    if (i >= command.length) return words
    const start = i
    let word = ''
    WINDOWS_PATH.lastIndex = i
    if (WINDOWS_PATH.test(command)) {
      while (i < command.length && !isBlank(command[i])) i++
      word = command.slice(start, i)
    }
    while (i < command.length && !isBlank(command[i])) {
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
    words.push({ text: word, code: SUBSTITUTION.test(command.slice(start, i)) })
  }
}

/** a URL: its last part can be a topic or a token, so a URL never names a hook */
const isUrl = (t: string): boolean => t.includes('://')
/** a script file: a word with a script extension, with no space and no URL in it */
const isScriptFile = (t: string): boolean => SCRIPT_EXT.test(t) && !BLANK.test(t) && !isUrl(t)
/** a flag value that is the script: a script file, or a path from the home or the current folder (`bash -x ~/hooks/run`) */
const isScriptValue = (t: string): boolean => isScriptFile(t) || (!BLANK.test(t) && (t.startsWith('~/') || t.startsWith('./')))

/**
 * The index of the word that names the command: argv0 at `first`, or, when argv0 is an interpreter, the script after it.
 * The word after a flag with no `=` is the value of that flag, unless it is a script value. After a skipped value, only
 * a script file names the script (`npx -y ntfy-notify https://ntfy.sh/<topic>` is `npx`). A word with a space and a URL
 * are never the script. Else the first word that looks like a path is the script, and any other word stops the search.
 */
function nameIndex(words: readonly Word[], first: number): number {
  if (!INTERPRETERS.has(basename(words[first]!.text))) return first
  let afterFlag = false
  let skipped = false
  for (let i = first + 1; i < words.length; i++) {
    const t = words[i]!.text
    if (t.startsWith('-')) {
      afterFlag = !t.includes('=')
      continue
    }
    const flagValue = afterFlag
    afterFlag = false
    if (ENV_ASSIGNMENT.test(t) || INTERPRETERS.has(basename(t))) continue
    if (flagValue) {
      if (isScriptValue(t)) return i
      skipped = true
      continue
    }
    if (skipped) return isScriptFile(t) ? i : first
    if (BLANK.test(t) || isUrl(t)) return first
    return pathLike(t) ? i : first
  }
  return first
}

/**
 * The basename that names a hook command: `basename(argv0)`, or, when argv0 is an interpreter, the basename
 * of the script after it (`nameIndex`). Arguments carry secrets and never enter a report; the argument that IS the
 * hook is the script, and it is a path, not a secret. Nothing after the interpreter is the script
 * (`bash -c "echo hi"`) → the interpreter's own name.
 *
 * The command is read 1 time as shell words (`shellWords`), so a quoted value or an escaped space stays inside its
 * word. The assignments in front of argv0 (`NAME=`, `NAME+=`, `NAME[i]=`) are skipped, as the shell reads them
 * (`AUTH="Bearer x" ~/hooks/post.sh` runs `post.sh`), so a value never names a hook.
 * A command of assignments only names nothing: ''. So does a command with a quote that does not close, a word up to
 * the program that holds `; & | < > ( )` or starts a comment (`#`), and a word up to the name that holds `$(`, a
 * backtick or `$'`. A substitution after the name leaves the name (`notify.sh "$(pwd)"` is `notify.sh`).
 */
export function argv0Basename(command: string): string {
  const words = shellWords(command)
  if (!words) return ''
  const first = words.findIndex((word) => !ENV_ASSIGNMENT.test(word.text))
  if (first === -1) return ''
  if (words.slice(0, first + 1).some((word) => OPERATOR.test(word.text) || word.text.startsWith('#'))) return ''
  const index = nameIndex(words, first)
  if (words.slice(0, index + 1).some((word) => word.code)) return ''
  return basename(words[index]!.text)
}
