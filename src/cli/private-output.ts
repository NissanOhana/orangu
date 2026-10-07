/** Descriptor-backed writer for CLI artifacts that can contain private session data. */
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import { oneLine } from './tty.js'

const PRIVATE_FILE_MODE = 0o600

/**
 * How much of an existing file the writer reads to find the orangu marker. orangu writes its marker in the first
 * few hundred bytes of every output, so the writer never reads a whole file that is not its own.
 */
export const OUTPUT_HEAD_BYTES = 4096

/**
 * The marker of an orangu HTML output: the document opens with doctype, html and head, and the generator meta is
 * among the meta tags that come first in the head, before the title (src/report/render.ts and the show-me templates).
 */
const HTML_MARKER = /^<!doctype html>\s*<html\b[^>]*>\s*<head>(?:\s*<meta\b[^>]*>)*?\s*<meta name="generator" content="orangu [^"<>]*"\/?>/
/**
 * The marker of an orangu JSON output: `schemaVersion` is the first key and holds a string, and the second key is one
 * that orangu writes there (aggregate `generatedAt`, harness and slim `generator`, evidence `source`). A file that only
 * has a `schemaVersion` key, such as a container manifest, is not an orangu output.
 */
const JSON_MARKER = /^\{\s*"schemaVersion"\s*:\s*"[^"\\]*"\s*,\s*"(?:generatedAt|generator|source)"\s*:/

/** True when `head`, the start of a file, carries the marker that orangu writes at the start of each output. */
export function isOranguOutput(head: string): boolean {
  return HTML_MARKER.test(head) || JSON_MARKER.test(head)
}

export class PrivateOutputError extends Error {
  override readonly name = 'PrivateOutputError'
}

function sameInode(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

function assertSafeOutput(stat: BigIntStats, path: string): void {
  if (!stat.isFile()) throw new PrivateOutputError(`private output target must be a regular file: ${path}`)
  // A second hard link would let the output overwrite or disclose bytes through another path.
  if (stat.nlink !== 1n) throw new PrivateOutputError(`private output target must not have multiple hard links: ${path}`)
}

async function assertPathStillNamesHandle(path: string, opened: BigIntStats): Promise<void> {
  const current = await lstat(path, { bigint: true })
  if (current.isSymbolicLink() || !current.isFile() || !sameInode(current, opened)) {
    throw new PrivateOutputError(`private output target changed during access: ${path}`)
  }
}

/**
 * Replace only a file that orangu wrote. A pre-approved orangu command can reach this writer with a path that a
 * steered model chose (`-o ~/.zshrc`), so the writer reads a bounded head through the same descriptor and stops
 * before it changes a byte or a mode bit. There is no flag to force it: a steered model could add that flag too.
 */
async function assertOranguOutput(handle: FileHandle, path: string): Promise<void> {
  const buffer = Buffer.alloc(OUTPUT_HEAD_BYTES)
  const { bytesRead } = await handle.read(buffer, 0, OUTPUT_HEAD_BYTES, 0)
  if (isOranguOutput(buffer.subarray(0, bytesRead).toString('utf8'))) return
  throw new PrivateOutputError(
    `${oneLine(path)} is not an orangu output, so orangu did not change it. Choose a new path, or delete the file by hand and run the command again.`,
  )
}

async function openOutput(path: string): Promise<{ handle: FileHandle; created: boolean }> {
  const baseFlags = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  try {
    return { handle: await open(path, baseFlags | constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, PRIVATE_FILE_MODE), created: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  try {
    // Do not truncate until the already-open inode has passed every safety check. Read and write, because the
    // writer reads the head of the existing file through this descriptor before it replaces anything.
    return { handle: await open(path, baseFlags | constants.O_RDWR), created: false }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new PrivateOutputError(`private output target must not be a symbolic link: ${path}`)
    }
    throw error
  }
}

/**
 * Create a private regular output file, or replace one that orangu wrote, through one verified descriptor.
 * Existing orangu outputs are supported for `watch` and for a run again on the same path; symlinks, hard links and
 * every file without the orangu marker are rejected.
 */
export async function writePrivateOutput(path: string, data: string | Uint8Array): Promise<void> {
  const outputPath = resolve(path)
  try {
    const { handle, created } = await openOutput(outputPath)
    try {
      const opened = await handle.stat({ bigint: true })
      assertSafeOutput(opened, outputPath)
      await assertPathStillNamesHandle(outputPath, opened)
      if (!created) await assertOranguOutput(handle, outputPath)

      // Tighten an existing permissive file before any private bytes are written.
      if (process.platform !== 'win32') await handle.chmod(PRIVATE_FILE_MODE)
      const secured = await handle.stat({ bigint: true })
      assertSafeOutput(secured, outputPath)
      if (process.platform !== 'win32' && Number(secured.mode & 0o777n) !== PRIVATE_FILE_MODE) {
        throw new PrivateOutputError(`private output permissions could not be secured: ${outputPath}`)
      }
      await assertPathStillNamesHandle(outputPath, secured)

      await handle.truncate(0)
      await handle.writeFile(data)

      const written = await handle.stat({ bigint: true })
      assertSafeOutput(written, outputPath)
      await assertPathStillNamesHandle(outputPath, written)
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof PrivateOutputError) throw error
    throw new PrivateOutputError(`private output could not be written safely: ${outputPath}`)
  }
}
