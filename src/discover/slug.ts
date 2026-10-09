/**
 * The project directory name of a cwd.
 *
 * Pure by contract: this module imports no Node module, so a reader with no Node runtime (the god pane) can
 * use it. `discover.ts` imports it and re-exports `projectSlug`.
 */

/** Claude Code encodes the cwd as a directory name: every '/' '\\' '.' ':' (and other non [A-Za-z0-9-]) becomes '-'. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-')
}
