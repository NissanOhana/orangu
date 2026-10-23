import { appendFile, mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServe } from '../../src/serve/server.js'
import type { QueueReadDeps } from '../../src/suggest/queue-read.js'
import type { SuggestionRecord } from '../../src/suggest/types.js'
import { makeFixtureHome } from '../fixtures/home.js'
import { SessionBuilder } from '../fixtures/session-builder.js'
import { APPLIED_AT, appliedOf, frozenOf, proposalOf, recordOf, sg, uuid } from '../fixtures/suggestion-records.js'
import { BROWSER_CAPABILITY } from './app-url.js'

const temp = await mkdtemp(join(tmpdir(), 'orangu-browser-'))
const fixtureRepo = join(temp, 'repo')
await mkdir(fixtureRepo, { recursive: true })
const fixture = await makeFixtureHome(join(temp, 'claude'), { cwd: fixtureRepo })
// a populated harness: the repo declares one skill nobody fired, and the canonical session carries a
// skill_listing attachment, so #harness renders the idle card AND the injected-listings table
await mkdir(join(fixtureRepo, '.claude', 'skills', 'demo-skill'), { recursive: true })
await writeFile(join(fixtureRepo, '.claude', 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: A fixture skill nobody invokes.\n---\nDo the demo.\n')
const ended = fixture.sessions.find((s) => s.id === fixture.endedId)!
const listing = new SessionBuilder({ sessionId: ended.id, startAt: '2026-08-14T10:00:00.000Z', cwd: fixtureRepo })
listing.attachment('skill_listing', { content: 'Available skills: demo-skill — A fixture skill nobody invokes. '.repeat(80) })
await appendFile(ended.path, listing.toJsonl())
await utimes(ended.path, new Date(ended.mtimeMs), new Date(ended.mtimeMs))
const appHome = join(temp, 'orangu-home')
process.env['ORANGU_HOME'] = appHome
// A store with 1 open record in each group of the improvement queue, in the workspace of serve. The titles stand for
// the stored titles of real findings. A frozen baseline of 2 sessions makes the first record due at once.
const proposal = proposalOf(fixtureRepo)
const queueRecords: SuggestionRecord[] = [
  appliedOf(sg(0xb1), { proposal, frozenBaseline: frozenOf([10, 11]), title: 'Run the type check before each commit' }),
  appliedOf(sg(0xb2), { proposal, status: 'regressed', statusAt: APPLIED_AT + 5_000, title: 'Stop a retry after 2 failed calls' }),
  recordOf(sg(0xb3), { ruleId: 'context-near-limit', status: 'proposed', statusAt: APPLIED_AT + 4_000, proposal, title: 'Keep the context small with a short project file' }),
  recordOf(sg(0xb4), { title: 'Read each file once, then keep it in context', statusAt: APPLIED_AT + 3_000 }),
  recordOf(sg(0xb5), { ruleId: 'cache-ttl-churn', status: 'kicked-off', statusAt: APPLIED_AT + 2_000, title: 'Keep the cache warm between turns' }),
  appliedOf(sg(0xb6), { proposal, ruleId: 'interruptions', title: 'Name the goal of the session in the first prompt' }),
  // 1 proposal of a second workspace: only the read of every workspace holds it, and none of its sessions is of serve
  recordOf(sg(0xd1), { status: 'proposed', statusAt: APPLIED_AT + 1_000, sessionIds: [uuid(901)], proposal: proposalOf(join(temp, 'other')), title: 'Keep one test command for the whole repository' }),
]
await mkdir(appHome, { recursive: true })
await writeFile(join(appHome, 'suggestions.jsonl'), queueRecords.map((record) => `${JSON.stringify(record)}\n`).join(''), { mode: 0o600 })
/** The queue reads of serve over the fixture store: the workspace of serve is its own path, and it lists no later session. */
const queueReadDeps = (now: number): QueueReadDeps => ({
  now,
  cohort: {
    listCandidates: async () => [],
    loadCandidate: async () => {
      throw new Error('the fixture lists no session')
    },
    canonicalWorkspace: async (identity) => identity.cwd,
  },
  canonical: async (dir) => dir,
  workspaceSessionIds: async () => [uuid(900)],
})
// the harness route reads ~/.claude.json and the repo's .claude/: keep both synthetic (never the real home)
const fakeHome = join(temp, 'home')
await mkdir(fakeHome, { recursive: true })
process.env['HOME'] = fakeHome

const server = await startServe(
  {
    port: 4174,
    open: false,
    includeText: true,
    configDir: fixture.configDir,
    cwd: fixtureRepo,
    noCache: true,
    version: 'browser-test',
  },
  { capability: BROWSER_CAPABILITY, queueReadDeps },
)

let stopping = false
const stop = (): void => {
  if (stopping) return
  stopping = true
  void server.close().finally(() => process.exit(0))
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
await new Promise(() => {})
