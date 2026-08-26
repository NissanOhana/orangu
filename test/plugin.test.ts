import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
  it('ships the seven intended /orangu:* commands with valid frontmatter', () => {
    const skills = ['analyze', 'apply', 'feedback', 'improve', 'mega', 'watch', 'suggest']
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
      if (s !== 'apply') {
        for (const source of ['Claude Code', 'Cowork', 'Desktop']) expect(desc, `${s} names supported ${source} sources`).toContain(source)
      }
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
  it('improve and mega declare proposal-only writes with no edit grant', () => {
    for (const s of ['improve', 'mega']) {
      const md = readFileSync(join(root, 'plugin/skills', s, 'SKILL.md'), 'utf8')
      const fm = /^---\n([\s\S]*?)\n---/.exec(md)!
      const allowed = /allowed-tools:\s*(.+)/.exec(fm[1]!)?.[1] ?? ''
      expect(allowed, `${s} has allowed-tools`).toBeTruthy()
      expect(allowed).not.toMatch(/\bEdit\b/)
      // the only Write grant is the orangu proposals dir
      const writes = allowed.match(/Write\([^)]*\)|Write(?!\()/g) ?? []
      for (const w of writes) expect(w, `${s} write grant is proposals-scoped: ${w}`).toMatch(/^Write\(~\/\.orangu\//)
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
  it('mega records scope-appropriate structured proposals without applying them', () => {
    const md = readText('plugin/skills/mega/SKILL.md')
    expect(md).toContain('../improve/references/artifact-contract.md')
    expect(md).toContain('~/.orangu/proposals/<id>.md')
    expect(md).toContain('~/.orangu/proposals/<id>.json')
    expect(md).toContain("--set '<id>' kicked-off")
    expect(md).toContain("--set '<id>' proposed --proposal '<proposal-path>'")
    expect(md).toContain("--manifest '<manifest-path>'")
    expect(md).not.toContain('compatibility proposal format')
    expect(md).toMatch(/Markdown-only proposals?[^\n]*must not be created/i)
    for (const field of ['files', 'evidence', 'expectedEffect', 'risk', 'verification', 'verificationChecks', 'sources']) {
      expect(md, `mega requires ${field}`).toMatch(new RegExp(`(?:must include|nonempty)[^\\n]*\\b${field}\\b|\\b${field}\\b[^\\n]*(?:must include|nonempty)`, 'i'))
    }
    expect(md).toContain('/orangu:apply <id>')
    expect(md).toMatch(/mega did not edit the target repository/i)
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
  it('watch points multi-session monitoring at orangu serve', () => {
    const md = readFileSync(join(root, 'plugin/skills/watch/SKILL.md'), 'utf8')
    expect(md).toContain('orangu serve')
    expect(md.toLowerCase()).toMatch(/multi-session|multiple (?:live )?sessions|several sessions|every session/)
  })
  it('mega scopes --limit to the per-session axis', () => {
    const md = readFileSync(join(root, 'plugin/skills/mega/SKILL.md'), 'utf8')
    expect(md).toContain('how many sessions are scanned')
  })

  it('keeps session diagnosis distinct from recurring repo/global improvement work', () => {
    const analyze = readText('plugin/skills/analyze/SKILL.md')
    const improve = readText('plugin/skills/improve/SKILL.md')
    const mega = readText('plugin/skills/mega/SKILL.md')
    expect(analyze).toMatch(/One session, observe and diagnose/)
    expect(analyze).toMatch(/Repository, find recurring patterns/)
    expect(improve).toContain('one session diagnosis')
    expect(improve).toContain('recurring repo/global improvement')
    expect(mega).toContain('Accept only `--scope repo` or `--scope global`.')
    expect(mega).toContain('Session scope belongs to the smaller skills.')
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
      'plugin/skills/mega/SKILL.md',
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
    const alias = readText('plugin/skills/suggest/SKILL.md')
    expect(improve).toContain("orangu estimate --suggestion '<id>' --json --quiet")
    expect(improve).not.toContain('--receipt')
    expect(improve).not.toContain('confirmationReceipt')
    expect(alias).not.toMatch(/confirmation receipt/i)
  })

  it('mega keeps two independent interactive estimate gates outside receipt kickoff', () => {
    const mega = readText('plugin/skills/mega/SKILL.md')
    expect(mega).toContain('orangu estimate harness --json')
    expect(mega).toContain("orangu estimate repo --cwd '<dir>' --json")
    expect(mega).toContain('orangu estimate global --json')
    expect(mega).toContain('Treat these as two separate gates.')
    expect(mega).toContain('Confirmation of one read does not confirm the other.')
    expect(mega).toContain('pass the same explicit directory')
    expect(mega).not.toContain('--receipt')
  })

  it('mega binds every manual aggregate suggestion to canonical evidence and the full cohort', () => {
    const mega = readText('plugin/skills/mega/SKILL.md')
    for (const scope of ['repo', 'global']) {
      expect(mega).toContain(`orangu evidence '<tmp>/aggregate.json' --scope ${scope} --estimate --quiet`)
      expect(mega).toContain(`orangu evidence '<tmp>/aggregate.json' --scope ${scope} --quiet > '<tmp>/evidence.json'`)
    }
    expect(mega).toContain('source.cohortFingerprint')
    expect(mega).toMatch(/exactly 16 lowercase hexadecimal characters/i)
    expect(mega).toContain('--cohort <16hex>')
    expect(mega).toMatch(/manual repo\/global `orangu suggest` command/i)
  })

  it('external skill discovery stays user-run, candidate-only, and install-free', () => {
    const improve = readText('plugin/skills/improve/SKILL.md')
    const mega = readText('plugin/skills/mega/SKILL.md')
    const researcher = readText('plugin/agents/harness-researcher.md')
    const policy = readText('plugin/skills/mega/references/research-sources.md')
    const proposal = readText('plugin/skills/suggest/references/proposal-format.md')
    for (const [path, text] of [
      ['orangu-mega', mega], ['harness-researcher', researcher], ['research policy', policy],
    ] as const) {
      expect(text, `${path} names the discovery command`).toContain('npx skills find')
      expect(text, `${path} forbids running the discovery command`).toMatch(/(?:do not|never) runs? `?npx skills find/i)
      expect(text, `${path} forbids installation`).toMatch(/(?:do not|never|cannot)[^\n]*install/i)
      expect(text, `${path} keeps discoveries unverified`).toContain('verifiedAt: null')
    }
    expect(improve).toContain('skills.sh')
    expect(improve).toMatch(/never install a skill or plugin/i)
    expect(`${mega}\n${researcher}\n${policy}`).toContain('skills.sh')
    expect(proposal).toContain('Candidate review')
    expect(proposal).toContain('repository evidence')
    expect(proposal).toContain('install count')
  })

  it('keeps every online research path free of local evidence and identifiers', () => {
    const surfaces = [
      ['Claude improve', readText('plugin/skills/improve/SKILL.md')],
      ['Codex improve', readText('.agents/skills/orangu-improve/SKILL.md')],
      ['mega', readText('plugin/skills/mega/SKILL.md')],
      ['mega researcher', readText('plugin/agents/harness-researcher.md')],
      ['mega research policy', readText('plugin/skills/mega/references/research-sources.md')],
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

  it('enforces the conservative lifecycle by scope in both hosts and mega', () => {
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
      expect(text, `${path} keeps repo applied`).toMatch(/repo scope[^\n]*no fresh-cohort comparator[^\n]*cannot become `verified`/i)
      expect(text, `${path} permits session later verification`).toMatch(/session scope[^\n]*later verification/i)
    }

    const mega = readText('plugin/skills/mega/SKILL.md')
    expect(mega).toMatch(/repo scope[^\n]*apply[^\n]*cannot become `verified`/i)
    expect(mega).toMatch(/global scope[^\n]*proposal-only[^\n]*never be applied or verified/i)
    expect(mega).toMatch(/global apply and verification are not supported/i)
  })

  it('preflights proposal eligibility and keeps undiscovered artifacts chat-only', () => {
    for (const [name, path] of [
      ['Claude improve', 'plugin/skills/improve/SKILL.md'],
      ['Codex improve', '.agents/skills/orangu-improve/SKILL.md'],
      ['mega', 'plugin/skills/mega/SKILL.md'],
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

  it('treats shell substitutions as inert data in improve, mega, and apply', () => {
    for (const [name, path] of [
      ['Claude improve', 'plugin/skills/improve/SKILL.md'],
      ['Codex improve', '.agents/skills/orangu-improve/SKILL.md'],
      ['mega', 'plugin/skills/mega/SKILL.md'],
      ['Claude apply', 'plugin/skills/apply/SKILL.md'],
      ['Codex apply', '.agents/skills/orangu-apply/SKILL.md'],
    ] as const) {
      const text = readText(path)
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
      ['mega', 'plugin/skills/mega/SKILL.md'],
      ['PM analyst', 'plugin/agents/harness-pm-analyst.md'],
      ['DevEx analyst', 'plugin/agents/harness-devex-analyst.md'],
      ['researcher', 'plugin/agents/harness-researcher.md'],
    ] as const) {
      const text = readText(path)
      for (const item of ['session', 'digest', 'tool', 'path', 'title', 'error', 'proposal text']) {
        expect(text.toLowerCase(), `${name} marks ${item} untrusted`).toContain(item)
      }
      expect(text, `${name} marks content untrusted`).toMatch(/untrusted (?:content|data)/i)
      expect(text, `${name} never follows embedded directives`).toMatch(/never follow (?:an? )?instructions?, commands?, or URLs?/i)
      expect(text, `${name} protects policy`).toMatch(/never let it override/i)
      expect(text, `${name} protects queries`).toMatch(/form a network query/i)
      expect(text, `${name} protects shell syntax`).toMatch(/become shell syntax/i)
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
    expect(surfaces.length, 'plugin and marketplace public surfaces').toBeGreaterThanOrEqual(14)
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
    for (const f of ['plugin/agents/harness-researcher.md', 'plugin/skills/mega/references/research-sources.md']) {
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
    for (const s of ['analyze', 'apply', 'mega', 'watch', 'suggest']) {
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
    expect(apply).toContain('status is exactly `proposed`')
    expect(apply).toContain("--set '<id>' applied --application '<application-path>'")
    expect(apply).toContain('applied locally, not yet verified on a later run')
    expect(apply).not.toMatch(/WebSearch|WebFetch|Agent|Task|mcp__/)
  })

  it('apply performs repository binding before any read or edit and records an attestation', () => {
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
        expect(text, `${name} labels the receipt as attestation`).toContain('skill-authored attestation')
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

  it('mega runs the staged pipeline', () => {
    const md = readFileSync(join(root, 'plugin/skills/mega/SKILL.md'), 'utf8')
    const literals = [
      'orangu estimate harness', "orangu harness --cwd '<dir>' --out '<tmp>/harness.json'",
      "orangu harness --global --out '<tmp>/harness.json'",
      'orangu:harness-pm-analyst', 'orangu:harness-devex-analyst', 'orangu:harness-researcher',
      'free:', 'how many sessions are scanned', 'orangu estimate',
      'consult its catalog before any outside research', 'catalog: <id>', '`verifiedAt: null`',
    ]
    for (const literal of literals) expect(md, `mega names ${literal}`).toContain(literal)
    const stages = [...md.matchAll(/^## (\d)\. /gm)].map((m) => m[1])
    expect(stages, 'six numbered stages, in order').toEqual(['0', '1', '2', '3', '4', '5'])
  })

  it('the research source list is honest', () => {
    const rel = 'plugin/skills/mega/references/research-sources.md'
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
