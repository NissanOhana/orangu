import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { prepareRun, runName } from './prepare.js'
import { showMeBase } from './render.js'

describe('show-me prepare: the run directory', () => {
  it('makes a new 0700 directory <scope>-<name>-<random> under the base, with data.json at 0600', async () => {
    const base = join(realpathSync(mkdtempSync(join(tmpdir(), 'orangu-show-me-prepare-'))), 'show-me')
    const json = `${JSON.stringify({ slim: true, a: 'x'.repeat(30_000) }, null, 2)}\n`
    const first = await prepareRun('session', 'aaaaaaaa', json, { base })
    const second = await prepareRun('session', 'aaaaaaaa', json, { base })
    expect(first.dir).not.toBe(second.dir)
    for (const run of [first, second]) {
      expect(dirname(run.dir)).toBe(base)
      expect(basename(run.dir)).toMatch(/^session-aaaaaaaa-[A-Za-z0-9]{6}$/)
      expect(run.data.path).toBe(join(run.dir, 'data.json'))
      expect(readFileSync(run.data.path, 'utf8')).toBe(json)
      if (process.platform !== 'win32') {
        expect(statSync(run.dir).mode & 0o777).toBe(0o700)
        expect(statSync(run.data.path).mode & 0o777).toBe(0o600)
      }
    }
    // the size in bytes and about tokens, 4 bytes a token as orangu estimate counts
    expect(first.data.bytes).toBe(Buffer.byteLength(json))
    expect(first.data.approxTokens).toBe(Math.ceil(Buffer.byteLength(json) / 4))
    expect(first.data.overThreshold).toBe(true)
    expect((await prepareRun('global', 'machine', '{}\n', { base })).data).toMatchObject({ bytes: 3, approxTokens: 1, overThreshold: false })
  })

  it('keeps a directory name to letters, digits, dot, dash and underscore', () => {
    expect(runName('my repo (2)')).toBe('my-repo-2')
    expect(runName('../../etc')).toBe('etc')
    expect(runName('\u001b]0;x\u0007')).toBe('0-x')
    expect(runName('...')).toBe('run')
    expect(runName('a'.repeat(300))).toHaveLength(64)
  })

  it('lives under the orangu home: ORANGU_HOME, then XDG_DATA_HOME', () => {
    const before = { home: process.env['ORANGU_HOME'], xdg: process.env['XDG_DATA_HOME'] }
    try {
      delete process.env['ORANGU_HOME']
      process.env['XDG_DATA_HOME'] = '/x/data'
      expect(showMeBase()).toBe(join('/x/data', 'orangu', 'show-me'))
      process.env['ORANGU_HOME'] = '/y/orangu'
      expect(showMeBase()).toBe(join('/y/orangu', 'show-me'))
    } finally {
      if (before.home === undefined) delete process.env['ORANGU_HOME']
      else process.env['ORANGU_HOME'] = before.home
      if (before.xdg === undefined) delete process.env['XDG_DATA_HOME']
      else process.env['XDG_DATA_HOME'] = before.xdg
    }
  })
})
