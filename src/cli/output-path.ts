/**
 * A file that the command names, inside Claude Code.
 *
 * A plugin skill pre-approves an orangu verb such as `repo`, so a line planted in a transcript, a file or a page can
 * make Claude run `orangu repo <repo> --out <repo>/CLAUDE.local.md` with no prompt. The writer (src/cli/private-output.ts)
 * replaces only a file that orangu wrote, but it makes any new path, and later sessions load such a file as
 * instructions. Inside Claude Code (it sets CLAUDECODE in the shell of its Bash tool), a path that -o, --out or --html
 * names must be in the temp folder of the OS or in the orangu home, at its real path, unless ORANGU_ALLOW_OUT=1 starts
 * the command. No allow rule matches past an assignment of another variable, so Claude Code asks the user before such
 * a command. A terminal run, the temporary file that orangu names, and the paths that the skills pass (a folder from
 * `mktemp -d`, the orangu home) do not change. The same shape as the gate for unredacted text, src/cli/raw-output.ts.
 */
import { lstatSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { oranguHome } from '../util/home.js'

/** The flags that name an output file, as in src/cli/raw-output.ts. `--html` with no value writes to the temp folder. */
const PATH_FLAGS = ['o', 'out', 'html'] as const

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code

/**
 * The real path that a write to `path` reaches, or undefined when orangu cannot tell. The writers resolve `..` in the
 * text first (src/cli/private-output.ts), so this does too. Then it follows each link: realpath reads the nearest part
 * that exists, and the parts below it, which do not exist yet, follow as text. A link that points to nothing gives
 * undefined, because a write follows it to a place that this check cannot read.
 */
export function realTarget(path: string): string | undefined {
  let head = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathSync(head), ...tail)
    } catch (error) {
      if (code(error) !== 'ENOENT') return undefined
    }
    try {
      lstatSync(head)
      // the name exists and realpath cannot read it: a link that points to nothing
      return undefined
    } catch (error) {
      if (code(error) !== 'ENOENT') return undefined
    }
    const parent = dirname(head)
    if (parent === head) return undefined
    tail.unshift(basename(head))
    head = parent
  }
}

/** True when the real path `target` is in the real folder `place`. A folder whose name only starts the same is not. */
function within(target: string, place: string): boolean {
  const rel = relative(place, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * The refusal for this command line, or undefined when orangu may run it. `places` are the folders where a named file
 * may go: the temp folder of the OS (where `mktemp -d` makes its folder) and the orangu home.
 */
export function outputPathRefusal(
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
  places: readonly string[] = [tmpdir(), oranguHome(env)],
): string | undefined {
  if (!env['CLAUDECODE'] || env['ORANGU_ALLOW_OUT'] === '1') return undefined
  // an empty value names no file: the writer then uses its temporary path, or writes nothing
  const named = PATH_FLAGS.filter((flag) => typeof flags[flag] === 'string' && flags[flag] !== '')
  if (!named.length) return undefined
  const real = places.map(realTarget).filter((place): place is string => place !== undefined)
  const outside = named.find((flag) => {
    const target = realTarget(flags[flag] as string)
    return target === undefined || !real.some((place) => within(target, place))
  })
  if (outside === undefined) return undefined
  return (
    `${outside.length === 1 ? '-' : '--'}${outside}: inside Claude Code, orangu writes a file that the command names only in the temp folder or in the orangu home. ` +
    'Text in a session can steer Claude to run such a command with no prompt. ' +
    'To allow another path, start the command with ORANGU_ALLOW_OUT=1, so that Claude Code asks you first.'
  )
}
