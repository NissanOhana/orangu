import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { currencyHits, moneyHits } from './money-vocabulary.js'
import { CHANGE_CLASS_DEFINITIONS } from '../src/suggest/change-classes.js'
import { allEntries } from '../src/suggest/catalog.js'
import { showMeChecks } from './fixtures/show-me-fill.js'

const root = process.cwd()
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'))
const readText = (p: string): string => readFileSync(join(root, p), 'utf8')

function filesWith(extensions: readonly string[], ...dirs: string[]): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir))) {
      const rel = `${dir}/${entry}`
      if (statSync(join(root, rel)).isDirectory()) walk(rel)
      else if (extensions.some((extension) => rel.endsWith(extension))) files.push(rel)
    }
  }
  for (const dir of dirs) walk(dir)
  return files.sort()
}
const markdownFiles = (...dirs: string[]): string[] => filesWith(['.md'], ...dirs)

// The normative shell-data and untrusted-content rules live in ONE file; each skill/agent keeps
// two inline sentences plus a link. Guards read the pair so the guarantee stays reachable.
const SHARED_RULES = 'plugin/skills/shared/untrusted-input.md'
// every skill and agent links the shared rules from its own tree (plugin/skills, plugin/agents, or a
// generated Codex mirror); follow that link so the guarantee is checked where the model would read it
const withSharedRules = (path: string): string => {
  const text = readText(path)
  const link = /\]\(([^)]*untrusted-input\.md)\)/.exec(text)?.[1]
  if (!link) throw new Error(`${path} does not link the shared untrusted-input rules`)
  return `${text}\n${readText(join(dirname(path), link))}`
}

// The show-me templates ship under plugin/skills as .html and become the pages a user shares, so the
// public-copy guards (money, claims, em dash) read them beside the Markdown.
function pluginPublicCopy(): Array<{ path: string; text: string }> {
  const markdown = filesWith(['.md', '.html'], 'plugin/skills', 'plugin/agents')
    .map((path) => ({ path, text: readText(path) }))
  return [
    ...markdown,
    { path: 'plugin/.claude-plugin/plugin.json', text: JSON.stringify(readJson('plugin/.claude-plugin/plugin.json')) },
    { path: '.claude-plugin/marketplace.json', text: JSON.stringify(readJson('.claude-plugin/marketplace.json')) },
  ]
}

