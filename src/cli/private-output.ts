/** Descriptor-backed writer for CLI artifacts that can contain private session data. */
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'

const PRIVATE_FILE_MODE = 0o600

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

async function openOutput(path: string): Promise<FileHandle> {
  const baseFlags = constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  try {
    return await open(path, baseFlags | constants.O_CREAT | constants.O_EXCL, PRIVATE_FILE_MODE)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  try {
    // Do not truncate until the already-open inode has passed every safety check.
    return await open(path, baseFlags)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new PrivateOutputError(`private output target must not be a symbolic link: ${path}`)
    }
    throw error
  }
}

/**
 * Create or replace a private regular output file through one verified descriptor.
 * Existing regular files are supported for `watch`; symlinks and hard links are rejected.
 */
export async function writePrivateOutput(path: string, data: string | Uint8Array): Promise<void> {
  const outputPath = resolve(path)
  try {
    const handle = await openOutput(outputPath)
    try {
      const opened = await handle.stat({ bigint: true })
      assertSafeOutput(opened, outputPath)
      await assertPathStillNamesHandle(outputPath, opened)

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
