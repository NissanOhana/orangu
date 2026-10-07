/**
 * The security properties of `orangu show-me --render`, one test each (1 to 7), the 2 probes that broke the old
 * test fixture fill, and the hostile words (9) with the offline gate (8). Each test name starts with the number of
 * its property.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NO_CHANGE } from '../analyze/insights.js'
import type { Analysis } from '../model/analysis.js'
import { projectEvidence } from '../suggest/evidence.js'
import { MAX_EVIDENCE_ARTIFACT_BYTES } from '../suggest/evidence.js'
import { slimAnalysis } from '../suggest/slim.js'
import { SelfCheckError, selfCheck } from './check.js'
import { validateShowMeData } from './data.js'
import { ATTRIBUTES, FillError, escapeHtml, fillTemplate, type Page } from './fill.js'
import { REPORT_HTML, SLIDES_HTML } from './generated/templates.js'
import { aggregatePage, sessionPage } from './pages.js'
import { prepareRun } from './prepare.js'
import { ShowMeRenderError, TEMPLATES, renderShowMe } from './render.js'
import { ShowMeInputError, validateWords, type Words } from './words.js'

const root = process.cwd()
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const golden = (name: string): Analysis => JSON.parse(read(`test/golden/${name}.analysis.json`)) as Analysis
const session = () => slimAnalysis(golden('errors-and-interrupts'))
const evidence = () => projectEvidence(JSON.parse(read('test/golden/aggregate.json')), { scope: 'repo' })
const repoData = () => ({ ...evidence(), folder: 'demo', version: '0.0.0-test' })

const WORDS: Words = {
  verdict: 'The session changed 1 file, and both test runs failed before it ended.',
  summary: 'The session ran the flaky test suite and changed 1 file. Both test runs failed.',
  improvementsTitle: 'Three changes for the next session',
}
/** the hostile words of the security review: each one must render as text */
const HOSTILE = [
  '<script>alert(1)</script>',
  '" onload="x',
  'javascript:',
  '</title><script>',
  '<!--',
  '&#106;avascript:',
  '<svg><set attributeName="href" to="https://x"/>',
]
const LONG = `${'The agent read the same file again '.repeat(290)}and stopped.`
const hostileWords = (i = 0): Words => ({ verdict: HOSTILE[i % 7]!, summary: HOSTILE[(i + 1) % 7]!, improvementsTitle: HOSTILE[(i + 2) % 7]! })

/** The markup outside the style and the script: what a value must never change. */
const tags = (html: string): string[] => html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '').match(/<[a-zA-Z][^>]*>/g) ?? []
const fillBoth = (page: Page): Array<[string, string, string]> => TEMPLATES.map(({ file, html }) => [file, fillTemplate(html, page), html])
const decode = (text: string): string =>
  text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&#58;', ':').replaceAll('&amp;', '&')

function tempBase(): string {
  const base = join(mkdtempSync(join(tmpdir(), 'orangu-show-me-test-')), 'show-me')
  mkdirSync(base, { mode: 0o700 })
  return base
}
async function run(base: string, data: unknown, words: unknown = WORDS): Promise<string> {
  const { dir } = await prepareRun('session', 'aaaaaaaa', typeof data === 'string' ? data : JSON.stringify(data), { base })
  writeFileSync(join(dir, 'words.json'), typeof words === 'string' ? words : JSON.stringify(words))
  return dir
}
const written = (dir: string): string[] => readdirSync(dir).filter((name) => name.endsWith('.html') || name.endsWith('.tmp')).sort()

