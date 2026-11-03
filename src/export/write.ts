/**
 * The run directory of `orangu export`: `<orangu home>/export/global-<random>/`, mode 0700 (mkdtemp), so a second run
 * never writes into the first. orangu-export.json and orangu-improve.zip go in it at 0600 through
 * src/cli/private-output.ts. Each name in the directory is new, so the writer never replaces a file.
 *
 * orangu-improve.zip is the portable skill that reads the export in a Claude chat outside Claude Code. The build checks
 * its files and writes them into src/export/generated/portable-skill.ts (scripts/build.mjs). The zip holds no data of the
 * user, so each run of 1 build writes the same bytes.
 *
 * A write that fails stops the run. The run directory then keeps only the files that orangu wrote before the failure.
 */
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { writePrivateOutput } from '../cli/private-output.js'
import { oranguHome } from '../util/home.js'
import { PORTABLE_SKILL_ENTRIES } from './generated/portable-skill.js'
import { storedZip } from './zip.js'

/** The name of the export file in each run directory. */
export const EXPORT_FILE = 'orangu-export.json'
/** The name of the portable skill in each run directory: the zip that the user uploads once as a custom skill. */
export const SKILL_ZIP_FILE = 'orangu-improve.zip'

/** Where each export run directory lives: `<orangu home>/export` (ORANGU_HOME, then XDG_DATA_HOME). */
export const exportBase = (): string => join(oranguHome(), 'export')

/** The bytes of orangu-improve.zip: a stored zip of the portable skill of this build. */
export const portableSkillZip = (): Uint8Array => storedZip(PORTABLE_SKILL_ENTRIES)

export interface ExportRun {
  dir: string
  export: { path: string; bytes: number; approxTokens: number }
  skill: { path: string; bytes: number }
}

/** Make a new run directory and write orangu-export.json and orangu-improve.zip in it. `text` is the exact text of the export. */
export async function writeExportRun(text: string, o: { base?: string } = {}): Promise<ExportRun> {
  const base = o.base ?? exportBase()
  await mkdir(base, { recursive: true, mode: 0o700 })
  // the real path, so that the printed directory and the file paths name the same folder
  const dir = await realpath(await mkdtemp(join(base, 'global-')))
  const path = join(dir, EXPORT_FILE)
  await writePrivateOutput(path, text)
  const zip = portableSkillZip()
  const skill = join(dir, SKILL_ZIP_FILE)
  await writePrivateOutput(skill, zip)
  const bytes = Buffer.byteLength(text)
  // about 4 bytes a token, as orangu estimate counts
  return { dir, export: { path, bytes, approxTokens: Math.ceil(bytes / 4) }, skill: { path: skill, bytes: zip.length } }
}
