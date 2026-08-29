import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { currencyHits, moneyHits } from './money-vocabulary.js'
import { CHANGE_CLASS_DEFINITIONS } from '../src/suggest/change-classes.js'
import { allEntries } from '../src/suggest/catalog.js'

const root = process.cwd()
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'))
const readText = (p: string): string => readFileSync(join(root, p), 'utf8')

function markdownFiles(...dirs: string[]): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir))) {
      const rel = `${dir}/${entry}`
      if (statSync(join(root, rel)).isDirectory()) walk(rel)
      else if (rel.endsWith('.md')) files.push(rel)
    }
  }
  for (const dir of dirs) walk(dir)
  return files.sort()
}

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

function pluginPublicCopy(): Array<{ path: string; text: string }> {
  const markdown = markdownFiles('plugin/skills', 'plugin/agents')
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
  it('ships the five intended /orangu:* commands with valid frontmatter', () => {
    const skills = ['analyze', 'apply', 'feedback', 'harness', 'improve']
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
    expect(harness).toContain('## 5. Report, approve, and apply')
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
      expect(format).toContain('measuredSessionIds')
      const marker = format.indexOf('"measuredSessionIds"')
      expect(marker, `${name} has verification intent example`).toBeGreaterThan(0)
      const intent = format.slice(Math.max(format.lastIndexOf('## Verification intent', marker), format.lastIndexOf('For a real later supported', marker)))
      expect(intent, `${name} intent omits authored labels`).not.toMatch(/"summary"|"name"/)
      expect(intent, `${name} intent matches review`).toMatch(/(?:must )?exactly match (?:the )?(?:reviewed )?proposal `verificationChecks`/i)
      expect(intent, `${name} lets Orangu label checks`).toMatch(/Orangu generates (?:both|them) deterministically/i)
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
    }
  })

  it('enforces the conservative lifecycle by scope in both hosts and harness', () => {
    for (const [name, path] of [
      ['Claude improve', 'plugin/skills/improve/SKILL.md'],
      ['Codex improve', '.agents/skills/orangu-improve/SKILL.md'],
    ] as const) {
      const text = readText(path)
      expect(text, `${name} supports session verification`).toMatch(/session[^\n]*propose[^\n]*apply[^\n]*verif/i)
      expect(text, `${name} leaves repo applied`).toMatch(/repo[^\n]*(?:remain|leave)[^\n]*`applied`/i)
      expect(text, `${name} keeps global proposal-only`).toMatch(/global[^\n]*proposal-only/i)
      expect(text, `${name} refuses global apply/verify`).toMatch(/global[^\n]*(?:never|cannot)[^\n]*(?:apply|applied)[^\n]*(?:verif|verified)|global[^\n]*(?:apply|applied)[^\n]*(?:verif|verified)[^\n]*(?:unsupported|cannot)/i)
    }

    for (const path of ['plugin/skills/apply/SKILL.md', '.agents/skills/orangu-apply/SKILL.md']) {
      const text = readText(path)
      expect(text, `${path} rejects global`).toMatch(/global proposals?[^\n]*proposal-only[^\n]*never be applied/i)
      expect(text, `${path} keeps repo applied`).toMatch(/repo scope[^\n]*cannot yet compare later repository sessions[^\n]*cannot become `verified`/i)
      expect(text, `${path} uses plain words`).not.toMatch(/cohort/i)
      expect(text, `${path} permits session later verification`).toMatch(/session scope[^\n]*later verification/i)
    }

    const harness = readText('plugin/skills/harness/SKILL.md')
    expect(harness).toMatch(/repo scope[^\n]*apply[^\n]*cannot become `verified`/i)
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
    expect(improve).toContain("--set '<id>' verified --verification")
    expect(apply).toContain('`record.status` is exactly `proposed`')
    expect(apply).toContain("--set '<id>' applied --application '<application-path>'")
    expect(apply).toContain('applied locally, not yet verified on a later run')
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
    expect(stages, 'six numbered stages, in order').toEqual(['0', '1', '2', '3', '4', '5'])
  })

  it('every description routes away from a sibling and opens with its own job', () => {
    const skills = ['analyze', 'apply', 'feedback', 'harness', 'improve']
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
    const rows = [...readme.matchAll(/^\| `\/orangu:([a-z]+)`/gm)].map((m) => m[1]).sort()
    expect(rows).toEqual(dirs)
    expect(readme.split(/\s+/).filter(Boolean).length, 'catalog stays under 200 words').toBeLessThan(200)
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
    const SKILL_WORD_CEILING: Record<string, number> = { harness: 1265, improve: 1000, analyze: 700, apply: 700, feedback: 350 }
    const DESC_CHAR_CEILING: Record<string, number> = { harness: 550, improve: 500, analyze: 500, apply: 400, feedback: 360 }
    const TOTAL_DESC_CEILING = 2200 // was 2,933 across 7 skills on 2026-08-27
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
      expect(words(readText('plugin/skills/README.md'))).toBeLessThan(200)
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
