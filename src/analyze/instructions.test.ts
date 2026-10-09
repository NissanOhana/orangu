import { describe, expect, it } from 'vitest'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from './analyze.js'
import { SessionBuilder } from '../../test/fixtures/session-builder.js'
import { commandSegments, contentWords, extractRules, matchCommand, noteKindOf, parseMemoryWarning, type RuleTarget } from './instructions.js'
import type { Analysis } from '../model/analysis.js'

const targets = (text: string, servers: string[] = []): RuleTarget[] => extractRules(text, new Set(servers)).flatMap((r) => r.targets)

describe('extractRules: the rule grammar', () => {
  it('reads each code span of a "never run" clause as a command', () => {
    expect(targets('- **Never run `npx tsc --noEmit` or `next build` bare.** Both abort with a heap SIGABRT.')).toEqual([
      { kind: 'command', name: 'npx tsc --noEmit' },
      { kind: 'command', name: 'next build' },
    ])
  })

  it('ends the sentence inside bold markers, so the advice in the next sentence is not a target', () => {
    expect(targets('- **Never run `npx tsc --noEmit` or `next build` bare.** Both abort on this tree: `npm run check:tsc-baseline` sets the heap.')).toEqual([
      { kind: 'command', name: 'npx tsc --noEmit' },
      { kind: 'command', name: 'next build' },
    ])
  })

  it('stops the clause at a dash, so the advice after it is not a target', () => {
    expect(targets('never use `db:push` for verification in this repo — use `npm run db:migrate:local` plus a check')).toEqual([{ kind: 'command', name: 'db:push' }])
  })

  it('reads "do not use for:" and a list after it', () => {
    expect(targets('**Do NOT use for:** UPDATE/DELETE/INSERT or `drizzle-kit push`. This is prod.')).toEqual([{ kind: 'command', name: 'drizzle-kit push' }])
  })

  it('reads "use X, not Y", "use X instead of Y" and "prefer X over Y" as a rule against Y', () => {
    expect(targets('Use `pnpm`, not `npm`.')).toEqual([{ kind: 'command', name: 'npm' }])
    expect(targets('Use the Read tool instead of `cat`.')).toEqual([{ kind: 'command', name: 'cat' }])
    expect(targets('Prefer `rg` over `grep` for search.')).toEqual([{ kind: 'command', name: 'grep' }])
  })

  it('names an MCP server by a plain word only when the session knows that server', () => {
    const line = 'Use the claude-in-chrome browser, not playwright.'
    expect(targets(line)).toEqual([])
    expect(targets(line, ['playwright', 'claude-in-chrome'])).toEqual([{ kind: 'mcp-server', name: 'playwright' }])
    expect(targets('Never use `mcp__playwright__*` for screenshots.')).toEqual([{ kind: 'mcp-server', name: 'playwright' }])
  })

  it('reads a long flag and a distinctive tool name', () => {
    expect(targets('Never use `--no-verify` on a commit.')).toEqual([{ kind: 'flag', name: '--no-verify' }])
    expect(targets('Do not use `WebFetch` for GitHub. Use gh instead.')).toEqual([{ kind: 'tool', name: 'WebFetch' }])
    expect(targets('Avoid TodoWrite in short tasks.')).toEqual([{ kind: 'tool', name: 'TodoWrite' }])
  })

  it('finds no target in prose rules, paths, or a sentence that only says "not"', () => {
    expect(targets('Do not use contractions, semicolons or em dashes.')).toEqual([])
    expect(targets('Never commit to `main`.')).toEqual([])
    expect(targets('This is not `src/foo.ts`, it is the other file.')).toEqual([])
    expect(targets('Never run `npm ci` through a symlinked `node_modules`.')).toEqual([{ kind: 'command', name: 'npm ci' }])
    expect(targets('Do not use `Bash` to read a file.')).toEqual([])
  })

  it('reads a double-backtick span as one span, and no prose or tagged template as a command', () => {
    expect(targets('- **Never call a `Date` method on an aggregate from a raw `` sql`x` `` template** - the driver returns those as **strings** at runtime.')).toEqual([])
    expect(targets('Never run `` npm run x`` here.')).toEqual([{ kind: 'command', name: 'npm run x' }])
    expect(targets('Never use `the driver returns those as strings at runtime regardless of it`.')).toEqual([])
  })

  it('reads every negative verb form and every connector', () => {
    expect(targets("Don't use `yarn` here.")).toEqual([{ kind: 'command', name: 'yarn' }])
    expect(targets('You must not run `make deploy` from a branch.')).toEqual([{ kind: 'command', name: 'make deploy' }])
    expect(targets('Stop using `npm install` in this repo.')).toEqual([{ kind: 'command', name: 'npm install' }])
    expect(targets('Never execute `terraform apply` by hand.')).toEqual([{ kind: 'command', name: 'terraform apply' }])
    expect(targets('Use `rg` rather than `grep -r`.')).toEqual([{ kind: 'command', name: 'grep -r' }])
    // "invoke" and "call" are about code: only a tool or a server is a target
    expect(targets('Never invoke `WebFetch` or `fetchAll` for GitHub.')).toEqual([{ kind: 'tool', name: 'WebFetch' }])
  })

  it('ends the clause at a condition, so the command the rule asks for is not a target', () => {
    expect(targets('Never run `git commit` without `npm run verify` first.')).toEqual([{ kind: 'command', name: 'git commit' }])
    expect(targets('Do not run `git push` before `npm test` passes.')).toEqual([{ kind: 'command', name: 'git push' }])
    expect(targets('Never run `vitest` when `--run` is missing.')).toEqual([{ kind: 'command', name: 'vitest' }])
  })

  it('gives the 1-based line and the whole trimmed line', () => {
    const r = extractRules('# Rules\n\n  - Never run `make clean` here.  \n')
    expect(r).toEqual([{ line: 3, text: '- Never run `make clean` here.', targets: [{ kind: 'command', name: 'make clean' }] }])
  })
})

