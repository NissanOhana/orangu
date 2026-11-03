import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { exportBase, portableSkillZip, writeExportRun } from './write.js'

describe('export run directory', () => {
  it('makes a new 0700 directory global-<random> under the base for each run, with orangu-export.json and orangu-improve.zip at 0600', async () => {
    const base = join(realpathSync(mkdtempSync(join(tmpdir(), 'orangu-export-write-'))), 'export')
    const text = '{\n"summary":{"v":1}\n}\n'
    const first = await writeExportRun(text, { base })
    const second = await writeExportRun(text, { base })
    expect(first.dir).not.toBe(second.dir)
    const zip = Buffer.from(portableSkillZip())
    for (const run of [first, second]) {
      expect(dirname(run.dir)).toBe(base)
      expect(basename(run.dir)).toMatch(/^global-[A-Za-z0-9]{6}$/)
      expect(readdirSync(run.dir)).toEqual(['orangu-export.json', 'orangu-improve.zip'])
      expect(run.export.path).toBe(join(run.dir, 'orangu-export.json'))
      expect(readFileSync(run.export.path, 'utf8')).toBe(text)
      expect(run.export).toEqual({ path: run.export.path, bytes: 22, approxTokens: 6 })
      expect(run.skill).toEqual({ path: join(run.dir, 'orangu-improve.zip'), bytes: zip.length })
      expect(readFileSync(run.skill.path).equals(zip), 'the portable skill, byte for byte').toBe(true)
      if (process.platform !== 'win32') {
        expect(statSync(run.dir).mode & 0o777).toBe(0o700)
        expect(statSync(run.export.path).mode & 0o777).toBe(0o600)
        expect(statSync(run.skill.path).mode & 0o777).toBe(0o600)
      }
    }
  })

  it('lives under the orangu home: ORANGU_HOME, then XDG_DATA_HOME', () => {
    const before = { home: process.env['ORANGU_HOME'], xdg: process.env['XDG_DATA_HOME'] }
    try {
      delete process.env['ORANGU_HOME']
      process.env['XDG_DATA_HOME'] = '/x/data'
      expect(exportBase()).toBe(join('/x/data', 'orangu', 'export'))
      process.env['ORANGU_HOME'] = '/y/orangu'
      expect(exportBase()).toBe(join('/y/orangu', 'export'))
    } finally {
      if (before.home === undefined) delete process.env['ORANGU_HOME']
      else process.env['ORANGU_HOME'] = before.home
      if (before.xdg === undefined) delete process.env['XDG_DATA_HOME']
      else process.env['XDG_DATA_HOME'] = before.xdg
    }
  })
})
