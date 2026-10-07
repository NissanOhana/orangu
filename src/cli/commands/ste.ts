/**
 * `orangu ste <file...|-> [--json] [--lines]`: score text against the STE writing rules (src/ste), offline.
 *
 * A .html or .htm file is scored as HTML. A .md file also scores its frontmatter description. `-` reads
 * stdin as Markdown text. --lines makes each line its own block, for columnar text.
 *
 * It has no pass mark. The sentence limits are the STE standard: they give findings, and a reader decides
 * which finding is real. So the verb exits 0 whenever the check ran, with or without findings, and a caller
 * that wants a gate reads --json. It exits 1 (a thrown Error, through main.ts) on a usage error, an input it
 * cannot read, or an input over MAX_EVIDENCE_ARTIFACT_BYTES. That bound is a resource guard, not a cap on
 * the text. Every input is read before any output, so a failure prints nothing on stdout.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { checkText, type SteResult } from '../../ste/index.js'
import { MAX_EVIDENCE_ARTIFACT_BYTES } from '../../suggest/evidence.js'
import { flagBool } from '../args.js'

export interface SteIo {
  stdin: AsyncIterable<Buffer | string>
  stdout: { write(chunk: string): unknown }
}

const USAGE = 'usage: orangu ste <file...|-> [--json] [--lines]'
const STDIN = '-'
/** the flags this verb reads, plus the 2 output switches that every verb accepts */
const OWN_FLAGS = new Set(['json', 'lines', 'quiet', 'no-color'])

type Checked = { file: string } & SteResult

const overBound = (name: string): Error => new Error(`${name} has more than ${MAX_EVIDENCE_ARTIFACT_BYTES} bytes, the most that orangu ste reads.`)

const cannotRead = (name: string, reason: string): Error => new Error(`orangu ste cannot read ${name}: ${reason}.`)

/** An error from the file system becomes "cannot read", with its cause. Our own errors pass through. */
function readError(name: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (typeof code !== 'string') return error instanceof Error ? error : new Error(String(error))
  if (code === 'ENOENT') return cannotRead(name, 'the file does not exist')
  if (code === 'EACCES' || code === 'EPERM') return cannotRead(name, 'permission denied')
  if (code === 'EISDIR') return cannotRead(name, 'it is a folder, not a file')
  return cannotRead(name, code)
}

/** Collect the bytes of one input, and stop at the first byte over the bound. */
async function readBounded(chunks: AsyncIterable<Buffer | string>, name: string): Promise<string> {
  const parts: Buffer[] = []
  let total = 0
  for await (const chunk of chunks) {
    const part = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += part.length
    if (total > MAX_EVIDENCE_ARTIFACT_BYTES) throw overBound(name)
    parts.push(part)
  }
  return Buffer.concat(parts).toString('utf8')
}

async function readNamedFile(name: string): Promise<string> {
  const path = resolve(name)
  try {
    const info = await stat(path)
    if (info.isDirectory()) throw cannotRead(name, 'it is a folder, not a file')
    if (info.size > MAX_EVIDENCE_ARTIFACT_BYTES) throw overBound(name)
    // The stream stops one byte over the bound (end is inclusive), so a file that grows after stat() still
    // cannot pass it. A pipe or a device has no size, and the same stream bound holds for it.
    return await readBounded(createReadStream(path, { end: MAX_EVIDENCE_ARTIFACT_BYTES }), name)
  } catch (error) {
    throw readError(name, error)
  }
}

function flagName(name: string): string {
  return `${name.length === 1 ? '-' : '--'}${name}`
}

function report(result: Checked): string[] {
  const lines = result.findings.map((finding) => `${result.file}:${finding.line}  ${finding.rule}  "${finding.text}"  ${finding.hint}`)
  lines.push(`${result.file}: ${result.sentences} sentences, ${result.clean} clean, STE score ${result.score}%, ${result.findings.length} findings`)
  return lines
}

export async function cmdSte(positionals: string[], flags: Record<string, string | boolean>, io: SteIo = { stdin: process.stdin, stdout: process.stdout }): Promise<void> {
  for (const name of Object.keys(flags)) {
    if (!OWN_FLAGS.has(name)) throw new Error(`${flagName(name)} is not an orangu ste flag. ${USAGE}`)
  }
  if (positionals.length === 0) throw new Error(`${USAGE}. Give one or more files, or - to read stdin.`)
  if (positionals.filter((name) => name === STDIN).length > 1) throw new Error(`orangu ste reads stdin (-) one time. Give - once. ${USAGE}`)
  const lines = flagBool(flags, 'lines')
  const results: Checked[] = []
  for (const file of positionals) {
    const text = file === STDIN ? await readBounded(io.stdin, file) : await readNamedFile(file)
    results.push({ file, ...checkText(text, { html: /\.html?$/i.test(file), lines, frontmatter: /\.md$/i.test(file) }) })
  }
  const output = flagBool(flags, 'json') ? [JSON.stringify(results, null, 2)] : results.flatMap(report)
  io.stdout.write(`${output.join('\n')}\n`)
}
