/**
 * The two /orangu:show-me templates. Each is built from its source, offline, typeset on the canonical tokens,
 * and filled by the code behind `orangu show-me --render`. A deck and a written report filled from synthetic
 * fixtures pass the same offline gate as an orangu report, with every sample value replaced.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { Analysis } from '../src/model/analysis.js'
import { slimAnalysis } from '../src/suggest/slim.js'
import { projectEvidence } from '../src/suggest/evidence.js'
import { REPORT_HTML, SCRIPT_HASH, SLIDES_HTML } from '../src/show-me/generated/templates.js'
import { FORMATS, aggregatePage, fillTemplate, sessionPage, type Item, type Page, type Words } from './fixtures/show-me-fill.js'

const root = process.cwd()
const DIR = 'plugin/skills/show-me/references'
const NAMES = ['slides', 'report'] as const
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const built = (name: string): string => read(`${DIR}/${name}.html`)
const source = (name: string): string => read(`${DIR}/${name}.src.html`)
// The report CSP with one change: the script source is the hash of the one runtime, not 'unsafe-inline'. The
// skill writes these files from session text, so a missed escape must not be able to run a script.
const cspFor = (hash: string): string => `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'`
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('base64')
/** script tags, inline event-handler attributes and javascript: URLs: none may enter through a slot */
function scriptSurface(html: string): { scripts: number; handlers: string[]; jsUrls: string[] } {
  return {
    scripts: html.match(/<script\b/gi)?.length ?? 0,
    handlers: html.match(/<[^>]*\son[a-z]+\s*=/gi) ?? [],
    jsUrls: html.match(/=\s*["']?\s*javascript:/gi) ?? [],
  }
}

function offline(html: string, name: string): { status: number; out: string } {
  const file = join(mkdtempSync(join(tmpdir(), 'orangu-show-me-')), name)
  writeFileSync(file, html)
  const r = spawnSync(process.execPath, [join(root, 'scripts/assert-offline.mjs'), '--file', file], { encoding: 'utf8' })
  return { status: r.status ?? -1, out: r.stdout + r.stderr }
}
/** the exact text of each inline script: the CSP hash covers these bytes, so nothing is trimmed */
const scripts = (html: string): string[] => [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
const slotNames = (html: string): string[] => [...new Set([...html.matchAll(/\bdata-slot="([^"]+)"/g)].map((m) => m[1]!))]

const WORDS: Words = {
  verdict: 'The session changed 1 file, and both test runs failed before it ended.',
  summary: 'The session ran the flaky test suite and changed 1 file. Both test runs failed, and the session ended on the failure. Two tool errors came from Bash.',
  improvementsTitle: 'Three changes for the next session',
}
const golden = (name: string): Analysis => JSON.parse(read(`test/golden/${name}.analysis.json`)) as Analysis

describe('show-me templates: built, offline, on the tokens', () => {
  for (const name of NAMES) {
    it(`${name}.html passes the offline gate`, () => {
      const r = offline(built(name), `${name}.html`)
      expect(r.out).toContain('offline OK')
      expect(r.status).toBe(0)
    })

    it(`${name}.html carries the report head and no placeholder`, () => {
      const html = built(name)
      expect(html.startsWith('<!doctype html>')).toBe(true)
      expect(html).toContain('<meta charset="utf-8"/>')
      expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1"/>')
      expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${cspFor(sha256(scripts(html)[0]!))}"/>`)
      expect(html).toContain('<meta name="robots" content="noindex"/>')
      expect(html).toContain(`<meta name="generator" content="orangu ${JSON.parse(read('package.json')).version}"/>`)
      expect(html).not.toMatch(/\{\{[^}]+\}\}|<!-- @[a-z]+ -->/)
    })

    it(`${name} follows the theme only through data-theme, and loads no font`, () => {
      const html = built(name)
      expect(html).not.toMatch(/prefers-color-scheme|fonts\.googleapis|@font-face|@import/)
      // the tokens come from the canonical file, once, and the source repeats none of them
      expect(html.split(read('src/report/client/tokens.css').trim()).length - 1).toBe(1)
      expect(source(name)).toContain('<!-- @tokens -->')
      expect(source(name).match(/#[0-9a-fA-F]{3,8}\b/g), `${name}.src.html hardcodes a colour`).toBeNull()
    })
  }

  for (const name of NAMES) {
    it(`${name}.html pins its one script by hash, and holds no event handler and no javascript: URL`, () => {
      const html = built(name)
      expect(scriptSurface(html)).toEqual({ scripts: 1, handlers: [], jsUrls: [] })
      expect(html).not.toContain("'unsafe-inline'; style-src")
      expect(html).toContain(`script-src 'sha256-${sha256(scripts(html)[0]!)}'`)
    })
  }

  it('both files run the one shared runtime, minified, in 2 KB or less', () => {
    const [deck, report] = NAMES.map((name) => scripts(built(name)))
    expect(deck).toHaveLength(1)
    expect(report).toEqual(deck)
    expect(Buffer.byteLength(deck![0]!), 'inline JS bytes').toBeLessThanOrEqual(2048)
  })

  it('the deck prints one slide per landscape page, and the written report on the default page', () => {
    expect(built('slides')).toContain('@page{size:13.333in 7.5in;margin:0}')
    expect(built('slides')).toMatch(/@media print\{[\s\S]*break-after:page/)
    expect(built('report')).toContain('@page{margin:18mm}')
  })

  it('the deck has the slide roles, a keyboard focus root and a theme button', () => {
    const html = built('slides')
    expect(html).toContain('<main class="deck" tabindex="0" aria-label="Slides">')
    expect(html.match(/aria-roledescription="slide"/g)).toHaveLength(6)
    expect(html).toContain('<button class="theme" id="theme" type="button">')
    expect(html).toContain('href="report.html"')
    expect(built('report')).toContain('href="slides.html"')
  })
})

// The CLI fills the templates from a generated module, so no input names a template path. The module must hold
// the same bytes as the built files that the offline gate and the tests above check.
describe('show-me templates: embedded in the CLI build', () => {
  const EMBEDDED: Record<(typeof NAMES)[number], string> = { slides: SLIDES_HTML, report: REPORT_HTML }

  for (const name of NAMES) {
    it(`the generated module holds ${name}.html byte for byte`, () => {
      const file = readFileSync(join(root, `${DIR}/${name}.html`))
      expect(Buffer.byteLength(EMBEDDED[name]), `${name} bytes`).toBe(file.length)
      expect(Buffer.from(EMBEDDED[name], 'utf8').equals(file), `${name} bytes differ`).toBe(true)
    })

    it(`SCRIPT_HASH is the sha256 of the one script in the embedded ${name}, and its CSP pins it`, () => {
      const html = EMBEDDED[name]
      expect(scripts(html)).toHaveLength(1)
      expect(sha256(scripts(html)[0]!)).toBe(SCRIPT_HASH)
      expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${cspFor(SCRIPT_HASH)}"/>`)
    })
  }

  it('verify:generated compares the module, and the build writes it before the CLI bundle', () => {
    expect(read('scripts/assert-generated.mjs')).toContain("'src/show-me/generated/templates.ts'")
    const build = read('scripts/build.mjs')
    const moduleAt = build.indexOf("join(root, 'src/show-me/generated/templates.ts')")
    const cliAt = build.indexOf("entryPoints: [join(root, 'src/cli/main.ts')]")
    expect(moduleAt, 'the build writes the module').toBeGreaterThan(-1)
    expect(cliAt, 'the build bundles the CLI').toBeGreaterThan(-1)
    expect(moduleAt, 'the module is written before the CLI bundle').toBeLessThan(cliAt)
  })
})

describe('show-me runtime', () => {
  // Run the shipped runtime against a minimal document: each number element gets the text that the report's
  // own formatter gives, so a deck, a written report and an orangu report never disagree.
  function format(cases: Array<{ f: string; v: string }>): string[] {
    const elements = cases.map(({ f, v }) => ({ dataset: { f, v }, textContent: 'unset' }))
    const document = {
      documentElement: { dataset: {} as Record<string, string> },
      querySelectorAll: (selector: string) => (selector === '[data-f][data-v]' ? elements : []),
      links: [],
      getElementById: () => null,
      addEventListener: () => undefined,
    }
    runInNewContext(scripts(built('slides'))[0]!, {
      document,
      location: { hash: '' },
      history: { replaceState: () => undefined },
      URLSearchParams,
      IntersectionObserver: class { observe(): void {} },
    })
    return elements.map((e) => e.textContent)
  }

  it('formats tok, ms, pct, num, date and time exactly as src/report/client/format.ts', () => {
    const cases: Array<{ f: string; v: number }> = []
    for (const v of [0, 7, 950, 1000, 12_345, 99_999, 100_000, 1_234_567, 12_345_678, 2_000_000_000, 23_000_000_000]) cases.push({ f: 'tok', v }, { f: 'num', v })
    for (const v of [0, 870, 999, 4_200, 59_400, 65_080, 750_000, 3_599_000, 7_500_000, 90_000_000, 200_000_000]) cases.push({ f: 'ms', v })
    for (const v of [0, 0.0004, 0.834, 0.836, 0.9997, 1]) cases.push({ f: 'pct', v })
    for (const v of [0, 1_786_955_400_000, 1_786_701_733_460]) cases.push({ f: 'date', v }, { f: 'time', v })
    expect(format(cases.map(({ f, v }) => ({ f, v: String(v) })))).toEqual(cases.map(({ f, v }) => FORMATS[f]!(v)))
  })

  it('adds the parts of a sum, and leaves an empty or unknown value alone', () => {
    expect(format([{ f: 'num', v: '3+1' }, { f: 'num', v: '' }, { f: 'num', v: 'x' }, { f: 'nope', v: '5' }])).toEqual(['4', 'unset', 'unset', 'unset'])
  })
})

// slots.md holds the rules of the 3 word slots only. The code behind `orangu show-me --render` sets every other
// value. So the code is the contract: each name in a template is one that a page of values sets, in some scope.
describe('show-me slot contract', () => {
  type Names = Record<'slot' | 'if' | 'chart' | 'list', Set<string>>
  const collect = (scope: Partial<Page> | Item, into: Names): Names => {
    for (const key of Object.keys(scope.slots ?? {})) into.slot.add(key)
    for (const condition of scope.conditions ?? []) into.if.add(condition)
    for (const key of Object.keys(scope.charts ?? {})) into.chart.add(key)
    for (const [key, items] of Object.entries(scope.lists ?? {})) {
      into.list.add(key)
      for (const item of items) collect(item, into)
    }
    return into
  }
  // every shape that sets an optional value: a live session that does not reconcile, with hidden details and savings
  const everything = (a: Analysis): Analysis => ({
    ...a,
    session: { ...a.session, live: true },
    parse: { ...a.parse, reconciliation: { ...a.parse.reconciliation, ok: false } },
    insights: a.insights.map((insight) => ({ ...insight, detail: '', savings: { tokens: 100, ms: 1_000, estimated: true } })),
  })
  const evidence = projectEvidence(JSON.parse(read('test/golden/aggregate.json')), { scope: 'repo' })
  const withSavings = { ...evidence, findings: evidence.findings.map((f) => ({ ...f, finding: { ...f.finding, evidence: { ...f.finding.evidence, savingsTokens: 100, savingsMs: 1_000 } } })) }
  const pages: Page[] = [
    ...['errors-and-interrupts', 'single-prompt', 'live-partial'].flatMap((name) => [sessionPage(slimAnalysis(golden(name)), WORDS), sessionPage(slimAnalysis(everything(golden(name))), WORDS)]),
    ...(['repo', 'global'] as const).flatMap((scope) => [evidence, withSavings].map((e) => aggregatePage(e, scope, { folder: 'demo', version: '0.0.0-test', words: WORDS }))),
  ]
  const set = pages.reduce((names, page) => collect(page, names), { slot: new Set<string>(), if: new Set<string>(), chart: new Set<string>(), list: new Set<string>() } as Names)

  for (const name of NAMES) {
    it(`every slot, condition, chart and list in ${name}.html is one that the fill code sets, and each slot holds an EXAMPLE sample`, () => {
      const html = built(name)
      for (const slot of slotNames(html)) expect(set.slot.has(slot), `the fill sets ${slot}`).toBe(true)
      for (const m of html.matchAll(/<([a-z0-9]+)\b[^>]*\bdata-slot="([^"]+)"[^>]*>([^<]*)<\/\1>/g))
        expect(m[3], `${m[2]} sample value`).toMatch(/^EXAMPLE /)
      for (const m of html.matchAll(/\bdata-(if|chart)="([^"]+)"/g)) expect(set[m[1] as 'if' | 'chart'].has(m[2]!), `the fill sets data-${m[1]} ${m[2]}`).toBe(true)
      for (const m of html.matchAll(/\bdata-(?:repeat|empty)="([^"]+)"/g)) expect(set.list.has(m[1]!), `the fill sets the list ${m[1]}`).toBe(true)
    })
  }

  // The skill reads the rules of the 3 words only: every other rule is code, and no word has a count.
  it('slots.md names the 3 word slots and no other slot, with no word or sentence count', () => {
    const rules = read(`${DIR}/slots.md`)
    expect([...rules.matchAll(/^## `([^`]+)`$/gm)].map((m) => m[1])).toEqual(['verdict', 'summary', 'improvementsTitle'])
    for (const slot of set.slot) if (!['verdict', 'summary', 'improvements-title'].includes(slot)) expect(rules, `slots.md names ${slot}`).not.toContain(`\`${slot}\``)
    expect(rules).not.toMatch(/\b(?:words|sentences|characters) or (?:fewer|less|more)\b|\b\d+ (?:words?|sentences?|characters?)\b/i)
  })

  it('one rule set fills both files: the report adds only its summary and its footer date', () => {
    const deck = new Set(slotNames(built('slides')))
    expect(slotNames(built('report')).filter((slot) => !deck.has(slot)).sort()).toEqual(['generated', 'summary'])
  })
})

describe('show-me filled from synthetic fixtures', () => {
  const fillBoth = (page: ReturnType<typeof sessionPage>): Record<(typeof NAMES)[number], string> =>
    ({ slides: fillTemplate(built('slides'), page), report: fillTemplate(built('report'), page) })

  // A filled file keeps the template's one script byte for byte, so the pinned hash still matches it.
  const keepsTheScriptSurface = (html: string, name: string): void => {
    expect(scriptSurface(html), `${name} script surface`).toEqual({ scripts: 1, handlers: [], jsUrls: [] })
    expect(html, `${name} keeps the pinned script`).toContain(`script-src 'sha256-${sha256(scripts(html)[0]!)}'`)
  }

  it('hostile session text stays text: no script, no event handler, no javascript: URL', () => {
    const hostile = '</title><script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">x</a>'
    const a = golden('errors-and-interrupts')
    const page = sessionPage(slimAnalysis({ ...a, session: { ...a.session, title: hostile, projectSlug: hostile } }), WORDS)
    for (const [name, html] of Object.entries(fillBoth(page))) {
      keepsTheScriptSurface(html, name)
      expect(html).toContain('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
    }
  })

  it('a session with 3 findings: 8 slides, no sample value left, offline', () => {
    const files = fillBoth(sessionPage(slimAnalysis(golden('errors-and-interrupts')), WORDS))
    expect(files.slides.match(/aria-roledescription="slide"/g)).toHaveLength(8)
    expect(files.report.match(/<article class="finding"/g)).toHaveLength(3)
    for (const name of NAMES) {
      const html = files[name]
      expect(html, `${name} keeps a sample value`).not.toContain('EXAMPLE')
      expect(html, `${name} leaves a number without its CLI value`).not.toContain('data-v=""')
      expect(html).toContain('<html lang="en" data-scope="session" data-live="false" data-caution="false" data-redacted="false">')
      expect(html).toContain('2 of 2 test runs failed')
      keepsTheScriptSurface(html, name)
      expect(offline(html, `${name}.html`).status).toBe(0)
    }
  })

  it('a session with no finding: no finding slide, the empty improvement state, offline', () => {
    const a = golden('single-prompt')
    const files = fillBoth(sessionPage(slimAnalysis({ ...a, insights: [], summary: { ...a.summary, topInsightIds: [] } }), WORDS))
    expect(files.slides.match(/aria-roledescription="slide"/g)).toHaveLength(5)
    for (const name of NAMES) {
      expect(files[name]).not.toContain('EXAMPLE')
      expect(files[name]).toContain('No improvements found')
      expect(files[name]).toContain('<code>npx orangu</code>')
      expect(files[name]).not.toContain('/orangu:improve')
      expect(offline(files[name], `${name}.html`).status).toBe(0)
    }
  })

  it('a repository aggregate: recurring findings, the harness command, offline', () => {
    const evidence = projectEvidence(JSON.parse(read('test/golden/aggregate.json')), { scope: 'repo' })
    const page = aggregatePage(evidence, 'repo', { folder: 'demo', version: '0.0.0-test', words: WORDS })
    for (const [name, html] of Object.entries(fillBoth(page))) {
      expect(html).not.toContain('EXAMPLE')
      expect(html).toContain('Recurring patterns in demo')
      keepsTheScriptSurface(html, name)
      expect(html).toContain('<code>claude "/orangu:harness --scope repo"</code>')
      expect(html).not.toContain('/orangu:improve')
      expect(offline(html, `${name}.html`).status).toBe(0)
    }
  })
})

// ---------- the run estimate and the review fixes ----------

const fillAll = (page: ReturnType<typeof sessionPage>): { slides: string; report: string } => ({
  slides: fillTemplate(built('slides'), page),
  report: fillTemplate(built('report'), page),
})
const evidenceOf = (mutate: (aggregate: Record<string, unknown>) => void = () => undefined) => {
  const aggregate = JSON.parse(read('test/golden/aggregate.json')) as Record<string, unknown>
  mutate(aggregate)
  return projectEvidence(aggregate, { scope: 'repo' })
}
const repoPage = (evidence: ReturnType<typeof evidenceOf>) => aggregatePage(evidence, 'repo', { folder: 'demo', version: '0.0.0-test', words: WORDS })
const oneTurn = (): Analysis => {
  const a = golden('errors-and-interrupts')
  return { ...a, summary: { ...a.summary, turns: 1 }, insights: a.insights.map((insight) => ({ ...insight, turnIndexes: [0] })) }
}

/** Every filled shape the tests know: 3 findings, 0 findings, 1 turn, hostile text, a repository, an empty one, 1 session. */
function filledFiles(): Array<[string, string]> {
  const a = golden('errors-and-interrupts')
  const single = golden('single-prompt')
  // markup in session text: the fill writes it as escaped text
  const hostile = '</title><script>alert(1)</script><b>bold</b> JavaScript: tests'
  const oneSession = evidenceOf()
  const pages: Array<[string, ReturnType<typeof sessionPage>]> = [
    ['session', sessionPage(slimAnalysis(a), WORDS)],
    ['no finding', sessionPage(slimAnalysis({ ...single, insights: [], summary: { ...single.summary, topInsightIds: [] } }), WORDS)],
    ['one turn', sessionPage(slimAnalysis(oneTurn()), WORDS)],
    ['hostile', sessionPage(slimAnalysis({ ...a, session: { ...a.session, title: hostile, projectSlug: hostile } }), WORDS)],
    ['repo', repoPage(evidenceOf())],
    ['empty repo', repoPage(evidenceOf((aggregate) => (aggregate['crossFindings'] = [])))],
    ['one session', repoPage({ ...oneSession, source: { ...oneSession.source, sessions: 1 } })],
  ]
  return pages.flatMap(([name, page]) => {
    const { slides, report } = fillAll(page)
    return [[`${name} slides`, slides], [`${name} report`, report]] as Array<[string, string]>
  })
}

describe('show-me review fixes', () => {
  it('turns read as positions in the report form, with a noun that agrees with the count', () => {
    for (const html of Object.values(fillAll(sessionPage(slimAnalysis(golden('errors-and-interrupts')), WORDS)))) {
      expect(html).toContain('In turns')
      expect(html).toContain('#0')
      expect(html).toMatch(/3<\/span> <span data-slot="turn-noun">turns<\/span> in the session/)
    }
    for (const html of Object.values(fillAll(sessionPage(slimAnalysis(oneTurn()), WORDS))))
      expect(html).toMatch(/1<\/span> <span data-slot="turn-noun">turn<\/span> in the session/)
  })

  it('no filled file says "1 sessions" or "1 turns"', () => {
    for (const [name, html] of filledFiles()) expect(html.replace(/<[^>]+>/g, ''), name).not.toMatch(/\b1 (?:sessions|turns)\b/)
  })

  it('a repository with no finding shows the designed empty state, invents nothing, and stays offline', () => {
    const empty = evidenceOf((aggregate) => (aggregate['crossFindings'] = []))
    expect(empty.findings).toEqual([])
    const { slides, report } = fillAll(repoPage(empty))
    for (const [name, html] of [['slides', slides], ['report', report]] as const) {
      expect(html, name).not.toContain('EXAMPLE')
      expect(html, name).not.toContain('data-slot="kpi-top-n"')
      expect(html, name).toContain('The rules found no finding in these sessions.')
      expect(offline(html, `${name}.html`).status).toBe(0)
    }
  })

  it('marks every sample chart, and the fill removes each mark', () => {
    for (const name of NAMES) {
      const charts = built(name).match(/<[^>]*\bdata-chart="[^"]+"[^>]*>/g) ?? []
      expect(charts.length, name).toBeGreaterThan(0)
      for (const tag of charts) expect(tag, name).toContain('data-sample')
    }
    for (const [name, html] of filledFiles()) expect(html, name).not.toContain('data-sample')
  })

  it('asks the model to add no numbers: each outcome is one CLI count', () => {
    expect(read('plugin/skills/show-me/references/slots.md')).not.toMatch(/\bplus\b/)
    expect(fillAll(sessionPage(slimAnalysis(golden('errors-and-interrupts')), WORDS)).slides).toContain('1 file edited · 2 of 2 test runs failed')
  })

  // A Read tool can cut a line at 2,000 characters. The longest line is the canonical tokens line, about 1,300.
  it('ships an ASCII runtime and no line that a reader could cut', () => {
    for (const name of NAMES) {
      expect(scripts(built(name))[0], name).toMatch(/^[\x00-\x7f]*$/)
      expect(Math.max(...built(name).split('\n').map((line) => line.length)), `${name} longest line`).toBeLessThan(2000)
    }
  })

  // SKILL.md states one estimate before any read: data.json from the prepare output, plus the slot rules. The model
  // reads no template and writes no HTML, so the estimate names neither. The stated size must match slots.md.
  it('states the slot-rule read within 20% of slots.md, and takes the data.json size from the prepare output', () => {
    const skill = read('plugin/skills/show-me/SKILL.md')
    expect(skill).toContain('`data.bytes` and `data.approxTokens` from that output')
    const stated = /Add about (\d+) KB \(about (\d+) tokens\) for the slot rules\./.exec(skill)
    expect(stated, 'SKILL.md states the slot-rule read').toBeTruthy()
    const [kb, tokens] = stated!.slice(1).map(Number)
    const bytes = Buffer.byteLength(read('plugin/skills/show-me/references/slots.md'))
    const near = (value: number, actual: number, label: string): void => {
      expect(value / actual, label).toBeGreaterThan(0.8)
      expect(value / actual, label).toBeLessThan(1.2)
    }
    near(kb!, bytes / 1024, 'slot rules KB')
    near(tokens!, bytes / 4, 'slot rules tokens at 4 bytes a token')
  })
})
