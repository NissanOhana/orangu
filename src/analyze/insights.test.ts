import { describe, it, expect } from 'vitest'
import { parseClaudeCodeSession, type ParseInput } from '../adapters/claude-code/parse.js'
import { analyzeSession } from './analyze.js'
import { buildCanonicalSession, fakeToolUseId, SessionBuilder } from '../../test/fixtures/session-builder.js'
import { resolveModel } from '../models/catalog.js'
import type { Analysis } from '../model/analysis.js'

async function analyzeOf(b: SessionBuilder, extra: Partial<ParseInput> = {}): Promise<Analysis> {
  const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true, ...extra })
  return analyzeSession(s, { version: 'test', now: 0 })
}
function find(a: Analysis, ruleId: string) {
  return a.insights.find((i) => i.ruleId === ruleId)
}

describe('core insight rules', () => {
  describe('unverified-edits', () => {
    it('fires medium when files were edited but no test/build ran', async () => {
      const b = new SessionBuilder()
      b.userPrompt('tweak the config')
      b.toolCall('Edit', { file_path: '/p/conf.ts', old_string: 'a', new_string: 'b' }, 'The file has been updated.')
      b.assistant([{ type: 'text', text: 'done' }])
      const ins = find(await analyzeOf(b), 'unverified-edits')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('medium')
      expect(ins.evidence['filesEdited']).toBe(1)
    })
    it('fires high when the last test run failed and the session ended', async () => {
      const b = new SessionBuilder()
      b.userPrompt('fix it')
      b.toolCall('Edit', { file_path: '/p/x.ts', old_string: 'a', new_string: 'b' }, 'The file has been updated.')
      b.toolCall('Bash', { command: 'npm test' }, 'FAIL 1 failed', { isError: true })
      b.assistant([{ type: 'text', text: 'hmm' }])
      const ins = find(await analyzeOf(b), 'unverified-edits')!
      expect(ins.severity).toBe('high')
      expect(ins.title).toContain('last test run failed')
    })
    it('does not escalate to high while the session is possibly live', async () => {
      const b = new SessionBuilder()
      b.userPrompt('fix it')
      b.toolCall('Bash', { command: 'npm test' }, 'FAIL', { isError: true })
      b.assistant([{ type: 'text', text: 'looking' }])
      const a = await analyzeOf(b, { trailingPartial: true })
      expect(find(a, 'unverified-edits')).toBeUndefined() // no edits either → nothing to flag
    })
    it('the medium branch is also silent while the session is possibly live', async () => {
      const b = new SessionBuilder()
      b.userPrompt('tweak the config')
      b.toolCall('Edit', { file_path: '/p/conf.ts', old_string: 'a', new_string: 'b' }, 'The file has been updated.')
      b.assistant([{ type: 'text', text: 'still going' }])
      const a = await analyzeOf(b, { trailingPartial: true })
      expect(find(a, 'unverified-edits')).toBeUndefined()
    })
    it('high fires when the last MAIN-THREAD test failed, even if a subagent test passed later', async () => {
      const b = new SessionBuilder()
      b.userPrompt('fix it')
      b.toolCall('Edit', { file_path: '/p/x.ts', old_string: 'a', new_string: 'b' }, 'The file has been updated.')
      b.toolCall('Bash', { command: 'npm test' }, 'FAIL 1 failed', { isError: true })
      b.sidechain('subverif00000001')
      b.userPrompt('verify in a worktree')
      b.toolCall('Bash', { command: 'npm test' }, 'PASS')
      b.assistant([{ type: 'text', text: 'green in the worktree' }])
      b.sidechain('', false)
      b.assistant([{ type: 'text', text: 'done' }])
      const ins = find(await analyzeOf(b), 'unverified-edits')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('high')
    })
    it('a failed test inside a subagent does not fire high when the main thread ended green', async () => {
      const b = new SessionBuilder()
      b.userPrompt('fix it')
      b.toolCall('Edit', { file_path: '/p/x.ts', old_string: 'a', new_string: 'b' }, 'The file has been updated.')
      b.toolCall('Bash', { command: 'npm test' }, 'PASS')
      b.sidechain('subexplore000001')
      b.userPrompt('poke around')
      b.toolCall('Bash', { command: 'npm test' }, 'FAIL', { isError: true })
      b.assistant([{ type: 'text', text: 'red in my sandbox' }])
      b.sidechain('', false)
      b.assistant([{ type: 'text', text: 'done' }])
      expect(find(await analyzeOf(b), 'unverified-edits')).toBeUndefined()
    })
    it('does not fire when tests ran and the last one passed', async () => {
      expect(find(await analyzeOf(buildCanonicalSession()), 'unverified-edits')).toBeUndefined()
    })
  })

  describe('edit-churn', () => {
    // anchors >= 24 chars so the containment check counts them
    const v = (n: string) => `const seed = computed_from(alpha_${n})`
    it('fires low on a file with 6+ edits of distinct regions', async () => {
      const b = new SessionBuilder()
      b.userPrompt('iterate')
      for (let i = 0; i < 6; i++) b.toolCall('Edit', { file_path: '/p/f.ts', old_string: `left${i}`, new_string: `right${i}` }, 'The file has been updated.')
      b.assistant([{ type: 'text', text: 'done' }])
      const ins = find(await analyzeOf(b), 'edit-churn')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('low')
      expect(ins.title).toContain('edited 6+ times')
    })
    it('does not fire on five edits of distinct regions because the threshold is 6', async () => {
      const b = new SessionBuilder()
      b.userPrompt('iterate a bit')
      for (let i = 0; i < 5; i++) b.toolCall('Edit', { file_path: '/p/f.ts', old_string: `left${i}`, new_string: `right${i}` }, 'The file has been updated.')
      b.assistant([{ type: 'text', text: 'done' }])
      expect(find(await analyzeOf(b), 'edit-churn')).toBeUndefined()
    })
    it('fires medium on 3+ re-edits of just-written regions within 10 minutes', async () => {
      const b = new SessionBuilder()
      b.userPrompt('thrash')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: 'const a = 1', new_string: v('one') }, 'ok')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: v('one'), new_string: v('two') }, 'ok')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: v('two'), new_string: v('three') }, 'ok')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: v('three'), new_string: v('four') }, 'ok')
      b.assistant([{ type: 'text', text: 'done' }])
      const ins = find(await analyzeOf(b), 'edit-churn')!
      expect(ins.severity).toBe('medium')
      expect((ins.evidence['thrashedFiles'] as Array<{ quickReEdits: number }>)[0]!.quickReEdits).toBe(3)
    })
    it('short old_string anchors (< 24 chars) do not count as re-edits', async () => {
      const b = new SessionBuilder()
      b.userPrompt('thrash with tiny anchors')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: 'const a = 1', new_string: 'const a = 2 // v1' }, 'ok')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: '// v1', new_string: '// v2' }, 'ok')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: '// v2', new_string: '// v3' }, 'ok')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: '// v3', new_string: '// v4' }, 'ok')
      b.assistant([{ type: 'text', text: 'done' }])
      expect(find(await analyzeOf(b), 'edit-churn')).toBeUndefined()
    })
    it('re-edits spaced beyond 10 minutes stay low', async () => {
      const b = new SessionBuilder()
      b.userPrompt('slow iterate')
      const names = ['one', 'two', 'three', 'four', 'five', 'six', 'seven']
      for (let i = 1; i < names.length; i++) {
        b.toolCall('Edit', { file_path: '/p/f.ts', old_string: v(names[i - 1]!), new_string: v(names[i]!) }, 'ok')
        b.tick(11 * 60_000)
      }
      b.assistant([{ type: 'text', text: 'done' }])
      const ins = find(await analyzeOf(b), 'edit-churn')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('low')
    })
    it('a file edited twice each by three subagents is fan-out, not churn (per-context counting)', async () => {
      const b = new SessionBuilder()
      b.userPrompt('fan out')
      for (const a of ['agentchurn000001', 'agentchurn000002', 'agentchurn000003']) {
        b.sidechain(a)
        b.userPrompt('touch the shared file')
        b.toolCall('Edit', { file_path: '/p/shared.ts', old_string: `x-${a}-1`, new_string: `y-${a}-1` }, 'ok')
        b.toolCall('Edit', { file_path: '/p/shared.ts', old_string: `x-${a}-2`, new_string: `y-${a}-2` }, 'ok')
        b.sidechain('', false)
      }
      b.assistant([{ type: 'text', text: 'done' }])
      expect(find(await analyzeOf(b), 'edit-churn')).toBeUndefined()
    })
    it('6 edits by a single subagent still count as churn', async () => {
      const b = new SessionBuilder()
      b.userPrompt('delegate the rework')
      b.sidechain('agentchurn00only')
      b.userPrompt('iterate on the file')
      for (let i = 0; i < 6; i++) b.toolCall('Edit', { file_path: '/p/f.ts', old_string: `left${i}`, new_string: `right${i}` }, 'ok')
      b.sidechain('', false)
      b.assistant([{ type: 'text', text: 'done' }])
      const ins = find(await analyzeOf(b), 'edit-churn')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('low')
    })
    it('living documents (.md) are suppressed', async () => {
      const b = new SessionBuilder()
      b.userPrompt('keep the status file current')
      for (let i = 0; i < 8; i++) b.toolCall('Edit', { file_path: '/p/STATUS.md', old_string: v(`s${i}`), new_string: v(`s${i + 1}`) }, 'ok')
      b.assistant([{ type: 'text', text: 'done' }])
      expect(find(await analyzeOf(b), 'edit-churn')).toBeUndefined()
    })
    it('does not fire on two edits', async () => {
      const b = new SessionBuilder()
      b.userPrompt('small fix')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: 'x1', new_string: 'y1' }, 'ok')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: 'x2', new_string: 'y2' }, 'ok')
      b.assistant([{ type: 'text', text: 'done' }])
      expect(find(await analyzeOf(b), 'edit-churn')).toBeUndefined()
    })
  })

  describe('reverts', () => {
    it('fires low on an edit-then-revert pair', async () => {
      const b = new SessionBuilder()
      b.userPrompt('try then undo')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: 'const a = 1', new_string: 'const a = 2' }, 'ok')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: 'const a = 2', new_string: 'const a = 1' }, 'ok')
      b.assistant([{ type: 'text', text: 'reverted' }])
      const ins = find(await analyzeOf(b), 'reverts')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('low')
      expect(ins.evidence['editedThenReverted']).toBe(1)
    })
    it('fires medium when a revert command follows a failed test in the same turn', async () => {
      const b = new SessionBuilder()
      b.userPrompt('risky change')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: 'a', new_string: 'b' }, 'ok')
      b.toolCall('Bash', { command: 'npm test' }, 'FAIL', { isError: true })
      b.toolCall('Bash', { command: 'git checkout -- src/f.ts' }, '')
      b.toolCall('Bash', { command: 'npm test' }, 'PASS')
      b.assistant([{ type: 'text', text: 'backed out' }])
      const ins = find(await analyzeOf(b), 'reverts')!
      expect(ins.severity).toBe('medium')
      expect(ins.evidence['afterFailedTest']).toBe(1)
    })
    it('branch setup is not a revert: checkout -b, edit-less stash, reset --hard main in the opening turns', async () => {
      const b = new SessionBuilder()
      b.userPrompt('set up the branch')
      b.toolCall('Bash', { command: 'git checkout -b feat/x' }, '')
      b.toolCall('Bash', { command: 'git stash' }, '')
      b.toolCall('Bash', { command: 'git reset --hard main' }, '')
      b.assistant([{ type: 'text', text: 'ready' }])
      expect(find(await analyzeOf(b), 'reverts')).toBeUndefined()
    })
    it('git stash after an edit counts; git restore --staged never does; two signals fire', async () => {
      const b = new SessionBuilder()
      b.userPrompt('try something')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: 'a', new_string: 'b' }, 'ok')
      b.toolCall('Bash', { command: 'git restore --staged src/f.ts' }, '')
      b.toolCall('Bash', { command: 'git checkout -- src/other.ts' }, '')
      b.toolCall('Bash', { command: 'git stash' }, '')
      b.assistant([{ type: 'text', text: 'parked it' }])
      const ins = find(await analyzeOf(b), 'reverts')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('low')
      const cmds = ins.evidence['revertCommands'] as Array<{ command: string }>
      expect(cmds.length).toBe(2)
      expect(cmds.map((c) => c.command).join(' ')).not.toContain('--staged')
    })
    it('a single isolated revert-like command does not fire (noise floor)', async () => {
      const b = new SessionBuilder()
      b.userPrompt('one small undo')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: 'a', new_string: 'b' }, 'ok')
      b.toolCall('Bash', { command: 'git checkout -- src/f.ts' }, '')
      b.assistant([{ type: 'text', text: 'undone' }])
      expect(find(await analyzeOf(b), 'reverts')).toBeUndefined()
    })
    it('git reset --hard main counts as an undo once past the opening turns (non-worktree cwd)', async () => {
      const b = new SessionBuilder()
      for (const p of ['one', 'two', 'three']) {
        b.userPrompt(`step ${p}`)
        b.assistant([{ type: 'text', text: `did ${p}` }])
      }
      b.userPrompt('this went wrong, start over')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: 'a', new_string: 'b' }, 'ok')
      b.toolCall('Bash', { command: 'git reset --hard main' }, '')
      b.toolCall('Bash', { command: 'git reset --hard main' }, '')
      b.assistant([{ type: 'text', text: 'reset' }])
      const ins = find(await analyzeOf(b), 'reverts')!
      expect(ins).toBeDefined()
      expect((ins.evidence['revertCommands'] as unknown[]).length).toBe(2)
    })
    it('git reset --hard main in a worktree-style cwd is branch setup even in a late turn', async () => {
      const b = new SessionBuilder({ cwd: '/Users/test/Code/demo/.worktrees/fix-x' })
      for (const p of ['one', 'two', 'three']) {
        b.userPrompt(`step ${p}`)
        b.assistant([{ type: 'text', text: `did ${p}` }])
      }
      b.userPrompt('sync the worktree')
      b.toolCall('Bash', { command: 'git reset --hard main' }, '')
      b.assistant([{ type: 'text', text: 'synced' }])
      expect(find(await analyzeOf(b), 'reverts')).toBeUndefined()
    })
    it('stash and sync-from-base addressing a worktree path are harness protocol, not undo', async () => {
      const b = new SessionBuilder()
      for (const p of ['one', 'two', 'three']) {
        b.userPrompt(`step ${p}`)
        b.assistant([{ type: 'text', text: `did ${p}` }])
      }
      b.userPrompt('merge the worktree branch')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: 'a', new_string: 'b' }, 'ok')
      b.toolCall('Bash', { command: 'cd /Users/test/Code/demo/.worktrees/wt1 && git stash' }, '')
      b.toolCall('Bash', { command: 'cd /Users/test/Code/demo/.worktrees/wt1 && git checkout origin/main -- src/generated.ts' }, '')
      b.assistant([{ type: 'text', text: 'merged' }])
      expect(find(await analyzeOf(b), 'reverts')).toBeUndefined()
    })
    it('checkout from a named ref is a content transplant, not an undo; ref-less and HEAD checkouts count', async () => {
      const b = new SessionBuilder()
      for (const p of ['one', 'two', 'three']) {
        b.userPrompt(`step ${p}`)
        b.assistant([{ type: 'text', text: `did ${p}` }])
      }
      b.userPrompt('mix of checkouts')
      b.toolCall('Bash', { command: 'git checkout origin/main -- src/app.ts' }, '')
      b.toolCall('Bash', { command: 'git checkout feat/other-branch -- src/lib.ts' }, '')
      b.toolCall('Bash', { command: 'git checkout HEAD -- src/undone.ts' }, '')
      b.toolCall('Bash', { command: 'git checkout -- src/also-undone.ts' }, '')
      b.assistant([{ type: 'text', text: 'done' }])
      const ins = find(await analyzeOf(b), 'reverts')!
      expect(ins).toBeDefined()
      const cmds = ins.evidence['revertCommands'] as Array<{ command: string }>
      expect(cmds.length).toBe(2)
      expect(cmds.map((c) => c.command).join(' ')).not.toContain('origin/main')
    })
    it('a stash that is popped later parked work — not counted; the same pathspec restored 3+ times is a ritual', async () => {
      const b = new SessionBuilder()
      for (const p of ['one', 'two', 'three']) {
        b.userPrompt(`step ${p}`)
        b.assistant([{ type: 'text', text: `did ${p}` }])
      }
      b.userPrompt('protocol-heavy work')
      b.toolCall('Edit', { file_path: '/p/f.ts', old_string: 'a', new_string: 'b' }, 'ok')
      b.toolCall('Bash', { command: 'git stash push -m parking' }, '')
      b.toolCall('Bash', { command: 'git stash pop' }, '')
      for (let i = 0; i < 3; i++) b.toolCall('Bash', { command: 'git checkout -- src/report/generated' }, '')
      b.assistant([{ type: 'text', text: 'done' }])
      expect(find(await analyzeOf(b), 'reverts')).toBeUndefined()
    })
    it('git reset --hard HEAD~1 is an undo even in the opening turns', async () => {
      const b = new SessionBuilder()
      b.userPrompt('undo those commits')
      b.toolCall('Bash', { command: 'git reset --hard HEAD~1' }, '')
      b.toolCall('Bash', { command: 'git reset --hard HEAD~2' }, '')
      b.assistant([{ type: 'text', text: 'undone' }])
      const ins = find(await analyzeOf(b), 'reverts')!
      expect(ins).toBeDefined()
      expect((ins.evidence['revertCommands'] as unknown[]).length).toBe(2)
    })
    it('does not fire on the canonical session', async () => {
      expect(find(await analyzeOf(buildCanonicalSession()), 'reverts')).toBeUndefined()
    })
  })

  describe('cache-dominates-tokens ', () => {
    // Gated on reReadMultiplier (totalCacheRead / peak context), NOT on cache's share of tokens:
    // Cache share alone is not enough: a steady context can be almost entirely cached without being
    // carried often enough to warrant a finding.
    // A steady context of `peak` re-read `n` times gives reReadMultiplier ≈ n.
    function carried(times: number, peak = 400_000): SessionBuilder {
      const b = new SessionBuilder()
      b.userPrompt('long-running context work')
      for (let i = 0; i < times; i++) b.assistant([{ type: 'text', text: `step ${i}` }], { usage: { input_tokens: 5, cache_read_input_tokens: peak, output_tokens: 50 } })
      return b
    }

    it('fires info when the context was carried 100x but the session is under the high bar', async () => {
      const a = await analyzeOf(carried(120))
      expect(a.context.reReadMultiplier).toBeGreaterThanOrEqual(100)
      expect(a.summary.totalTokens).toBeLessThan(750_000_000)
      const ins = find(a, 'cache-dominates-tokens')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('info')
      expect(ins.evidence['reReadMultiplier'] as number).toBe(a.context.reReadMultiplier)
      expect(ins.evidence['totalTokens'] as number).toBe(a.summary.totalTokens)
    })

    it('escalates to high only when the session also clears 750M tokens', async () => {
      // 2,000 requests x 400k carried = 800M tokens, comfortably over the magnitude floor
      const a = await analyzeOf(carried(2_000))
      expect(a.summary.totalTokens).toBeGreaterThanOrEqual(750_000_000)
      const ins = find(a, 'cache-dominates-tokens')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('high')
    })

    it('a heavily-carried but small session stays info — magnitude is half the ladder', async () => {
      const a = await analyzeOf(carried(150, 10_000))
      expect(a.context.reReadMultiplier).toBeGreaterThanOrEqual(100)
      expect(a.summary.totalTokens).toBeLessThan(750_000_000)
      expect(find(a, 'cache-dominates-tokens')!.severity).toBe('info')
    })

    it('boundary: a context carried fewer than 100 times does not fire at all', async () => {
      const a = await analyzeOf(carried(99))
      expect(a.context.reReadMultiplier).toBeLessThan(100)
      expect(find(a, 'cache-dominates-tokens')).toBeUndefined()
    })

    it('does not fire when fresh input and output carry the tokens (nothing is being re-read)', async () => {
      const b = new SessionBuilder()
      b.userPrompt('fresh work')
      b.assistant([{ type: 'text', text: 'reply' }], { usage: { input_tokens: 50_000, cache_read_input_tokens: 0, output_tokens: 8000 } })
      const a = await analyzeOf(b)
      expect(a.context.reReadMultiplier).toBe(0)
      expect(find(a, 'cache-dominates-tokens')).toBeUndefined()
    })

    // The regression this rule shipped with, pinned so it cannot come back: a high cache SHARE is
    // true of essentially every cached session and must not, on its own, produce a finding.
    it('a 99% cache share with almost no re-reading stays silent (the wallpaper guard)', async () => {
      const b = new SessionBuilder()
      b.userPrompt('one huge single-shot read')
      b.assistant([{ type: 'text', text: 'reply' }], { usage: { input_tokens: 0, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 100_000, output_tokens: 200 } })
      const a = await analyzeOf(b)
      expect((a.tokens.byKind.cacheRead + a.tokens.byKind.cacheWrite5m + a.tokens.byKind.cacheWrite1h) / a.tokens.totalTokens).toBeGreaterThan(0.99)
      expect(a.context.reReadMultiplier).toBeLessThan(100)
      expect(find(a, 'cache-dominates-tokens')).toBeUndefined()
    })
  })

  // `unpriced-model` was deleted with the price table: an id orangu cannot place changes nothing about
  // the token counts, which the API reports exactly. What still matters — that we could not name the
  // model — is asserted here on the catalog resolution and on the per-model row instead of as a rule.
  describe('an unrecognised model id (no longer a rule)', () => {
    it('emits no insight, still counts the tokens, and marks the model row as an estimated match', async () => {
      const b = new SessionBuilder()
      b.userPrompt('hello')
      b.assistant([{ type: 'text', text: 'hi' }], { model: 'mystery-model-9000', usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5 } })
      const a = await analyzeOf(b)
      expect(a.insights.some((i) => i.ruleId === 'unpriced-model')).toBe(false)
      const row = a.tokens.byModel.find((m) => m.model === 'mystery-model-9000')!
      expect(row).toBeDefined()
      expect(row.totalTokens).toBe(15)
      expect(row.estimatedMatch).toBe(true)
      expect(resolveModel('mystery-model-9000').displayName).toBe('mystery-model-9000')
    })
    it('a catalogued model is not an estimated match', async () => {
      const a = await analyzeOf(buildCanonicalSession())
      expect(a.tokens.byModel.every((m) => !m.estimatedMatch)).toBe(true)
    })
  })

  describe('slow-tool', () => {
    it('fires low and names a tool with p95 > 30 s over 5+ calls', async () => {
      const b = new SessionBuilder()
      b.userPrompt('slow greps')
      for (let i = 0; i < 5; i++) b.toolCall('Grep', { pattern: `p${i}` }, 'match', { durationMs: 40_000 })
      b.assistant([{ type: 'text', text: 'done' }])
      const ins = find(await analyzeOf(b), 'slow-tool')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('low')
      expect(ins.title).toContain('Grep')
    })
    it('does not fire on fast tools or on fewer than 5 calls', async () => {
      const b = new SessionBuilder()
      b.userPrompt('quick greps + one slow read')
      for (let i = 0; i < 5; i++) b.toolCall('Grep', { pattern: `p${i}` }, 'match', { durationMs: 500 })
      b.toolCall('Read', { file_path: '/p/big.ts' }, 'x', { durationMs: 45_000 })
      b.assistant([{ type: 'text', text: 'done' }])
      expect(find(await analyzeOf(b), 'slow-tool')).toBeUndefined()
    })
    it('boundary: exactly 30 s p95 does not fire (open bound)', async () => {
      const b = new SessionBuilder()
      b.userPrompt('greps at the line')
      for (let i = 0; i < 5; i++) b.toolCall('Grep', { pattern: `p${i}` }, 'match', { durationMs: 30_000 })
      b.assistant([{ type: 'text', text: 'done' }])
      expect(find(await analyzeOf(b), 'slow-tool')).toBeUndefined()
    })
    it('does not count Agent delegation waits as a slow tool', async () => {
      const b = new SessionBuilder()
      b.userPrompt('fan out')
      for (let i = 0; i < 5; i++) b.toolCall('Agent', { description: `t${i}`, prompt: 'go', subagent_type: 'general-purpose' }, 'ok', { durationMs: 120_000, toolUseResult: { status: 'completed', content: [{ type: 'text', text: 'ok' }] } })
      b.assistant([{ type: 'text', text: 'done' }])
      expect(find(await analyzeOf(b), 'slow-tool')).toBeUndefined()
    })
  })

  describe('failed-agents + deep-fanout ', () => {
    function agentSession(statuses: string[]): SessionBuilder {
      const b = new SessionBuilder()
      b.userPrompt('delegate')
      statuses.forEach((status, i) => {
        const agentId = `fail${i}00000000000`.slice(0, 16)
        b.toolCall('Agent', { description: `t${i}`, prompt: 'go', subagent_type: 'general-purpose' }, status === 'completed' ? 'ok' : 'agent hit an error', {
          toolUseResult: { status, agentId, content: [{ type: 'text', text: 'x' }], totalDurationMs: 900, totalTokens: 1200, totalToolUseCount: 1 },
        })
        b.sidechain(agentId)
        b.userPrompt('go')
        b.assistant([{ type: 'text', text: 'working' }], { model: 'claude-sonnet-5', usage: { input_tokens: 500, output_tokens: 30 } })
        b.sidechain('', false)
      })
      b.assistant([{ type: 'text', text: 'done' }])
      return b
    }
    it('fires low on one killed agent run (a real on-disk status)', async () => {
      const ins = find(await analyzeOf(agentSession(['killed', 'completed'])), 'failed-agents')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('low')
      expect((ins.evidence['failed'] as Array<{ status: string }>).length).toBe(1)
      expect((ins.evidence['failed'] as Array<{ status: string }>)[0]!.status).toBe('killed')
    })
    it('killed is a weak signal: two killed runs still cap at low', async () => {
      const ins = find(await analyzeOf(agentSession(['killed', 'killed'])), 'failed-agents')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('low')
      expect((ins.evidence['failed'] as unknown[]).length).toBe(2)
    })
    it('explicit error statuses (other adapters) keep the medium ladder at 2+', async () => {
      const ins = find(await analyzeOf(agentSession(['error', 'failed'])), 'failed-agents')!
      expect(ins.severity).toBe('medium')
    })
    it('does not fire when every agent completed', async () => {
      expect(find(await analyzeOf(agentSession(['completed', 'completed'])), 'failed-agents')).toBeUndefined()
    })
    it('non-terminal real statuses (async_launched, teammate_spawned) are not failures', async () => {
      expect(find(await analyzeOf(agentSession(['async_launched', 'teammate_spawned'])), 'failed-agents')).toBeUndefined()
    })
    it('deep-fanout fires info at spawn depth 3 (from sidecar meta)', async () => {
      const sub = new SessionBuilder({ sessionId: 'aaaaaaaa-0000-4000-8000-0000000000aa' })
      sub.sidechain('deepagent0000001')
      sub.userPrompt('deep task')
      sub.assistant([{ type: 'text', text: 'deep done' }], { usage: { input_tokens: 100, output_tokens: 10 } })
      const a = await analyzeOf(buildCanonicalSession(), {
        subagents: [{ path: '/tmp/x/subagents/agent-deepagent0000001.jsonl', records: sub.toRecords(), meta: { agentType: 'digger', spawnDepth: 3 } }],
      })
      const ins = find(a, 'deep-fanout')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('info')
      expect(ins.evidence['maxDepth']).toBe(3)
    })
    it('deep-fanout does not fire on a flat fan-out', async () => {
      expect(find(await analyzeOf(buildCanonicalSession()), 'deep-fanout')).toBeUndefined()
    })
  })

  describe('skill-token-weight ', () => {
    function skillSession(skillCacheRead: number): SessionBuilder {
      const b = new SessionBuilder()
      // two light human turns pin the median low
      b.userPrompt('small question one')
      b.assistant([{ type: 'text', text: 'a1' }], { usage: { input_tokens: 10, cache_read_input_tokens: 60_000, output_tokens: 20 } })
      b.userPrompt('small question two')
      b.assistant([{ type: 'text', text: 'a2' }], { usage: { input_tokens: 10, cache_read_input_tokens: 60_000, output_tokens: 20 } })
      // third human turn invokes the skill; its usage is attributed to the skill
      b.userPrompt('use the heavy skill')
      b.toolCall('Skill', { skill: 'heavy-skill' }, 'skill loaded', { usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 20 } })
      b.assistant([{ type: 'text', text: 'skill work' }], { usage: { input_tokens: 10, cache_read_input_tokens: skillCacheRead, output_tokens: 200 } })
      return b
    }
    it('fires low when a skill moves more than 2x the median human turn in tokens', async () => {
      const b = skillSession(600_000)
      const recs = b.toRecords()
      const last = recs[recs.length - 1]!
      last['attributionSkill'] = 'heavy-skill'
      const a = analyzeSession(await parseClaudeCodeSession({ records: recs, noSidecar: true }), { version: 'test', now: 0 })
      const ins = find(a, 'skill-token-weight')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('low')
      const skills = ins.evidence['skills'] as Array<{ name: string; perInvocationTokens: number }>
      expect(skills[0]!.name).toBe('heavy-skill')
      expect(skills[0]!.perInvocationTokens).toBeGreaterThan(2 * (ins.evidence['medianHumanTurnTokens'] as number))
    })
    it('does not fire when the attributed skill usage is light', async () => {
      const b = skillSession(1000)
      const recs = b.toRecords()
      const last = recs[recs.length - 1]!
      last['attributionSkill'] = 'heavy-skill'
      const a = analyzeSession(await parseClaudeCodeSession({ records: recs, noSidecar: true }), { version: 'test', now: 0 })
      expect(find(a, 'skill-token-weight')).toBeUndefined()
    })
    it('does not fire without attribution, even when a skill ran', async () => {
      expect(find(await analyzeOf(skillSession(600_000)), 'skill-token-weight')).toBeUndefined()
    })
  })

  describe('time-budget', () => {
    it('fires info naming tool execution when tools take >= 75% of active time', async () => {
      const b = new SessionBuilder()
      b.userPrompt('run the long suite')
      b.toolCall('Bash', { command: 'npm run e2e' }, 'PASS', { durationMs: 120_000 })
      b.assistant([{ type: 'text', text: 'done' }])
      const ins = find(await analyzeOf(b), 'time-budget')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('info')
      expect(ins.title).toContain('tool execution')
    })
    it('never fires on model inference — modelMs is a residual, not a measurement', async () => {
      const b = new SessionBuilder()
      b.userPrompt('think hard')
      b.tick(70_000)
      b.assistant([{ type: 'text', text: 'a long think' }])
      expect(find(await analyzeOf(b), 'time-budget')).toBeUndefined()
    })
    it('boundary: exactly 75% tool share fires (closed bound)', async () => {
      const b = new SessionBuilder()
      b.userPrompt('run the suite')
      b.toolCall('Bash', { command: 'npm run e2e' }, 'PASS', { durationMs: 60_000 })
      b.tick(20_000)
      b.assistant([{ type: 'text', text: 'done' }]) // turn: 80 s active, 60 s tools = exactly 75%
      const ins = find(await analyzeOf(b), 'time-budget')!
      expect(ins).toBeDefined()
      expect(ins.title).toContain('75%')
      expect(ins.title).toContain('tool execution')
    })
    it('parallel tool calls are unioned, not summed: two overlapping 60 s calls in a 100 s turn stay quiet', async () => {
      const b = new SessionBuilder()
      b.userPrompt('run two suites at once')
      const id1 = fakeToolUseId()
      const id2 = fakeToolUseId()
      b.assistant([
        { type: 'tool_use', id: id1, name: 'Bash', input: { command: 'npm run e2e -- shard 1' } },
        { type: 'tool_use', id: id2, name: 'Bash', input: { command: 'npm run e2e -- shard 2' } },
      ])
      b.tick(60_000)
      b.toolResult(id1, 'PASS')
      b.toolResult(id2, 'PASS')
      b.tick(40_000)
      b.assistant([{ type: 'text', text: 'both green' }]) // union 60 s of 100 s active = 60% < 75%
      expect(find(await analyzeOf(b), 'time-budget')).toBeUndefined()
    })
    it('stays quiet under a minute of active time', async () => {
      expect(find(await analyzeOf(buildCanonicalSession()), 'time-budget')).toBeUndefined()
    })
  })

  // `model-mix` was deleted with the price table. Its entire signal was "the same tokens would have
  // been billed less elsewhere" — switching model does not change a single token count, so in a
  // token-only product there is nothing left to report. This guards the deletion and, more usefully,
  // guards the principle: no rule may claim a saving on a session where nothing would have been sent
  // or generated differently.
  describe('model swaps claim no saving (model-mix deleted)', () => {
    it('an opus-heavy session emits no model-mix insight', async () => {
      const b = new SessionBuilder()
      b.userPrompt('heavy opus work')
      for (let i = 0; i < 6; i++) b.assistant([{ type: 'text', text: `s${i}` }], { usage: { input_tokens: 5, cache_read_input_tokens: 700_000, output_tokens: 100 } })
      const a = await analyzeOf(b)
      expect(a.summary.totalTokens).toBeGreaterThan(1_000_000)
      expect(find(a, 'model-mix')).toBeUndefined()
      expect(a.insights.every((i) => i.savings?.tokens === undefined || i.savings.tokens > 0)).toBe(true)
    })
    it('the same session on haiku produces the same token totals — the metric is model-independent', async () => {
      const mk = (model: string) => {
        const b = new SessionBuilder({ model })
        b.userPrompt('work')
        for (let i = 0; i < 4; i++) b.assistant([{ type: 'text', text: `s${i}` }], { usage: { input_tokens: 400_000, cache_read_input_tokens: 0, output_tokens: 100 } })
        return b
      }
      const opus = await analyzeOf(mk('claude-opus-5'))
      const haiku = await analyzeOf(mk('claude-haiku-4-5-20251001'))
      expect(haiku.summary.totalTokens).toBe(opus.summary.totalTokens)
      expect(haiku.tokens.byKind).toEqual(opus.tokens.byKind)
    })
    it('every savings figure in the corpus is a token count, never anything else', async () => {
      const a = await analyzeOf(buildCanonicalSession())
      for (const i of a.insights) {
        if (!i.savings) continue
        expect(Object.keys(i.savings).sort()).toEqual(['estimated', 'ms', 'tokens'].filter((k) => k in i.savings!).sort())
      }
    })
  })
})

