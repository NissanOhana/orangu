import { describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveWorkspaceIdentity, sameWorkspace, type LiveWorkspaceIdentity } from './workspace-identity.js'

const stored = { cwd: '/w/repo', device: '16777234', inode: '722641' }
const live = (over: Partial<LiveWorkspaceIdentity> = {}): LiveWorkspaceIdentity => ({ ...stored, mountRoot: false, ...over })

describe('sameWorkspace', () => {
  it('matches the same path, device, and inode', () => {
    expect(sameWorkspace(stored, live())).toBe(true)
    expect(sameWorkspace(stored, live({ mountRoot: true }))).toBe(true)
  })

  it('tolerates a renumbered device when the path and inode still match', () => {
    // The OS renumbers volumes across restarts and remounts; the directory itself did not change.
    expect(sameWorkspace(stored, live({ device: '16777229' }))).toBe(true)
  })

  it('still needs the device at a mount root, where every volume has the same inode', () => {
    expect(sameWorkspace(stored, live({ device: '16777229', mountRoot: true }))).toBe(false)
  })

  it('never matches another directory or another path', () => {
    expect(sameWorkspace(stored, live({ inode: '722642' }))).toBe(false)
    expect(sameWorkspace(stored, live({ cwd: '/w/other' }))).toBe(false)
    expect(sameWorkspace(stored, live({ inode: '722642', device: '16777229' }))).toBe(false)
  })
})

describe('liveWorkspaceIdentity', () => {
  it('reads the canonical path, device, and inode of a directory', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orangu-ws-id-')))
    const st = statSync(dir, { bigint: true })
    await expect(liveWorkspaceIdentity(dir)).resolves.toEqual({ cwd: dir, device: String(st.dev), inode: String(st.ino), mountRoot: false })
  })

  it('treats the filesystem root as a mount root and refuses a path that is not a directory', async () => {
    expect((await liveWorkspaceIdentity('/')).mountRoot).toBe(true)
    const file = join(mkdtempSync(join(tmpdir(), 'orangu-ws-id-')), 'file.txt')
    writeFileSync(file, 'x')
    await expect(liveWorkspaceIdentity(file)).rejects.toThrow(/not a directory/)
  })
})
