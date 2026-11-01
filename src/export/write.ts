/**
 * The run directory of `orangu export`: `<orangu home>/export/global-<random>/`, mode 0700 (mkdtemp), so a second run
 * never writes into the first. orangu-export.json goes in it at 0600 through src/cli/private-output.ts. Each name in
 * the directory is new, so the writer never replaces a file.
 *
 * A write that fails after mkdtemp leaves an empty run directory and no file, as `orangu show-me` does.
 */
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { writePrivateOutput } from '../cli/private-output.js'
import { oranguHome } from '../util/home.js'

/** The name of the export file in each run directory. */
export const EXPORT_FILE = 'orangu-export.json'

/** Where each export run directory lives: `<orangu home>/export` (ORANGU_HOME, then XDG_DATA_HOME). */
export const exportBase = (): string => join(oranguHome(), 'export')

export interface ExportRun {
  dir: string
  export: { path: string; bytes: number; approxTokens: number }
}

/** Make a new run directory and write orangu-export.json in it. `text` is the exact text of the file. */
export async function writeExportRun(text: string, o: { base?: string } = {}): Promise<ExportRun> {
  const base = o.base ?? exportBase()
  await mkdir(base, { recursive: true, mode: 0o700 })
  // the real path, so that the printed directory and the file path name the same folder
  const dir = await realpath(await mkdtemp(join(base, 'global-')))
  const path = join(dir, EXPORT_FILE)
  await writePrivateOutput(path, text)
  const bytes = Buffer.byteLength(text)
  // about 4 bytes a token, as orangu estimate counts
  return { dir, export: { path, bytes, approxTokens: Math.ceil(bytes / 4) } }
}
