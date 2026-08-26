import { spawn } from 'node:child_process'

/** Best-effort OS browser handoff. The target is always printed by the caller. */
export function openInBrowser(target: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.once('error', () => {
      /* Missing browser helpers are expected on headless hosts. */
    })
    child.unref()
  } catch {
    /* Headless hosts can use the printed URL. */
  }
}
