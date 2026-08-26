import { describe, expect, it } from 'vitest'
import { mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prevalidateStableTextFile, readStableTextFile, readStableTextManifest } from './stable-file.js'

describe('stable text artifact reader', () => {
  it('reads a regular file within the cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orangu-stable-'))
    const path = join(root, 'evidence.json')
    writeFileSync(path, '{"ok":true}')
    await expect(readStableTextFile(path, 64, 'evidence JSON')).resolves.toBe('{"ok":true}')
  })

  it('rejects symlinks, oversized files, and replacement after prevalidation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orangu-stable-'))
    const path = join(root, 'evidence.json')
    const outside = join(root, 'outside.json')
    writeFileSync(path, '{"first":true}')
    writeFileSync(outside, '{"replacement":true}')
    await expect(readStableTextFile(path, 4, 'evidence JSON')).rejects.toThrow(/exceeds/)

    const manifest = await prevalidateStableTextFile(path, 64, 'evidence JSON')
    unlinkSync(path)
    symlinkSync(outside, path)
    await expect(readStableTextManifest(manifest)).rejects.toThrow(/changed/)
    await expect(readStableTextFile(path, 64, 'evidence JSON')).rejects.toThrow(/symbolic link/)
  })
})