describe('plugin packaging', () => {
  it('plugin.json is valid and named orangu', () => {
    const p = readJson('plugin/.claude-plugin/plugin.json')
    expect(p.name).toBe('orangu')
    expect(p.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(typeof p.description).toBe('string')
    expect(p.description.length).toBeLessThan(1536)
  })
  it('marketplace.json lists the orangu plugin from ./plugin', () => {
    const m = readJson('.claude-plugin/marketplace.json')
    expect(m.plugins.some((x: { name: string; source: string }) => x.name === 'orangu' && x.source === './plugin')).toBe(true)
  })
  it('ships the six intended /orangu:* commands with valid frontmatter', () => {
    const skills = ['analyze', 'apply', 'feedback', 'harness', 'improve', 'show-me']
    const namespace = readJson('plugin/.claude-plugin/plugin.json').name
    expect(readdirSync(join(root, 'plugin/skills')).filter((entry) => existsSync(join(root, 'plugin/skills', entry, 'SKILL.md'))).sort()).toEqual([...skills].sort())
    for (const s of skills) {
      const md = readFileSync(join(root, 'plugin/skills', s, 'SKILL.md'), 'utf8')
      const fm = /^---\n([\s\S]*?)\n---/.exec(md)
      expect(fm, `${s} has frontmatter`).toBeTruthy()
      const block = fm![1]!
      expect(`/${namespace}:${s}`).toBe(`/orangu:${s}`)
      expect(block).not.toContain(`name: orangu-${s}`)
      expect(block).toMatch(new RegExp(`name:\\s*${s}`))
      // description present, single line, under the 1536 truncation budget
      const desc = /description:\s*(.+)/.exec(block)?.[1] ?? ''
      expect(desc.length).toBeGreaterThan(40)
      expect(desc.length).toBeLessThan(1536)
      // the host support matrix lives in the body (one line under the H1), never in the resident description
      expect(desc, `${s} description carries no host boilerplate`).not.toContain('Cowork')
      const body = md.slice(fm![0].length)
      for (const source of ['Claude Code', 'Cowork', 'Desktop']) expect(body, `${s} body names supported ${source} sources`).toContain(source)
      if (md.includes('.jsonl')) expect(md.toLowerCase(), `${s} forbids direct transcript reads`).toMatch(/never (?:read|open)[^\n]*\.jsonl/)
    }
  })
  it('the analyze skill forbids reading jsonl transcripts directly', () => {
    const md = readFileSync(join(root, 'plugin/skills/analyze/SKILL.md'), 'utf8')
    expect(md.toLowerCase()).toContain('never read')
    expect(md).toContain('.jsonl')
  })
  it('ships no active or inert session hooks', () => {
    expect(existsSync(join(root, 'plugin/hooks/hooks.json'))).toBe(false)
    expect(existsSync(join(root, 'plugin/optional-hooks'))).toBe(false)
  })
  it('improve and harness declare proposal-only writes with no edit grant', () => {
    for (const s of ['improve', 'harness']) {
      const md = readFileSync(join(root, 'plugin/skills', s, 'SKILL.md'), 'utf8')
      const fm = /^---\n([\s\S]*?)\n---/.exec(md)!
      const allowed = /allowed-tools:\s*(.+)/.exec(fm[1]!)?.[1] ?? ''
      expect(allowed, `${s} has allowed-tools`).toBeTruthy()
      expect(allowed).not.toMatch(/\bEdit\b/)
      // the only Write grant is the orangu proposals dir
      const writes = allowed.match(/Write\([^)]*\)|Write(?!\()/g) ?? []
      for (const w of writes) expect(w, `${s} write grant is proposals-scoped: ${w}`).toMatch(/^Write\(~\/\.orangu\//)
    }
    // the only grant that can reach a repository edit is the apply skill itself, one approved id per call
    const harness = /^allowed-tools:\s*(.+)$/m.exec(readText('plugin/skills/harness/SKILL.md'))?.[1] ?? ''
    expect(harness, 'harness may invoke apply through the Skill tool').toContain('Skill(orangu:apply)')
  })
  // A `*` in a Bash rule matches any text, so only the text before the first `*` limits it. `node *orangu.cli.mjs*`
  // also matched `node -e "<code>" …/orangu.cli.mjs`, which ran injected code with no prompt. A node grant now names the
  // plugin's CLI file before its `*`, so node can run only that file.
  it('no skill pre-approves a node command that can run code other than the plugin CLI', () => {
    const PLUGIN_CLI = 'Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/orangu.cli.mjs" '
    const probes = ['node -e "x"', 'node --eval "x"', 'node -p "x"', 'node --print "x"', 'node -r ./x.js y', 'node --require ./x.js y', 'node --import ./x.mjs y', 'node ./evil.mjs', 'node /tmp/x/orangu.cli.mjs.js']
    const skills = readdirSync(join(root, 'plugin/skills')).filter((entry) => existsSync(join(root, 'plugin/skills', entry, 'SKILL.md')))
    let nodeGrants = 0
    for (const s of skills) {
      const allowed = (/^allowed-tools:\s*(.+)$/m.exec(readText(`plugin/skills/${s}/SKILL.md`))?.[1] ?? '').split(',').map((grant) => grant.trim())
      for (const grant of allowed) {
        const rule = /^Bash\((.*)\)$/.exec(grant)?.[1]
        if (rule === undefined) continue
        const star = rule.indexOf('*')
        const prefix = rule.endsWith(':*') ? rule.slice(0, -2) : star === -1 ? rule : rule.slice(0, star)
        for (const probe of probes) expect(probe.startsWith(prefix), `${s}: ${grant} pre-approves ${probe}`).toBe(false)
        if (rule.startsWith('node')) {
          nodeGrants += 1
          expect(grant.startsWith(PLUGIN_CLI), `${s} names the plugin CLI before its *: ${grant}`).toBe(true)
        }
      }
    }
    // 5 -> 7 when apply lost its bare Bash grant: apply keeps the CLI fallback as 2 grants, one for each verb that it
    // runs (suggest, ste), and each names the plugin CLI and the verb before its *.
    expect(nodeGrants, 'analyze, feedback, harness, improve and show-me keep one CLI fallback, apply keeps 2').toBe(7)
  })

  // apply edits a repository, so it pre-approves only what it must run with no prompt: the 2 orangu verbs that it
  // runs (suggest, ste), in both the PATH form and the plugin CLI form, and reads. Each edit, each project check,
  // the receipt write and any other command fall back to a permission prompt. So a check that a proposal names,
  // such as `curl … | sh`, cannot run unseen.
  const APPLY_GRANTS = 'allowed-tools: Bash(orangu suggest:*), Bash(orangu ste:*), Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/orangu.cli.mjs" suggest *), Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/orangu.cli.mjs" ste *), Read'
  it('apply pre-approves only its 2 orangu verbs and reads, and no skill pre-approves a bare Bash, Edit or Write', () => {
    expect(readText('plugin/skills/apply/SKILL.md').split('\n')[3]).toBe(APPLY_GRANTS)
    for (const s of readdirSync(join(root, 'plugin/skills')).filter((entry) => existsSync(join(root, 'plugin/skills', entry, 'SKILL.md')))) {
      const grants = (/^allowed-tools:\s*(.+)$/m.exec(readText(`plugin/skills/${s}/SKILL.md`))?.[1] ?? '').split(',').map((grant) => grant.trim())
      for (const bare of ['Bash', 'Edit', 'Write']) expect(grants, `${s} pre-approves no bare ${bare}`).not.toContain(bare)
    }
  })

  // With no edit grant, each edit and each check can stop at a permission prompt. The body says so once, so that
  // Claude reads a prompt as the expected step and not as a failure. The Codex mirrors drop allowed-tools but
  // carry the same body.
  it('apply says once that each edit and each check can ask for permission, in both hosts', () => {
    const PERMISSION = 'Each edit, each check and the receipt write can ask the user for permission. This is expected.'
    for (const path of ['plugin/skills/apply/SKILL.md', '.agents/skills/orangu-apply/SKILL.md', 'plugins/orangu/skills/orangu-apply/SKILL.md']) {
      const text = readText(path)
      expect(text.split(PERMISSION).length - 1, `${path} says it once`).toBe(1)
      expect(text.indexOf(PERMISSION), `${path} says it before the first edit`).toBeLessThan(text.indexOf('Inspect only the named files'))
    }
  })
  it('the localhost handoff is copy-only and cannot spawn a model process', () => {
    const source = readText('src/serve/kickoff.ts')
    expect(source).not.toMatch(/node:child_process|\bspawn\s*\(|--allowedTools|--permission-mode/)
    expect(source).toContain("parsed.mode === 'run'")
    expect(source).toContain('automatic model launch is disabled')
    expect(source).toContain('spawned: false')
  })
  it('improve uses the canonical evidence estimate and interactive read gate', () => {
    for (const [name, path] of [
      ['Claude', 'plugin/skills/improve/SKILL.md'],
      ['Codex', '.agents/skills/orangu-improve/SKILL.md'],
    ] as const) {
      const md = readText(path)
      expect(md, `${name} uses canonical evidence estimate`).toContain("orangu evidence '<input>' [--scope repo|global] --estimate --quiet")
      expect(md, `${name} estimates suggestion handoff`).toContain("orangu estimate --suggestion '<id>'")
      expect(md, `${name} asks before an oversized read`).toMatch(/ask (?:for approval|before loading)/i)
      expect(md, `${name} stops before an unapproved oversized read`).toMatch(/stop before loading unless approval is given|ask before loading it/i)
      expect(md).not.toContain('confirmationReceipt')
      expect(md).not.toContain('orangu evidence <input> --depth')
    }
  })
  it('improve never applies and records both proposal artifacts', () => {
    const md = readFileSync(join(root, 'plugin/skills/improve/SKILL.md'), 'utf8')
    expect(md).toContain('~/.orangu/proposals/')
    expect(md).toContain("--set '<id>' proposed --proposal '<proposal-path>'")
    expect(md).toContain('--manifest')
    expect(md.toLowerCase()).toMatch(/never edit the target repository|never edit the target project/)
    expect(existsSync(join(root, 'plugin/skills/improve/references/artifact-contract.md'))).toBe(true)
  })
  it('harness records scope-appropriate structured proposals without applying them', () => {
    const md = readText('plugin/skills/harness/SKILL.md')
    expect(md).toContain('../improve/references/artifact-contract.md')
    expect(md).toContain('~/.orangu/proposals/<id>.md')
    expect(md).toContain('~/.orangu/proposals/<id>.json')
    expect(md).toContain("--set '<id>' kicked-off")
    expect(md).toContain("--set '<id>' proposed --proposal '<proposal-path>'")
    expect(md).toContain("--manifest '<manifest-path>'")
    expect(md).not.toContain('compatibility proposal format')
    expect(md).toMatch(/Markdown-only proposals?[^\n]*must not be created/i)
    for (const field of ['files', 'evidence', 'expectedEffect', 'risk', 'verification', 'verificationChecks', 'sources']) {
      expect(md, `harness requires ${field}`).toMatch(new RegExp(`(?:must include|nonempty)[^\\n]*\\b${field}\\b|\\b${field}\\b[^\\n]*(?:must include|nonempty)`, 'i'))
    }
    expect(md).toContain('/orangu:apply <id>')
    expect(md).toMatch(/this review did not edit the target repository/i)
  })
  it('improve is catalog-first and preserves honest research provenance', () => {
    const md = readFileSync(join(root, 'plugin/skills/improve/SKILL.md'), 'utf8')
    expect(md).toMatch(/catalog matches before going online/i)
    expect(md).toContain('catalog: <id>')
    expect(md).toContain('kind: "research"')
    expect(md).toContain('kind: "inference"')
    expect(md).toMatch(/never install a skill or plugin/i)
  })
  it('analyze documents --slim, default redaction, and ends with the improve offer', () => {
    const md = readFileSync(join(root, 'plugin/skills/analyze/SKILL.md'), 'utf8')
    expect(md).toContain('--slim')
    expect(md).toContain('redacted by default')
    expect(md).toContain('/orangu:improve')
    expect(md).toContain('orangu estimate')
    const shape = readFileSync(join(root, 'plugin/skills/analyze/references/json-shape.md'), 'utf8')
    expect(shape).toContain('SlimAnalysis')
  })
  // The aggregate emits CrossFinding.recommendation (the improvement for each recurring finding); the shape
  // reference that analyze reads lists it, so the skill knows the field exists.
  it('the analyze JSON reference lists the cross-finding recommendation', () => {
    const shape = readText('plugin/skills/analyze/references/json-shape.md')
    const crossFindings = shape.split('\n').find((line) => line.includes('crossFindings:[{')) ?? ''
    expect(crossFindings, 'json-shape.md has a crossFindings line').not.toBe('')
    expect(crossFindings).toMatch(/\brecommendation\b/)
  })
  // The report opens in Detailed. The plain words replace the mechanism names only when the user asks for plain
  // language, so each swap sentence carries that condition itself.
  it('analyze swaps to plain words only when the user asks for plain language', () => {
    const md = readText('plugin/skills/analyze/SKILL.md')
    expect(md).toContain('When the user asks for plain language, keep the words tool calls and subagents.')
    expect(md).toContain('In plain language, say reused context for the cache, and working memory for the context window.')
    expect(md, 'no unconditional swap sentence').not.toMatch(/(?:^|\. )Say reused context/m)
  })
  it('analyze carries the live-session branch: orangu watch for one, orangu serve for several', () => {
    const md = readFileSync(join(root, 'plugin/skills/analyze/SKILL.md'), 'utf8')
    expect(md).toContain('orangu watch')
    expect(md).toContain('orangu serve')
    expect(md.toLowerCase()).toMatch(/multi-session|multiple (?:live )?sessions|several sessions|every session/)
  })
  it('analyze opens the report for the session Claude Code is running in, with a placeholder fallback', () => {
    const md = readFileSync(join(root, 'plugin/skills/analyze/SKILL.md'), 'utf8')
    const desc = /description:\s*(.+)/.exec(md)?.[1] ?? ''
    expect(desc).toContain('open the report for the session running right now')
    // `current` resolves inside the CLI (env id > pid record > cwd guess); the documented
    // ${CLAUDE_SESSION_ID} substitution is the independent second path on older Claude Code. It is
    // the quoted flag form: an unsubstituted placeholder then fails loudly (`--session needs a session
    // selector`) instead of dropping the word and building the latest session's report
    expect(md).toContain('`orangu report current --open`')
    expect(md).toContain('`orangu report -s "${CLAUDE_SESSION_ID}" --open`')
    expect(md).not.toContain('`orangu report ${CLAUDE_SESSION_ID} --open`')
    expect(md).toMatch(/`latest`, or `current`/)
    // the picker is not offered: the Bash tool has no TTY, where pick is just a numbered list
    expect(md).not.toContain('orangu pick')
    expect(readText('plugin/skills/README.md')).toContain('`current`')
  })
  it('harness scopes --limit to the per-session axis', () => {
    const md = readFileSync(join(root, 'plugin/skills/harness/SKILL.md'), 'utf8')
    expect(md).toContain('how many sessions are scanned')
  })

  it('keeps session diagnosis distinct from recurring repo/global improvement work', () => {
    const analyze = readText('plugin/skills/analyze/SKILL.md')
    const improve = readText('plugin/skills/improve/SKILL.md')
    const harness = readText('plugin/skills/harness/SKILL.md')
    expect(analyze).toMatch(/One session, observe and diagnose/)
    expect(analyze).toMatch(/Repository, find recurring patterns/)
    expect(improve).toContain('one session diagnosis')
    expect(improve).toContain('recurring repo/global improvement')
    expect(harness).toContain('Accept only `--scope repo` or `--scope global`.')
    expect(harness).toContain('Session scope belongs to the smaller skills.')
  })
  it('bundles an offline CLI launcher', () => {
    expect(existsSync(join(root, 'plugin/bin/orangu'))).toBe(true)
  })

  it('shares one exact nine-class taxonomy across catalog, plugin, and app', () => {
    const ids = CHANGE_CLASS_DEFINITIONS.map((definition) => definition.id)
    expect(ids).toEqual([
      'instruction', 'script-cli', 'hook', 'skill-create', 'skill-discover',
      'subagent-agent', 'mcp', 'plugin', 'workflow-config',
    ])
    expect(new Set(allEntries().map((entry) => entry.changeClass))).toEqual(new Set(ids))

    for (const path of [
      'plugin/skills/improve/SKILL.md',
      'plugin/skills/harness/SKILL.md',
      'plugin/skills/improve/references/artifact-contract.md',
    ]) {
      const text = readText(path)
      for (const id of ids) expect(text, `${path} covers ${id}`).toContain(id)
    }

    const app = readText('src/report/client/screens/suggest.ts')
    expect(app, 'app imports the compact canonical taxonomy labels').toMatch(/from ['"][^'"]*suggest\/change-class-labels\.js['"]/)
    expect(app, 'app renders the canonical labels').toMatch(/CHANGE_CLASS_LABELS\.map/)
  })

  it('suggestion-id handoff is estimated interactively and accepts no server receipt', () => {
    const improve = readText('plugin/skills/improve/SKILL.md')
    expect(improve).toContain("orangu estimate --suggestion '<id>' --json --quiet")
    expect(improve).not.toContain('--receipt')
    expect(improve).not.toContain('confirmationReceipt')
  })

  it('harness keeps two independent interactive estimate gates outside receipt kickoff', () => {
    const harness = readText('plugin/skills/harness/SKILL.md')
    expect(harness).toContain('orangu estimate harness --json')
    expect(harness).toContain("orangu estimate repo --cwd '<dir>' --json")
    expect(harness).toContain('orangu estimate global --json')
    expect(harness).toContain('Treat these as two separate gates.')
    expect(harness).toContain('Confirmation of one read does not confirm the other.')
    expect(harness).toContain('pass the same explicit directory')
    expect(harness).not.toContain('--receipt')
  })

  // Stage 5 is the only path from a harness review to a repository edit: the ranked report first, then
  // an explicit per-item approval, then /orangu:apply one id at a time. Global stays review-only, and
  // the skill says nothing about how the host treats the nested skill's own grants (unverified).
  it('harness asks for approval, applies repo proposals one id at a time, and never a global one', () => {
    const harness = readText('plugin/skills/harness/SKILL.md')
    expect(harness).toContain('## 6. Report, approve, and apply')
    expect(harness).toContain('which items the user approves')
    expect(harness).toContain('apply nothing without explicit approval')
    expect(harness).toContain('one id per invocation, one receipt per id')
    expect(harness).toContain('Stop at the first failure')
    expect(harness).toContain('Never apply a global proposal')
    expect(harness).toContain('If the Skill tool is unavailable or denied')
    expect(harness).toContain('the ordered `/orangu:apply <id>` list')
    const report = harness.indexOf('this review did not edit the target repository')
    const approval = harness.indexOf('which items the user approves')
    expect(approval, 'the approval question follows the pre-approval report').toBeGreaterThan(report)
    expect(approval, 'nothing is invoked before the approval question').toBeLessThan(harness.indexOf('through the Skill tool'))
    expect(harness).not.toMatch(/permission prompt|not honou?red/i)
  })

  // Informed consent: the user approves a repository write knowing which files it touches and the exact
  // text of anything it introduces that will run or grant authority; item titles alone are model-authored
  // from evidence text and cannot carry that. The disclosure is content-shaped, not a class list: a
  // workflow-config, skill-create, subagent-agent, or plugin item writes CI steps, settings hooks and
  // permission grants, or instruction files that later models obey, and none of those is a `hook`, `mcp`,
  // or `script-cli` item. The applied id is bound to the approved item by echoing it.
  it('harness names the files and the executable or authority-granting text per item before approval, and binds each apply to a verbatim id', () => {
    const harness = readText('plugin/skills/harness/SKILL.md')
    expect(harness).toContain('the manifest `files` it writes')
    expect(harness).toContain('the exact text of any command, hook, workflow step, permission or plugin grant, or skill or agent instruction file it introduces')
    expect(harness, 'no disclosure limited to a class list').not.toMatch(/for `hook`, `mcp`, or `script-cli`|the exact command it introduces/)
    expect(harness).toContain('each option labelled with its `<id>`, title, and files')
    expect(harness).toContain('approves only the `<id>`s it names verbatim')
    expect(harness).toContain('a number alone, stop and ask again')
    expect(harness).toContain('echoing that exact `<id>`, title, and files just before each invocation')
    const files = harness.indexOf('the manifest `files` it writes')
    expect(files, 'the files list is part of the pre-approval report').toBeLessThan(harness.indexOf('this review did not edit the target repository'))
    const verbatim = harness.indexOf('approves only the `<id>`s it names verbatim')
    expect(verbatim, 'the id rule is set before any invocation').toBeLessThan(harness.indexOf('through the Skill tool'))
  })

  // The description governs auto-invocation; a skill that can end in a repository edit says so there,
  // the way apply does, so the model never routes a "why does this keep happening" question into a
  // mutating flow without the user knowing that is where it leads.
  it('harness description discloses that approved repo items get applied', () => {
    const desc = /description:\s*(.+)/.exec(readText('plugin/skills/harness/SKILL.md'))?.[1] ?? ''
    expect(desc).toContain('apply the repo items you approve by id')
  })

  // The interview stage: evidence says what happened; only the user knows why and what they will accept. It
  // sits between the analysts (stage 2) and the first suggestion record (stage 4) so answers shape the
  // proposals; it uses AskUserQuestion only where the choices are finite and free text otherwise; and its
  // answers are user-stated context that never becomes a measurement and never counts as apply approval.
  it('harness interviews the user in depth after the analysts and before any record, per the shared guide', () => {
    const harness = readText('plugin/skills/harness/SKILL.md')
    const heading = harness.indexOf('## 3. Interview the user')
    expect(heading, 'the interview is a stage of its own').toBeGreaterThan(0)
    expect(heading).toBeGreaterThan(harness.indexOf('## 2. Analyze two lenses in parallel'))
    expect(heading, 'the interview precedes the first suggest --rule record').toBeLessThan(harness.indexOf("orangu suggest --rule '<ruleId>'"))
    expect(harness).toContain('](../shared/interview.md)')
    expect(harness).toContain('AskUserQuestion when the choices are finite')
    expect(harness).toContain('free text in chat when the answer is open')
    expect(harness).toContain('one follow-up at a time')
    for (const topic of ['instruction files and memory', 'hooks', 'skills and agents', 'MCP servers', 'settings'])
      expect(harness, `the interview covers ${topic}`).toContain(topic)
    expect(harness).toContain('the user may skip any topic or stop')
    expect(harness).toContain('user-stated context, never as a measurement')
    expect(harness).toContain('"What you told us"')
    expect(harness).toContain('Nothing said in the interview approves an application')
  })

  it('improve asks the bounded interview questions before drafting, from the same guide, in both hosts', () => {
    for (const path of ['plugin/skills/improve/SKILL.md', '.agents/skills/orangu-improve/SKILL.md']) {
      const text = readText(path)
      expect(text, `${path} links the guide`).toContain('](../shared/interview.md)')
      expect(text).toContain('AskUserQuestion when the choices are finite, free text otherwise')
      expect(text).toContain('user-stated context, never a measurement')
      expect(text.indexOf('interview the user'), `${path} interviews before the proposal is saved`).toBeGreaterThan(0)
      expect(text.indexOf('interview the user'), `${path} interviews before the proposal is saved`).toBeLessThan(text.indexOf('## 4. Save one bounded proposal'))
    }
  })

  it('the shared interview guide is deep, bounded, host-portable, and turns answers into context, never measurements', () => {
    const rel = 'plugin/skills/shared/interview.md'
    expect(existsSync(join(root, rel)), `${rel} exists`).toBe(true)
    const guide = readText(rel)
    for (const literal of [
      'AskUserQuestion', 'free text', 'at most four questions per call', 'one follow-up at a time', 'Stop after twelve questions',
      'never ask the user to confirm a measured number', 'ask in plain text and wait', 'Never answer for the user',
      'never read consent into silence', '"What you told us"', '"kind": "inference"', 'interview: <short paraphrase>',
      'never a measured value', 'Nothing said in an interview approves an application', '](untrusted-input.md)',
    ]) expect(guide, `the guide says: ${literal}`).toContain(literal)
    for (const topic of ['Instruction files and memory', 'Hooks', 'Skills and agents', 'MCP servers', 'Settings and workflow'])
      expect(guide, `the guide covers ${topic}`).toContain(`**${topic}.**`)
    // portable to the generated Codex mirror: no slash command, no plugin root variable
    expect(guide).not.toMatch(/\/orangu:|CLAUDE_PLUGIN_ROOT/)
    // born 2026-09-16 at 619 measured words: a ceiling, not a target (PROJECT.md: ratchets only go down, and
    // one is raised only in the commit that measures the growth that needs it)
    expect(guide.split(/\s+/).filter(Boolean).length, 'interview guide words').toBeLessThan(620)
  })

  // B7: the record identity is derived by the CLI from --session; the skill never asks the model to
  // read, validate or pass a cohort fingerprint (`--cohort` stays accepted for compatibility, undocumented).
  it('harness projects the aggregate through the evidence seam and never asks for a cohort fingerprint', () => {
    const harness = readText('plugin/skills/harness/SKILL.md')
    for (const scope of ['repo', 'global']) {
      expect(harness).toContain(`orangu evidence '<tmp>/aggregate.json' --scope ${scope} --estimate --quiet`)
      expect(harness).toContain(`orangu evidence '<tmp>/aggregate.json' --scope ${scope} --quiet > '<tmp>/evidence.json'`)
    }
    expect(harness).toContain("--scope repo|global --session '<evidence ids>'")
    expect(harness).toContain('`--session` is mandatory')
    expect(harness).not.toContain('--cohort')
    expect(harness).not.toContain('cohortFingerprint')
    expect(harness).not.toMatch(/16 lowercase hexadecimal/i)
  })

  it('external skill discovery stays user-run, candidate-only, and install-free', () => {
    const improve = readText('plugin/skills/improve/SKILL.md')
    const harness = readText('plugin/skills/harness/SKILL.md')
    const researcher = readText('plugin/agents/harness-researcher.md')
    const policy = readText('plugin/skills/harness/references/research-sources.md')
    for (const [path, text] of [
      ['orangu-harness', harness], ['harness-researcher', researcher], ['research policy', policy],
    ] as const) {
      expect(text, `${path} names the discovery command`).toContain('npx skills find')
      expect(text, `${path} forbids running the discovery command`).toMatch(/(?:do not|never) runs? `?npx skills find/i)
      expect(text, `${path} forbids installation`).toMatch(/(?:do not|never|cannot)[^\n]*install/i)
      expect(text, `${path} keeps discoveries unverified`).toContain('verifiedAt: null')
    }
    expect(improve).toContain('skills.sh')
    expect(improve).toMatch(/never install a skill or plugin/i)
    expect(`${harness}\n${researcher}\n${policy}`).toContain('skills.sh')
    // the candidate-review policy used to live in the retired suggest alias; it is pinned on the research policy now
    expect(policy).toContain('Candidate review')
    expect(policy).toContain('repository evidence')
    expect(policy).toContain('install count')
  })

  it('keeps every online research path free of local evidence and identifiers', () => {
    const surfaces = [
      ['Claude improve', readText('plugin/skills/improve/SKILL.md')],
      ['Codex improve', readText('.agents/skills/orangu-improve/SKILL.md')],
      ['harness', readText('plugin/skills/harness/SKILL.md')],
      ['harness researcher', readText('plugin/agents/harness-researcher.md')],
      ['harness research policy', readText('plugin/skills/harness/references/research-sources.md')],
    ] as const
    for (const [name, text] of surfaces) {
      expect(text, `${name} uses generic network terms`).toMatch(/generic feature(?: and|\/) change-class terms/i)
      expect(text, `${name} forbids disclosure`).toMatch(/never send local prompts/i)
      for (const item of ['paths', 'session or suggestion ids', 'project/repository/customer names', 'proposal text']) {
        expect(text, `${name} protects ${item}`).toContain(item)
      }
      expect(text, `${name} keeps local values out of URLs`).toMatch(/place them in a URL/i)
    }
  })

  it('proposal files require evidence, effect, risk, and a deterministic verification', () => {
    for (const [name, path] of [
      ['Claude', 'plugin/skills/improve/references/artifact-contract.md'],
      ['Codex', '.agents/skills/orangu-improve/references/artifact-contract.md'],
    ] as const) {
      const format = readText(path)
      for (const field of ['changeClass', 'evidence', 'expectedEffect', 'risk', 'verification', 'verificationChecks']) {
        expect(format, `${name} proposal format requires ${field}`).toContain(field)
      }
      // Verification needs no skill-written file: Orangu picks both cohorts and computes every number.
      expect(format, `${name} writes no verification intent`).not.toContain('"measuredSessionIds"')
      expect(format, `${name} names the read-only effect`).toContain('orangu suggest --effect')
      expect(format, `${name} keeps session choice out of the model's reach`).toMatch(/Orangu picks both sides/)
      expect(format, `${name} leaves the finding's own sessions out`).toMatch(/leaving out the finding's own sessions/)
      expect(format, `${name} states the noise rule`).toMatch(/beat chance at p ≤ 0\.05[^\n]*at least three sessions/)
      expect(format, `${name} makes no causal claim`).toMatch(/does not prove the change caused it/)
      expect(format, `${name} uses a real shipped catalog id`).toContain('catalog: cli-ripgrep')
      expect(format, `${name} omits caller-owned catalog metadata`).not.toMatch(/"kind": "catalog"[^\n]*(?:"url"|"verifiedAt")/)
      expect(format, `${name} requires dated research provenance`).toMatch(/research source requires[^\n]*HTTPS[^\n]*non-null[^\n]*YYYY-MM-DD/i)
      expect(format, `${name} keeps null-date candidates out of manifests`).toMatch(/candidate[^\n]*`verifiedAt`[^\n]*`null`[^\n]*(?:must not|do not)[^\n]*manifest/i)
    }
  })

  it('documents the store-owned computed verification trust marker', () => {
    for (const path of ['docs/DATA-CONTRACTS.md', 'docs/DETERMINISM.md']) {
      const text = readText(path)
      expect(text, `${path} names the current trust marker`).toContain('verificationTrust')
      expect(text, `${path} distinguishes legacy verification`).toMatch(/legacy verified records?[^\n]*(?:lack|without)[^\n]*(?:marker|current computed verification)/i)
      expect(text, `${path} names the noise-aware marker`).toContain('computed-v2')
    }
  })

  it('enforces the conservative lifecycle by scope in both hosts and harness', () => {
    for (const [name, path] of [
      ['Claude improve', 'plugin/skills/improve/SKILL.md'],
      ['Codex improve', '.agents/skills/orangu-improve/SKILL.md'],
    ] as const) {
      const text = readText(path)
      expect(text, `${name} supports session verification`).toMatch(/session[^\n]*propose[^\n]*apply[^\n]*verif/i)
      expect(text, `${name} supports repo verification`).toMatch(/`repo`[^\n]*propose[^\n]*apply[^\n]*verif/i)
      expect(text, `${name} keeps global proposal-only`).toMatch(/global[^\n]*proposal-only/i)
      expect(text, `${name} refuses global apply/verify`).toMatch(/global[^\n]*(?:never|cannot)[^\n]*(?:apply|applied)[^\n]*(?:verif|verified)|global[^\n]*(?:apply|applied)[^\n]*(?:verif|verified)[^\n]*(?:unsupported|cannot)/i)
    }

    for (const path of ['plugin/skills/apply/SKILL.md', '.agents/skills/orangu-apply/SKILL.md']) {
      const text = readText(path)
      expect(text, `${path} rejects global`).toMatch(/global proposals?[^\n]*proposal-only[^\n]*never be applied/i)
      expect(text, `${path} says applied is not verified`).toMatch(/session or repo scope[^\n]*applied locally, not yet verified\. Verify after at least three settled later sessions/i)
      expect(text, `${path} uses plain words`).not.toMatch(/cohort/i)
    }

    const harness = readText('plugin/skills/harness/SKILL.md')
    expect(harness).toMatch(/repo scope[^\n]*apply[^\n]*verify against later repository sessions/i)
    expect(harness, 'harness keeps changes attributable').toMatch(/applied together are measured together/i)
    expect(harness).toMatch(/global scope[^\n]*proposal-only[^\n]*never be applied or verified/i)
    expect(harness).toMatch(/global apply and verification are not supported/i)
  })

  it('preflights proposal eligibility and keeps undiscovered artifacts chat-only', () => {
    for (const [name, path] of [
      ['Claude improve', 'plugin/skills/improve/SKILL.md'],
      ['Codex improve', '.agents/skills/orangu-improve/SKILL.md'],
      ['harness', 'plugin/skills/harness/SKILL.md'],
    ] as const) {
      const text = readText(path)
      const command = "orangu suggest --show '<id>' --for-proposal --json --quiet"
      expect(text, `${name} uses proposal preflight`).toContain(command)
      expect(text.indexOf(command), `${name} preflights before artifact writes`).toBeLessThan(text.indexOf('Write both') === -1 ? text.indexOf('Write `~/.orangu') : text.indexOf('Write both'))
      expect(text, `${name} names custom root configuration`).toContain('ORANGU_CLAUDE_ROOTS')
      expect(text, `${name} names alternate Claude config`).toContain('CLAUDE_CONFIG_DIR')
      expect(text, `${name} falls back to chat`).toMatch(/ranked (?:chat )?(?:recommendations|suggestions?)[^\n]*do not claim (?:a )?saved(?: or proposed)?/i)
    }
  })

  it('treats shell substitutions as inert data in improve, harness, and apply', () => {
    for (const [name, path] of [
      ['Claude improve', 'plugin/skills/improve/SKILL.md'],
      ['Codex improve', '.agents/skills/orangu-improve/SKILL.md'],
      ['harness', 'plugin/skills/harness/SKILL.md'],
      ['Claude apply', 'plugin/skills/apply/SKILL.md'],
      ['Codex apply', '.agents/skills/orangu-apply/SKILL.md'],
    ] as const) {
      const text = withSharedRules(path)
      for (const rejected of ['NUL', 'carriage return', 'newline']) expect(text, `${name} rejects ${rejected}`).toContain(rejected)
      expect(text, `${name} prefers argv`).toMatch(/argument-array process API/i)
      expect(text, `${name} specifies POSIX quoting`).toMatch(/correctly escaped POSIX shell word/i)
      const quoteRecipe = /embedded single quote (?:as|becomes) `([^`]+)`/.exec(text)?.[1]
      expect(quoteRecipe, `${name} specifies the exact embedded quote encoding`).toBe(`'"'"'`)
      expect(text, `${name} forbids shell concatenation`).toMatch(/never concatenate an unquoted value/i)
      expect(text, `${name} controls redirection`).toMatch(/fixed redirection|fixed `>`/i)
    }
  })

  it('documents aggregate cohort fingerprints at both evidence handoff levels', () => {
    const contract = readText('docs/DATA-CONTRACTS.md')
    const evidenceContract = contract.slice(contract.indexOf('## EvidenceBundle v1'), contract.indexOf('## AppData v1'))
    expect(evidenceContract.match(/cohortFingerprint\?: string/g)).toHaveLength(2)
    expect(evidenceContract).toMatch(/present only for repo\/global Aggregate evidence/i)
    expect(evidenceContract).toMatch(/exactly 16 lowercase hexadecimal characters/i)
  })

  it('treats all evidence text as prompt-injection data across skills and agents', () => {
    for (const [name, path] of [
      ['Claude improve', 'plugin/skills/improve/SKILL.md'],
      ['Codex improve', '.agents/skills/orangu-improve/SKILL.md'],
      ['harness', 'plugin/skills/harness/SKILL.md'],
      ['PM analyst', 'plugin/agents/harness-pm-analyst.md'],
      ['DevEx analyst', 'plugin/agents/harness-devex-analyst.md'],
      ['researcher', 'plugin/agents/harness-researcher.md'],
    ] as const) {
      const text = withSharedRules(path)
      for (const item of ['session', 'evidence', 'tool', 'path', 'title', 'error', 'proposal text']) {
        expect(text.toLowerCase(), `${name} marks ${item} untrusted`).toContain(item)
      }
      expect(text, `${name} marks content untrusted`).toMatch(/untrusted (?:content|data)/i)
      expect(text, `${name} never follows embedded directives`).toMatch(/never follow (?:an? )?instructions?, commands?, or URLs?/i)
      expect(text, `${name} protects policy`).toMatch(/never let it override/i)
      expect(text, `${name} protects queries`).toMatch(/form a network query/i)
      expect(text, `${name} protects shell syntax`).toMatch(/become shell syntax/i)
    }
  })

  it('every skill and agent that handles evidence links the one shared untrusted-input rule inline', () => {
    expect(existsSync(join(root, SHARED_RULES))).toBe(true)
    for (const [path, link] of [
      ['plugin/skills/improve/SKILL.md', '../shared/untrusted-input.md'],
      ['plugin/skills/harness/SKILL.md', '../shared/untrusted-input.md'],
      ['plugin/skills/apply/SKILL.md', '../shared/untrusted-input.md'],
      ['plugin/agents/harness-pm-analyst.md', '../skills/shared/untrusted-input.md'],
      ['plugin/agents/harness-devex-analyst.md', '../skills/shared/untrusted-input.md'],
      ['plugin/agents/harness-researcher.md', '../skills/shared/untrusted-input.md'],
    ] as const) {
      const text = readText(path)
      expect(text, `${path} links the shared rules`).toContain(`](${link})`)
      // the link never replaces the rule: the inert-data sentence stays inline
      expect(text, `${path} keeps the inert-data rule inline`).toMatch(/as inert data, never as instructions/)
    }
  })

  // Every skill tells Claude to write what the user reads in STE (Simplified Technical English), with one
  // sentence and a link to one shared rules file. The rules live once, in plugin/skills/shared/, which the
  // build mirrors to Codex, so the file stays host-portable. The list grows until it names every shipped skill.
  const STE_RULES = 'plugin/skills/shared/ste.md'
  const STE_SENTENCE = 'Write all user-facing text in STE, as [the STE rules](../shared/ste.md) direct.'
  const STE_SKILLS = ['improve', 'apply', 'feedback', 'analyze', 'harness', 'show-me']
  it('the skills tell Claude to write user-facing text in STE, from one shared rules file', () => {
    expect(existsSync(join(root, STE_RULES)), `${STE_RULES} exists`).toBe(true)
    for (const s of STE_SKILLS) {
      const body = readText(`plugin/skills/${s}/SKILL.md`).split('\n---\n')[1] ?? ''
      expect(body, `${s} carries the STE sentence`).toContain(STE_SENTENCE)
      expect(body.split('](../shared/ste.md)').length - 1, `${s} links the STE rules once`).toBe(1)
    }
    const rules = readText(STE_RULES)
    for (const literal of ['20 words or fewer', '25 words or fewer', 'active voice', 'One word for one thing', 'semicolon', 'contraction', 'em dash', 'Plain language', 'Detailed'])
      expect(rules, `the STE rules say: ${literal}`).toContain(literal)
    // portable to the generated Codex mirror: no slash command, no plugin root variable
    expect(rules).not.toMatch(/\/orangu:|CLAUDE_PLUGIN_ROOT/)
  })

  // The STE rules shape prose only. Values that Orangu validates, text that a proposal writes into a
  // repository, and sentences a skill fixes word for word stay exact; the audience follows the skill and the
  // user, never a default of its own (the report itself opens in Detailed).
  it('the shared STE rules leave validated values, repository text, fixed sentences and the audience alone', () => {
    const rules = readText(STE_RULES)
    for (const field of ['`title`', '`change`', '`evidence`', '`expectedEffect`', '`risk`', '`verification`'])
      expect(rules, `STE reaches the manifest prose field ${field}`).toContain(field)
    expect(rules).not.toContain('the text fields of a proposal manifest')
    expect(rules).toContain('Do not put code spans inside JSON values.')
    expect(rules).toMatch(/repository file[^\n]*keeps the exact mechanism names/)
    expect(rules).toContain('A sentence that a skill tells you to say stays word for word.')
    expect(rules, 'no order to quote transcript text').not.toMatch(/Quote text exactly: transcript/)
    expect(rules).toContain('If the skill that sent you here names a default audience, use it.')
    expect(rules, 'no audience default of its own').not.toMatch(/write for Plain language/i)
    expect(rules, 'the unit list covers read sizes').toMatch(/\bbytes\b/)
    // improve researches online itself; the researcher-only rule is scoped to the harness review
    expect(readText(SHARED_RULES)).toContain('In the harness review, only the researcher builds network queries.')
  })

  // A page counts as research only when this invocation opened it: "this session" would let a page from
  // earlier in a long conversation pass as checked today.
  it('research provenance covers only pages opened while the skill ran', () => {
    for (const path of ['plugin/skills/improve/SKILL.md', '.agents/skills/orangu-improve/SKILL.md'])
      expect(readText(path), path).toContain('A page that you opened while this skill ran is `kind: "research"`')
    for (const path of ['plugin/skills/improve/references/artifact-contract.md', '.agents/skills/orangu-improve/references/artifact-contract.md'])
      expect(readText(path), path).toMatch(/research source requires the direct HTTPS page opened while the skill ran/)
  })

  // Diagnosis covers the input forms the skill accepts and nothing wider.
  it('improve diagnoses only an accepted input', () => {
    for (const path of ['plugin/skills/improve/SKILL.md', '.agents/skills/orangu-improve/SKILL.md'])
      expect(readText(path), path).toContain('Diagnose any accepted input in chat.')
  })

  // The descriptions keep the phrases that the routing cases in plugin/evals send.
  it('the mirrored descriptions keep the phrases the routing evals rely on', () => {
    const desc = (s: string): string => /description:\s*(.+)/.exec(readText(`plugin/skills/${s}/SKILL.md`))?.[1] ?? ''
    expect(desc('improve')).toContain('what to change so the next run or session goes better')
    expect(desc('improve')).toContain('wants an applied change verified against later sessions')
    expect(desc('improve')).toContain('pastes a suggestion id from a report')
    expect(desc('feedback')).toContain('report a bug')
  })

  // The same guard for the Claude-only skills: each phrase answers a prompt in plugin/evals (analyze-*,
  // never-reads-a-transcript-directly, harness-*), so an STE rewrite of a description keeps it.
  it('the Claude-only descriptions keep the phrases the routing evals rely on', () => {
    const desc = (s: string): string => /description:\s*(.+)/.exec(readText(`plugin/skills/${s}/SKILL.md`))?.[1] ?? ''
    for (const phrase of [
      'what happened in one session', 'finished or still running', 'where time or tokens went', 'open a visual report',
      'open the report for the session running right now', 'keep a report refreshed while a session runs',
    ]) expect(desc('analyze')).toContain(phrase)
    // each analyze trigger is phrased as a trigger ("Use when", "use it to"), never as a capability ("It can")
    expect(desc('analyze')).not.toMatch(/\bIt can\b/)
    for (const phrase of [
      'what your harness declares', 'every session on the machine', 'instruction files, hooks, skills, agents, MCP servers, plugins',
      'why the same problem keeps recurring', 'wants a repo or global harness review', 'what to change in their setup',
    ]) expect(desc('harness')).toContain(phrase)
  })

  // The build mirrors these four trees to Codex. A Claude-only skill named there becomes a dead command in
  // the mirror (a SKILL.md stops the build; a shared or reference file would copy it silently).
  it('no mirrored skill file names the Claude-only show-me skill', () => {
    for (const path of markdownFiles('plugin/skills/improve', 'plugin/skills/apply', 'plugin/skills/feedback', 'plugin/skills/shared'))
      expect(readText(path), `${path} names no Claude-only skill`).not.toContain('/orangu:show-me')
    // Claude-only: no Codex mirror and no CLI verb of the same name
    for (const target of ['.agents/skills', 'plugins/orangu/skills']) expect(existsSync(join(root, target, 'orangu-show-me'))).toBe(false)
  })

  // /orangu:show-me turns deterministic evidence into a slide deck and a written report. It may read CLI
  // output and its own templates, write only under ~/.orangu/show-me, and never measure anything itself.
  describe('show-me', () => {
    const SHOW_ME = 'plugin/skills/show-me/SKILL.md'
    const md = (): string => readText(SHOW_ME)
    const body = (): string => md().split('\n---\n')[1] ?? ''
    const grants = (): string[] => (/^allowed-tools:\s*(.+)$/m.exec(md())?.[1] ?? '').split(',').map((grant) => grant.trim())

    // Grep is the read-only tool for the post-write check: no shell, and no reach that the Read grant lacks.
    it('pre-approves exactly the CLI, a temp directory, reads, a read-only check, and writes under ~/.orangu/show-me', () => {
      expect(grants()).toEqual(['Bash(orangu:*)', 'Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/orangu.cli.mjs" *)', 'Bash(mktemp:*)', 'Read', 'Grep', 'Write(~/.orangu/show-me/**)'])
      // opening the files is a normal permission prompt, never a pre-approval
      expect(grants().join(' ')).not.toMatch(/\b(?:open|xdg-open|start)\b/)
    })

    it('sizes every read before it reads, and treats a failed size command as a large read', () => {
      const text = body()
      const before = (size: string, read: string): void => {
        expect(text, `names ${size}`).toContain(size)
        expect(text, `names ${read}`).toContain(read)
        expect(text.indexOf(size), `${size} comes before ${read}`).toBeLessThan(text.indexOf(read))
      }
      before("orangu estimate '<session>' --slim --json", "orangu analyze '<session>' --json --slim")
      before("orangu evidence '<tmp>/aggregate.json' --scope repo --estimate --quiet", "orangu evidence '<tmp>/aggregate.json' --scope repo --quiet > '<tmp>/evidence.json'")
      expect(text).toMatch(/more than about 5,000 tokens \(about 20 KB\), so ask once before you read anything/)
      expect(text).toMatch(/If the size command fails[^.]*treat the read as over the limit/)
      expect(text).toContain('Never combine `--out` with `--json`.')
    })

    it('copies numbers, never computes one, and keeps money, scores and rankings out', () => {
      for (const rule of [
        'Copy each number from the CLI output. Compute or estimate no new figure.',
        'Use only tokens, milliseconds (ms) and S, M or L effort as units.',
        'Show a savings figure only where the rule claims one.',
        'Show no composite score and no ranking of people.',
      ]) expect(body(), rule).toContain(rule)
    })

    // The report's Show me control copies exactly these 3 forms, each as claude "…" for a terminal paste: the
    // full session id on a session, --scope repo or --scope global on a scope file. Each form must be documented
    // and must reach its read, and a bare call must pick a session instead of failing.
    it('accepts the 3 forms that the report copies, and a bare call', () => {
      const text = body()
      expect(text).toContain('`claude "/orangu:show-me …"`')
      for (const form of ['/orangu:show-me <session>', '/orangu:show-me --scope repo', '/orangu:show-me --scope global'])
        expect(text, `documents ${form}`).toContain(`\`${form}\``)
      expect(text, 'a full session id is a session').toMatch(/`<session>` is a session id/)
      expect(text, 'session form reaches its read').toContain("orangu analyze '<session>' --json --slim")
      expect(text, 'repo form reaches its read').toContain("orangu repo '<dir>' --out '<tmp>/aggregate.json'")
      expect(text, 'repo form projects its scope').toContain("orangu evidence '<tmp>/aggregate.json' --scope repo --quiet")
      expect(text, 'global form reaches its read').toContain("orangu global --out '<tmp>/aggregate.json'")
      expect(text, 'global form projects its scope').toMatch(/the same steps with `orangu global --out '<tmp>\/aggregate\.json'` and `--scope global`/)
      expect(text, 'a bare call shows the latest session').toContain('With no argument, show `latest`, and tell the user which session id that is.')
    })

    it('keeps default redaction unless the user asks', () => {
      expect(body()).toContain('Use default redaction. Add `--no-redact` or `--include-text` only when the user explicitly asks for it.')
    })

    it('fills the two built templates and writes exactly two files to a new directory each run', () => {
      const text = body()
      for (const file of ['references/slides.html', 'references/report.html', 'references/slots.md']) expect(text, file).toContain(file)
      expect(text, 'the sources are build input, never read by the skill').not.toContain('.src.html')
      expect(text).toContain('~/.orangu/show-me/<id>/slides.html')
      expect(text).toContain('~/.orangu/show-me/<id>/report.html')
      expect(text).toContain("so a second run never overwrites the first")
    })

    // The files carry session text that Claude escapes by hand. A missed escape must not run script or send the
    // reader anywhere: the CSP pins the one script by hash, and the skill counts what it wrote before it opens it. The
    // patterns live once, in SKILL.md; test/show-me-templates.test.ts runs them on filled files and on hostile ones.
    // The Grep tool parameters are named exactly: the head count needs multiline mode, and ripgrep refuses its `\n`
    // without it, so a missed parameter fails closed.
    it('counts each written file before it opens it: samples, script, meta, links, the exact link and the fixed head', () => {
      const text = body()
      expect(text).toContain('run these counts on each file with the Grep tool and `output_mode: "count"`. Set `-i: true` for counts 2 to 9, and `multiline: true` for count 9:')
      expect(showMeChecks(md()).map(({ expected }) => expected)).toEqual([0, 0, 1, 5, 1, 1, 1, 1, 1])
      expect(showMeChecks(md())[0]).toEqual({ pattern: 'EXAMPLE|data-sample', expected: 0, caseSensitive: true, multiline: false })
      expect(showMeChecks(md()).map(({ multiline }) => multiline).lastIndexOf(true)).toBe(8)
      expect(showMeChecks(md()).filter(({ multiline }) => multiline)).toHaveLength(1)
      expect(text).toContain('The templates keep each counted tag on its own line, so a count of lines and a count of matches agree.')
      expect(text).toContain('If a count is different, delete nothing, report the file and the count, and do not open it.')
      expect(text.indexOf('run these counts with the Grep tool')).toBeLessThan(text.indexOf('Print both absolute paths.'))
    })

    // One estimate for the whole run, before any read: the fixed template and slot-rule reads, the evidence read, and
    // the 2 files to write. test/show-me-templates.test.ts holds the stated sizes to the built files.
    it('states the cost of the whole run and asks once before any read', () => {
      const text = body()
      expect(text).toMatch(/The 2 templates and the slot rules are about \d+ KB to read \(about \d+k tokens\)\. The 2 files are about \d+ KB to write \(about \d+k tokens\)\./)
      expect(text.indexOf('about 20 KB')).toBeLessThan(text.indexOf("orangu analyze '<session>' --json --slim"))
      expect(text.indexOf('about 20 KB')).toBeLessThan(text.indexOf('Read [the slot rules]'))
    })

    // A user who asks what happened in a session wants /orangu:analyze; show-me answers a request for a deck.
    it('routes a deck request here and leaves the diagnosis phrases to analyze', () => {
      const desc = /description:\s*(.+)/.exec(md())?.[1] ?? ''
      for (const phrase of ['what happened', 'review a run', 'trace what the agent did']) expect(desc).not.toContain(phrase)
      expect(desc).toMatch(/slides/)
    })

    it('prints both paths and opens both files with the OS opener', () => {
      expect(body()).toContain('Print both absolute paths.')
      for (const opener of ['`open`', '`xdg-open`', '`start`']) expect(body()).toContain(opener)
    })
  })

  it('public plugin and marketplace copy stays role-neutral and claim-safe', () => {
    const forbidden: Array<[string, RegExp]> = [
      ['software-versus-model framing', /software\s*[,;:]?\s*not (?:an?\s+)?model|not (?:an?\s+)?model\s*[,;:]?\s*(?:it(?:'s| is)\s+)?software/i],
      ['coding-agent framing', /AI coding agent|coding[- ]agent (?:analytics|telemetry)|agent telemetry/i],
      ['local-corpus boast', /79 of 85|verified on \d+ sessions|sessions across \d+|\bcorpus\b/i],
      ['client-version boast', /Claude Code (?:versions?|v?\d)/i],
      ['profession framing', /\b(?:developer|engineer|programmer)s?\b/i],
      ['em dash', /—/],
    ]
    for (const surface of pluginPublicCopy()) {
      for (const [claim, pattern] of forbidden) expect(surface.text, `${surface.path} contains ${claim}`).not.toMatch(pattern)
    }
    for (const path of ['plugin/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']) {
      const text = JSON.stringify(readJson(path))
      for (const source of ['Claude Code', 'Cowork', 'Desktop']) expect(text, `${path} names ${source}`).toContain(source)
      expect(text, `${path} preserves the local deterministic boundary`).toMatch(/local|deterministic/i)
    }
  })

  // Read-only plugin agents, staged pipeline, source-list, and token/effort invariants.

  const AGENTS = ['harness-pm-analyst', 'harness-devex-analyst', 'harness-researcher']
  // the only frontmatter keys plugin agents support
  const AGENT_KEYS = ['name', 'description', 'model', 'effort', 'maxTurns', 'tools', 'disallowedTools', 'skills', 'memory', 'background', 'isolation']
  const agentBlock = (name: string): string => {
    const md = readFileSync(join(root, 'plugin/agents', `${name}.md`), 'utf8')
    const fm = /^---\n([\s\S]*?)\n---/.exec(md)
    expect(fm, `${name} has frontmatter`).toBeTruthy()
    return fm![1]!
  }
  const fmField = (block: string, key: string): string => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim() ?? ''
  const fmList = (block: string, key: string): string[] => fmField(block, key).split(',').map((t) => t.trim()).filter(Boolean)

  // Widened twice. It first covered six hand-listed files, which let the analyze skill keep quoting
  // list prices; then it walked every .md but with a regex that only knew `usd|dollar|list-rate|cost`,
  // which left "faster/cheaper/better" live in the mega skill's DESCRIPTION — the entire triggering
  // surface. It now uses the ONE shared vocabulary (test/money-vocabulary.ts) with no exceptions:
  // every rule statement in these files is phrased as a positive unit whitelist ("tokens,
  // milliseconds and S | M | L effort are the only units that exist here"), which is both stronger
  // instruction design and free of the words being banned.
  it('the whole plugin talks tokens and effort, never money', () => {
    const surfaces = pluginPublicCopy()
    expect(surfaces.length, 'plugin and marketplace public surfaces').toBeGreaterThanOrEqual(15)
    for (const surface of surfaces) {
      // ${…} substitutions are the plugin's own variables, not money
      const text = surface.text.replace(/\$\{[^}]*\}/g, '')
      expect(currencyHits(text), `${surface.path} quotes no currency amount`).toEqual([])
      const hits = moneyHits(text)
      expect(hits, `${surface.path} uses money vocabulary: ${hits.join(' || ')}`).toEqual([])
    }
  })

  // `budget` and `spend` are deliberately NOT in the vocabulary: the researcher uses both for WEB
  // CALLS per run. Pinned so a future widening does not break honest English for no honesty gain.
  it('keeps the researcher\'s web-call budget language, which is a request count and not money', () => {
    for (const f of ['plugin/agents/harness-researcher.md', 'plugin/skills/harness/references/research-sources.md']) {
      const text = readFileSync(join(root, f), 'utf8')
      expect(moneyHits(text), `${f} must stay money-free`).toEqual([])
      expect(/\bbudget\b|\bspend\b/i.test(text), `${f} still speaks of a web-call budget`).toBe(true)
    }
  })

  it('ships exactly three plugin agents under plugin/agents/, each with valid frontmatter', () => {
    const onDisk = readdirSync(join(root, 'plugin/agents')).filter((f) => f.endsWith('.md')).sort()
    expect(onDisk).toEqual(AGENTS.map((a) => `${a}.md`).sort())
    for (const a of AGENTS) {
      const block = agentBlock(a)
      expect(fmField(block, 'name'), `${a} name matches its filename`).toBe(a)
      const desc = fmField(block, 'description')
      expect(desc.length, `${a} description length`).toBeGreaterThan(40)
      expect(desc.length, `${a} description length`).toBeLessThan(1536)
      expect(fmField(block, 'tools'), `${a} declares tools`).toBeTruthy()
      expect(fmField(block, 'disallowedTools'), `${a} declares disallowedTools`).toBeTruthy()
      expect(fmField(block, 'effort'), `${a} effort`).toMatch(/^(xhigh|max)$/)
      for (const line of block.split('\n')) {
        const key = /^([A-Za-z-]+):/.exec(line)?.[1]
        if (key) expect(AGENT_KEYS, `${a} frontmatter key ${key} is supported for plugin agents`).toContain(key)
      }
    }
  })

  it('no plugin agent can write or execute', () => {
    for (const a of AGENTS) {
      const block = agentBlock(a)
      const tools = fmList(block, 'tools')
      for (const forbidden of ['Edit', 'Write', 'NotebookEdit', 'Bash']) {
        expect(tools, `${a} tools omit ${forbidden}`).not.toContain(forbidden)
      }
      const disallowed = fmList(block, 'disallowedTools')
      for (const required of ['Edit', 'Write', 'NotebookEdit']) {
        expect(disallowed, `${a} disallows ${required}`).toContain(required)
      }
    }
  })

  it('only the explicit research surfaces hold network tools; localhost never launches them', () => {
    const networked = AGENTS.filter((a) => fmList(agentBlock(a), 'tools').some((t) => t === 'WebSearch' || t === 'WebFetch'))
    expect(networked, 'exactly one agent may reach the network').toEqual(['harness-researcher'])
    for (const s of ['analyze', 'apply', 'harness']) {
      const md = readFileSync(join(root, 'plugin/skills', s, 'SKILL.md'), 'utf8')
      const allowed = /^allowed-tools:\s*(.+)$/m.exec(md)?.[1] ?? ''
      expect(allowed, `${s} grants no network tool`).not.toMatch(/WebSearch|WebFetch/)
    }
    const improve = readFileSync(join(root, 'plugin/skills/improve/SKILL.md'), 'utf8')
    expect(/^allowed-tools:.*WebSearch.*WebFetch$/m.test(improve)).toBe(true)
    expect(readText('src/serve/kickoff.ts')).not.toMatch(/child_process|--allowedTools|--tools/)
  })

  it('keeps analysis, application, and later verification as separate claims', () => {
    const improve = readText('plugin/skills/improve/SKILL.md')
    const apply = readText('plugin/skills/apply/SKILL.md')
    expect(improve).toContain('Never edit the target repository')
    expect(improve).toContain("orangu suggest --effect '<id>' --json --quiet")
    expect(improve).toContain("orangu suggest --set '<id>' verified --json --quiet")
    expect(improve).not.toContain('--verification')
    expect(improve, 'an older `--verify <id> <later-input>` handoff still works').toContain('ignore any later-input after the id')
    expect(improve, 'the skill chooses no sessions').toContain('Orangu picks the sessions. Never choose them.')
    expect(improve, 'improve fixes causes instead of pasting the failure').toMatch(/never copy the session's own failing text/)
    expect(improve, 'improve picks attributable checks').toMatch(/the change directly moves, plus one guard/)
    expect(apply).toContain('`record.status` is exactly `proposed`')
    expect(apply).toContain("--set '<id>' applied --application '<application-path>'")
    expect(apply).toContain('applied locally, not yet verified. Verify after at least three settled later sessions')
    expect(apply).not.toMatch(/WebSearch|WebFetch|Agent|Task|mcp__/)
  })

  it('apply performs repository binding before any read or edit and records a skill-authored receipt', () => {
    for (const [name, skillPath, contractPath] of [
      ['Claude', 'plugin/skills/apply/SKILL.md', 'plugin/skills/apply/references/application-contract.md'],
      ['Codex', '.agents/skills/orangu-apply/SKILL.md', '.agents/skills/orangu-apply/references/application-contract.md'],
    ] as const) {
      const skill = readText(skillPath)
      const contract = readText(contractPath)
      const command = "orangu suggest --show '<id>' --for-apply --json --quiet"
      expect(skill, `${name} apply uses the binding preflight`).toContain(command)
      expect(skill, `${name} apply never uses plain show`).not.toContain("orangu suggest --show '<id>' --json --quiet")
      expect(skill, `${name} apply stops before reads`).toMatch(/before any project read or edit/i)
      expect(skill, `${name} apply stops on failed binding`).toMatch(/stop immediately unless this repository-binding preflight succeeds/i)
      expect(skill.indexOf(command), `${name} preflight precedes contract reads`).toBeLessThan(skill.indexOf('application contract'))
      for (const text of [skill, contract]) {
        expect(text, `${name} labels the receipt as skill-authored`).toMatch(/receipt is (?:your )?skill-authored/)
        expect(text, `${name} does not claim diff inspection`).toMatch(/does not inspect the working-tree diff/i)
        expect(text, `${name} keeps confinement as a skill requirement`).toMatch(/required|requirements/)
      }
    }
  })

  it('labels retained kickoff process fields as legacy compatibility', () => {
    const contract = readText('docs/DATA-CONTRACTS.md')
    expect(contract).toMatch(/`kickoff\.pid` and `kickoff\.exitCode` fields are legacy compatibility fields/i)
    expect(contract).toMatch(/copy-only localhost handoff never starts a model process/i)
  })

  it('ships mirrored Codex skills with valid interface metadata', () => {
    for (const name of ['orangu-improve', 'orangu-apply', 'orangu-feedback']) {
      const skill = readText(`.agents/skills/${name}/SKILL.md`)
      const yaml = readText(`.agents/skills/${name}/agents/openai.yaml`)
      expect(skill).toMatch(new RegExp(`name:\\s*${name}`))
      expect(yaml).toContain('display_name:')
      expect(yaml).toContain('short_description:')
      expect(yaml).toContain('default_prompt:')
      expect(yaml).toContain(`$${name}`)
    }
  })

  it('plugin agents live at plugin/agents/, never under .claude-plugin/', () => {
    expect(existsSync(join(root, 'plugin/agents'))).toBe(true)
    expect(existsSync(join(root, 'plugin/.claude-plugin/agents'))).toBe(false)
    // an `agents` key REPLACES the default dir rather than adding to it
    expect(Object.keys(readJson('plugin/.claude-plugin/plugin.json'))).not.toContain('agents')
  })

  it('harness runs the staged pipeline', () => {
    const md = readFileSync(join(root, 'plugin/skills/harness/SKILL.md'), 'utf8')
    const literals = [
      'orangu estimate harness', "orangu harness --cwd '<dir>' --out '<tmp>/harness.json'",
      "orangu harness --global --out '<tmp>/harness.json'",
      'orangu:harness-pm-analyst', 'orangu:harness-devex-analyst', 'orangu:harness-researcher',
      'free:', 'how many sessions are scanned', 'orangu estimate',
      'consult its catalog before any outside research', 'catalog: <id>', '`verifiedAt: null`',
    ]
    for (const literal of literals) expect(md, `harness names ${literal}`).toContain(literal)
    const stages = [...md.matchAll(/^## (\d)\. /gm)].map((m) => m[1])
    expect(stages, 'seven numbered stages, in order').toEqual(['0', '1', '2', '3', '4', '5', '6'])
  })

  it('every description routes away from a sibling and opens with its own job', () => {
    const skills = ['analyze', 'apply', 'feedback', 'harness', 'improve', 'show-me']
    const descriptions = new Map<string, string>()
    for (const s of skills) {
      const md = readText(`plugin/skills/${s}/SKILL.md`)
      const desc = /description:\s*(.+)/.exec(md)?.[1] ?? ''
      descriptions.set(s, desc)
      const routes = [...desc.matchAll(/\/orangu:([a-z]+)/g)].map((m) => m[1]).filter((name) => name !== s)
      expect(routes.length, `${s} points at least one job at a sibling`).toBeGreaterThan(0)
      for (const r of routes) expect(skills, `${s} routes to a shipped skill: ${r}`).toContain(r)
      expect(desc, `${s} says what it is not for`).toMatch(/Not for /)
    }
    const openings = [...descriptions.values()].map((d) => d.split(/\s+/).slice(0, 8).join(' '))
    expect(new Set(openings).size, 'no two descriptions open the same way').toBe(skills.length)
  })

  it('plugin/skills/README.md catalogs exactly the shipped skills', () => {
    const readme = readText('plugin/skills/README.md')
    const dirs = readdirSync(join(root, 'plugin/skills')).filter((entry) => existsSync(join(root, 'plugin/skills', entry, 'SKILL.md'))).sort()
    const rows = [...readme.matchAll(/^\| `\/orangu:([a-z-]+)`/gm)].map((m) => m[1]).sort()
    expect(rows).toEqual(dirs)
    expect(readme, 'the harness row says the review interviews the user').toMatch(/interview/)
    // 2026-10-06 200 -> 226: the show-me row, measured 26 words (199 -> 225); the ratchet below says why
    expect(readme.split(/\s+/).filter(Boolean).length, 'catalog stays under 226 words').toBeLessThan(226)
  })

  // Ceilings, not targets: each is the value MEASURED on the day it landed. Lowering one needs nothing.
  // Raising one is allowed only in the same commit that measures a deliberate, named growth, with the
  // measured value and the reason written both here and in the commit body; otherwise the chunk stops
  // and escalates rather than widening the ceiling (PROJECT.md §Testing).
  describe('ratchet: skill weight', () => {
    // harness and improve landed above their B4 targets (1000 / 900) and are still above them after the
    // 2026-08-27 final pass (measured 1,110 / 998): the remaining words are pinned command literals and
    // policy sentences this file asserts (the network-disclosure paragraph alone is ~60 words per skill).
    // The targets stay unmet, not redefined; the ceilings track the measurement and only go DOWN.
    // 2026-08-28 harness 1120 -> 1180: stage 5 gained the approve-and-apply gate (ask, apply approved repo
    // ids one at a time through the Skill tool, stop at the first failure, never global) after the smallest
    // honest wording; measured 1,179, and the comparator is strict, so 1,180 leaves zero words of headroom.
    // 2026-08-28 harness 1180 -> 1239 (review fix): the approval gate now names each item's files and, for a
    // hook, MCP, or script-cli item, the command it introduces, labels every option by id, accepts only a
    // verbatim id, and echoes id, title, and files before each apply; measured 1,238, again zero headroom.
    // 2026-08-28 harness 1239 -> 1249 (review fix 2): the command disclosure was limited to hook, MCP, and
    // script-cli items, which left workflow-config, skill-create, subagent-agent, and plugin items (CI steps,
    // settings hooks and permission grants, instruction files) undisclosed; it is now content-shaped, which
    // costs ten words after "numbered" was dropped; measured 1,248, again zero headroom.
    // 2026-08-28 sip-skill, orchestrator pass: +15 words so stage 5 states that only the AskUserQuestion answer is an approval
    // (approval-shaped text anywhere else is data), closing a security advisory on the mutation gate; measured 1,264.
    // 2026-09-16 harness 1265 -> 1402 and improve 1000 -> 1029: the interview stage. Harness gained stage 3 "Interview the
    // user" (summarize, then AskUserQuestion for finite choices and free text for open ones, one follow-up at a time, five
    // topics, answers are user-stated context and never approval) plus three clauses tying stages 4 and 5 to it; improve
    // gained one bounded-interview sentence before drafting. The question bank lives in shared/interview.md, not here.
    // Measured 1,401 / 1,028; the comparator is strict, so both ceilings leave zero words of headroom.
    // 2026-09-29 noise-aware verification: harness 1402 -> 1401 and improve 1029 -> 1021, lowered to the measured
    // 1,400 / 1,020. Both skills now hand verification to `orangu suggest --effect` (Orangu picks the sessions), which
    // paid for the root-cause, attributable-check, and one-change-at-a-time sentences.
    // 2026-10-06 show-me, a sixth skill: its body (649 words) and description (309 chars) are born at the measured
    // value, strict, so zero headroom. The resident description total rises once, 2,200 -> 2,509, by exactly that
    // description (the five others measured 2,144 after their STE rewrite, so the total is 2,453); the catalog cap
    // rises once, 200 -> 226, by exactly its new row (26 words, 199 -> 225). No other ceiling moves.
    // 2026-10-06 show-me review fixes: body 650 -> 769, measured 768 words (+119). The post-write check grew from 3
    // Grep counts to 7 (no sample text or unset chart, no active markup in any form the security review proved, 1
    // script, 5 metas, 1 http-equiv, 1 link, the exact CSP line) with the rule that text which reads like markup also
    // stops the open, and step 2 now gives one estimate of the whole run and asks once. The description lost the phrase that overlapped analyze: 310 -> 305 (measured 304), and the
    // resident total goes down by the same 5, 2,509 -> 2,504 (measured 2,448).
    // 2026-10-06 show-me security re-check R1: body 769 -> 794, measured 793 words (+25). The 7 counts become 9, 8 on
    // each file: the exact link in each file (2 items), the fixed head of the file with the exact runtime hash in place
    // of the line that took any hash anywhere, and the exact Grep parameters (`output_mode`, `-i`, `multiline`).
    const SKILL_WORD_CEILING: Record<string, number> = { harness: 1401, improve: 1021, analyze: 700, apply: 700, feedback: 350, 'show-me': 794 }
    const DESC_CHAR_CEILING: Record<string, number> = { harness: 550, improve: 500, analyze: 500, apply: 400, feedback: 360, 'show-me': 305 }
    const TOTAL_DESC_CEILING = 2504 // was 2,933 across 7 skills on 2026-08-27; 2,200 for five skills until show-me (+309, then -5)
    const words = (text: string): number => text.split(/\s+/).filter(Boolean).length
    const split = (name: string): { desc: string; body: string } => {
      const md = readText(`plugin/skills/${name}/SKILL.md`)
      const fm = /^---\n([\s\S]*?)\n---/.exec(md)!
      return { desc: /description:\s*(.+)/.exec(fm[1]!)?.[1] ?? '', body: md.slice(fm[0].length) }
    }
    it('every SKILL.md body stays under its word ceiling', () => {
      for (const [name, ceiling] of Object.entries(SKILL_WORD_CEILING)) {
        expect(words(split(name).body), `${name} body words`).toBeLessThan(ceiling)
      }
    })
    it('every description stays under its character ceiling, and the resident sum shrinks', () => {
      let total = 0
      for (const [name, ceiling] of Object.entries(DESC_CHAR_CEILING)) {
        const { desc } = split(name)
        expect(desc.length, `${name} description chars`).toBeLessThan(ceiling)
        total += desc.length
      }
      expect(total, 'always-resident description chars').toBeLessThan(TOTAL_DESC_CEILING)
    })
    it('the catalog ships next to the skills, so it is capped too', () => {
      expect(words(readText('plugin/skills/README.md'))).toBeLessThan(226)
    })
  })

  it('the research source list is honest', () => {
    const rel = 'plugin/skills/harness/references/research-sources.md'
    expect(existsSync(join(root, rel))).toBe(true)
    const md = readFileSync(join(root, rel), 'utf8')
    for (const tier of ['Tier 1', 'Tier 2', 'Tier 3']) expect(md, `names ${tier}`).toContain(tier)
    const budgets = [...md.matchAll(/Budget: at most (\d+) web calls/g)].map((m) => Number(m[1]))
    expect(budgets.length, 'one numeric budget per tier').toBe(3)
    expect(budgets.reduce((a, b) => a + b, 0), 'per-run web budget').toBeLessThanOrEqual(10)
    // Every URL on a line that calls anything verified must be in the vendored inventory the
    // catalog is held to. The label is position-independent: `- verified — <url>` and
    // `- <url> — verified` are the same claim, so the whole line counts, not just the text
    // before the URL. `verifiedAt` (the candidate marker) and `unverified` are not labels.
    const inventory = new Set((readJson('src/suggest/verified-urls.json') as { urls: string[] }).urls)
    for (const line of md.split('\n')) {
      const urls = [...line.matchAll(/https?:\/\/[^\s`)<>"]+/g)].map((m) => m[0])
      if (!urls.length) continue
      if (!/verified/i.test(line.replace(/verifiedAt|unverified/gi, ''))) continue
      for (const url of urls) {
        expect(inventory.has(url), `${url} is on a line labelled verified but is not in src/suggest/verified-urls.json`).toBe(true)
      }
    }
  })
})
