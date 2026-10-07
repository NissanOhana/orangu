/**
 * Unredacted session text to a named file, inside Claude Code.
 *
 * A plugin skill pre-approves an orangu verb such as `report`, so a line planted in a transcript, a file or a page can
 * make Claude run `orangu report latest --no-redact --include-text -o <repo>/notes.md` with no prompt. Inside Claude
 * Code (it sets CLAUDECODE in the shell of its Bash tool), `--no-redact` or `--include-text` with a path that the
 * command names needs ORANGU_ALLOW_RAW=1. No allow rule matches past an assignment of another variable, so Claude Code
 * asks the user before such a command. A terminal run, and the private temporary file that orangu names, do not change.
 */
import { flagBool } from './args.js'

/** The flags that name an output file. `--html` with no value writes to the temporary directory. */
const PATH_FLAGS = ['o', 'out', 'html'] as const
/** The flags that keep session text that orangu otherwise removes. */
const RAW_FLAGS = ['no-redact', 'include-text'] as const

/** The refusal for this command line, or undefined when orangu may run it. */
export function rawOutputRefusal(flags: Record<string, string | boolean>, env: Record<string, string | undefined>): string | undefined {
  if (!env['CLAUDECODE'] || env['ORANGU_ALLOW_RAW'] === '1') return undefined
  const raw = RAW_FLAGS.filter((flag) => flagBool(flags, flag))
  const path = PATH_FLAGS.find((flag) => typeof flags[flag] === 'string')
  if (!raw.length || path === undefined) return undefined
  const named = `${raw.map((flag) => `--${flag}`).join(' and ')} with ${path.length === 1 ? '-' : '--'}${path}`
  return (
    `${named}: inside Claude Code, orangu does not write unredacted session text to a path that the command names. ` +
    'Text in a session can steer Claude to run such a command with no prompt. ' +
    'To allow it, start the command with ORANGU_ALLOW_RAW=1, so that Claude Code asks you first.'
  )
}