describe('matchCommand', () => {
  it('matches a segment that starts with the target, or with a runner and then the target', () => {
    expect(matchCommand('next build', 'next build')).toBe('next build')
    expect(matchCommand('npx next build --debug', 'next build')).toBe('npx next build')
    expect(matchCommand('npm run db:push -- --force', 'db:push')).toBe('npm run db:push')
    expect(matchCommand('npx tsc --noEmit -p tsconfig.json', 'npx tsc --noEmit')).toBe('npx tsc --noEmit')
  })

  it('matches after each runner', () => {
    for (const [seg, hit] of [
      ['pnpm db:push', 'pnpm db:push'],
      ['pnpm run db:push', 'pnpm run db:push'],
      ['pnpm exec db:push', 'pnpm exec db:push'],
      ['yarn db:push', 'yarn db:push'],
      ['yarn run db:push', 'yarn run db:push'],
      ['bunx db:push', 'bunx db:push'],
      ['bun run db:push', 'bun run db:push'],
      ['npm exec db:push', 'npm exec db:push'],
    ]) {
      expect(matchCommand(seg!, 'db:push'), seg).toBe(hit)
    }
  })

  it('holds a "bare" rule: an env assignment in front is not a match', () => {
    expect(matchCommand('NODE_OPTIONS=--max-old-space-size=8192 next build', 'next build')).toBeNull()
  })

  it('needs a word boundary after the target', () => {
    expect(matchCommand('npm cit', 'npm ci')).toBeNull()
    expect(matchCommand('next buildx', 'next build')).toBeNull()
    expect(matchCommand('echo next build', 'next build')).toBeNull()
  })
})

describe('commandSegments', () => {
  it('leaves heredoc bodies and quoted text out of the commands', () => {
    const commit = "git commit -m \"$(cat <<'EOF'\nfix: build\n\nnpx tsc --noEmit with NODE_OPTIONS passes\nEOF\n)\" && git push"
    expect(commandSegments(commit)).toEqual(["git commit -m ''", 'git push'])
    expect(commandSegments("echo 'next build; npm ci' && next build")).toEqual(["echo ''", 'next build'])
  })
})

