/**
 * A file that the command names, inside Claude Code.
 *
 * A plugin skill pre-approves an orangu verb such as `repo`, so a line planted in a transcript, a file or a page can
 * make Claude run `orangu repo <repo> --out <repo>/CLAUDE.local.md` with no prompt. The writer (src/cli/private-output.ts)
 * replaces only a file that orangu wrote, but it makes any new path, and later sessions load such a file as
 * instructions. Inside Claude Code (it sets CLAUDECODE in the shell of its Bash tool), 2 rules hold for a path that
 * -o, --out or --html names, on its text and on its real path:
 * 1. A name that an agent loads (CLAUDE.md, CLAUDE.local.md, AGENTS.md, .mcp.json, or a file in a .claude folder) is
 *    refused in every folder. orangu writes only HTML and JSON reports, so ORANGU_ALLOW_OUT=1 does not lift this rule.
 * 2. The file goes in a folder inside the temp folder of the OS (as `mktemp -d` makes) or in the orangu home, and never
 *    in the folder of the command or in its git repository, unless ORANGU_ALLOW_OUT=1 starts the command. No allow rule
 *    matches past an assignment of another variable, so Claude Code asks the user before such a command.
 * A terminal run, the temporary file that orangu names, and the paths that the skills pass (a folder from `mktemp -d`,
 * the orangu home) do not change. The same shape as the gate for unredacted text, src/cli/raw-output.ts. The check runs
 * before the write, so a second process that swaps a folder for a link between the two can pass it.
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { oranguHome } from '../util/home.js'

/** The flags that name an output file, as in src/cli/raw-output.ts. `--html` with no value writes to the temp folder. */
const PATH_FLAGS = ['o', 'out', 'html'] as const

/** The file names that an agent loads as instructions or as settings, folded as `fold` folds them. */
const LOADED_NAMES: ReadonlySet<string> = new Set(['claude.md', 'claude.local.md', 'agents.md', '.mcp.json'])
/** The folder whose files Claude Code loads, folded. */
const LOADED_FOLDER = '.claude'

/** The folders that decide where a named file may go. */
export interface OutputPlaces {
  /** the temp folder of the OS: a named file goes in a folder inside it, as `mktemp -d` makes */
  temp: string
  /** the orangu home */
  home: string
  /** the folder of the command, or undefined when the OS cannot tell: a named file never goes in it or in its git repository */
  cwd: string | undefined
}

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code
const flagName = (flag: string): string => `${flag.length === 1 ? '-' : '--'}${flag}`

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

/** True when `target` is in a folder inside `place`, not straight in `place`: the shape of a folder from `mktemp -d`. */
function withinChild(target: string, place: string): boolean {
  return within(dirname(target), place)
}

/**
 * One part of a path as a file system reads it. It keeps the part before a Windows stream name (`CLAUDE.md::$DATA`
 * writes CLAUDE.md) and drops the dots and spaces at its end (Windows drops them). Then it folds the case as a file
 * system that ignores case does: `AGENTſ.md` names AGENTS.md on macOS, and toUpperCase().toLowerCase() gives agents.md.
 */
function fold(part: string): string {
  const stream = part.indexOf(':')
  return (stream < 0 ? part : part.slice(0, stream)).replace(/[. ]+$/, '').toUpperCase().toLowerCase()
}

/** True when a write to `path` makes or changes a file that an agent loads: a loaded name, or a file in a .claude folder. */
function loadedByAgent(path: string): boolean {
  const parts = path.split(/[\\/]/).map(fold)
  return LOADED_NAMES.has(parts.at(-1) ?? '') || parts.includes(LOADED_FOLDER)
}

/**
 * The folder of the command and the root of its git repository, at their real paths. The root is the nearest folder at
 * or above the command folder with a .git entry: a folder in a clone, a file in a worktree or a submodule. Undefined
 * when orangu cannot read the folder of the command.
 */
function workFolders(cwd: string): string[] | undefined {
  const real = realTarget(cwd)
  if (real === undefined) return undefined
  for (let dir = real; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir === real ? [real] : [real, dir]
    if (dirname(dir) === dir) return [real]
  }
}

function currentFolder(): string | undefined {
  try {
    return process.cwd()
  } catch {
    return undefined
  }
}

function loadedRefusal(flag: string): string {
  return (
    `${flagName(flag)}: inside Claude Code, orangu does not write CLAUDE.md, CLAUDE.local.md, AGENTS.md, .mcp.json or a file in a .claude folder. ` +
    'A later session can load such a file as instructions or as settings. ' +
    'Text in a session can steer Claude to run such a command with no prompt. ' +
    'ORANGU_ALLOW_OUT=1 does not change this. Choose another path.'
  )
}

function placeRefusal(flag: string): string {
  return (
    `${flagName(flag)}: inside Claude Code, orangu writes a named file only in a folder inside the temp folder or in the orangu home. ` +
    'It does not write in the current folder or in its git repository. ' +
    'Text in a session can steer Claude to run such a command with no prompt. ' +
    'To allow another path, start the command with ORANGU_ALLOW_OUT=1, so that Claude Code asks you first.'
  )
}

/** The refusal for this command line, or undefined when orangu may run it. */
export function outputPathRefusal(
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
  places: OutputPlaces = { temp: tmpdir(), home: oranguHome(env), cwd: currentFolder() },
): string | undefined {
  if (!env['CLAUDECODE']) return undefined
  // an empty value names no file: the writer then uses its temporary path, or writes nothing
  const named = PATH_FLAGS.filter((flag) => typeof flags[flag] === 'string' && flags[flag] !== '')
  if (!named.length) return undefined
  const targets = named.map((flag) => ({ flag, text: resolve(flags[flag] as string), real: realTarget(flags[flag] as string) }))

  // rule 1, in every folder: ORANGU_ALLOW_OUT=1 does not lift it
  const loaded = targets.find(({ text, real }) => loadedByAgent(text) || (real !== undefined && loadedByAgent(real)))
  if (loaded !== undefined) return loadedRefusal(loaded.flag)
  if (env['ORANGU_ALLOW_OUT'] === '1') return undefined

  // rule 2: a folder inside the temp folder, or the orangu home, and never the work folders of the command
  const temp = realTarget(places.temp)
  const home = realTarget(places.home)
  const work = places.cwd === undefined ? undefined : workFolders(places.cwd)
  const outside = targets.find(({ real }) => {
    if (real === undefined || work === undefined) return true
    if (work.some((folder) => within(real, folder))) return true
    return !((temp !== undefined && withinChild(real, temp)) || (home !== undefined && within(real, home)))
  })
  return outside === undefined ? undefined : placeRefusal(outside.flag)
}
