/**
 * `orangu global` / `orangu repo` print the aggregate's cross-findings (aggregateBlock in
 * src/cli/summary.ts). Those titles used to be the rule's title with every number replaced by N, so a person
 * read "N tool results over N KB". Against the BUILT CLI: every recurring-finding row carries real figures
 * from an example session, under one caption that says so, so they never read as the cross-session total,
 * and the "(N sessions)" count follows each title.
 *
 * The HTML report of the same verbs (`--html <file>`) embeds the aggregate after the default redaction. Each
 * closed repo or global card shows its finding's `recommendation` as the improvement line, so every embedded
 * cross finding must carry that copy, and it must be the copy of the example session the title names.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
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
      expect(line).not.toMatch(/\be\.g\./)
      // the caption is said once, above the rows; then each row head, or a continuation under its title
      expect(line).toMatch(line === lines[0] ? /^ {2}Each title shows the figures of one example session\.$/ : /^ {4} *(~\S+|–) {2}\S|^ {14}\S/)
    }
  })
})

interface EmbeddedFinding { ruleId: string; title: string; recommendation?: string; exampleSessionIds: string[] }
interface SessionInsight { ruleId: string; title: string; recommendation: string }

/** The app data a written report carries: one application/json script (src/report/render.ts). */
function embeddedFindings(html: string, scope: 'repo' | 'global'): EmbeddedFinding[] {
  const data = /<script type="application\/json" id="orangu-data">([\s\S]*?)<\/script>/.exec(html)
  expect(data, 'embedded app data').not.toBeNull()
  const parsed = JSON.parse(data![1]!) as { aggregates: Partial<Record<'repo' | 'global', { crossFindings: EmbeddedFinding[] }>> }
  expect(parsed.aggregates[scope], `aggregates.${scope}`).toBeDefined()
  return parsed.aggregates[scope]!.crossFindings
}

describe.skipIf(!existsSync(CLI))('orangu repo|global --html: the improvement line reaches the written report (built CLI)', () => {
  it.each(['repo', 'global'] as const)('%s --html embeds each cross finding with its example title and the improvement of that session', async (scope) => {
    const home = await mkdtemp(join(tmpdir(), `orangu-cli-improvement-${scope}-`))
    const cwd = join(home, 'project')
    await mkdir(cwd, { recursive: true })
    const fx = await makeFixtureHome(join(home, '.claude'), { cwd })
    const file = join(home, `${scope}.html`)
    run([scope, ...(scope === 'repo' ? [cwd] : []), '--root', fx.configDir, '--jobs', '1', '--no-cache', '--quiet', '--html', file], home)

    const findings = embeddedFindings(readFileSync(file, 'utf8'), scope)
    expect(findings.length).toBeGreaterThan(0)
    // the same session's report, through the same default redaction: what its own card says
    const insights = new Map<string, SessionInsight[]>()
    const insightsOf = (id: string): SessionInsight[] => {
      if (!insights.has(id)) insights.set(id, (JSON.parse(run(['analyze', id, '--root', fx.configDir, '--json', '--no-cache', '--quiet'], home)) as { insights: SessionInsight[] }).insights)
      return insights.get(id)!
    }
    for (const f of findings) {
      expect(f.title, f.ruleId).toMatch(/^In one session: \S/)
      expect(f.recommendation?.trim(), `${f.ruleId}: recommendation`).toBeTruthy()
      const source = f.exampleSessionIds.flatMap(insightsOf).filter((i) => i.ruleId === f.ruleId && `In one session: ${i.title}` === f.title)
      expect(source.map((i) => i.recommendation), `${f.ruleId}: the improvement of the session the title names`).toContain(f.recommendation)
    }
  })
})