describe('parseMemoryWarning', () => {
  it('reads the byte form that Claude Code writes', () => {
    const w = '> WARNING: MEMORY.md is 25.1KB (limit: 24.4KB) — index entries are too long. Only part of it was loaded: 5 of 115 lines were cut off, starting at line 111 ("- [x](y.md) —…"). Keep index entries to one line under ~200 chars; move detail into topic files.'
    expect(parseMemoryWarning(w)).toEqual({ over: 'bytes', totalLines: 115, linesCut: 5, firstCutLine: 111 })
  })

  it('reads the line form, both limits, and the one-long-line form', () => {
    expect(parseMemoryWarning('MEMORY.md is 230 lines (limit: 200). Only part of it was loaded: 30 of 230 lines were cut off, starting at line 201. Keep index entries short')).toEqual({ over: 'lines', totalLines: 230, linesCut: 30, firstCutLine: 201 })
    expect(parseMemoryWarning('MEMORY.md is 230 lines and 30.2KB. Only part of it was loaded: 40 of 230 lines were cut off, starting at line 191. Keep index entries short')).toEqual({ over: 'both', totalLines: 230, linesCut: 40, firstCutLine: 191 })
    expect(parseMemoryWarning('MEMORY.md is 40.0KB (limit: 24.4KB) — index entries are too long. Only part of it was loaded: everything after the first 25000 characters of line 1 was cut off. Keep index entries short')).toEqual({ over: 'bytes', firstCutLine: 1 })
    expect(parseMemoryWarning('# a normal memory index')).toBeNull()
  })
})

describe('noteKindOf and contentWords', () => {
  it('names the instruction and memory files', () => {
    expect(noteKindOf('/Users/test/.claude/projects/-Users-test-Code-x/memory/feedback_screens.md')).toBe('memory')
    expect(noteKindOf('/Users/test/.claude/projects/-Users-test-Code-x/memory/MEMORY.md')).toBe('memory-index')
    expect(noteKindOf('/Users/test/Code/x/CLAUDE.md')).toBe('claude-md')
    expect(noteKindOf('/Users/test/Code/x/AGENTS.md')).toBe('agents-md')
    expect(noteKindOf('/Users/test/Code/x/.claude/rules/testing.md')).toBe('rules')
    expect(noteKindOf('/Users/test/Code/x/README.md')).toBeUndefined()
  })

  it('keeps distinct content words in order and drops stop words and frontmatter keys', () => {
    expect(contentWords('---\nname: screens\ndescription: Check every screen size before done\n---\nCheck the desktop and the mobile layout. Desktop first.')).toEqual(['screens', 'check', 'screen', 'size', 'desktop', 'mobile', 'layout'])
  })
})

async function analyzeOf(b: SessionBuilder): Promise<Analysis> {
  const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
  return analyzeSession(s, { version: 'test', now: 0 })
}

const CLAUDE_MD = '# Rules\n- **Never run `next build` bare.** Set NODE_OPTIONS first.\n'
const MEMORY_MD = '- [Screens](feedback_screens.md) — check every screen size\n> WARNING: MEMORY.md is 25.1KB (limit: 24.4KB) — index entries are too long. Only part of it was loaded: 5 of 115 lines were cut off, starting at line 111 ("x"). Keep index entries to one line under ~200 chars; move detail into topic files.'

