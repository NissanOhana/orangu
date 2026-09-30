/**
 * Workspace identity for reviewed proposals.
 *
 * A proposal is bound to the directory it was reviewed in: its canonical path, its inode, and, where the
 * filesystem reports a real one, its creation time. The device number is recorded too, but it is not stable:
 * the OS renumbers volumes across restarts and remounts (macOS does on most boots), and it reuses a number for
 * another volume, so a device change alone is not a different workspace. Two exceptions keep the device
 * strict: a mount root, whose inode is the same on every volume, and Windows, where the volume serial does
 * not change. The creation time is what tells apart two volumes mounted in turn at one path, which can both
 * hold a directory with the same inode.
 */
import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import type { SuggestionWorkspaceIdentity } from './types.js'

export interface LiveWorkspaceIdentity extends SuggestionWorkspaceIdentity {
  /** the directory is a filesystem root or the root of a mounted volume */
  mountRoot: boolean
}

/**
 * A creation time worth recording. A filesystem without one reports zero or repeats the change time, and the
 * change time moves whenever an entry is added, so neither may become part of an identity.
 */
export function reliableBirthtimeNs(birthtimeNs: bigint, ctimeNs: bigint): string | undefined {
  return birthtimeNs > 0n && birthtimeNs !== ctimeNs ? String(birthtimeNs) : undefined
}

export async function liveWorkspaceIdentity(path: string): Promise<LiveWorkspaceIdentity> {
  const cwd = await realpath(path)
  const info = await stat(cwd, { bigint: true })
  if (!info.isDirectory()) throw new Error(`workspace is not a directory: ${cwd}`)
  const parent = dirname(cwd)
  const mountRoot = parent === cwd || (await stat(parent, { bigint: true })).dev !== info.dev
  const birthtimeNs = reliableBirthtimeNs(info.birthtimeNs, info.ctimeNs)
  return { cwd, device: String(info.dev), inode: String(info.ino), ...(birthtimeNs ? { birthtimeNs } : {}), mountRoot }
}

/** The fields persisted with a reviewed proposal, and nothing else. */
export function storedWorkspaceIdentity(live: LiveWorkspaceIdentity): SuggestionWorkspaceIdentity {
  const { cwd, device, inode, birthtimeNs } = live
  return { cwd, device, inode, ...(birthtimeNs ? { birthtimeNs } : {}) }
}

const DIGITS_RE = /^\d+$/

export function isStoredWorkspaceIdentity(value: unknown): value is SuggestionWorkspaceIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const identity = value as Partial<Record<keyof SuggestionWorkspaceIdentity, unknown>>
  return (
    typeof identity.cwd === 'string' &&
    isAbsolute(identity.cwd) &&
    typeof identity.device === 'string' &&
    DIGITS_RE.test(identity.device) &&
    typeof identity.inode === 'string' &&
    DIGITS_RE.test(identity.inode) &&
    (identity.birthtimeNs === undefined || (typeof identity.birthtimeNs === 'string' && DIGITS_RE.test(identity.birthtimeNs)))
  )
}

export function sameWorkspace(
  stored: SuggestionWorkspaceIdentity,
  live: LiveWorkspaceIdentity,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (live.cwd !== stored.cwd || live.inode !== stored.inode) return false
  // Records written before the creation time was captured carry none and keep the path-and-inode rule.
  if (stored.birthtimeNs !== undefined && stored.birthtimeNs !== live.birthtimeNs) return false
  if (live.device === stored.device) return true
  return platform !== 'win32' && !live.mountRoot
}
