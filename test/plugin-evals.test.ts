import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { currencyHits, moneyHits } from './money-vocabulary.js'

// The behavioural suite `claude plugin eval` runs against plugin/. This file is the offline half:
// it pins the suite's shape (one positive case per shipped skill, negatives that must fire none,
// a graded transcript boundary), its hygiene (tokens and effort, no em dash, no personal path,
// synthetic fixtures only), and the way it is run (results ignored, a named script, a manual
// CI job that trusts the plugin, pins both models, keeps the report local and grants no tool).

const root = process.cwd()
const EVALS = 'plugin/evals'
const readText = (p: string): string => readFileSync(join(root, p), 'utf8')
const SKILLS = ['analyze', 'apply', 'feedback', 'harness', 'improve'] as const
const GRADER_TYPES = ['regex', 'tool_used', 'tool_order', 'file_exists', 'llm', 'baseline']
// prompt.md frontmatter keys the runner accepts; an unknown key fails the case at load time
const PROMPT_KEYS = ['schema_version', 'name', 'description', 'tags', 'plugins', 'runs', 'expected_outcome', 'model', 'max_turns', 'timeout_seconds', 'allowed_tools', 'append_system_prompt', 'env']
// tools a case may list without an operator grant; anything else is removed from the run
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'NotebookRead', 'Skill', 'Agent', 'TodoWrite', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop', 'TaskOutput']

interface Frontmatter { fields: Record<string, string>; body: string }
function frontmatter(path: string): Frontmatter {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(readText(path))
  if (!match) throw new Error(`${path} has no frontmatter`)
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split('\n')) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line)
    if (kv) fields[kv[1]!] = kv[2]!.trim()
  }
  return { fields, body: match[2]!.trim() }
}
const list = (value: string | undefined): string[] =>
  (value ?? '').replace(/^\[|\]$/g, '').split(',').map((item) => item.trim()).filter(Boolean)

// a case is a directory holding prompt.md or case.yaml; results/ and mocks/ are never cases
function caseDirs(dir = EVALS): string[] {
  if (!existsSync(join(root, dir))) return []
  const found: string[] = []
  for (const entry of readdirSync(join(root, dir)).sort()) {
    const rel = `${dir}/${entry}`
    if (!statSync(join(root, rel)).isDirectory() || entry === 'results' || entry === 'mocks') continue
    if (existsSync(join(root, rel, 'prompt.md')) || existsSync(join(root, rel, 'case.yaml'))) found.push(rel)
    else found.push(...caseDirs(rel))
  }
  return found
}
function filesUnder(dir: string): string[] {
  if (!existsSync(join(root, dir))) return []
  const files: string[] = []
  for (const entry of readdirSync(join(root, dir)).sort()) {
    const rel = `${dir}/${entry}`
    if (statSync(join(root, rel)).isDirectory()) {
      if (entry !== 'results') files.push(...filesUnder(rel))
    } else files.push(rel)
  }
  return files
}

interface Grader extends Frontmatter { file: string }
const graders = (caseDir: string): Grader[] => {
  const dir = join(root, caseDir, 'graders')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    .map((f) => ({ file: `${caseDir}/graders/${f}`, ...frontmatter(`${caseDir}/graders/${f}`) }))
}
const skillIndicator = (g: Grader): boolean => g.fields.type === 'tool_used' && g.fields.tool === 'Skill'
const skillNamed = (g: Grader): string | undefined => SKILLS.find((s) => (g.fields.input_match ?? '').includes(`${s}"`))
// "no orangu skill may fire": zero calls, scored in both arms so the baseline cannot inflate the delta
const forbidsAnySkill = (g: Grader): boolean =>
  skillIndicator(g) && g.fields.min === '0' && g.fields.max === '0' && g.fields.arm === 'both'
