import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildCanonicalSession } from '../../../test/fixtures/session-builder.js'

const CLI = join(process.cwd(), 'dist', 'orangu.js')
const helpHasEvidence = (): boolean => {
  try {
    return execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).includes('orangu evidence')
  } catch {
    return false
  }
}

describe.skipIf(!existsSync(CLI) || !helpHasEvidence())('orangu evidence (built CLI)', () => {
  it('runs on a JSONL fixture with outbound network blocked and creates no suggestion state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orangu-evidence-e2e-'))
    const transcript = join(dir, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl')
    const preload = join(dir, 'block-network.mjs')
    const attemptsPath = join(dir, 'network-attempts.txt')
    const stateDir = join(dir, 'orangu-state')
    await writeFile(transcript, buildCanonicalSession().toJsonl())
    await writeFile(
      preload,
      `import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import dgram from 'node:dgram'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const marker = ${JSON.stringify(attemptsPath)}
const blocked = name => () => { appendFileSync(marker, name + '\\n'); throw new Error('OUTBOUND_NETWORK:' + name) }
globalThis.fetch = blocked('fetch')
for (const [owner, names] of [
  [http, ['get', 'request']], [https, ['get', 'request']], [http2, ['connect']],
  [net, ['connect', 'createConnection']], [tls, ['connect']],
  [dns, ['lookup', 'resolve', 'resolve4', 'resolve6']],
  [dnsPromises, ['lookup', 'resolve', 'resolve4', 'resolve6']], [dgram, ['createSocket']],
]) for (const name of names) owner[name] = blocked(name)
syncBuiltinESMExports()
`,
    )

    const result = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(preload).href, CLI, 'evidence', transcript, '--quiet'],
      { encoding: 'utf8', env: { ...process.env, ORANGU_HOME: stateDir } },
    )
    const attempts = existsSync(attemptsPath) ? readFileSync(attemptsPath, 'utf8') : ''
    expect(attempts, `outbound attempts:\n${attempts}`).toBe('')
    expect(result.status, result.stderr).toBe(0)
    const bundle = JSON.parse(result.stdout)
    expect(bundle.source).toMatchObject({ kind: 'analysis', scope: 'session' })
    expect(bundle.findings[0]?.suggestionId).toMatch(/^sg_[0-9a-f]{12}$/)
    expect(bundle.findings[0]?.findingToken).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(existsSync(join(stateDir, 'suggestions.jsonl'))).toBe(false)
  })
})
