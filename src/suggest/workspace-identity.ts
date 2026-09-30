/**
 * Workspace identity for reviewed proposals.
 *
 * A proposal is bound to the directory it was reviewed in: its canonical path and its inode. The device
 * number is recorded too, but it is not stable: the OS renumbers volumes across restarts and remounts
 * (macOS does on most boots), so a device change alone is not a different workspace. The exception is a
 * mount root, whose inode is the same on every volume; there the device is what tells two volumes apart.
 */
import { realpath, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SuggestionWorkspaceIdentity } from './types.js'

export interface LiveWorkspaceIdentity extends SuggestionWorkspaceIdentity {
  /** the directory is a filesystem root or the root of a mounted volume */
  mountRoot: boolean
}

export async function liveWorkspaceIdentity(path: string): Promise<LiveWorkspaceIdentity> {
  const cwd = await realpath(path)
  const info = await stat(cwd, { bigint: true })
  if (!info.isDirectory()) throw new Error(`workspace is not a directory: ${cwd}`)
  const parent = dirname(cwd)
  const mountRoot = parent === cwd || (await stat(parent, { bigint: true })).dev !== info.dev
  return { cwd, device: String(info.dev), inode: String(info.ino), mountRoot }
}

export function sameWorkspace(stored: SuggestionWorkspaceIdentity, live: LiveWorkspaceIdentity): boolean {
  if (live.cwd !== stored.cwd || live.inode !== stored.inode) return false
  return live.device === stored.device || !live.mountRoot
}