const firesSkill = (g: Grader): string | undefined => (skillIndicator(g) && g.fields.min !== '0' ? skillNamed(g) : undefined)
// the slash form (`/orangu:apply ...`) expands the skill inline with no Skill tool call, so the apply case
// proves the skill ran by what only the skill knows: it demands an `sg_` id before touching anything
const provesApply = (dir: string, g: Grader): boolean =>
  basename(dir).startsWith('apply-') && g.fields.type === 'regex' && /sg_/.test(g.fields.pattern ?? '')

describe('plugin eval suite', () => {
  const cases = caseDirs()

  it('ships one case that should fire each skill and at least two that must fire none', () => {
    expect(cases.length, 'cases under plugin/evals').toBeGreaterThanOrEqual(SKILLS.length + 2)
    const fired = new Map<string, string[]>()
    let negatives = 0
    for (const dir of cases) {
      const gs = graders(dir)
      for (const g of gs) {
        const s = firesSkill(g) ?? (provesApply(dir, g) ? 'apply' : undefined)
        if (s) fired.set(s, [...(fired.get(s) ?? []), dir])
      }
      for (const g of gs.filter(forbidsAnySkill)) {
        // either input form, every shipped skill: a negative that only knew one form could never fail
        expect(g.fields.input_match, `${g.file} accepts the plugin-qualified form`).toContain('(?:[\\w-]+:)?')
        for (const s of SKILLS) expect(g.fields.input_match, `${g.file} names ${s}`).toContain(s)
      }
      if (gs.some(forbidsAnySkill)) negatives++
    }
    for (const s of SKILLS) expect(fired.get(s), `a case expects /orangu:${s} to fire`).toBeTruthy()
    expect(negatives, 'cases that forbid every orangu skill').toBeGreaterThanOrEqual(2)
  })

  it('every case is a natural prompt inside the documented run limits, requesting read-only tools only', () => {
    for (const dir of cases) {
      expect(existsSync(join(root, dir, 'prompt.md')), `${dir} has prompt.md`).toBe(true)
      const { fields, body } = frontmatter(`${dir}/prompt.md`)
      for (const key of Object.keys(fields)) expect(PROMPT_KEYS, `${dir}: unknown prompt.md key ${key}`).toContain(key)
      if (fields.name) expect(fields.name, `${dir} name matches its directory`).toBe(basename(dir))
      expect(fields.description, `${dir} says what it checks`).toBeTruthy()
      expect(fields.expected_outcome, `${dir} says what a good run looks like`).toBeTruthy()
      expect(list(fields.tags).length, `${dir} carries a tag`).toBeGreaterThan(0)
      expect(body.length, `${dir} has a prompt`).toBeGreaterThan(20)
      if (fields.max_turns) expect(Number(fields.max_turns)).toBeLessThanOrEqual(200)
      const tools = list(fields.allowed_tools)
      expect(tools, `${dir} lets the skill be invoked`).toContain('Skill')
      for (const tool of tools) expect(READ_ONLY_TOOLS, `${dir} requests a tool that needs an operator grant: ${tool}`).toContain(tool)
      // a routing case is phrased the way a person types, never by naming the skill; the slash form
      // is the realistic prompt only for apply, which is invoked explicitly by design
      if (!basename(dir).startsWith('apply-')) expect(body, `${dir} prompt does not name a skill`).not.toMatch(/\/orangu:|orangu:[a-z]/)
    }
  })

  it('every grader has a known type, and every case grades both the result and the path Claude took', () => {
    for (const dir of cases) {
      const gs = graders(dir)
      expect(gs.length, `${dir} has at least two graders`).toBeGreaterThanOrEqual(2)
      for (const g of gs) {
        expect(GRADER_TYPES, `${g.file} type`).toContain(g.fields.type)
        if (g.fields.type === 'regex') expect(g.fields.pattern, `${g.file} has a pattern`).toBeTruthy()
        if (g.fields.type === 'tool_used') expect(g.fields.tool, `${g.file} names a tool`).toBeTruthy()
        if (g.fields.type === 'llm') {
          expect(g.body, `${g.file} carries a rubric`).toMatch(/PASS if/)
          expect(g.body, `${g.file} names the failure`).toMatch(/FAIL if/)
        }
      }
      // at least one grader counts in both arms, so the case has a score the baseline can be compared on
      const scored = gs.filter((g) => !(skillIndicator(g) && g.fields.arm !== 'both') && g.fields.arm !== 'with-only')
      expect(scored.length, `${dir} has a grader that is scored against the baseline`).toBeGreaterThan(0)
    }
  })

  it('a plugin-fired indicator names a shipped skill in its namespaced form', () => {
    let indicators = 0
    for (const dir of cases) {
      for (const g of graders(dir).filter((g) => skillIndicator(g) && g.fields.min !== '0')) {
        indicators++
        expect(g.fields.input_match, `${g.file} accepts the plugin-qualified skill name`).toContain('(?:[\\w-]+:)?')
        expect(skillNamed(g), `${g.file} names a shipped skill`).toBeTruthy()
      }
    }
    // every skill but apply, whose slash-invoked case cannot see a Skill call (see provesApply)
    expect(indicators).toBeGreaterThanOrEqual(SKILLS.length - 1)
    for (const dir of cases.filter((d) => basename(d).startsWith('apply-')))
      expect(graders(dir).some(skillIndicator), `${dir} carries no Skill indicator: the slash form never calls the Skill tool`).toBe(false)
  })

  it('grades the transcript boundary in both arms wherever a transcript is offered, with a tiny synthetic fixture', () => {
    const offered = cases.filter((dir) => filesUnder(dir).some((f) => f.endsWith('.jsonl')))
    expect(offered.length, 'a case offers a transcript to tempt a direct read').toBeGreaterThan(0)
    for (const dir of offered) {
      const guard = graders(dir).find((g) =>
        g.fields.type === 'tool_used' && g.fields.tool === 'Read' && /jsonl/.test(g.fields.input_match ?? '')
        && g.fields.min === '0' && g.fields.max === '0' && g.fields.arm === 'both')
      expect(guard, `${dir} forbids a direct Read of the transcript in both arms`).toBeTruthy()
      expect(readText(`${dir}/case.yaml`), `${dir} grants the fixture directory`).toMatch(/add_dirs:/)
      for (const fixture of filesUnder(dir).filter((f) => f.endsWith('.jsonl'))) {
        const lines = readText(fixture).trimEnd().split('\n')
        expect(lines.length, `${fixture} stays tiny`).toBeLessThanOrEqual(40)
        for (const line of lines) expect(() => JSON.parse(line), `${fixture} is JSON per line`).not.toThrow()
        expect(readText(fixture), `${fixture} is synthetic`).toMatch(/"sessionId":"eval-/)
      }
    }
  })

  it('the suite speaks tokens and effort, with no em dash and no personal path', () => {
    const files = filesUnder(EVALS)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readText(file)
      expect(currencyHits(text), `${file} quotes no currency amount`).toEqual([])
      expect(moneyHits(text), `${file} uses money vocabulary`).toEqual([])
      expect(text, `${file} carries an em dash`).not.toContain('—')
      expect(text, `${file} carries a personal path`).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\Users\\/)
    }
  })

  it('ignores eval results and exposes the run as a named script', () => {
    expect(readText('.gitignore')).toContain('/plugin/evals/results/')
    const pkg = JSON.parse(readText('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['eval:plugin']).toMatch(/^claude plugin eval \.\/plugin\b/)
    expect(pkg.scripts['eval:plugin']).toContain('--no-publish')
  })

  it('splits the cases into a train set to improve against and a held-out set that is never tuned on', () => {
    // Held out: one routing case per skill family that has more than one, plus one negative. Improving a skill against
    // the same cases that judge it rewards the suite's quirks; train up with holdout flat is the overfitting sign.
    const HOLDOUT = ['analyze-live-session', 'harness-global-declared-vs-used', 'ignores-a-jsonl-coding-question', 'improve-from-suggestion-id']
    const split = new Map<string, string[]>()
    for (const dir of cases) {
      const tags = list(frontmatter(`${dir}/prompt.md`).fields.tags)
      const sides = tags.filter((tag) => tag === 'train' || tag === 'holdout')
      expect(sides, `${dir} is tagged train or holdout, exactly once`).toHaveLength(1)
      if (existsSync(join(root, dir, 'case.yaml'))) {
        const yamlTags = list(/^tags:\s*(.*)$/m.exec(readText(`${dir}/case.yaml`))?.[1])
        expect(yamlTags, `${dir} case.yaml tags match prompt.md`).toEqual(tags)
      }
      split.set(basename(dir), tags)
    }
    const holdout = [...split].filter(([, tags]) => tags.includes('holdout')).map(([name]) => name).sort()
    expect(holdout).toEqual(HOLDOUT)
    expect(holdout.some((name) => split.get(name)!.includes('negative')), 'holdout keeps a negative').toBe(true)
    expect(holdout.some((name) => split.get(name)!.includes('routing')), 'holdout keeps a routing case').toBe(true)
    const pkg = JSON.parse(readText('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['eval:plugin:train']).toBe('claude plugin eval ./plugin --no-publish --tag train')
    expect(pkg.scripts['eval:plugin:holdout']).toBe('claude plugin eval ./plugin --no-publish --tag holdout')
  })

  it('documents how to improve the skills against the suite without fooling yourself', () => {
    const readme = readText(`${EVALS}/README.md`)
    expect(readme).toContain('## Improving the skills against this suite')
    expect(readme).toContain('npm run eval:plugin:train')
    expect(readme).toContain('npm run eval:plugin:holdout')
    expect(readme, 'overfitting sign').toMatch(/train[^\n]*up[^\n]*holdout[^\n]*flat/i)
    expect(readme, 'no pasting failures into a skill').toMatch(/never paste a failing prompt or reply into a skill/i)
    expect(readme, 'headroom').toMatch(/0\.95/)
    expect(readme, 'plumbing is not a skill failure').toMatch(/grader that threw[^\n]*not a skill failure/i)
    expect(readme, 'read graded runs before trusting a score').toMatch(/read a sample of graded runs/i)
  })

  it('CI runs the suite only on demand: trusted, both models pinned, local report, spend ceiling, no tool grant', () => {
    const workflow = readText('.github/workflows/plugin-evals.yml')
    expect(workflow).toMatch(/\non:\n  workflow_dispatch:/)
    expect(workflow, 'never on push or pull request: every run is a batch of real model calls').not.toMatch(/\n  push:|\n  pull_request:/)
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('secrets.ANTHROPIC_API_KEY')
    // --report <path> is in `claude plugin eval --help` (2.1.273) and wrote both local reports on 2026-09-16
    for (const flag of ['claude plugin eval ./plugin', '--trust-plugin', '--json', '--report', '--threshold', '--model claude-sonnet-5', '--judge-model claude-haiku-4-5', '--no-publish', '--max-cost-usd'])
      expect(workflow, `workflow passes ${flag}`).toContain(flag)
    for (const grant of ['--allow-tools', '--scaffold', '--mocks off', '--allow-real-servers'])
      expect(workflow, `workflow never widens the run with ${grant}`).not.toContain(grant)
    // inputs reach the shell through the environment, never by interpolation into the script
    expect(workflow).not.toMatch(/run:[\s\S]*?\$\{\{\s*inputs\./)
  })

  it('documents what the suite grades, what it deliberately leaves to npm test, and how to iterate', () => {
    const readme = readText(`${EVALS}/README.md`)
    expect(readme).toContain('claude plugin eval')
    expect(readme).toContain('--ablation none')
    expect(readme, 'names the without-plugin arm').toMatch(/baseline|without the plugin/i)
    expect(readme, 'says the CLI is not exercised because Bash is not granted').toContain('Bash')
    expect(readme).toContain('npm run eval:plugin')
  })
})