describe('analyzeInstructions on a parsed session', () => {
  it('counts the calls that broke a loaded rule after it entered the context, main and agents apart', async () => {
    const b = new SessionBuilder()
    b.toolCall('Bash', { command: 'next build' }, 'ok') // before the rule was loaded: not counted
    b.attachment('instructions', {
      files: [
        { path: '/Users/test/Code/x/CLAUDE.md', type: 'Project', content: CLAUDE_MD },
        { path: '/Users/test/.claude/projects/-Users-test-Code-x/memory/MEMORY.md', type: 'AutoMem', content: MEMORY_MD },
      ],
    })
    b.userPrompt('ship it')
    b.tick(1000)
    b.toolCall('Bash', { command: 'cd web && next build' }, 'ok')
    b.toolCall('Bash', { command: 'NODE_OPTIONS=--max-old-space-size=8192 next build' }, 'ok')
    b.sidechain('a1')
    b.toolCall('Bash', { command: 'npx next build --debug' }, 'ok')
    b.sidechain('a1', false)
    const a = await analyzeOf(b)
    const ins = a.instructions!
    expect(ins.loaded.map((l) => [l.path.split('/').pop(), l.type])).toEqual([
      ['CLAUDE.md', 'Project'],
      ['MEMORY.md', 'AutoMem'],
    ])
    expect(ins.rules).toHaveLength(1)
    expect(ins.rules[0]).toMatchObject({ source: 'loaded', line: 2, target: { kind: 'command', name: 'next build' }, calls: 2, agentCalls: 1, examples: ['next build', 'npx next build'] })
    expect(ins.memoryCuts).toEqual([expect.objectContaining({ over: 'bytes', totalLines: 115, linesCut: 5, firstCutLine: 111 })])
  })

  it('counts a call that a PreToolUse hook or a deny rule stopped as blocked', async () => {
    const b = new SessionBuilder()
    b.attachment('instructions', { files: [{ path: '/Users/test/Code/x/CLAUDE.md', type: 'Project', content: CLAUDE_MD }] })
    b.userPrompt('build').tick(1000)
    b.toolCall('Bash', { command: 'next build' }, 'PreToolUse:Bash hook error: next build on this tree needs an 8 GB heap', { isError: true })
    b.toolCall('Bash', { command: 'next build' }, 'Permission to use Bash with command next build has been denied.', { isError: true })
    b.toolCall('Bash', { command: 'next build' }, 'Error: build failed', { isError: true })
    const r = (await analyzeOf(b)).instructions!.rules[0]!
    expect(r).toMatchObject({ calls: 3, blocked: 2 })
  })

  it('treats a note the session wrote as in context from the write, and records the write', async () => {
    const b = new SessionBuilder()
    b.userPrompt('you are not checking every screen size!')
    b.toolCall('Bash', { command: 'npm run deploy' }, 'ok')
    b.toolCall('Write', { file_path: '/Users/test/.claude/projects/-Users-test-Code-x/memory/feedback_deploy.md', content: '---\nname: deploy\n---\nNever run `npm run deploy` before the viewport check.' }, 'ok')
    b.tick(60_000)
    b.userPrompt('broken on desktop')
    b.toolCall('Bash', { command: 'npm run deploy' }, 'ok')
    const ins = (await analyzeOf(b)).instructions!
    expect(ins.noteWrites).toEqual([expect.objectContaining({ kind: 'memory', words: ['deploy', 'viewport', 'check'] })])
    expect(ins.rules).toEqual([expect.objectContaining({ source: 'written', target: { kind: 'command', name: 'npm run deploy' }, calls: 1, agentCalls: 0 })])
  })

  it('gives a rule that an Edit wrote line 0, because a snippet carries no file line', async () => {
    const b = new SessionBuilder()
    b.userPrompt('save the rule')
    b.toolCall('Edit', { file_path: '/Users/test/Code/x/CLAUDE.md', old_string: 'a', new_string: 'x\nNever run `make clean` here.' }, 'ok')
    b.tick(1000)
    b.toolCall('Bash', { command: 'make clean' }, 'ok')
    expect((await analyzeOf(b)).instructions!.rules).toEqual([expect.objectContaining({ source: 'written', line: 0, calls: 1 })])
  })

  it('gives empty arrays to a session with no instructions record', async () => {
    const b = new SessionBuilder()
    b.userPrompt('hi')
    expect((await analyzeOf(b)).instructions).toEqual({ loaded: [], rules: [], noteWrites: [], memoryCuts: [] })
  })
})
