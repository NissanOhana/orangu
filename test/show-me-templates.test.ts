/**
 * The two /orangu:show-me templates. Each is built from its source, offline, typeset on the canonical tokens,
 * and fillable by the slot rules the skill follows. A deck and a written report filled from synthetic
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
import { FORMATS, aggregatePage, countCheck, fillTemplate, sessionPage, showMeChecks, type Words } from './fixtures/show-me-fill.js'

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
  whys: ['Each failed tool call used a turn and gave the agent no new evidence.', 'The session ended on a failing test run.', 'The model sent its request again.'],
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

describe('show-me runtime', () => {
  // Run the shipped runtime against a minimal document: each number element gets the text that the report's
  // own formatter gives, so a deck, a written report and an orangu report never disagree.
  function format(cases: Array<{ f: string; v: string }>): string[] {
    const elements = cases.map(({ f, v }) => ({ dataset: { f, v }, textContent: 'unset' }))
    const document = {
      documentElement: { dataset: {} as Record<string, string> },
      querySelectorAll: (selector: string) => (selector === '[data-f][data-v]' ? elements : []),
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

describe('show-me slot contract', () => {
  const rules = read(`${DIR}/slots.md`)
  const named = new Set([...rules.matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]!))

  for (const name of NAMES) {
    it(`every slot in ${name}.html is named in the slot rules and holds an EXAMPLE sample`, () => {
      const html = built(name)
      for (const slot of slotNames(html)) expect(named.has(slot), `slots.md names ${slot}`).toBe(true)
      for (const m of html.matchAll(/<([a-z0-9]+)\b[^>]*\bdata-slot="([^"]+)"[^>]*>([^<]*)<\/\1>/g))
        expect(m[3], `${m[2]} sample value`).toMatch(/^EXAMPLE /)
      for (const m of html.matchAll(/\bdata-(?:if|chart)="([^"]+)"/g)) expect(named.has(m[1]!), `slots.md names ${m[1]}`).toBe(true)
    })
  }

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

// ---------- the post-write check, the run estimate, and the review fixes ----------

const CHECKS = showMeChecks(read('plugin/skills/show-me/SKILL.md'))
const BY = ['lines', 'matches'] as const
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
  const hostile = '</title><script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">x</a>'
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

describe('show-me post-write check (SKILL.md, step 4)', () => {
  it('is 7 counts: no sample, no active markup, 1 script, 5 metas, 1 http-equiv, 1 link, the exact CSP line', () => {
    expect(CHECKS.map(({ expected }) => expected)).toEqual([0, 0, 1, 5, 1, 1, 1])
  })

  // Grep in count mode may count lines, not matches. The templates put each counted tag alone on a line with no
  // slot, so an injected tag always lands on another line and both counts move.
  for (const name of NAMES) {
    it(`${name}.html keeps each counted tag alone on a line with no slot, and has no active markup`, () => {
      const html = built(name)
      for (const check of CHECKS.slice(2)) {
        for (const by of BY) expect(countCheck(html, check, by), `${check.pattern} by ${by}`).toBe(check.expected)
        for (const line of html.split('\n').filter((l) => new RegExp(check.pattern, 'i').test(l))) {
          expect(line, check.pattern).not.toContain('data-slot')
          expect(line.match(new RegExp(check.pattern, 'gi'))?.length, `one ${check.pattern} on its line`).toBe(1)
        }
      }
      for (const by of BY) expect(countCheck(html, CHECKS[1]!, by), 'active markup in the template').toBe(0)
    })
  }

  it('every filled shape passes every count, by lines and by matches', () => {
    for (const [name, html] of filledFiles())
      for (const check of CHECKS) for (const by of BY) expect(countCheck(html, check, by), `${name}: ${check.pattern} by ${by}`).toBe(check.expected)
  })

  // The forms that the security review proved against the CSP-only defence, plus a dropped and a loosened CSP.
  it('every injection, a dropped or loosened CSP, and a leftover sample fail a count, by lines and by matches', () => {
    const base = fillAll(sessionPage(slimAnalysis(golden('errors-and-interrupts')), WORDS)).slides
    const titleSlot = '<h1 class="dp" data-slot="title">Run the flaky suite</h1>'
    expect(base).toContain(titleSlot)
    const inSlot = (payload: string): string => base.replace(titleSlot, `<h1 class="dp" data-slot="title">${payload}</h1>`)
    const variants: Array<[string, string]> = [
      ['meta refresh in the title', base.replace('<title data-slot="title">Run the flaky suite</title>', '<title data-slot="title"></title><meta http-equiv="refresh" content="0;url=https:evil.example/x"></title>')],
      ['meta refresh in the body, no slashes', inSlot('<meta http-equiv="refresh" content="0;url=http:127.0.0.1:9/noslash">')],
      ['onerror after a slash', inSlot('<img src="data:,"/onerror="x()">')],
      ['svg onload', inSlot('<svg/onload=x()>')],
      ['a quoted > before the handler', inSlot('<img alt=">" onerror=x()>')],
      ['a handler on the next line', inSlot('<img src=x\nonerror=x()>')],
      ['an entity-encoded javascript: link', inSlot('<a href="java&#115;cript:x()">x</a>')],
      ['an svg set to an encoded javascript:', inSlot('<svg><set attributeName="href" to="java&#115;cript:x()"/></svg>')],
      ['a named-entity javascript: link', inSlot('<a href="java&Tab;script:x()">x</a>')],
      ['an upper-case javascript: link', inSlot('<A HREF="JAVASCRIPT:x()">x</A>')],
      ['a second script', inSlot('<script>x()</script>')],
      ['an iframe', inSlot('<iframe srcdoc="&lt;script&gt;x()&lt;/script&gt;"></iframe>')],
      ['a base', inSlot('<base href="https://evil.example/">')],
      ['a link with no slashes', inSlot('<a href="https:evil.example">x</a>')],
      ['a form', inSlot('<form action="https://evil.example"><button>x</button></form>')],
      ['an object', inSlot('<object data="data:text/html,x"></object>')],
      ['a dropped CSP', base.replace(/^<meta http-equiv="Content-Security-Policy"[^\n]*\n/m, '')],
      ['a loosened CSP', base.replace("script-src 'sha256-", "script-src 'unsafe-inline' 'sha256-")],
      ['a leftover sample sentence', inSlot('EXAMPLE The session ran.')],
      ['a chart left at its sample values', base.replace('<svg class="ring" data-chart="cache"', '<svg class="ring" data-chart="cache" data-sample')],
    ]
    for (const [name, html] of variants) {
      expect(html, `${name} changes the file`).not.toBe(base)
      for (const by of BY) expect(CHECKS.some((check) => countCheck(html, check, by) !== check.expected), `${name} passes every count by ${by}`).toBe(true)
    }
  })
})

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

  it('marks every sample chart, so a chart that the skill did not set stays countable', () => {
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

  it('ships an ASCII runtime and no line that a reader could cut', () => {
    for (const name of NAMES) {
      expect(scripts(built(name))[0], name).toMatch(/^[\x00-\x7f]*$/)
      expect(Math.max(...built(name).split('\n').map((line) => line.length)), `${name} longest line`).toBeLessThan(1000)
    }
  })

  // SKILL.md states one estimate of the whole run before any read; it must match what the run reads and writes.
  it('states the read and write sizes of the run within 20% of the built templates and a filled pair', () => {
    const stated = /about (\d+) KB to read \(about (\d+)k tokens\)\. The 2 files are about (\d+) KB to write \(about (\d+)k tokens\)/.exec(read('plugin/skills/show-me/SKILL.md'))
    expect(stated, 'SKILL.md states the run estimate').toBeTruthy()
    const [readKb, readTokens, writeKb, writeTokens] = stated!.slice(1).map(Number)
    const readBytes = Buffer.byteLength(built('slides')) + Buffer.byteLength(built('report')) + Buffer.byteLength(read('plugin/skills/show-me/references/slots.md'))
    const filled = fillAll(sessionPage(slimAnalysis(golden('errors-and-interrupts')), WORDS))
    const writeBytes = Buffer.byteLength(filled.slides) + Buffer.byteLength(filled.report)
    const near = (value: number, actual: number, label: string): void => {
      expect(value / actual, label).toBeGreaterThan(0.8)
      expect(value / actual, label).toBeLessThan(1.2)
    }
    near(readKb!, readBytes / 1024, 'read KB')
    near(readTokens!, readBytes / 4 / 1000, 'read tokens at 4 bytes a token')
    near(writeKb!, writeBytes / 1024, 'write KB')
    near(writeTokens!, writeBytes / 4 / 1000, 'write tokens at 4 bytes a token')
  })
})
