import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { stripAnsi } from './tty.js'

/** The parts of the process that the handoff uses, so a test can stub the platform and the spawn. */
export interface OpenDeps {
  platform?: NodeJS.Platform
  spawn?: (command: string, args: string[], options: SpawnOptions) => { once(event: 'error', listener: () => void): unknown; unref(): void }
  stderr?: { write(text: string): unknown }
}

/**
 * cmd.exe reads these characters in the target of `start`, so a target that holds one could run a second command.
 * A model can name a show-me run directory with Write, and a report path comes from -o: both reach this handoff.
 */
const CMD_SPECIAL = /[&^%!"<>|]/

/**
 * Best-effort OS browser handoff. The target is always printed by the caller. On Windows, a target that holds a
 * character that cmd reads is refused: orangu prints it and asks the user to open it by hand. It returns false then.
 * On macOS and Linux the target is one argument with no shell, so no character in it is special.
 */
export function openInBrowser(target: string, deps: OpenDeps = {}): boolean {
  const platform = deps.platform ?? process.platform
  const spawn = deps.spawn ?? nodeSpawn
  if (platform === 'win32' && CMD_SPECIAL.test(target)) {
    ;(deps.stderr ?? process.stderr).write(`  orangu does not open this path, because cmd reads a character in it. Open it by hand: ${stripAnsi(target)}\n`)
    return false
  }
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', target] : [target]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', () => {
      /* Missing browser helpers are expected on headless hosts. */
    })
    child.unref()
  } catch {
    /* Headless hosts can use the printed URL. */
  }
  return true
}