describe('additional diagnostic insight rules', () => {
  describe('cache-invalidation ', () => {
    it('fires medium on a 50k–300k miss and groups by reason type', async () => {
      const b = new SessionBuilder()
      b.userPrompt('work')
      b.assistant([{ type: 'text', text: 'ok' }], {
        diagnostics: { cache_miss_reason: { type: 'tools_changed', cache_missed_input_tokens: 133_306 } },
        usage: { input_tokens: 5, cache_creation_input_tokens: 133_306, output_tokens: 40 },
      })
      const a = await analyzeOf(b)
      const ins = find(a, 'cache-invalidation')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('medium')
      expect(ins.evidence['byType']).toEqual([{ type: 'tools_changed', events: 1, missedTokens: 133_306 }])
      expect(ins.evidence['missedTokensTotal']).toBe(133_306)
      // a miss re-writes tokens it would otherwise have re-read: same count, different category.
      // There is no token saving to claim, so the rule claims none.
      expect(ins.savings).toBeUndefined()
      expect(a.context.cacheMisses).toHaveLength(1)
    })
    it('fires high above 300k missed tokens, and high when more than 3 actionable events', async () => {
      const b = new SessionBuilder()
      b.userPrompt('big miss')
      b.assistant([{ type: 'text', text: 'ok' }], {
        diagnostics: { cache_miss_reason: { type: 'model_changed', cache_missed_input_tokens: 350_000 } },
        usage: { input_tokens: 5, cache_creation_input_tokens: 350_000, output_tokens: 40 },
      })
      expect(find(await analyzeOf(b), 'cache-invalidation')!.severity).toBe('high')
      const c = new SessionBuilder()
      c.userPrompt('many small misses')
      for (let i = 0; i < 4; i++) {
        c.assistant([{ type: 'text', text: `m${i}` }], {
          diagnostics: { cache_miss_reason: { type: 'messages_changed', cache_missed_input_tokens: 20_000 } },
          usage: { input_tokens: 5, cache_creation_input_tokens: 20_000, output_tokens: 40 },
        })
      }
      expect(find(await analyzeOf(c), 'cache-invalidation')!.severity).toBe('high')
    })
    it('reports the re-written tokens on the tier the event actually used, and claims no saving', async () => {
      // the missed tokens were re-written on the 5m tier. The token count is what we report; the
      // difference between the tiers was only ever a price difference, so nothing is claimed.
      const b = new SessionBuilder()
      b.userPrompt('warm up')
      b.assistant([{ type: 'text', text: 'big read' }], { usage: { input_tokens: 5, cache_read_input_tokens: 10_000_000, output_tokens: 40 } })
      b.userPrompt('switch tools')
      b.assistant([{ type: 'text', text: 'ok' }], {
        diagnostics: { cache_miss_reason: { type: 'tools_changed', cache_missed_input_tokens: 100_000 } },
        usage: { input_tokens: 5, cache_creation_input_tokens: 100_000, cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 0 }, output_tokens: 40 },
      })
      const a = await analyzeOf(b)
      const ins = find(a, 'cache-invalidation')!
      expect(ins).toBeDefined()
      expect(ins.evidence['missedTokensTotal']).toBe(100_000)
      expect(a.tokens.byKind.cacheWrite5m).toBe(100_000)
      expect(a.tokens.byKind.cacheWrite1h).toBe(0)
      expect(ins.savings).toBeUndefined()
    })
    it('count-driven high needs a 50k token floor: >3 tiny events cap at medium', async () => {
      const b = new SessionBuilder()
      b.userPrompt('many tiny misses')
      for (let i = 0; i < 4; i++) {
        b.assistant([{ type: 'text', text: `m${i}` }], {
          diagnostics: { cache_miss_reason: { type: 'messages_changed', cache_missed_input_tokens: 10_000 } },
          usage: { input_tokens: 5, cache_creation_input_tokens: 10_000, output_tokens: 40 },
        })
      }
      expect(find(await analyzeOf(b), 'cache-invalidation')!.severity).toBe('medium')
    })
    it('boundary: a lone sub-50k actionable miss is low; infra-only misses with no tokens never fire', async () => {
      const b = new SessionBuilder()
      b.userPrompt('small miss')
      b.assistant([{ type: 'text', text: 'ok' }], {
        diagnostics: { cache_miss_reason: { type: 'system_changed', cache_missed_input_tokens: 49_999 } },
        usage: { input_tokens: 5, cache_creation_input_tokens: 49_999, output_tokens: 40 },
      })
      expect(find(await analyzeOf(b), 'cache-invalidation')!.severity).toBe('low')
      const c = new SessionBuilder()
      c.userPrompt('infra blip')
      c.assistant([{ type: 'text', text: 'ok' }], { diagnostics: { cache_miss_reason: { type: 'unavailable' } } })
      c.assistant([{ type: 'text', text: 'ok2' }], { diagnostics: { cache_miss_reason: { type: 'previous_message_not_found' } } })
      expect(find(await analyzeOf(c), 'cache-invalidation')).toBeUndefined()
    })
  })

  describe('cache-ttl-churn ', () => {
    /** a session whose cache writes are dominated by the 1h tier, with a controllable gap between turns */
    function ttlSession(gapMs: number, turns = 4): SessionBuilder {
      const b = new SessionBuilder()
      for (let i = 0; i < turns; i++) {
        b.userPrompt(`step ${i}`)
        b.tick(500)
        b.assistant([{ type: 'text', text: 'ok' }], {
          usage: { input_tokens: 5, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 60_000, output_tokens: 30 },
        })
        b.tick(gapMs)
      }
      return b
    }
    it('fires medium when 1h writes exceed 75% of all cache writes and the median turn gap is under 5 minutes', async () => {
      const a = await analyzeOf(ttlSession(60_000))
      const ins = find(a, 'cache-ttl-churn')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('medium')
      expect(ins.evidence['quickCadence']).toBe(true)
      expect(ins.evidence['cacheWrite1hTokens']).toBe(a.tokens.byKind.cacheWrite1h)
      // both tiers write the same tokens: the tier is a price choice, so no saving is ever claimed
      expect(ins.savings).toBeUndefined()
    })
    it('stays info when the cadence is slower than the 5m TTL, and still claims nothing', async () => {
      const ins = find(await analyzeOf(ttlSession(10 * 60_000)), 'cache-ttl-churn')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('info')
      expect(ins.evidence['quickCadence']).toBe(false)
      expect(ins.savings).toBeUndefined()
    })
    // Both gates pinned separately, because the shipped regression was a wrong DENOMINATOR that no
    // test could see: the share is of the cache WRITES (which tier they went to), never of the
    // session's total tokens, and a materiality floor keeps a handful of write-tokens from firing.
    it('does not fire when the 1h tier is a minor share of the writes, even with plenty of writes', async () => {
      const b = new SessionBuilder()
      b.userPrompt('mostly 5m writes')
      for (let i = 0; i < 3; i++)
        b.assistant([{ type: 'text', text: 'ok' }], {
          usage: { input_tokens: 5, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 100_000, cache_creation: { ephemeral_5m_input_tokens: 90_000, ephemeral_1h_input_tokens: 10_000 }, output_tokens: 30 },
        })
      const a = await analyzeOf(b)
      const writes = a.tokens.byKind.cacheWrite5m + a.tokens.byKind.cacheWrite1h
      expect(writes).toBeGreaterThanOrEqual(100_000)
      expect(a.tokens.byKind.cacheWrite1h / writes).toBeCloseTo(0.1, 3)
      expect(find(a, 'cache-ttl-churn')).toBeUndefined()
    })
    it('does not fire below the materiality floor, even at a 100% 1h share', async () => {
      const b = new SessionBuilder()
      b.userPrompt('barely wrote anything to cache')
      b.tick(500)
      b.assistant([{ type: 'text', text: 'ok' }], { usage: { input_tokens: 5, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 20_000, output_tokens: 30 } })
      const a = await analyzeOf(b)
      const writes = a.tokens.byKind.cacheWrite5m + a.tokens.byKind.cacheWrite1h
      expect(writes).toBeLessThan(100_000)
      expect(a.tokens.byKind.cacheWrite1h).toBe(writes) // 100% on the 1h tier
      expect(find(a, 'cache-ttl-churn')).toBeUndefined()
    })
    it('the share is of the WRITES, not of the session total (the denominator regression)', async () => {
      // a read-heavy session: 1h writes are ~2% of all tokens but 100% of the writes -> must fire
      const b = new SessionBuilder()
      for (let i = 0; i < 4; i++) {
        b.userPrompt(`step ${i}`)
        b.tick(500)
        b.assistant([{ type: 'text', text: 'ok' }], { usage: { input_tokens: 5, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 60_000, output_tokens: 30 } })
        b.tick(60_000)
      }
      const a = await analyzeOf(b)
      expect(a.tokens.byKind.cacheWrite1h / a.tokens.totalTokens).toBeLessThan(0.05)
      expect(find(a, 'cache-ttl-churn')).toBeDefined()
    })
  })

  describe('blocking-questions', () => {
    function askSession(blockMs: number): SessionBuilder {
      const b = new SessionBuilder()
      b.userPrompt('decide something')
      const id = fakeToolUseId()
      b.assistant([{ type: 'tool_use', id, name: 'AskUserQuestion', input: { question: 'A or B?' } }])
      b.tick(blockMs)
      b.toolResult(id, 'B')
      b.assistant([{ type: 'text', text: 'going with B' }])
      return b
    }
    it('fires low above 5 minutes and medium above 30 minutes', async () => {
      expect(find(await analyzeOf(askSession(6 * 60_000)), 'blocking-questions')!.severity).toBe('low')
      expect(find(await analyzeOf(askSession(40 * 60_000)), 'blocking-questions')!.severity).toBe('medium')
    })
    it('fires high above 2 hours with nothing running in the background', async () => {
      const ins = find(await analyzeOf(askSession(2.5 * 3_600_000)), 'blocking-questions')!
      expect(ins.severity).toBe('high')
      expect(ins.savings?.ms).toBeGreaterThan(2 * 3_600_000)
    })
    it('caps at medium when subagents kept working through the wait', async () => {
      const b = new SessionBuilder()
      b.userPrompt('decide while agents work')
      const ask = fakeToolUseId()
      b.assistant([{ type: 'tool_use', id: ask, name: 'AskUserQuestion', input: { question: 'A or B?' } }])
      // an agent spanning the whole ask window
      b.sidechain('bgagent000000001')
      b.userPrompt('long background chore')
      b.tick(2.5 * 3_600_000)
      b.assistant([{ type: 'text', text: 'chore done' }], { usage: { input_tokens: 500, output_tokens: 20 } })
      b.sidechain('', false)
      b.toolResult(ask, 'B')
      expect(find(await analyzeOf(b), 'blocking-questions')!.severity).toBe('medium')
    })
    it('does not fire on a quick answer', async () => {
      expect(find(await analyzeOf(askSession(2 * 60_000)), 'blocking-questions')).toBeUndefined()
    })
  })

  describe('truncated-reads', () => {
    const cappedRead = (b: SessionBuilder, path: string) =>
      b.toolCall('Read', { file_path: path }, 'partial…', { toolUseResult: { type: 'text', file: { filePath: path, content: 'partial', numLines: 100, truncatedByTokenCap: true } } })
    it('fires low on one capped Read', async () => {
      const b = new SessionBuilder()
      b.userPrompt('read it')
      cappedRead(b, '/p/big.json')
      const ins = find(await analyzeOf(b), 'truncated-reads')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('low')
    })
    it('escalates to medium when the same file is capped twice', async () => {
      const b = new SessionBuilder()
      b.userPrompt('read it again')
      cappedRead(b, '/p/big.json')
      cappedRead(b, '/p/big.json')
      const ins = find(await analyzeOf(b), 'truncated-reads')!
      expect(ins.severity).toBe('medium')
      expect(ins.evidence['files']).toEqual([{ path: '/p/big.json', count: 2 }])
    })
    it('does not fire on ordinary reads', async () => {
      const b = new SessionBuilder()
      b.userPrompt('read it')
      b.toolCall('Read', { file_path: '/p/ok.ts' }, 'fine', { toolUseResult: { type: 'text', file: { filePath: '/p/ok.ts', content: 'fine', numLines: 5 } } })
      expect(find(await analyzeOf(b), 'truncated-reads')).toBeUndefined()
    })
  })

  describe('hidden-iterations', () => {
    const fallbackUsage = {
      input_tokens: 5,
      cache_read_input_tokens: 10_000,
      output_tokens: 60,
      iterations: [
        { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 4, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 0, output_tokens: 120 },
        { type: 'message', input_tokens: 5, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0, output_tokens: 60 },
      ],
    }
    it('fires medium on a single-message fallback iteration and rolls up its cost', async () => {
      const b = new SessionBuilder()
      b.userPrompt('do it')
      b.assistant([{ type: 'text', text: 'ok' }], { usage: fallbackUsage })
      const a = await analyzeOf(b)
      const ins = find(a, 'hidden-iterations')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('medium')
      expect(a.tokens.hiddenIterations.count).toBe(1)
      expect(a.tokens.hiddenIterations.tokens).toBe(9_124)
    })
    it('escalates to high (capped — no critical severity) when the fallback was session-scoped', async () => {
      const b = new SessionBuilder()
      b.userPrompt('do it')
      b.system('model_refusal_fallback', { content: 'refusal fallback', originalModel: 'claude-fable-5', fallbackModel: 'claude-opus-5', scope: 'session' })
      b.assistant([{ type: 'text', text: 'ok' }], { usage: fallbackUsage })
      expect(find(await analyzeOf(b), 'hidden-iterations')!.severity).toBe('high')
    })
    it('is info for a hidden retry that was not a fallback, and silent with no iterations', async () => {
      const b = new SessionBuilder()
      b.userPrompt('retry')
      b.assistant([{ type: 'text', text: 'ok' }], {
        usage: { input_tokens: 5, output_tokens: 60, iterations: [
          { type: 'message', input_tokens: 4, output_tokens: 10 },
          { type: 'message', input_tokens: 5, output_tokens: 60 },
        ] },
      })
      expect(find(await analyzeOf(b), 'hidden-iterations')!.severity).toBe('info')
      const c = new SessionBuilder()
      c.userPrompt('plain')
      c.assistant([{ type: 'text', text: 'ok' }])
      expect(find(await analyzeOf(c), 'hidden-iterations')).toBeUndefined()
    })
  })

  describe('binary-attachments', () => {
    it('fires medium on a base64 block over 500 KB', async () => {
      const b = new SessionBuilder()
      b.userPrompt('look at this pdf')
      b.assistant([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(600_000) } }])
      const ins = find(await analyzeOf(b), 'binary-attachments')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('medium')
      expect(ins.savings?.estimated).toBe(true)
    })
    it('does not fire on small images', async () => {
      const b = new SessionBuilder()
      b.userPrompt('small icon')
      b.assistant([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(10_000) } }])
      expect(find(await analyzeOf(b), 'binary-attachments')).toBeUndefined()
    })
  })

  describe('queued-prompts', () => {
    it('fires info with positive framing when 20+ human prompts were queued', async () => {
      const b = new SessionBuilder()
      b.userPrompt('start')
      for (let i = 0; i < 20; i++) b.queueOp('enqueue', `p${i}`)
      b.queueOp('dequeue')
      b.system('away_summary', { content: 'while you were away…' })
      b.assistant([{ type: 'text', text: 'ok' }])
      const ins = find(await analyzeOf(b), 'queued-prompts')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('info')
      expect(ins.evidence['queueOperations']).toEqual({ enqueue: 20, dequeue: 1 })
      expect(ins.evidence['humanEnqueues']).toBe(20)
      expect(ins.evidence['notificationEnqueues']).toBe(0)
      expect(ins.evidence['awaySummaries']).toBe(1)
    })
    it('stays silent below 20 queued prompts and on away summaries alone', async () => {
      const b = new SessionBuilder()
      b.userPrompt('start')
      for (let i = 0; i < 19; i++) b.queueOp('enqueue', `p${i}`)
      b.system('away_summary', { content: 'while you were away…' })
      b.assistant([{ type: 'text', text: 'ok' }])
      expect(find(await analyzeOf(b), 'queued-prompts')).toBeUndefined()
    })
    it('does not count machine notification enqueues toward the threshold', async () => {
      // 25 task-notification envelopes + 3 typed prompts: the queue was busy with machine
      // notifications, not a human working style — the rule must stay silent.
      const b = new SessionBuilder()
      b.userPrompt('start')
      for (let i = 0; i < 25; i++) b.queueOp('enqueue', `<task-notification>\n<task-id>t${i}</task-id>\n<status>completed</status>\n</task-notification>`)
      for (let i = 0; i < 3; i++) b.queueOp('enqueue', `typed prompt ${i}`)
      b.assistant([{ type: 'text', text: 'ok' }])
      expect(find(await analyzeOf(b), 'queued-prompts')).toBeUndefined()
    })
    it('counts human enqueues in the title and reports the notification count as context', async () => {
      const b = new SessionBuilder()
      b.userPrompt('start')
      for (let i = 0; i < 21; i++) b.queueOp('enqueue', `typed prompt ${i}`)
      for (let i = 0; i < 5; i++) b.queueOp('enqueue', `<task-notification>\n<task-id>t${i}</task-id>\n</task-notification>`)
      b.assistant([{ type: 'text', text: 'ok' }])
      const ins = find(await analyzeOf(b), 'queued-prompts')!
      expect(ins).toBeDefined()
      expect(ins.title).toContain('21 prompts queued')
      expect(ins.evidence['humanEnqueues']).toBe(21)
      expect(ins.evidence['notificationEnqueues']).toBe(5)
      expect(ins.detail).toContain('5 machine notification')
    })
  })

  describe('thinking-on-mechanical', () => {
    it('fires low when a lone Read spends over 2k thinking tokens', async () => {
      const b = new SessionBuilder()
      b.userPrompt('check the file')
      b.toolCall('Read', { file_path: '/p/x.ts' }, 'content', { usage: { output_tokens: 3_500, output_tokens_details: { thinking_tokens: 3_000 } } })
      const ins = find(await analyzeOf(b), 'thinking-on-mechanical')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('low')
      expect(ins.savings?.tokens).toBe(3_000)
    })
    it('does not fire on a non-mechanical tool or below the 2k boundary', async () => {
      const b = new SessionBuilder()
      b.userPrompt('edit the file')
      b.toolCall('Edit', { file_path: '/p/x.ts', old_string: 'a', new_string: 'b' }, 'ok', { usage: { output_tokens: 3_500, output_tokens_details: { thinking_tokens: 3_000 } } })
      expect(find(await analyzeOf(b), 'thinking-on-mechanical')).toBeUndefined()
      const c = new SessionBuilder()
      c.userPrompt('check the file')
      c.toolCall('Read', { file_path: '/p/x.ts' }, 'content', { usage: { output_tokens: 2_500, output_tokens_details: { thinking_tokens: 2_000 } } })
      expect(find(await analyzeOf(c), 'thinking-on-mechanical')).toBeUndefined()
    })
  })

  describe('output-burst', () => {
    it('fires info when 8k+ bursts are routine (10+ in the session)', async () => {
      const b = new SessionBuilder()
      b.userPrompt('write the plans')
      for (let i = 0; i < 10; i++) b.assistant([{ type: 'text', text: `plan ${i}` }], { usage: { output_tokens: 9_000 } })
      const ins = find(await analyzeOf(b), 'output-burst')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('info')
    })
    it('is low when 3+ bursts are generated file content (Write/Edit)', async () => {
      const b = new SessionBuilder()
      b.userPrompt('generate the files')
      for (let i = 0; i < 3; i++) b.toolCall('Write', { file_path: `/p/gen${i}.ts`, content: 'x' }, 'ok', { usage: { output_tokens: 9_000 } })
      for (let i = 0; i < 7; i++) b.assistant([{ type: 'text', text: `plan ${i}` }], { usage: { output_tokens: 9_000 } })
      const ins = find(await analyzeOf(b), 'output-burst')!
      expect(ins.severity).toBe('low')
      expect(ins.evidence['writeBursts']).toBe(3)
    })
    it('stays silent below 10 bursts and at 8k output exactly', async () => {
      const b = new SessionBuilder()
      b.userPrompt('normal steps')
      for (let i = 0; i < 9; i++) b.assistant([{ type: 'text', text: `s${i}` }], { usage: { output_tokens: 9_000 } })
      b.assistant([{ type: 'text', text: 'boundary' }], { usage: { output_tokens: 8_000 } })
      expect(find(await analyzeOf(b), 'output-burst')).toBeUndefined()
    })
  })

  describe('mcp-definition-weight', () => {
    // 100 idle tools × 25 tok/tool = 2.5k estimated tokens per request; 200 requests → the 500k gate
    const NAMES = Array.from({ length: 100 }, (_, i) => `mcp__srv${i % 2}__tool${i}`)
    function mcpSession(requests: number, names: string[] = NAMES): SessionBuilder {
      const b = new SessionBuilder()
      b.attachment('deferred_tools_delta', { addedNames: names, addedLines: [], pendingMcpServers: [] })
      b.userPrompt('no browser work today')
      for (let i = 0; i < requests; i++) b.assistant([{ type: 'text', text: `s${i}` }])
      return b
    }
    it('fires info once the idle listings carried an estimated 500k tokens, labeled estimated', async () => {
      const ins = find(await analyzeOf(mcpSession(200)), 'mcp-definition-weight')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('info')
      expect(ins.evidence['servers']).toEqual([
        { server: 'srv0', tools: 50, calls: 0 },
        { server: 'srv1', tools: 50, calls: 0 },
      ])
      expect(ins.evidence['estimatedCarriedTokens']).toBe(500_000)
      expect(ins.evidence['estimated']).toBe(true)
    })
    it('stays silent below the carried-weight gate', async () => {
      expect(find(await analyzeOf(mcpSession(199)), 'mcp-definition-weight')).toBeUndefined()
    })
    it('does not count servers that were actually used, and ignores tiny rosters', async () => {
      const b = mcpSession(200)
      b.toolCall('mcp__srv0__tool0', { x: 1 }, 'ok')
      b.toolCall('mcp__srv1__tool1', { x: 1 }, 'ok')
      expect(find(await analyzeOf(b), 'mcp-definition-weight')).toBeUndefined()
      const c = mcpSession(400, ['mcp__solo__a', 'mcp__solo__b', 'mcp__solo__c'])
      expect(find(await analyzeOf(c), 'mcp-definition-weight')).toBeUndefined()
    })
  })
})

