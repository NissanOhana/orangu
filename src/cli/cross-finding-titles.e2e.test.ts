/**
 * `orangu global` / `orangu repo` print the aggregate's cross-findings verbatim (printAggregate in
 * src/cli/main.ts). Those titles used to be the rule's title with every number replaced by N, so a person
 * read "N tool results over N KB". Against the BUILT CLI: every recurring-finding line carries real figures
 * from an example session and the "(N sessions)" count that follows it.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFixtureHome } from '../../test/fixtures/home.js'

const CLI = join(process.cwd(), 'dist', 'orangu.js')
// hermetic: claudeRoots() appends ~/.claude after an explicit --root, so HOME must point at the fixture too
const run = (args: string[], home: string) =>
  execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, ORANGU_NO_CACHE: '1', ORANGU_HOME: join(home, '.orangu'), ORANGU_CLAUDE_ROOTS: '', CLAUDE_CONFIG_DIR: '' },
  })

describe.skipIf(!existsSync(CLI))('orangu global: recurring-finding titles (built CLI)', () => {
  it('prints an example session title with its real figures, never a template N', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orangu-cli-cross-titles-'))
    const fx = await makeFixtureHome(join(home, '.claude'))
    const out = run(['global', '--root', fx.configDir, '--jobs', '1', '--no-cache', '--quiet'], home)
    expect(out).toMatch(/^ {2}\d sessions$/m)
    const block = /recurring findings \(across sessions\)\n([\s\S]*?)\n\n/.exec(out)
    expect(block, 'recurring findings block').not.toBeNull()
    const lines = block![1]!.split('\n').filter((l) => l.trim())
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).not.toMatch(/\bN\b/)
      expect(line).toMatch(/ {2}e\.g\. \S.*\(\d+ sessions?\)$/)
    }
  })
})
