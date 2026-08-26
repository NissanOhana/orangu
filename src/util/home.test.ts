import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { oranguHome } from './home.js'

describe('oranguHome', () => {
  it('prefers $ORANGU_HOME', () => {
    expect(oranguHome({ ORANGU_HOME: '/x/orangu', XDG_DATA_HOME: '/y' })).toBe('/x/orangu')
  })
  it('then $XDG_DATA_HOME/orangu', () => {
    expect(oranguHome({ XDG_DATA_HOME: '/y/data' })).toBe(join('/y/data', 'orangu'))
  })
  it('falls back to ~/.orangu and ignores empty values', () => {
    expect(oranguHome({ ORANGU_HOME: '', XDG_DATA_HOME: '' })).toBe(join(homedir(), '.orangu'))
    expect(oranguHome({})).toBe(join(homedir(), '.orangu'))
  })
})
