/**
 * `orangu show-me --render <dir>`: the deterministic step that writes the 2 HTML files of a show-me run.
 *
 * 1. The directory resolves (after realpath) to a run directory directly under the show-me base, and it holds a
 *    data.json (confined paths).
 * 2. words.json holds exactly 3 strings (src/show-me/words.ts). data.json passes its shape again
 *    (src/show-me/data.ts). Each file is read through one bounded, no-symlink read.
 * 3. Both templates come from the generated module, from a fixed list. No input names a template path.
 * 4. Each filled file passes the self-check (src/show-me/check.ts).
 * 5. Only then are both files written, at mode 0600, through src/cli/private-output.ts. A failure at any step
 *    writes nothing.
 * The STE findings on the 3 word slots come back with the paths. They are advisory: they never refuse a render.
 */
import { randomBytes } from 'node:crypto'
import { lstat, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writePrivateOutput } from '../cli/private-output.js'
import { MAX_EVIDENCE_ARTIFACT_BYTES } from '../suggest/evidence.js'
import { oranguHome } from '../util/home.js'
import { readStableTextFile } from '../util/stable-file.js'
import { selfCheck } from './check.js'
import { validateShowMeData } from './data.js'
import { fillTemplate } from './fill.js'
import { REPORT_HTML, SLIDES_HTML } from './generated/templates.js'
import { aggregatePage, sessionPage } from './pages.js'
import { ShowMeInputError, validateWords, wordFindings, type WordFinding } from './words.js'

/** The 2 files of a run, from the generated module only: the list is fixed, and no flag or data key picks one. */
export const TEMPLATES: ReadonlyArray<{ readonly file: 'slides.html' | 'report.html'; readonly html: string }> = Object.freeze([
  Object.freeze({ file: 'slides.html', html: SLIDES_HTML }),
  Object.freeze({ file: 'report.html', html: REPORT_HTML }),
])

/** Where every show-me run directory lives: `<orangu home>/show-me` (ORANGU_HOME, then XDG_DATA_HOME). */
export const showMeBase = (): string => join(oranguHome(), 'show-me')

export interface RenderResult {
  dir: string
  slides: string
  report: string
  findings: WordFinding[]
}

/** A path, an input or a write that the render refuses. The message names the rule and never quotes the input. */
export class ShowMeRenderError extends Error {
  override readonly name = 'ShowMeRenderError'
}

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code

/**
 * The run directory, confined: its real path is a directory directly under the real show-me base, and it holds a
 * data.json. A path outside the base, the base itself, a deeper folder and a link that leaves the base all fail.
 */
export async function confinedRunDir(dir: string, base = showMeBase()): Promise<string> {
  let realBase: string
  try {
    realBase = await realpath(base)
  } catch {
    throw new ShowMeRenderError('orangu has no show-me run directory yet. Run orangu show-me first, then render its directory.')
  }
  let real: string
  try {
    real = await realpath(dir)
  } catch {
    throw new ShowMeRenderError('the --render directory does not exist.')
  }
  if (dirname(real) !== realBase) throw new ShowMeRenderError('the --render directory must be a run directory that orangu show-me made in the show-me folder of the orangu home.')
  if (!(await lstat(real)).isDirectory()) throw new ShowMeRenderError('the --render path must be a directory.')
  try {
    const data = await lstat(join(real, 'data.json'))
    if (!data.isFile()) throw new ShowMeRenderError('data.json in the run directory must be a regular file.')
  } catch (error) {
    if (error instanceof ShowMeRenderError) throw error
    throw new ShowMeRenderError('the run directory has no data.json. Run orangu show-me to make one.')
  }
  return real
}

/** One input file of the run: a regular file, no link, at most MAX_EVIDENCE_ARTIFACT_BYTES, then JSON. */
async function readJson(dir: string, name: 'words.json' | 'data.json'): Promise<unknown> {
  let text: string
  try {
    text = await readStableTextFile(join(dir, name), MAX_EVIDENCE_ARTIFACT_BYTES, name)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.includes('not found')) throw new ShowMeInputError(`the run directory has no ${name}.${name === 'words.json' ? ' Write the 3 words first.' : ''}`)
    if (message.includes('exceeds')) throw new ShowMeInputError(`${name} has more than ${MAX_EVIDENCE_ARTIFACT_BYTES} bytes, the most that orangu show-me reads.`)
    if (message.includes('symbolic link') || message.includes('regular file')) throw new ShowMeInputError(`${name} must be a regular file, not a link.`)
    throw new ShowMeInputError(`orangu show-me cannot read ${name}.`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ShowMeInputError(`${name} is not valid JSON.`)
  }
}

/**
 * Write both files, or neither. Each goes first to a new name in the run directory through writePrivateOutput (a
 * new file at 0600, no link followed), and the 2 renames come last. A target that is not a regular file stops the
 * write before any rename.
 */
async function writeBoth(dir: string, files: ReadonlyArray<{ file: string; html: string }>): Promise<void> {
  const staged: Array<{ from: string; to: string }> = []
  try {
    for (const { file } of files) {
      const to = join(dir, file)
      try {
        const existing = await lstat(to)
        if (!existing.isFile()) throw new ShowMeRenderError(`${file} in the run directory is not a regular file.`)
      } catch (error) {
        if (error instanceof ShowMeRenderError) throw error
        if (code(error) !== 'ENOENT') throw error
      }
    }
    for (const { file, html } of files) {
      const from = join(dir, `.${file}.${randomBytes(6).toString('hex')}.tmp`)
      staged.push({ from, to: join(dir, file) })
      await writePrivateOutput(from, html)
    }
    for (const { from, to } of staged) await rename(from, to)
  } catch (error) {
    await Promise.all(staged.map(({ from }) => rm(from, { force: true })))
    if (error instanceof ShowMeRenderError) throw error
    throw new ShowMeRenderError('orangu show-me could not write the 2 files.')
  }
}

/** Render the run directory `dir`: validate, fill, check, then write both files. */
export async function renderShowMe(dir: string, o: { base?: string } = {}): Promise<RenderResult> {
  const run = await confinedRunDir(dir, o.base)
  const words = validateWords(await readJson(run, 'words.json'))
  const data = validateShowMeData(await readJson(run, 'data.json'))
  const page = data.kind === 'session' ? sessionPage(data.value, words) : aggregatePage(data.value, data.scope, { ...(data.folder !== undefined ? { folder: data.folder } : {}), version: data.version, words })
  const files = TEMPLATES.map(({ file, html: template }) => {
    const html = fillTemplate(template, page)
    selfCheck(html, template, file)
    return { file, html }
  })
  await writeBoth(run, files)
  return { dir: run, slides: join(run, 'slides.html'), report: join(run, 'report.html'), findings: wordFindings(words) }
}
