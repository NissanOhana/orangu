import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isStoredWorkspaceIdentity,
  liveWorkspaceIdentity,
  reliableBirthtimeNs,
  sameWorkspace,
  storedWorkspaceIdentity,
  type LiveWorkspaceIdentity,
} from './workspace-identity.js'

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

describe('sameWorkspace: creation time and platform', () => {
  const born = { ...stored, birthtimeNs: '1755000000000000000' }

  it('requires the recorded creation time, which a different volume at the same path cannot share', () => {
    expect(sameWorkspace(born, live({ birthtimeNs: born.birthtimeNs, device: '16777229' }))).toBe(true)
    // Two volumes mounted in turn at one path can both hold a directory with the same inode.
    expect(sameWorkspace(born, live({ birthtimeNs: '1756000000000000000', device: '16777229' }))).toBe(false)
    expect(sameWorkspace(born, live({ birthtimeNs: '1756000000000000000' }))).toBe(false)
    expect(sameWorkspace(born, live({ device: '16777229' }))).toBe(false)
  })

  it('keeps the earlier rule for a record that stored no creation time', () => {
    expect(sameWorkspace(stored, live({ birthtimeNs: '1756000000000000000', device: '16777229' }))).toBe(true)
  })

  it('stays strict about the device on Windows, where the volume serial does not change', () => {
    expect(sameWorkspace(stored, live({ device: '16777229' }), 'win32')).toBe(false)
    expect(sameWorkspace(stored, live(), 'win32')).toBe(true)
  })
})

describe('reliableBirthtimeNs', () => {
  it('keeps a real creation time and drops the values a filesystem reports when it has none', () => {
    expect(reliableBirthtimeNs(1_000n, 2_000n)).toBe('1000')
    expect(reliableBirthtimeNs(0n, 2_000n)).toBeUndefined() // not reported
    expect(reliableBirthtimeNs(2_000n, 2_000n)).toBeUndefined() // the change time standing in for it, which moves
  })
})

describe('stored identities', () => {
  it('persists only the identity fields', () => {
    expect(storedWorkspaceIdentity(live({ birthtimeNs: '5' }))).toEqual({ ...stored, birthtimeNs: '5' })
    expect(storedWorkspaceIdentity(live())).toEqual(stored)
  })

  it('validates the stored shape', () => {
    expect(isStoredWorkspaceIdentity(stored)).toBe(true)
    expect(isStoredWorkspaceIdentity({ ...stored, birthtimeNs: '5' })).toBe(true)
    for (const bad of [null, {}, { ...stored, cwd: 'relative' }, { ...stored, device: 'x' }, { ...stored, inode: '' }, { ...stored, birthtimeNs: 'soon' }, { ...stored, birthtimeNs: 5 }]) {
      expect(isStoredWorkspaceIdentity(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('liveWorkspaceIdentity', () => {
  it('reads the canonical path, device, inode, and creation time of a directory', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orangu-ws-id-')))
    const st = statSync(dir, { bigint: true })
    const identity = await liveWorkspaceIdentity(dir)
    expect(identity).toMatchObject({ cwd: dir, device: String(st.dev), inode: String(st.ino), mountRoot: false })
    expect(identity.birthtimeNs).toBe(reliableBirthtimeNs(st.birthtimeNs, st.ctimeNs))
  })

  const mountPoint = process.platform === 'darwin' ? '/System/Volumes/VM' : process.platform === 'linux' ? '/proc' : undefined
  it.skipIf(!mountPoint || !existsSync(mountPoint))('sees the root of a mounted volume', async () => {
    expect((await liveWorkspaceIdentity(mountPoint!)).mountRoot).toBe(true)
  })

  it('treats the filesystem root as a mount root and refuses a path that is not a directory', async () => {
    expect((await liveWorkspaceIdentity('/')).mountRoot).toBe(true)
    const file = join(mkdtempSync(join(tmpdir(), 'orangu-ws-id-')), 'file.txt')
    writeFileSync(file, 'x')
    await expect(liveWorkspaceIdentity(file)).rejects.toThrow(/not a directory/)
  })
})
