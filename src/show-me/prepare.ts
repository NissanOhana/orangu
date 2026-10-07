/**
 * `orangu show-me` (prepare): a new run directory under the show-me base, and data.json in it.
 *
 * The directory is `<orangu home>/show-me/<scope>-<name>-<random>/`, mode 0700 (mkdtemp), so a second run never
 * writes into the first. data.json is the redacted orangu data that the model reads to write its 3 words, and
 * that the render reads again. It is written at 0600 through src/cli/private-output.ts.
 */
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { writePrivateOutput } from '../cli/private-output.js'
import { ESTIMATE_TOKEN_THRESHOLD } from '../suggest/types.js'
import { showMeBase } from './render.js'

export type ShowMeScope = 'session' | 'repo' | 'global'

export interface PreparedRun {
  dir: string
  data: { path: string; bytes: number; approxTokens: number; overThreshold: boolean }
}

/** A part of a directory name: letters, digits, dot, dash and underscore only. A file-name bound, not a text cap. */
const MAX_NAME_CHARS = 64
export function runName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|-+$/g, '').slice(0, MAX_NAME_CHARS)
  return safe || 'run'
}

/** Make the run directory and write data.json. `json` is the exact text of data.json. */
export async function prepareRun(scope: ShowMeScope, name: string, json: string, o: { base?: string } = {}): Promise<PreparedRun> {
  const base = o.base ?? showMeBase()
  await mkdir(base, { recursive: true, mode: 0o700 })
  // the real path, as the render prints it, so both steps name the directory the same way
  const dir = await realpath(await mkdtemp(join(base, `${scope}-${runName(name)}-`)))
  const path = join(dir, 'data.json')
  await writePrivateOutput(path, json)
  const bytes = Buffer.byteLength(json)
  // about 4 bytes a token, as orangu estimate counts
  const approxTokens = Math.ceil(bytes / 4)
  return { dir, data: { path, bytes, approxTokens, overThreshold: approxTokens > ESTIMATE_TOKEN_THRESHOLD } }
}
