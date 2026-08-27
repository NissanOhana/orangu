import { describe, expect, it } from 'vitest'
import { lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { link, mkdir, mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writePrivateOutput } from './private-output.js'

async function tempPath(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'orangu-private-output-')), name)
}

describe('writePrivateOutput', () => {
  it('creates private files and safely rewrites an existing regular file', async () => {
    const path = await tempPath('report.html')
    await writePrivateOutput(path, 'first')
    await writePrivateOutput(path, 'second')

    expect(readFileSync(path, 'utf8')).toBe('second')
    expect(lstatSync(path).isFile()).toBe(true)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('tightens a permissive existing file before replacing its contents', async () => {
    const path = await tempPath('aggregate.json')
    writeFileSync(path, 'old', { mode: 0o644 })

    await writePrivateOutput(path, 'private')

    expect(readFileSync(path, 'utf8')).toBe('private')
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink without changing its target', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orangu-private-output-link-'))
    const outside = join(dir, 'outside.txt')
    const path = join(dir, 'report.html')
    writeFileSync(outside, 'outside')
    await symlink(outside, path)

    await expect(writePrivateOutput(path, 'secret')).rejects.toThrow(/symbolic link|changed during access/)
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('outside')
  })

  it.skipIf(process.platform === 'win32')('rejects multiply-linked files without changing their contents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orangu-private-output-hardlink-'))
    const outside = join(dir, 'outside.txt')
    const path = join(dir, 'report.html')
    writeFileSync(outside, 'outside')
    await link(outside, path)

    await expect(writePrivateOutput(path, 'secret')).rejects.toThrow(/multiple hard links/)
    expect(readFileSync(outside, 'utf8')).toBe('outside')
  })

  it('rejects non-regular targets', async () => {
    const path = await tempPath('directory')
    await mkdir(path)
    await expect(writePrivateOutput(path, 'secret')).rejects.toThrow()
  })
})
