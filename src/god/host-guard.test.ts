/**
 * The guard of the host port: what 1 host command passes to the engine. Every command runs with the 5 s timeout,
 * only the commands of the allowlist run, and only the TZ variable goes into the environment of a command.
 */
import { describe, expect, it } from 'vitest'
import { ALLOWED_COMMANDS, HOST_TIMEOUT_MS } from './host.js'
import { RUN_ENV_KEYS, planRun } from './host-guard.js'

describe('the host command guard', () => {
  it('gives every allowed command the 5 s timeout, and its cwd when it has one', () => {
    expect(HOST_TIMEOUT_MS).toBe(5000)
    for (const name of ALLOWED_COMMANDS) expect(planRun([name, '--version'])).toEqual({ ok: true, init: { timeoutMs: 5000 } })
    expect(planRun(['git', 'rev-parse'], { cwd: '/work/api' })).toEqual({ ok: true, init: { timeoutMs: 5000, cwd: '/work/api' } })
  })

  it('passes the TZ variable and refuses a command that asks for any other one', () => {
    expect(RUN_ENV_KEYS).toEqual(['TZ'])
    expect(planRun(['ps', '-o', 'pid='], { env: { TZ: 'UTC' } })).toEqual({ ok: true, init: { timeoutMs: 5000, env: { TZ: 'UTC' } } })
    const refused: Array<Record<string, string>> = [{ PATH: '/tmp' }, { TZ: 'UTC', HOME: '/tmp' }, { tz: 'UTC' }, { DYLD_INSERT_LIBRARIES: 'x' }]
    for (const env of refused) {
      const plan = planRun(['ps'], { env })
      expect(plan.ok, JSON.stringify(env)).toBe(false)
    }
    expect(planRun(['ps'], { env: {} })).toEqual({ ok: true, init: { timeoutMs: 5000 } })
  })

  it('refuses a command that is not on the allowlist by its bare name', () => {
    for (const argv of [['sh', '-c', 'ls'], ['/bin/ps'], ['PS'], [' ps'], ['ps '], [], ['curl', 'x']]) {
      const plan = planRun(argv)
      expect(plan.ok, JSON.stringify(argv)).toBe(false)
      if (!plan.ok) expect(plan.reason).toMatch(/\S/)
    }
  })
})