describe('show-me security properties', () => {
  it('1. words.json is one input of exactly 3 strings: another key, a value that is not a string, an empty string, a control character and a file over the bound are refused', async () => {
    expect(validateWords({ ...WORDS })).toEqual(WORDS)
    // no length cap: a 10,000-character sentence is a valid word
    expect(LONG.length).toBeGreaterThan(10_000)
    expect(validateWords({ ...WORDS, verdict: LONG }).verdict).toBe(LONG)
    const refused: unknown[] = [
      null,
      [],
      'words',
      { ...WORDS, template: 'slides.html' },
      { ...WORDS, whys: ['a'] },
      JSON.parse(`{"verdict":"a","summary":"b","improvementsTitle":"c","__proto__":{"x":1}}`),
      { verdict: 'a', summary: 'b' },
      { ...WORDS, verdict: 7 },
      { ...WORDS, summary: ['a'] },
      { ...WORDS, improvementsTitle: { text: 'a' } },
      { ...WORDS, verdict: null },
      { ...WORDS, verdict: '' },
      { ...WORDS, summary: '   ' },
      ...['\u0000', '\n', '\t', '\r', '\u001b', '\u001f', '\u007f', '\u0080', '\u009b', '\u009f'].map((c) => ({ ...WORDS, verdict: `one${c}two` })),
    ]
    for (const raw of refused) expect(() => validateWords(raw), JSON.stringify(raw)).toThrow(ShowMeInputError)
    // over the read bound: refused before it is parsed, and nothing is written
    const base = tempBase()
    const dir = await run(base, session(), ' '.repeat(MAX_EVIDENCE_ARTIFACT_BYTES + 1))
    await expect(renderShowMe(dir, { base })).rejects.toThrow(/more than 8388608 bytes/)
    expect(written(dir)).toEqual([])
  })

  it('2. every slot value reaches the HTML only through escapeHtml: hostile words and hostile data change text nodes, never a tag', () => {
    // the one writer: the text decodes back to the value and holds no markup character
    for (const value of [...HOSTILE, LONG, 'a & b', `it's "x"`]) {
      const text = escapeHtml(value)
      expect(text, value).not.toMatch(/[<>"']/)
      expect(text.replaceAll(/&(?:amp|lt|gt|quot|#39|#58);/g, ''), value).not.toContain('&')
      expect(decode(text), value).toBe(value)
    }
    // the same data with benign and with hostile strings in every text slot gives the same tags. A present text
    // stays present, and a "No change needed." improvement keeps its verdict, so the lists keep their length.
    const hostileSession = (() => {
      const a = session()
      let i = 0
      const next = (): string => HOSTILE[i++ % HOSTILE.length]!
      const swap = (text: string | undefined): string | undefined => (text === undefined ? undefined : text.startsWith(NO_CHANGE) ? `${NO_CHANGE} ${next()}` : next())
      return {
        ...a,
        session: { ...a.session, title: next(), projectSlug: swap(a.session.projectSlug), cwd: next(), models: a.session.models.map((m) => ({ ...m, displayName: next() })) },
        insights: a.insights.map((insight) => ({ ...insight, title: next(), detail: next(), improvement: swap(insight.improvement)!, why: swap(insight.why), recommendation: next() })),
      }
    })()
    const plain = fillBoth(sessionPage(session(), WORDS))
    const hostile = fillBoth(sessionPage(hostileSession, hostileWords()))
    for (let f = 0; f < plain.length; f++) {
      expect(tags(hostile[f]![1]), plain[f]![0]).toEqual(tags(plain[f]![1]))
      for (const value of HOSTILE) if (/[<>"]/.test(value)) expect(hostile[f]![1], value).not.toContain(value)
      selfCheck(hostile[f]![1], hostile[f]![2], hostile[f]![0])
    }
    // one definition of the writer in src/show-me and the fixture (the fixture re-exports it)
    const sources = readdirSync(join(root, 'src/show-me')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => read(`src/show-me/${f}`))
    const definitions = [...sources, read('test/fixtures/show-me-fill.ts')].join('\n').match(/(?:function|const|let)\s+escapeHtml\b/g) ?? []
    expect(definitions).toHaveLength(1)
  })

  it('3. the fill sets only allowlisted attributes: an enum word outside its list, a number that is not finite and any other name are refused', () => {
    expect([...ATTRIBUTES].sort()).toEqual(['data-caution', 'data-end', 'data-live', 'data-redacted', 'data-scope', 'data-sev', 'data-v', 'x'])
    const page = sessionPage(session(), WORDS)
    const first = page.lists['finding']![0]!
    // the turn strip and its markers render only for a finding with turns
    const finding = { ...first, conditions: [...(first.conditions ?? []), 'turns'] }
    const withFinding = (item: typeof finding): Page => ({ ...page, lists: { ...page.lists, finding: [item] } })
    const refused: Array<[string, Page]> = [
      ['data-sev outside its enum', withFinding({ ...finding, attrs: { 'data-sev': 'urgent' } })],
      ['data-sev that closes its quote', withFinding({ ...finding, attrs: { 'data-sev': 'high" onload="x' } })],
      ['x that is not a whole number', withFinding({ ...finding, lists: { turn: [{ attrs: { x: 1.5 } }] } })],
      ['x below 0', withFinding({ ...finding, lists: { turn: [{ attrs: { x: -1 } }] } })],
      ['x that is NaN', withFinding({ ...finding, lists: { turn: [{ attrs: { x: Number.NaN } }] } })],
      ['data-scope outside its enum', { ...page, root: { ...page.root, 'data-scope': 'admin' } }],
      ['data-live outside its enum', { ...page, root: { ...page.root, 'data-live': 'yes' } }],
      ['data-end outside its enum', { ...page, end: 'clean" x="1' }],
      ['data-v of Infinity', { ...page, slots: { ...page.slots, tokens: { v: Number.POSITIVE_INFINITY } } }],
      ['a bar value of NaN', { ...page, charts: { ...page.charts, time: { kind: 'bars', values: { active: Number.NaN }, label: 'x' } } }],
      ['a bar key that is a pattern', { ...page, charts: { ...page.charts, time: { kind: 'bars', values: { 'active|waiting': 1 }, label: 'x' } } }],
      ['a ring total below 0', { ...page, charts: { ...page.charts, cache: { kind: 'ring', value: 1, of: -100, label: 'x' } } }],
      ['a turn count of Infinity', withFinding({ ...finding, charts: { turns: { kind: 'turns', turns: Number.POSITIVE_INFINITY, label: 'x' } } })],
    ]
    for (const [name, bad] of refused) expect(() => fillTemplate(SLIDES_HTML, bad), name).toThrow(FillError)
    // an attribute name that is not on the list is never read from an item: it cannot reach the file
    const extra = withFinding({ ...finding, attrs: { 'data-sev': 'low', onclick: 'x()', href: 'https://x' } as never })
    const out = fillTemplate(SLIDES_HTML, extra)
    expect(out).not.toContain('onclick')
    selfCheck(out, SLIDES_HTML, 'slides.html')
  })

  it('4. the fill uses only the 2 embedded templates from a fixed list: no flag, data key or word names a template', async () => {
    expect(TEMPLATES.map(({ file }) => file)).toEqual(['slides.html', 'report.html'])
    expect(TEMPLATES[0]!.html).toBe(SLIDES_HTML)
    expect(TEMPLATES[1]!.html).toBe(REPORT_HTML)
    expect(Object.isFrozen(TEMPLATES) && TEMPLATES.every((t) => Object.isFrozen(t))).toBe(true)
    // no code in src/show-me reads a template file or names the references folder (comments may name them)
    for (const file of readdirSync(join(root, 'src/show-me')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const code = read(`src/show-me/${file}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code, file).not.toMatch(/readFile|references\/|\.src\.html/)
    }
    // a data key that names a template changes no byte, and a word key that names one is refused
    const base = tempBase()
    const plain = await run(base, session())
    const keyed = await run(base, { ...session(), template: '/etc/passwd', templates: ['x.html'], templatePath: '../x.html' })
    await renderShowMe(plain, { base })
    await renderShowMe(keyed, { base })
    for (const file of ['slides.html', 'report.html']) expect(readFileSync(join(keyed, file), 'utf8'), file).toBe(readFileSync(join(plain, file), 'utf8'))
    const worded = await run(base, session(), { ...WORDS, template: 'x.html' })
    await expect(renderShowMe(worded, { base })).rejects.toThrow(ShowMeInputError)
    expect(written(worded)).toEqual([])
  })

  it('5. the self-check refuses a file whose html tag, head, script, http-equiv, links, tags or attributes differ from the template', () => {
    const pages: Page[] = [sessionPage(session(), WORDS), aggregatePage(evidence(), 'repo', { folder: 'demo', version: '1', words: WORDS }), aggregatePage(evidence(), 'global', { version: '1', words: WORDS })]
    for (const page of pages) for (const [file, out, template] of fillBoth(page)) expect(() => selfCheck(out, template, file), file).not.toThrow()
    // text that reads like markup is text: it never stops the render
    const wordy = fillBoth(sessionPage(session(), { ...WORDS, verdict: 'Set http-equiv="refresh" and href=x in the page.' }))
    for (const [file, out, template] of wordy) expect(() => selfCheck(out, template, file), file).not.toThrow()

    const [, slides] = fillBoth(sessionPage(session(), WORDS))[0]!
    const runtime = /<script>([\s\S]*?)<\/script>/.exec(slides)![1]!
    const mutations: Array<[string, string]> = [
      ['an extra attribute on <html>', slides.replace('<html lang="en" ', '<html lang="en" data-x="1" ')],
      ["an open ' in <html> that swallows the head", slides.replace('<html lang="en" ', `<html lang="en" data-x=' `)],
      ['markup before <html>', slides.replace('<html', '<img src="x">\n<html')],
      ['a loosened CSP', slides.replace("script-src 'sha256-", "script-src 'unsafe-inline' 'sha256-")],
      ['the CSP moved under <body>', slides.replace(/<meta http-equiv="Content-Security-Policy"[^\n]*\n/, '').replace('<body>', (m) => `${m}\n${/<meta http-equiv="Content-Security-Policy"[^\n]*/.exec(slides)![0]}`)],
      ['a meta after the CSP', slides.replace('<meta name="robots" content="noindex"/>', '<meta name="robots" content="noindex"/>\n<meta name="referrer" content="unsafe-url"/>')],
      ['a style changed', slides.replace('box-sizing:border-box', 'box-sizing:content-box')],
      ['a second script', slides.replace('</main>', '<script>x()</script></main>')],
      ['the runtime swapped', slides.replace(runtime, "document.title='x'")],
      ['a refresh meta in the body', slides.replace('<main class="deck"', '<meta http-equiv="refresh" content="0;url=https:x"><main class="deck"')],
      ['the one link retargeted', slides.replace('href="report.html"', 'href="https:evil.example/?d=x"')],
      ['a second link', slides.replace('</main>', '<a href="report.html">x</a></main>')],
      ['an svg link set by <set>', slides.replace('</main>', '<svg><a><set attributeName="href" to="https:x"/><text>x</text></a></svg></main>')],
      ['an event handler on a template tag', slides.replace('<main class="deck"', '<main onfocus="x()" class="deck"')],
      ['a base tag', slides.replace('</main>', '<base href="https:x/"></main>')],
    ]
    for (const [name, html] of mutations) {
      expect(html, `${name} changes the file`).not.toBe(slides)
      expect(() => selfCheck(html, SLIDES_HTML, 'slides.html'), name).toThrow(SelfCheckError)
    }
  })

  it('6. --render accepts only a run directory directly under the show-me base that holds a data.json', async () => {
    const base = tempBase()
    const good = await run(base, session())
    const outside = mkdtempSync(join(tmpdir(), 'orangu-show-me-outside-'))
    writeFileSync(join(outside, 'data.json'), JSON.stringify(session()))
    writeFileSync(join(outside, 'words.json'), JSON.stringify(WORDS))
    const nested = join(good, 'deeper')
    mkdirSync(nested)
    writeFileSync(join(nested, 'data.json'), JSON.stringify(session()))
    writeFileSync(join(nested, 'words.json'), JSON.stringify(WORDS))
    const link = join(base, 'session-link-abcdef')
    symlinkSync(outside, link)
    const noData = join(base, 'session-nodata-abcdef')
    mkdirSync(noData)
    writeFileSync(join(noData, 'words.json'), JSON.stringify(WORDS))
    const linkedData = join(base, 'session-linkeddata-abcdef')
    mkdirSync(linkedData)
    symlinkSync(join(outside, 'data.json'), join(linkedData, 'data.json'))
    writeFileSync(join(linkedData, 'words.json'), JSON.stringify(WORDS))
    const refused: Array<[string, string]> = [
      ['a directory outside the base', outside],
      ['the base itself', base],
      ['a folder inside a run directory', nested],
      ['a path that leaves the base with ..', join(base, '..', 'show-me', '..')],
      ['a link inside the base to a directory outside it', link],
      ['a run directory with no data.json', noData],
      ['a data.json that is a link', linkedData],
      ['a directory that does not exist', join(base, 'session-missing-abcdef')],
    ]
    for (const [name, dir] of refused) await expect(renderShowMe(dir, { base }), name).rejects.toThrow(/run directory|does not exist|data\.json|regular file/)
    for (const dir of [outside, nested, noData, linkedData]) expect(written(dir), dir).toEqual([])
    // with no base at all, nothing is a run directory
    await expect(renderShowMe(good, { base: join(base, 'none') })).rejects.toThrow(ShowMeRenderError)
    // the run directory itself renders, both files at 0600
    const result = await renderShowMe(good, { base })
    expect(written(good)).toEqual(['report.html', 'slides.html'])
    if (process.platform !== 'win32') for (const path of [result.slides, result.report]) expect(statSync(path).mode & 0o777, path).toBe(0o600)
  })

  it('7. a changed data.json stays inert: a value changes only escaped text or a finite number, and any other change is refused', async () => {
    const a = session()
    const insight = a.insights[0]!
    const refused: Array<[string, unknown]> = [
      ['a severity that is not an enum word', { ...a, insights: [{ ...insight, severity: 'high" http-equiv="refresh' }] }],
      ['an ending that is not an enum word', { ...a, summary: { ...a.summary, ending: 'done' } }],
      ['a turn index below 0', { ...a, insights: [{ ...insight, turnIndexes: [-1] }] }],
      ['a turn index that is not whole', { ...a, insights: [{ ...insight, turnIndexes: [1.5] }] }],
      ['a token total as a string', { ...a, summary: { ...a.summary, totalTokens: '100' } }],
      ['a time out of the date range', { ...a, generator: { ...a.generator, generatedAt: 1e20 } }],
      ['a live flag that is not a boolean', { ...a, session: { ...a.session, live: 'true' } }],
      ['a model name that is not a string', { ...a, session: { ...a.session, models: [{ displayName: { html: '<b>' } }] } }],
      ['an older analysis schema', { ...a, schemaVersion: '1' }],
      ['no slim flag and no evidence shape', { ...a, slim: undefined }],
      ['an evidence scope of session', { ...repoData(), source: { ...repoData().source, scope: 'session' } }],
      ['a repository with no folder', { ...repoData(), folder: undefined }],
      ['a finding severity that is not an enum word', { ...repoData(), findings: repoData().findings.map((f) => ({ ...f, severity: 'x' })) }],
    ]
    for (const [name, raw] of refused) expect(() => validateShowMeData(JSON.parse(JSON.stringify(raw))), name).toThrow(ShowMeInputError)
    // JSON has no Infinity, but 1e400 parses to it
    expect(() => validateShowMeData(JSON.parse(JSON.stringify(a).replace(/"activeMs":\d+/, '"activeMs":1e400'))), '1e400').toThrow(ShowMeInputError)
    // a key that the page does not read is dropped, so it reaches nothing
    const extra = validateShowMeData(JSON.parse(JSON.stringify({ ...a, evil: '<script>', session: { ...a.session, onload: 'x' } })))
    expect(extra.kind).toBe('session')
    expect(JSON.stringify(extra)).not.toContain('evil')
    expect(JSON.stringify(extra)).not.toContain('onload')
    // a changed string is escaped text, and the file still passes the self-check
    const changed = validateShowMeData(JSON.parse(JSON.stringify({ ...a, insights: [{ ...insight, title: '</h2><script>x()</script>' }], summary: { ...a.summary, topInsightIds: [insight.id] } })))
    if (changed.kind !== 'session') throw new Error('session data')
    for (const [file, out, template] of fillBoth(sessionPage(changed.value, WORDS))) {
      expect(out, file).toContain('&lt;/h2&gt;&lt;script&gt;x()&lt;/script&gt;')
      selfCheck(out, template, file)
    }
    // end to end: the render refuses a changed data.json, and writes nothing
    const base = tempBase()
    const dir = await run(base, { ...a, insights: [{ ...insight, severity: 'high"><meta http-equiv="refresh" content="0;url=https:x"><i class="' }] })
    await expect(renderShowMe(dir, { base })).rejects.toThrow(ShowMeInputError)
    expect(written(dir)).toEqual([])
  })
})

describe('the 2 probes that broke the old fixture fill', () => {
  it('a data-sev meta refresh is refused by the data check, by the fill and by the self-check', () => {
    const attack = 'high"><meta http-equiv="refresh" content="0;url=https://x.example"><i class="'
    const a = session()
    expect(() => validateShowMeData({ ...a, insights: a.insights.map((i) => ({ ...i, severity: attack })) })).toThrow(ShowMeInputError)
    const page = sessionPage(a, WORDS)
    const finding = page.lists['finding']![0]!
    expect(() => fillTemplate(SLIDES_HTML, { ...page, lists: { ...page.lists, finding: [{ ...finding, attrs: { 'data-sev': attack } }] } })).toThrow(FillError)
    // the file the old setAttr wrote: 2 http-equiv attributes, refused before any write
    const good = fillTemplate(SLIDES_HTML, page)
    const old = good.replace(/data-sev="(?:info|low|medium|high)"/, `data-sev="${attack}"`)
    expect(old).not.toBe(good)
    expect(() => selfCheck(old, SLIDES_HTML, 'slides.html')).toThrow(/http-equiv/)
  })

  it('a chart label with $` $\' and $& stays inside its aria-label', () => {
    const page = sessionPage(session(), WORDS)
    for (const label of ['A$`B', "A$'B", 'A$&B', 'A$1B']) {
      const out = fillTemplate(SLIDES_HTML, { ...page, charts: { ...page.charts, time: { kind: 'bars', values: { active: 1, waiting: 2 }, label } } })
      expect(out, label).toContain(`aria-label="${escapeHtml(label)}"`)
      selfCheck(out, SLIDES_HTML, 'slides.html')
    }
  })
})

describe('9. hostile words, 8. offline', () => {
  it('9. each hostile word renders as escaped text, a 10,000-character sentence renders whole, and 8. each file passes the offline gate', async () => {
    const base = tempBase()
    for (let i = 0; i < HOSTILE.length; i++) {
      const dir = await run(base, i % 2 ? repoData() : session(), hostileWords(i))
      const result = await renderShowMe(dir, { base })
      for (const path of [result.slides, result.report]) {
        const html = readFileSync(path, 'utf8')
        expect(html.match(/<script\b/gi), path).toHaveLength(1)
        // the verdict is in both files, the summary only in the report, the improvements title only in the deck
        expect(html, path).toContain(`data-slot="verdict">${escapeHtml(HOSTILE[i % 7]!)}<`)
        expect(html, path).toContain(path === result.report ? `data-slot="summary">${escapeHtml(HOSTILE[(i + 1) % 7]!)}<` : `data-slot="improvements-title">${escapeHtml(HOSTILE[(i + 2) % 7]!)}<`)
        for (const value of HOSTILE) if (/[<>"]/.test(value)) expect(html, `${path}: ${value}`).not.toContain(value)
        const gate = spawnSync(process.execPath, [join(root, 'scripts/assert-offline.mjs'), '--file', path], { encoding: 'utf8' })
        expect(gate.stdout + gate.stderr, path).toContain('offline OK')
        expect(gate.status, path).toBe(0)
      }
    }
    const dir = await run(base, session(), { ...WORDS, summary: LONG })
    const result = await renderShowMe(dir, { base })
    expect(readFileSync(result.report, 'utf8')).toContain(LONG)
    expect(result.findings.filter((f) => f.slot === 'summary').map((f) => f.rule)).toEqual(['sentence-length'])
    expect(existsSync(result.slides)).toBe(true)
  })
})