describe('workflow improvement insight rules', () => {
  describe('script-candidate', () => {
    function templated(n: number, distinct = true): SessionBuilder {
      const b = new SessionBuilder()
      b.userPrompt('convert the files')
      for (let i = 0; i < n; i++) b.toolCall('Bash', { command: `node scripts/convert.js --seed ${distinct ? i : 1} /Users/test/Code/demo/data/f${distinct ? i : 1}.json` }, 'converted')
      b.assistant([{ type: 'text', text: 'done' }])
      return b
    }
    it('fires on scripting-scale templated Bash repeats and carries the template + count in evidence', async () => {
      const ins = find(await analyzeOf(templated(15)), 'script-candidate')!
      expect(ins).toBeDefined()
      expect(ins.axis).toBe('tokens')
      const templates = ins.evidence['templates'] as Array<{ template: string; count: number }>
      expect(templates[0]!.template).toBe('node «path» --seed «n» «path»')
      expect(templates[0]!.count).toBe(15)
      expect(ins.savings?.estimated).toBe(true)
    })
    it('stays silent at 14 templated repeats (fire-rate-tightened ×15 boundary)', async () => {
      expect(find(await analyzeOf(templated(14)), 'script-candidate')).toBeUndefined()
    })
    it('leaves identical commands to repeated-commands (needs 2+ distinct raw commands)', async () => {
      const a = await analyzeOf(templated(16, false))
      expect(find(a, 'script-candidate')).toBeUndefined()
      expect(find(a, 'repeated-commands')).toBeDefined()
    })
    function ngramSession(reps: number, tools: Array<[string, Record<string, unknown>]> = [
      ['Read', { file_path: '/p/a.ts' }],
      ['Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' }],
      ['Bash', { command: 'make render-one' }],
    ]): SessionBuilder {
      const b = new SessionBuilder()
      b.userPrompt('one file at a time')
      for (let i = 0; i < reps; i++) for (const [name, input] of tools) b.toolCall(name, { ...input }, 'ok')
      b.assistant([{ type: 'text', text: 'done' }])
      return b
    }
    it('fires on a 3-call tool sequence repeated 15x with the sequence + count in evidence', async () => {
      const ins = find(await analyzeOf(ngramSession(15)), 'script-candidate')!
      expect(ins).toBeDefined()
      const grams = ins.evidence['sequences'] as Array<{ gram: string; count: number }>
      expect(grams[0]!.gram).toBe('Read→Edit→Bash')
      expect(grams[0]!.count).toBe(15)
    })
    it('stays silent at 14 repeats of the sequence (fire-rate-tightened ×15 boundary)', async () => {
      expect(find(await analyzeOf(ngramSession(14)), 'script-candidate')).toBeUndefined()
    })
    it('leaves pure read/search sequences to sequential-reads (guard)', async () => {
      const b = ngramSession(16, [
        ['Read', { file_path: '/p/a.ts' }],
        ['Grep', { pattern: 'x' }],
        ['Read', { file_path: '/p/b.ts' }],
      ])
      expect(find(await analyzeOf(b), 'script-candidate')).toBeUndefined()
    })
    it('ignores homogeneous runs of one tool (needs 2+ distinct names in the sequence)', async () => {
      const b = new SessionBuilder()
      b.userPrompt('many different commands')
      const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi']
      for (const w of words) b.toolCall('Bash', { command: `make ${w}` }, 'ok')
      b.assistant([{ type: 'text', text: 'done' }])
      expect(find(await analyzeOf(b), 'script-candidate')).toBeUndefined()
    })
    it('attributes savings per context: agent repeats never pull in main-thread usage sharing the same turn numbers', async () => {
      const b = new SessionBuilder()
      // main thread, turn 0: one huge usage event with NO scriptable pattern
      b.userPrompt('big main work')
      b.assistant([{ type: 'text', text: 'thinking hard' }], { usage: { input_tokens: 400_000, output_tokens: 2_000, cache_read_input_tokens: 0 } })
      // subagent context: turn indexes restart at 0, so its turns collide with main-thread turn numbers
      b.sidechain('agentX')
      b.userPrompt('convert the files')
      for (let i = 0; i < 15; i++) b.toolCall('Bash', { command: `node scripts/convert.js --seed ${i} /Users/test/Code/demo/data/f${i}.json` }, 'converted', { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 } })
      b.assistant([{ type: 'text', text: 'done' }])
      b.sidechain('agentX', false)
      const ins = find(await analyzeOf(b), 'script-candidate')!
      expect(ins).toBeDefined()
      // agent context carries 15 × (10 in + 5 out) = 225 tokens; × (n-1)/n keeps it well under 1,000.
      // The bug matched the main thread's 402,000-token turn 0 into the estimate.
      expect(ins.savings?.tokens ?? 0).toBeLessThan(1_000)
      expect(ins.savings?.tokens ?? 0).toBeGreaterThan(0)
    })
  })

  describe('fanout-opportunity', () => {
    function serialAgents(n: number, opts: { dependent?: boolean; parallel?: boolean } = {}): SessionBuilder {
      const b = new SessionBuilder()
      b.userPrompt('do the chores')
      if (opts.parallel) {
        const ids = Array.from({ length: n }, () => fakeToolUseId())
        b.assistant(ids.map((id, i) => ({ type: 'tool_use' as const, id, name: 'Agent', input: { description: `chore ${i}`, prompt: `do chore number ${i} in module m${i}`, subagent_type: 'general-purpose' } })))
        ids.forEach((id, i) => b.toolResult(id, `finished chore ${i}`))
      } else {
        const prev = 'finished the setup work for module alpha completely'
        for (let i = 0; i < n; i++) {
          const prompt = opts.dependent && i > 0 ? `given "${prev}" continue with module m${i}` : `do chore number ${i} in module m${i}`
          b.toolCall('Agent', { description: `chore ${i}`, prompt, subagent_type: 'general-purpose' }, prev, { durationMs: 60_000 })
        }
      }
      b.assistant([{ type: 'text', text: 'done' }])
      return b
    }
    it('fires on 3 serial independent Agent calls with a time saving and the documented heuristic', async () => {
      const ins = find(await analyzeOf(serialAgents(3)), 'fanout-opportunity')!
      expect(ins).toBeDefined()
      expect(ins.axis).toBe('time')
      expect(typeof ins.evidence['heuristic']).toBe('string')
      expect(ins.savings?.ms).toBe(120_000) // 3x60s serial -> max 60s parallel
    })
    it('stays silent at 2 serial Agent calls (boundary)', async () => {
      expect(find(await analyzeOf(serialAgents(2)), 'fanout-opportunity')).toBeUndefined()
    })
    it('stays silent when later prompts quote the earlier result (dependency heuristic)', async () => {
      expect(find(await analyzeOf(serialAgents(3, { dependent: true })), 'fanout-opportunity')).toBeUndefined()
    })
    it('stays silent when the calls were already issued in parallel', async () => {
      expect(find(await analyzeOf(serialAgents(3, { parallel: true })), 'fanout-opportunity')).toBeUndefined()
    })

    // The spawn ToolCall resolves in milliseconds when the agent body lives in a sidecar (the tool_result
    // is a receipt, not the wait); the linked AgentRun carries the real span. Measuring the call reported
    // "save ~83ms" for 100 minutes of serial agent time on a real session, and called concurrent runs serial.
    function linkedAgents(n: number, opts: { overlap?: boolean } = {}): SessionBuilder {
      const b = new SessionBuilder()
      b.userPrompt('do the chores')
      const RUN_MS = 60_000
      for (let i = 0; i < n; i++) {
        const agentId = `agent${i}`
        // the spawn returns its receipt 10 ms later, agentId linking it to the run
        b.toolCall('Agent', { description: `chore ${i}`, prompt: `do chore number ${i} in module m${i}`, subagent_type: 'Explore' }, `queued chore ${i}`, {
          durationMs: 10,
          toolUseResult: { status: 'completed', agentId, content: [{ type: 'text', text: `queued chore ${i}` }] },
        })
        // the agent's own records span RUN_MS; with overlap every run starts at (nearly) the same instant
        if (opts.overlap) b.tick(-10 - i * 20 - (i ? RUN_MS : 0))
        b.sidechain(agentId)
        b.userPrompt(`chore ${i}`)
        b.tick(RUN_MS)
        b.assistant([{ type: 'text', text: 'done' }])
        b.sidechain(agentId, false)
        if (opts.overlap) b.tick(-RUN_MS + 30 + i * 20 + (i ? RUN_MS : 0))
      }
      b.tick(1000)
      b.assistant([{ type: 'text', text: 'done' }])
      return b
    }
    it('measures the linked agent run, not the millisecond spawn call', async () => {
      const a = await analyzeOf(linkedAgents(3))
      expect(a.agents.runs.filter((r) => r.spawnedByToolUseId).length).toBe(3)
      const ins = find(a, 'fanout-opportunity')!
      expect(ins).toBeDefined()
      // three serial 60 s runs (each span includes its 10 ms spawn) -> ~180 s serial vs ~60 s parallel;
      // the spawn calls alone would have claimed ~20 ms
      expect(ins.savings?.ms).toBeGreaterThanOrEqual(120_000)
      expect(ins.savings?.ms).toBeLessThan(121_000)
      const runs = ins.evidence['runs'] as Array<{ serialMs: number; longestMs: number }>
      expect(runs[0]!.serialMs).toBeGreaterThanOrEqual(180_000)
      expect(runs[0]!.longestMs).toBeGreaterThanOrEqual(60_000)
      expect(runs[0]!.longestMs).toBeLessThan(61_000)
    })
    it('stays silent when the spawned runs overlapped, however serial the spawn calls look', async () => {
      const a = await analyzeOf(linkedAgents(3, { overlap: true }))
      expect(a.agents.maxConcurrency).toBeGreaterThan(1)
      expect(find(a, 'fanout-opportunity')).toBeUndefined()
    })
  })

  describe('model-for-task', () => {
    function mechAgent(nMech: number, opts: { nHeavy?: number; nameOnly?: string } = {}): SessionBuilder {
      const b = new SessionBuilder()
      b.userPrompt('spawn the checker')
      const id = fakeToolUseId()
      b.assistant([
        {
          type: 'tool_use',
          id,
          name: 'Agent',
          input: opts.nameOnly
            ? { description: 'check', prompt: 'check things', name: opts.nameOnly }
            : { description: 'check', prompt: 'check things', subagent_type: 'mech-bot' },
        },
      ])
      const agentId = 'mech000000000001'
      b.sidechain(agentId)
      b.userPrompt('check things')
      for (let i = 0; i < nMech; i++) b.toolCall('Read', { file_path: `/p/f${i}.ts` }, 'content', { usage: { output_tokens: 50 } })
      for (let i = 0; i < (opts.nHeavy ?? 0); i++) b.assistant([{ type: 'text', text: `long analysis ${i}` }], { usage: { output_tokens: 5_000 } })
      b.sidechain('', false)
      b.toolResult(id, 'checked', { toolUseResult: { status: 'completed', agentId, content: [{ type: 'text', text: 'checked' }], totalDurationMs: 900, totalTokens: 2_000, totalToolUseCount: nMech } })
      b.assistant([{ type: 'text', text: 'done' }])
      return b
    }
    it('fires info naming the agent type and the tokens its mechanical requests moved', async () => {
      const ins = find(await analyzeOf(mechAgent(10)), 'model-for-task')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('info')
      expect(ins.title).toContain('mech-bot')
      const types = ins.evidence['agentTypes'] as Array<{ agentType: string; mechanicalRequests: number; mechanicalTokens: number }>
      expect(types[0]!.agentType).toBe('mech-bot')
      expect(types[0]!.mechanicalRequests).toBe(10)
      expect(types[0]!.mechanicalTokens).toBeGreaterThan(0)
      // routing the same requests to a smaller model sends the same tokens: no saving is claimed
      expect(ins.savings).toBeUndefined()
    })
    it('stays silent at 9 mechanical requests (boundary)', async () => {
      expect(find(await analyzeOf(mechAgent(9)), 'model-for-task')).toBeUndefined()
    })
    it('does not promote a transcript-authored display name into agentType evidence', async () => {
      const marker = 'private-agent-display-name-9073'
      const ins = find(await analyzeOf(mechAgent(10, { nameOnly: marker })), 'model-for-task')!
      expect(ins).toBeDefined()
      expect(JSON.stringify(ins)).not.toContain(marker)
      const types = ins.evidence['agentTypes'] as Array<{ agentType: string }>
      expect(types[0]!.agentType).toBe('unknown')
    })
    it('stays silent when the agent already runs on haiku', async () => {
      const b = new SessionBuilder({ model: 'claude-haiku-4-5-20251001' })
      b.userPrompt('spawn the checker')
      const id = fakeToolUseId()
      b.assistant([{ type: 'tool_use', id, name: 'Agent', input: { description: 'check', prompt: 'check things', subagent_type: 'mech-bot' } }])
      b.sidechain('mech000000000002')
      b.userPrompt('check things')
      for (let i = 0; i < 12; i++) b.toolCall('Read', { file_path: `/p/f${i}.ts` }, 'content', { usage: { output_tokens: 50 } })
      b.sidechain('', false)
      b.toolResult(id, 'checked')
      b.assistant([{ type: 'text', text: 'done' }])
      expect(find(await analyzeOf(b), 'model-for-task')).toBeUndefined()
    })
    it('stays silent below the 60% mechanical share (boundary)', async () => {
      expect(find(await analyzeOf(mechAgent(10, { nHeavy: 11 })), 'model-for-task')).toBeUndefined()
    })
  })

  describe('write-not-edit', () => {
    function writeAfterRead(n: number, opts: { writeChars?: number; readChars?: number } = {}): SessionBuilder {
      const b = new SessionBuilder()
      b.userPrompt('update the files')
      for (let i = 0; i < n; i++) {
        b.toolCall('Read', { file_path: `/p/mod${i}.ts` }, 'x'.repeat(opts.readChars ?? 3_000))
        b.toolCall('Write', { file_path: `/p/mod${i}.ts`, content: 'y'.repeat(opts.writeChars ?? 2_800) }, 'File created successfully')
      }
      b.assistant([{ type: 'text', text: 'done' }])
      return b
    }
    it('fires low with "Edit beats Write" on 2 same-length rewrites of files already read', async () => {
      const ins = find(await analyzeOf(writeAfterRead(2)), 'write-not-edit')!
      expect(ins).toBeDefined()
      expect(ins.severity).toBe('low')
      expect(ins.recommendation).toContain('Edit beats Write for modifications')
      expect((ins.evidence['rewrites'] as unknown[]).length).toBe(2)
    })
    it('stays silent on a single occurrence (boundary)', async () => {
      expect(find(await analyzeOf(writeAfterRead(1)), 'write-not-edit')).toBeUndefined()
    })
    it('stays silent when the written length is outside ±30% of the read length', async () => {
      expect(find(await analyzeOf(writeAfterRead(2, { writeChars: 1_200 })), 'write-not-edit')).toBeUndefined()
    })
    it('stays silent on small files (< 1 KB read)', async () => {
      expect(find(await analyzeOf(writeAfterRead(2, { readChars: 600, writeChars: 610 })), 'write-not-edit')).toBeUndefined()
    })
  })
})
