/**
 * The landing page. site/index.src.html is the authored source, and `node scripts/build.mjs --site` writes
 * site/index.html from it. The page tells the chain in 6 sections: the hero with the app window, the 3 steps, what
 * the brain finds, the checks, where you work, and the last call. These tests hold the source to its design rules
 * (sections, words, motion, labels) and hold each sample number to the sample build. test/site.test.ts holds the
 * generated page, the SEO head, the footer and the published samples.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import type { Analysis } from '../src/model/analysis.js'
import { briefBlock, fmtAge } from '../src/cli/summary.js'
import { MACHINE_CAPS, stripAnsi } from '../src/cli/tty.js'
import { outcomeHeadline } from '../src/report/client/derive.js'
import { ms, tok } from '../src/report/client/format.js'
import { PARAGRAPH, htmlToText } from '../src/ste/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')
const src = read('site/index.src.html')

/** The first element whose opening tag matches `open`, through its matching close tag ('' when there is none). */
function element(html: string, open: RegExp): string {
  const start = html.search(open)
  if (start < 0) return ''
  const tag = /^<([a-z][\w-]*)/i.exec(html.slice(start))?.[1] ?? ''
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi')
  re.lastIndex = start
  let depth = 0
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1
    if (depth === 0) return html.slice(start, m.index + m[0].length)
  }
  return ''
}

/** The body of the first at-rule of `css` that starts with `head`, by brace matching ('' when there is none). */
function atRule(css: string, head: string): string {
  const start = css.indexOf(head)
  if (start < 0) return ''
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}' && (depth -= 1) === 0) return css.slice(open + 1, i)
  }
  return ''
}

/** The text of markup as a reader sees it: no tags, the entities decoded. */
const textOf = (html: string): string =>
  html.replace(/<[^>]+>/g, '').replace(/&#47;/g, '/').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')

/** The lines of a <pre> terminal, as the reader sees them, with no trailing space. */
const preLines = (block: string): string[] => textOf(/<pre class="tout">([\s\S]*?)<\/pre>/.exec(block)?.[1] ?? '').split('\n').map((line) => line.trimEnd())

const style = src.slice(src.indexOf('<style>') + '<style>'.length, src.indexOf('</style>'))
const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '')
const hero = element(src, /<section class="hero"/)
const chain = element(src, /<section class="sec alt" id="chain"/)

// The sample build: site/sample.html carries the data of its session, and the repo and machine aggregates beside it
// (scripts/build-sample.ts). The landing does not read it at build time, so each number on the page is a literal,
// and these tests hold each literal to this data.
interface SampleRow { id: string; title: string; project: string; startedAt: number; wallMs: number; toolCalls: number; toolErrors: number; tokens: number; agents: number }
interface SampleCross { ruleId: string; exampleTitle?: string; title: string; improvement?: string; sessions: number; boundedSavingsTokens?: number }
interface SampleData {
  session: Analysis
  aggregates: { global: { generatedAt: number; sessionCount: number; totals: { toolCalls: number; toolErrors: number }; sessions: SampleRow[]; crossFindings: SampleCross[] } }
}
const sampleHtml = read('site/sample.html')
const sample = JSON.parse(/<script type="application\/json" id="orangu-data">([\s\S]*?)<\/script>/.exec(sampleHtml)?.[1] ?? '{}') as SampleData
const machine = sample.aggregates.global
const newest = [...machine.sessions].sort((a, b) => b.startedAt - a.startedAt)
const base = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path
/** The first 2 sentences of an improvement, as the window and the proposal card show them. */
const lead2 = (text: string): string => text.split(/(?<=\.)\s+/).slice(0, 2).join(' ')

describe('the landing source: shape and words', () => {
  it('uses only the current build placeholders, with the 96 px mascot data in 1 CSS rule', () => {
    for (const placeholder of ['<!-- @tokens -->', '{{mascot:main}}', '{{mascot:logo}}', '{{favicon:32}}', '{{favicon:180}}', '{{version}}'])
      expect(src, `missing placeholder ${placeholder}`).toContain(placeholder)
    expect(src, 'stale hand-typed version').not.toMatch(/\bv0\.\d+/)
    // The build puts the whole data URI in place of each placeholder, so the small mascots share 1 rule.
    expect(src.match(/\{\{mascot:logo\}\}/g)).toHaveLength(1)
    expect(style).toContain('.ms{display:inline-block;flex:none;background:url({{mascot:logo}}) center/contain no-repeat}')
    expect(src.match(/\{\{mascot:main\}\}/g)).toHaveLength(1)
  })

  it('uses the shared color tokens only, and no ad-prefixed class', () => {
    const hexes = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
    expect(hexes, `hand-duplicated palette: ${hexes.join(' ')}`).toHaveLength(0)
    const adish = [...src.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? '').split(/\s+/)).filter((name) => /^ad[-_]/i.test(name))
    expect([...new Set(adish)]).toEqual([])
  })

  // The measure: the text after the head, style and script blocks and all tags go, split on white space.
  // The page before the rewrite measured 2,135 words and 8 sections by this measure (about 2,134 in the run plan).
  // Measured on the rewrite, 2026-11-01: 1,131 words and 6 sections. The caps are the old page: less copy, not more.
  it('has 6 sections or fewer, and fewer visible words than the page before it', () => {
    const words = src
      .replace(/<head>[\s\S]*?<\/head>/, ' ')
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .split(/\s+/)
      .filter(Boolean).length
    expect((src.match(/<section\b/g) ?? []).length).toBeLessThanOrEqual(6)
    expect(words).toBeLessThan(2_134)
    expect([...src.matchAll(/<section\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1])).toEqual(['top', 'chain', 'finds', 'proof', 'hosts'])
  })

  it('names npx orangu, /orangu:improve and /orangu:interview, and no other skill command', () => {
    expect(src).toContain('npx orangu')
    expect(new Set([...src.matchAll(/\/orangu:([a-z-]+)/g)].map((m) => m[1]))).toEqual(new Set(['improve', 'interview']))
    // the Codex form of the same skill, which the Codex card names
    expect(new Set([...src.matchAll(/\$orangu-([a-z-]+)/g)].map((m) => m[1]))).toEqual(new Set(['improve']))
    // no person surface names the store API (test/front-doors.test.ts sweeps the same file)
    expect(src).not.toMatch(/\borangu suggest\b/)
  })

  it('names a Codex skill that the Codex plugin ships', () => {
    expect(existsSync(join(root, 'plugins/orangu/skills/orangu-improve/SKILL.md'))).toBe(true)
  })

  it('keeps the qualifiers of each claim about a check, a change and the scope', () => {
    const text = htmlText(src)
    expect(text).toContain('orangu marks a change verified only when your later sessions beat the earlier sessions beyond chance.')
    expect(text).toContain('orangu never changes your harness by itself. A change to the whole machine stays a proposal.')
    expect(text).toContain('You approve each change by its id. Then orangu checks it on your later sessions, beyond chance.')
    expect(text).toContain('It reads every session on your disk, each agent tree included, and it measures with no model.')
    expect(text).toContain('Local only. No model in the measurement. No network calls.')
    // never "your whole history": Claude Code deletes old transcripts, and the read has bounds
    expect(text).not.toMatch(/whole history|all of your history/i)
  })

  // A chance claim is about the later sessions of 1 reader, never a general result. Each block of visible text splits at
  // each sentence end, also before a lower-case "orangu", so 2 sentences never pass as 1. A label of 2 words, such as
  // the heading "Beyond chance.", makes no claim.
  const sentences = htmlToText(src)
    .split(PARAGRAPH)
    .flatMap((block) => block.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/))
    .filter((sentence) => sentence.split(' ').length >= 3)

  it('names your later sessions in each sentence that says beyond chance or beat chance', () => {
    const chance = sentences.filter((sentence) => /\b(?:beyond|beat) chance\b/i.test(sentence))
    expect(chance.length).toBeGreaterThan(1)
    expect(chance.filter((sentence) => !sentence.includes('your later sessions'))).toEqual([])
  })

  it('says beyond chance after each guard clause', () => {
    // a guard holds when the check did not get worse beyond chance, so a bare "did not rise" claims too much
    const guards = sentences.flatMap((sentence) => [...sentence.matchAll(/\b(?:got worse|did not (?:go up|rise|increase))\b(?: beyond chance)?/g)].map((m) => m[0]))
    expect(guards.filter((guard) => !guard.endsWith(' beyond chance'))).toEqual([])
  })

  it('opens each sample link in a new tab without opener access, and says so', () => {
    const links = [...src.matchAll(/<a\b[^>]*href="sample\.html"[^>]*>/g)].map((m) => m[0])
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(link).toContain('target="_blank"')
      expect(link).toMatch(/rel="[^"]*\bnoopener\b[^"]*"/)
      expect(link).toContain('opens in a new tab')
    }
  })

  it('links each section of the header to a section of the page', () => {
    const nav = element(src, /<nav class="nav"/)
    expect([...nav.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]+)/g)].map((m) => `${(m[2] ?? '').trim()} ${m[1]}`)).toEqual([
      'How it works #chain',
      'What it finds #finds',
      'Sample report sample.html',
      'GitHub https://github.com/NissanOhana/orangu',
    ])
    for (const [, id] of nav.matchAll(/href="#([^"]+)"/g)) expect(src, `dead nav anchor #${id}`).toContain(`id="${id}"`)
    expect(src).toContain('<span class="ver">v{{version}}</span>')
  })

  it('makes the same checked-change claim in each head tag', () => {
    const tag = (pattern: RegExp): string => pattern.exec(src)?.[1] ?? ''
    expect(tag(/<meta property="og:title" content="([^"]+)"/)).toBe('orangu: improve your agent harness, one checked change at a time')
    expect(tag(/<meta name="twitter:title" content="([^"]+)"/)).toBe('orangu: improve your agent harness, one checked change at a time')
    expect(tag(/<title>([^<]+)<\/title>/)).toBe('orangu: improve your Claude Code harness, one checked change at a time')
    expect(tag(/<meta name="description" content="([^"]+)"/)).toBe('orangu is an open-source CLI. It reads your local Claude Code sessions, finds what to change in your harness, and checks each change on your later sessions.')
  })

  it('ships none of the design-canvas runtime', () => {
    for (const bad of ['support.js', 'DCLogic', 'sc-for', 'sc-if', 'x-dc', '{{ copyAny }}', '{{ toggleTheme }}', '/_blob/'])
      expect(src, `must not contain ${bad}`).not.toContain(bad)
  })

  it('avoids AI-marketing cliches and keeps American spelling', () => {
    const text = htmlText(src)
    expect(text).not.toMatch(/unlock|supercharge|seamless|effortless|revolutioni[sz]e/i)
    expect(text).not.toMatch(/\b(colour|behaviour|analyse|optimis(e|ed|ing)|organis(e|ed|ing)|licence|prioritis)\w*/i)
  })
})

/** The visible text of markup, with no script and no style: what the money and claim guards read. */
function htmlText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
}

describe('the landing hero: the app window holds the sample', () => {
  it('holds the session field in its final state: 1 cell for each sample session, 1 dot for each tool call', () => {
    const field = element(hero, /<div class="field"/)
    const cells = [...field.matchAll(/<span class="cell( has-e)?" style="--c:(\d+)">([\s\S]*?)<\/span>/g)]
    // hand-checked from the sample, newest first: 224 calls, and 12 errors in 7 sessions
    expect(cells.map((m) => (m[3]?.match(/<i\b/g) ?? []).length)).toEqual([76, 15, 14, 5, 14, 17, 20, 11, 26, 8, 18])
    expect(cells.map((m) => (m[3]?.match(/<i class="e"><\/i>/g) ?? []).length)).toEqual([3, 0, 1, 0, 1, 1, 1, 0, 1, 0, 4])
    // the same counts from the data of the sample build
    expect(cells.map((m) => (m[3]?.match(/<i\b/g) ?? []).length)).toEqual(newest.map((s) => s.toolCalls))
    expect(cells.map((m) => (m[3]?.match(/<i class="e">/g) ?? []).length)).toEqual(newest.map((s) => s.toolErrors))
    expect(cells.map((m) => m[1] === ' has-e')).toEqual(newest.map((s) => s.toolErrors > 0))
    expect(cells.map((m) => Number(m[2]))).toEqual(newest.map((_, at) => at))
    // the markup is the final state: the window opens on This machine, and no motion class is in it
    expect(hero).toContain('<div class="win z-machine" id="heroWin">')
    expect(hero).not.toMatch(/class="[^"]*\b(?:hp|p-read|p-hit|p-run|paused|auto|run)\b/)
    expect(field).toMatch(/role="img" aria-label="The 11 sample sessions have 224 tool calls\. [^"]*12 dots are tool errors\."/)
  })

  it('counts the sample sessions, tool calls and tool errors of the machine level', () => {
    const level = element(hero, /<div class="layer l-machine"/)
    const counts = [...level.matchAll(/<span class="count" style="--to:(\d+)" aria-hidden="true"><\/span><span class="vh">(\d+)<\/span>/g)]
    // each rolled number is also text, for a screen reader, and both say the same number
    expect(counts.map((m) => [Number(m[1]), Number(m[2])])).toEqual([[11, 11], [224, 224], [12, 12]])
    expect(counts.map((m) => Number(m[1]))).toEqual([machine.sessionCount, machine.totals.toolCalls, machine.totals.toolErrors])
  })

  it('lists the newest sample sessions with their tokens, ages and agents', () => {
    const level = element(hero, /<div class="layer l-sessions"/)
    const rows = [...level.matchAll(/<span class="st">([^<]+)<\/span><span class="stok">([^<]+)<\/span>\s*<span class="sm">([^<]+)/g)]
    expect(rows.map((m) => m[1])).toEqual(newest.slice(0, 4).map((s) => s.title))
    expect(rows.map((m) => m[2])).toEqual(newest.slice(0, 4).map((s) => `${tok(s.tokens)} tokens`))
    // the age of each session from the end of its transcript to the time of the sample (fmtAge, as `orangu pick` prints it)
    const ages = newest.slice(0, 4).map((s) => fmtAge(s.startedAt + s.wallMs, machine.generatedAt))
    expect(ages).toEqual(['40m', '3d', '3d', '5d'])
    // the newest row also names its agents after a last separator
    expect(rows.map((m) => (m[3] ?? '').trim())).toEqual(newest.slice(0, 4).map((s, at) => (at === 0 ? `${base(s.project)} · ended ${ages[at]} ago ·` : `${base(s.project)} · ${ages[at]} ago`)))
    expect(level).toContain(`<span class="sag">orchestrator · ${newest[0]!.agents} agents</span>`)
    const agents = [...level.matchAll(/<li class="ag" style="--k:\d"><b>([^<]+)<\/b><span>([^<]+)<\/span><span class="at">([^<]+)<\/span><\/li>/g)]
    expect(agents.map((m) => `${m[1]} ${m[2]} ${m[3]}`)).toEqual(sample.session.agents.runs.map((run) => `${run.agentType} ${run.description} ${tok(run.totalTokens)} tokens`))
    expect(level).toContain(`<p class="more">${machine.sessionCount - 4} more sessions</p>`)
    expect(level).toContain(`<span class="stat">${machine.sessionCount} sessions, newest first</span>`)
  })

  it('shows the latest sample session with its outcome, its numbers and its top finding', () => {
    const level = element(hero, /<div class="layer l-session"/)
    const a = sample.session
    const top = a.insights.find((i) => i.id === a.summary.topInsightIds[0]) ?? a.insights[0]!
    expect(level).toContain(`<p class="sess-t">${a.session.title}</p>`)
    expect(level).toContain(`<p class="sess-m">${base(a.session.cwd ?? '')} · ${a.session.id.slice(0, 8)}</p>`)
    expect(level).toContain(`<p class="sess-o">${outcomeHeadline(a.summary)}</p>`)
    const kpis = [...level.matchAll(/<span class="kl">([^<]+)<\/span><span class="kv">(?:<span class="count" style="--to:(\d+)"[^>]*><\/span><span class="vh">\d+<\/span>|([^<]+))<\/span>/g)]
    expect(kpis.map((m) => `${m[1]} ${m[2] ?? m[3]}`)).toEqual([`Turns ${a.summary.turns}`, `Tokens ${tok(a.summary.totalTokens)}`, `Active ${ms(a.summary.activeMs)}`, `Agents ${a.summary.agents}`])
    expect(level).toContain(`<span class="fx-t">${top.title}</span><span class="fsave">save ~${tok(top.savings?.tokens ?? 0)} tokens</span>`)
    expect(level).toContain(`<b>Improvement:</b> ${lead2(top.improvement ?? '')}</p>`)
    expect(level).toContain('latest · ended 40m ago')
  })
})

describe('the landing chain: 3 steps in 1 tab list', () => {
  it('holds 1 tab list with 3 tabs, 3 tab panels and 1 Pause button, and no hidden panel in the source', () => {
    expect(chain.match(/role="tablist"/g)).toHaveLength(1)
    expect(chain.match(/role="tab"/g)).toHaveLength(3)
    const panels = [...chain.matchAll(/<div class="panel p\d" role="tabpanel" id="([^"]+)" aria-labelledby="([^"]+)"([^>]*)>/g)]
    expect(panels.map((m) => `${m[1]} ${m[2]}`)).toEqual(['panel-see tab-see', 'panel-improve tab-improve', 'panel-tune tab-tune'])
    // only the script hides a panel, after it reads the reduced-motion preference
    for (const m of panels) expect(m[3], `${m[1]} is hidden in the source`).not.toMatch(/\bhidden\b/)
    expect(chain.match(/<button\b[^>]*aria-pressed=/g)).toHaveLength(1)
    expect([...chain.matchAll(/<span class="tname">([^<]+)<\/span><code class="tcmd">([^<]+)<\/code>/g)].map((m) => `${m[1]} ${m[2]}`)).toEqual(['See npx orangu', 'Improve /orangu:improve', 'Tune /orangu:interview'])
    // each panel keeps its h3, so the stacked panels read as 3 sections
    expect([...chain.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1])).toEqual(['See', 'Improve', 'Tune'])
  })

  it('prints the brief of the sample session in step 1 as bare orangu prints it at 80 columns', () => {
    const a = sample.session
    const top = a.insights.find((i) => i.id === a.summary.topInsightIds[0]) ?? a.insights[0]!
    const brief = briefBlock(MACHINE_CAPS, a, a.session.title ?? '', { finding: top.title, improvement: top.improvement, next: 'claude "/orangu:improve sg_0123456789ab"' }, { hint: false }).map(stripAnsi)
    const lines = preLines(element(chain, /<div class="panel p0"/))
    expect(lines[0]).toBe('$ npx orangu')
    // line 2 is the mascot. The brief opens with a blank line, then the title row: the page draws the blank as the mascot.
    expect(brief[0]).toBe('')
    expect(lines.slice(2, 1 + brief.length)).toEqual(brief.slice(1))
    expect(lines.slice(2, 4)).toEqual(['orangu  Add rate limiting to the checkout API', '        latest · 5a91c73e · 6 turns · 5.83M tokens · 26m 5s active'])
  })

  it('shows the CLI verbs that the review runs in step 2, and no store command', () => {
    const lines = preLines(element(chain, /<div class="panel p1"/))
    expect(lines[0]).toBe('> /orangu:improve')
    for (const verb of ['harness', 'repo', 'evidence']) expect(lines.some((line) => line.includes(`Bash(orangu ${verb} `)), verb).toBe(true)
    expect(lines.filter((line) => line.includes('Agent('))).toEqual(['● Agent(harness-pm-analyst)      6 focus areas', '● Agent(harness-devex-analyst)   6 focus areas'])
    for (const agent of ['harness-pm-analyst', 'harness-devex-analyst']) expect(existsSync(join(root, `plugin/agents/${agent}.md`)), agent).toBe(true)
  })

  it('shows the sample proposal with the saving and the session count of its machine finding', () => {
    const card = element(chain, /<div class="prop"/)
    const finding = machine.crossFindings.find((f) => f.ruleId === 'preamble-weight')!
    expect(card).toContain(`<b>${finding.exampleTitle}</b><span class="fsave">save ~${tok(finding.boundedSavingsTokens ?? 0)} tokens</span>`)
    expect(finding.sessions).toBe(machine.sessionCount)
    expect(card).toContain(`<p class="prop-e">This pattern shows in all ${machine.sessionCount} sessions.</p>`)
    expect(card).toContain(`<b>Improvement:</b> ${lead2(finding.improvement ?? '')}</p>`)
    expect(card).toContain('<span class="smp">Sample</span>')
  })

  it('shows the questions and the answers of step 3 with no question count', () => {
    const chat = element(chain, /<div class="chat"/)
    expect([...chat.matchAll(/<p class="q">([^<]+)<\/p>/g)].map((m) => m[1])).toEqual([
      'Which role fits your work best?',
      'How do you run agents most of the time?',
      'What must get better first in your next sessions?',
    ])
    expect([...chat.matchAll(/<span class="chip sel">([^<]+)<\/span>/g)].map((m) => m[1])).toEqual(['I write and ship code.', 'One orchestrator session with subagents.', 'Fewer tokens.'])
    expect([...chat.matchAll(/<dd>([^<]+)<\/dd>/g)].map((m) => m[1])).toEqual(['I write and ship code.', 'One orchestrator session with subagents.', 'Fewer tokens.'])
    // the interview copy names no question count
    expect(htmlText(chain)).not.toMatch(/\b\d+ questions\b/)
  })
})

describe('the landing labels each demo number as a sample', () => {
  interface Node { tag: string; cls: string[]; text: string; children: Node[]; parent?: Node }
  const VOID = new Set(['img', 'br', 'meta', 'link', 'input', 'hr', 'source', 'wbr'])
  /** A small tree of the markup: enough to find the nearest labelled block of each text. */
  function parse(html: string): Node {
    const top: Node = { tag: '#root', cls: [], text: '', children: [] }
    let at = top
    for (const m of html.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>|([^<]+)/gi)) {
      if (m[4] !== undefined) {
        at.children.push({ tag: '#text', cls: [], text: m[4], children: [], parent: at })
        continue
      }
      const tag = (m[2] ?? '').toLowerCase()
      if (m[1]) {
        for (let up: Node | undefined = at; up?.parent; up = up.parent)
          if (up.tag === tag) {
            at = up.parent
            break
          }
        continue
      }
      const node: Node = { tag, cls: /\bclass="([^"]*)"/.exec(m[3] ?? '')?.[1]?.split(/\s+/) ?? [], text: '', children: [], parent: at }
      at.children.push(node)
      if (!VOID.has(tag)) at = node
    }
    return top
  }
  // each element is its own box, so 2 element texts never join into 1 word
  const text = (node: Node): string => (node.tag === '#text' ? node.text : node.children.map(text).join(' '))
  const walk = (node: Node, visit: (n: Node) => void): void => {
    visit(node)
    node.children.forEach((child) => walk(child, visit))
  }

  it('puts each digit of a demo inside a block that shows the word Sample', () => {
    // the demo blocks: the app window of the hero, the 2 terminals, the proposal card and the chat of the chain
    const DEMOS = ['win', 'term', 'prop', 'chat']
    // a labelled block: the window bar, a zoom level, a terminal, the proposal card, the chat and the profile card
    const LABELLED = ['win-bar', 'layer', 'term', 'prop', 'chat', 'prof']
    const demos: Node[] = []
    walk(parse(src.slice(src.indexOf('<body>'))), (node) => {
      if (node.cls.some((c) => DEMOS.includes(c)) && !demos.some((d) => d !== node && isInside(node, d))) demos.push(node)
    })
    function isInside(node: Node, outer: Node): boolean {
      for (let up = node.parent; up; up = up.parent) if (up === outer) return true
      return false
    }
    expect(demos.map((d) => d.cls.find((c) => DEMOS.includes(c)))).toEqual(['win', 'term', 'term', 'prop', 'chat'])
    let digits = 0
    const unlabelled: string[] = []
    for (const demo of demos)
      walk(demo, (node) => {
        if (node.tag !== '#text' || !/\d/.test(node.text)) return
        digits += 1
        let block: Node | undefined = node.parent
        while (block && block !== demo && !block.cls.some((c) => LABELLED.includes(c))) block = block.parent
        if (!block || !/\bSample\b/.test(text(block))) unlabelled.push(node.text.trim())
      })
    expect(digits).toBeGreaterThan(40)
    expect(unlabelled).toEqual([])
  })
})

describe('the landing motion: CSS first, finite, and still under reduced motion', () => {
  const moving = atRule(style, '@media (prefers-reduced-motion:no-preference)')
  const still = atRule(style, '@media (prefers-reduced-motion:reduce)')

  it('runs each keyframe and each transition only when the reader allows motion', () => {
    const keyframes = [...style.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]!)
    expect(keyframes.length).toBeGreaterThanOrEqual(10)
    for (const name of keyframes) expect(moving, `@keyframes ${name} has no rule`).toMatch(new RegExp(`animation(?:-name)?:[^;}]*\\b${name}\\b`))
    // outside the no-preference block, an animation or a transition is set only to none
    const outside = style.replace(moving, '')
    expect([...outside.matchAll(/\b(animation|animation-name|transition)\s*:\s*([^;}]+)/g)].map((m) => `${m[1]}:${m[2]}`)).toEqual(['animation:none!important', 'transition:none!important'])
  })

  it('sets each animation and each transition to none under reduced motion', () => {
    expect(still).toBe('*,::before,::after{animation:none!important;transition:none!important}')
  })

  // The motion code of the page: the CSS and the script between the marker comments. The plan budget is about 7 KB,
  // and the cap is 8,192 B before gzip. Measured on the rewrite, 2026-11-01: 7,688 B in 3 parts: 108 B of the head
  // script (the js and mo classes), 3,428 B of motion CSS and 4,152 B of motion script, with no comment inside.
  it('keeps the motion code between the markers at 8,192 B or less', () => {
    const parts = [...src.matchAll(/\/\* motion \*\/([\s\S]*?)\/\* \/motion \*\//g)].map((m) => m[1] ?? '')
    expect(parts).toHaveLength(3)
    expect(parts.reduce((sum, part) => sum + Buffer.byteLength(part, 'utf8'), 0)).toBeLessThanOrEqual(8_192)
    // every keyframe of the page is inside the markers
    for (const name of [...style.matchAll(/@keyframes ([\w-]+)/g)].map((m) => m[1]!)) expect(parts.join(''), name).toContain(`@keyframes ${name}`)
  })

  it('reads the reduced-motion preference in each script that starts a motion', () => {
    const motion = scripts.filter((code) => /requestAnimationFrame\(|IntersectionObserver\(|classList\.add\('mo'\)/.test(code))
    expect(motion).toHaveLength(3)
    for (const code of motion) expect(code).toContain("matchMedia('(prefers-reduced-motion: reduce)')")
  })
})

/** A stub of the elements that the motion script reads, with the calls that it makes. */
class Stub {
  attrs = new Map<string, string>()
  classes = new Set<string>()
  hidden = false
  tabIndex = 0
  textContent = ''
  offsetWidth = 0
  onclick: (() => unknown) | null = null
  onkeydown: ((event: { key: string; preventDefault: () => void }) => unknown) | null = null
  lastChild = { nodeValue: '' }
  props = new Map<string, string>()
  style = { setProperty: (name: string, value: unknown): void => void this.props.set(name, String(value)) }
  path?: Stub
  kids: Stub[] = []
  focused = 0
  constructor(cls = '') {
    for (const name of cls.split(/\s+/).filter(Boolean)) this.classes.add(name)
  }
  get className(): string {
    return [...this.classes].join(' ')
  }
  set className(value: string) {
    this.classes = new Set(value.split(/\s+/).filter(Boolean))
  }
  classList = {
    add: (...names: string[]): void => names.forEach((name) => this.classes.add(name)),
    remove: (...names: string[]): void => names.forEach((name) => this.classes.delete(name)),
    toggle: (name: string, on: boolean): void => void (on ? this.classes.add(name) : this.classes.delete(name)),
  }
  setAttribute(name: string, value: unknown): void {
    this.attrs.set(name, String(value))
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }
  querySelector(): Stub | undefined {
    return this.path
  }
  querySelectorAll(): Stub[] {
    return this.kids
  }
  focus(): void {
    this.focused += 1
  }
}

/** Run the motion script on a stub page. `reduce` is the answer of the reduced-motion query. */
function runMotion(reduce: boolean) {
  const code = scripts.find((script) => script.includes('/* motion */') && script.includes('function seq'))
  expect(code, 'the motion script').toBeDefined()
  const button = (word: string, hidden: boolean): Stub => {
    const b = new Stub('pp')
    b.path = new Stub()
    b.lastChild.nodeValue = word
    b.hidden = hidden
    return b
  }
  const zt = ['session', 'sessions', 'machine'].map(() => new Stub('ztab'))
  const tabs = [0, 1, 2].map(() => new Stub('tab'))
  const panels = [0, 1, 2].map((k) => {
    const p = new Stub(`panel p${k}`)
    p.setAttribute('role', 'tabpanel')
    p.setAttribute('aria-labelledby', `tab-${k}`)
    return p
  })
  const cells = [76, 15, 14].map((n) => {
    const cell = new Stub('cell')
    cell.kids = Array.from({ length: n }, () => new Stub())
    return cell
  })
  const page: Record<string, Stub> = { '#heroWin': new Stub('win z-machine'), '#hz': new Stub(), '#heroPause': button('Pause', true), '.ztabs': new Stub('ztabs'), '.chain': new Stub('chain'), '#chainPause': button('Play', false), '.stepof': new Stub('stepof'), '.tabs': new Stub('tabs') }
  const lists: Record<string, Stub[]> = { '.ztab': zt, '.tab': tabs, '.panel': panels, '.cell': cells }
  const timers = new Map<number, { run: () => void; ms: number }>()
  let id = 0
  let clock = 0
  const observers: Array<{ callback: (entries: Array<{ intersectionRatio: number }>) => void; options: unknown; disconnected: boolean }> = []
  const document = {
    activeElement: null as Stub | null,
    querySelector: (selector: string) => page[selector],
    querySelectorAll: (selector: string) => lists[selector] ?? [],
  }
  const query = { matches: reduce, onchange: null as (() => void) | null }
  runInNewContext(code!, {
    document,
    matchMedia: (q: string) => {
      expect(q).toBe('(prefers-reduced-motion: reduce)')
      return query
    },
    setTimeout: (run: () => void, wait: number) => {
      timers.set((id += 1), { run, ms: wait })
      return id
    },
    clearTimeout: (at: number) => timers.delete(at),
    Date: { now: () => clock },
    IntersectionObserver: class {
      constructor(callback: (entries: Array<{ intersectionRatio: number }>) => void, options: unknown) {
        observers.push({ callback, options, disconnected: false })
      }
      observe(): void {}
      disconnect(): void {
        observers.at(-1)!.disconnected = true
      }
    },
  })
  /** Run the timer that waits `wait` ms, as the clock reaches it. */
  const fire = (wait: number): void => {
    const entry = [...timers].find(([, t]) => t.ms === wait)
    expect(entry, `a timer of ${wait} ms in ${JSON.stringify([...timers.values()].map((t) => t.ms))}`).toBeDefined()
    timers.delete(entry![0])
    clock += wait
    entry![1].run()
  }
  return { page, zt, tabs, panels, cells, timers, observers, document, query, fire, tick: (wait: number) => void (clock += wait) }
}

describe('the landing motion script', () => {
  it('starts no timer, hides no panel and keeps the 3 steps stacked under reduced motion', () => {
    const s = runMotion(true)
    expect(s.timers.size).toBe(0)
    expect(s.observers).toHaveLength(0)
    expect(s.panels.map((p) => p.hidden)).toEqual([false, false, false])
    expect(s.panels.some((p) => p.classes.has('run'))).toBe(false)
    // the stacked panels are plain blocks: the tab roles go
    expect(s.panels.map((p) => p.attrs.get('role') ?? null)).toEqual([null, null, null])
    expect(s.page['.chain']!.classes.has('on')).toBe(false)
    expect(s.page['#heroPause']!.hidden).toBe(true)
    expect(s.page['#heroWin']!.className).toBe('win z-machine hp p-end')
    expect(s.cells[0]!.kids[5]!.props.size).toBe(0)
    // the zoom tabs still work, with no timer
    s.zt[0]!.onclick!()
    expect(s.page['#heroWin']!.className).toBe('win z-session hp p-end')
    expect(s.page['#hz']!.textContent).toBe('session')
    expect(s.zt.map((t) => t.attrs.get('aria-selected'))).toEqual(['true', 'false', 'false'])
    // Replay starts no run under reduced motion
    s.page['#heroPause']!.onclick!()
    expect(s.timers.size).toBe(0)
  })

  it('plays the hero once: it reads, rings the errors, then zooms to the sessions and to 1 session', () => {
    const s = runMotion(false)
    const win = s.page['#heroWin']!
    const pause = s.page['#heroPause']!
    expect(pause.hidden).toBe(false)
    expect(pause.lastChild.nodeValue).toBe('Pause')
    expect(win.className).toBe('win z-machine')
    // each dot gets its place in its cell for the delay of the wave
    expect(s.cells[2]!.kids.map((dot) => dot.props.get('--j'))).toEqual(Array.from({ length: 14 }, (_, j) => String(j)))
    s.fire(600)
    expect(win.className).toBe('win z-machine hp p-read')
    s.fire(1900)
    expect(win.className).toBe('win z-machine hp p-hit')
    s.fire(2700)
    expect(win.className).toBe('win z-sessions hp p-run')
    expect(s.page['#hz']!.textContent).toBe('sessions')
    expect(s.zt.map((t) => t.attrs.get('aria-selected'))).toEqual(['false', 'true', 'false'])
    // Pause holds the run where it is, and Play goes on with the rest of the wait
    s.tick(1000)
    pause.onclick!()
    expect(pause.lastChild.nodeValue).toBe('Play')
    expect(pause.attrs.get('aria-pressed')).toBe('true')
    expect(win.className).toBe('win z-sessions hp p-run paused')
    expect([...s.timers.values()].some((t) => t.ms === 4200)).toBe(false)
    pause.onclick!()
    expect(pause.lastChild.nodeValue).toBe('Pause')
    s.fire(3200)
    expect(win.className).toBe('win z-session hp p-run')
    s.fire(3200)
    expect(win.className).toBe('win z-session hp p-end')
    expect(pause.lastChild.nodeValue).toBe('Replay')
    expect(s.timers.size).toBe(0)
  })

  it('turns the chain into a stepper that plays 1 lap when it is in view, and a click or a key stops it', () => {
    const s = runMotion(false)
    const chainEl = s.page['.chain']!
    const pause = s.page['#chainPause']!
    expect(chainEl.className).toBe('chain on')
    expect(s.panels.map((p) => p.hidden)).toEqual([false, true, true])
    expect(s.observers).toHaveLength(1)
    expect(s.observers[0]!.options).toEqual({ threshold: 0.35 })
    // a chain that is less than 30% in view does not start
    s.observers[0]!.callback([{ intersectionRatio: 0.1 }])
    expect(chainEl.classes.has('auto')).toBe(false)
    s.observers[0]!.callback([{ intersectionRatio: 0.4 }])
    expect(s.observers[0]!.disconnected).toBe(true)
    expect(chainEl.className).toBe('chain on auto')
    expect(pause.lastChild.nodeValue).toBe('Pause')
    s.fire(7000)
    expect(s.panels.map((p) => p.hidden)).toEqual([true, false, true])
    expect(s.panels[1]!.classes.has('run')).toBe(true)
    expect(s.page['.stepof']!.textContent).toBe('Step 2 of 3')
    expect(s.tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1])
    // a key on the tab list stops the lap and moves the focus
    s.document.activeElement = s.tabs[1]!
    let prevented = false
    s.page['.tabs']!.onkeydown!({ key: 'End', preventDefault: () => void (prevented = true) })
    expect(prevented).toBe(true)
    expect(s.tabs[2]!.focused).toBe(1)
    expect(s.panels.map((p) => p.hidden)).toEqual([true, true, false])
    expect(chainEl.className).toBe('chain on')
    expect(pause.lastChild.nodeValue).toBe('Replay')
    expect([...s.timers.values()].filter((t) => t.ms === 7000)).toHaveLength(0)
    // Left from the first tab goes to the last, and Right from the last goes to the first
    s.document.activeElement = s.tabs[0]!
    s.page['.tabs']!.onkeydown!({ key: 'ArrowLeft', preventDefault: () => {} })
    expect(s.tabs[2]!.focused).toBe(2)
    s.document.activeElement = s.tabs[2]!
    s.page['.tabs']!.onkeydown!({ key: 'ArrowRight', preventDefault: () => {} })
    expect(s.tabs[0]!.focused).toBe(1)
    // Replay plays the lap again from step 1
    pause.onclick!()
    expect(chainEl.className).toBe('chain on auto')
    expect(s.panels.map((p) => p.hidden)).toEqual([false, true, true])
  })

  it('stops both runs when the reader turns on reduced motion', () => {
    const s = runMotion(false)
    s.observers[0]!.callback([{ intersectionRatio: 0.5 }])
    expect(s.timers.size).toBe(2)
    s.query.matches = true
    s.query.onchange!()
    expect(s.timers.size).toBe(0)
    expect(s.page['#heroPause']!.hidden).toBe(true)
    expect(s.page['#chainPause']!.hidden).toBe(true)
    expect(s.page['#heroWin']!.className).toBe('win z-machine hp p-end')
  })
})

describe('the landing head script and the copy and theme script', () => {
  const head = scripts.find((code) => code.includes("classList.add('mo')"))
  const tail = scripts.find((code) => code.includes("closest('button[data-cmd]')"))

  it('paints a stored dark theme before the first frame, and turns on the motion only when the reader allows it', () => {
    expect(head, 'the head script').toBeDefined()
    expect(src.indexOf(head!)).toBeLessThan(src.indexOf('</head>'))
    for (const [stored, reduce] of [[null, false], ['dark', true], ['system', false]] as const) {
      const classes: string[] = []
      let theme: string | null = null
      runInNewContext(head!, {
        document: { documentElement: { classList: { add: (name: string) => classes.push(name) }, setAttribute: (_: string, value: string) => void (theme = value) } },
        localStorage: { getItem: () => stored },
        matchMedia: () => ({ matches: reduce }),
      })
      expect(classes, `${stored} ${reduce}`).toEqual(reduce ? ['js'] : ['js', 'mo'])
      expect(theme).toBe(stored === 'dark' ? 'dark' : null)
    }
  })

  it('copies each command, reads Copied, tells a screen reader, and goes back to Copy', async () => {
    expect(tail, 'the copy and theme script').toBeDefined()
    for (const withClipboard of [true, false]) {
      let click: ((event: unknown) => void) | undefined
      let copied = ''
      let legacyCopy = false
      const timers: Array<() => void> = []
      const label = { textContent: 'Copy', getAttribute: (name: string) => (name === 'data-lbl' ? 'Copy' : null) }
      const note = { textContent: '' }
      const button = { reset: 0, querySelector: () => label, getAttribute: (name: string) => (name === 'data-cmd' ? '/plugin install orangu' : name === 'data-copied' ? 'Copied' : null) }
      const area = { value: '', style: { position: '', opacity: '' }, setAttribute: () => {}, select: () => {}, remove: () => {} }
      const document = {
        documentElement: { removeAttribute: () => {}, setAttribute: () => {} },
        getElementById: (id: string) => (id === 'copyNote' ? note : id === 'themeLabel' ? { textContent: '' } : { addEventListener: () => {}, setAttribute: () => {} }),
        addEventListener: (type: string, fn: (event: unknown) => void) => {
          if (type === 'click') click = fn
        },
        createElement: () => area,
        execCommand: (command: string) => {
          legacyCopy = command === 'copy'
          return true
        },
        body: { appendChild: () => {} },
      }
      runInNewContext(tail!, {
        document,
        navigator: withClipboard ? { clipboard: { writeText: async (text: string) => void (copied = text) } } : {},
        localStorage: { getItem: () => null, setItem: () => {} },
        setTimeout: (fn: () => void) => timers.push(fn),
        clearTimeout: () => {},
      })
      click!({ target: { closest: () => button } })
      await Promise.resolve()
      await Promise.resolve()
      if (withClipboard) expect(copied).toBe('/plugin install orangu')
      else expect(legacyCopy).toBe(true)
      expect(label.textContent).toBe('Copied')
      expect(note.textContent).toBe('Copied to the clipboard.')
      timers.forEach((timer) => timer())
      expect(label.textContent).toBe('Copy')
      expect(note.textContent).toBe('')
    }
  })

  it('defaults the theme to light, toggles 2 states and keeps the stored preference', () => {
    const start = (stored: string | null) => {
      let click: (() => void) | undefined
      let saved = stored
      let attr: string | null = 'never touched'
      const attrs: Record<string, string> = {}
      const label = { textContent: '' }
      const button = {
        addEventListener: (type: string, fn: () => void) => {
          if (type === 'click') click = fn
        },
        setAttribute: (name: string, value: string) => void (attrs[name] = value),
      }
      runInNewContext(tail!, {
        document: {
          documentElement: { removeAttribute: () => void (attr = null), setAttribute: (_: string, value: string) => void (attr = value) },
          getElementById: (id: string) => (id === 'themeBtn' ? button : id === 'themeLabel' ? label : { textContent: '' }),
          addEventListener: () => {},
        },
        navigator: {},
        // a reader whose system asks for dark: the page follows only the stored preference
        localStorage: { getItem: () => saved, setItem: (_: string, value: string) => void (saved = value) },
        matchMedia: () => ({ matches: true }),
        setTimeout: () => 1,
        clearTimeout: () => {},
      })
      return { click: click!, label, attrs, attr: () => attr, saved: () => saved }
    }
    const fresh = start(null)
    expect(fresh.label.textContent).toBe('light')
    expect(fresh.attr()).toBeNull()
    expect(fresh.attrs['aria-label']).toBe('theme light, switch to dark')
    fresh.click()
    expect([fresh.label.textContent, fresh.attr(), fresh.saved(), fresh.attrs['aria-label']]).toEqual(['dark', 'dark', 'dark', 'theme dark, switch to light'])
    fresh.click()
    expect([fresh.label.textContent, fresh.attr(), fresh.saved()]).toEqual(['light', null, 'light'])
    expect(start('dark').label.textContent).toBe('dark')
    // the removed third state reads as light
    const legacy = start('system')
    expect([legacy.label.textContent, legacy.attr()]).toEqual(['light', null])
  })
})

describe('the landing triad: the 3 axes sit in the checks section', () => {
  it('authors the 3D triad inline with depth, shadow and reduced motion, inside #proof', () => {
    expect(src).toContain("customElements.define('qtc-triad'")
    expect(src).toContain('sort((a,b)=>a.z-b.z)')
    expect(src).toContain('rotX')
    expect(src).toContain('createRadialGradient')
    expect(src).not.toMatch(/\bfps\b/i)
    const triad = scripts.find((code) => code.includes("customElements.define('qtc-triad'")) ?? ''
    expect(triad.indexOf("matchMedia('(prefers-reduced-motion: reduce)')")).toBeLessThan(triad.indexOf('requestAnimationFrame('))
    const proof = element(src, /<section class="sec alt" id="proof"/)
    expect(proof.match(/<qtc-triad\b/g)).toHaveLength(1)
    expect(src.match(/<qtc-triad\b/g)).toHaveLength(1)
    expect(proof).toContain('<figcaption>Quality, time and tokens stay separate. orangu never makes one score.</figcaption>')
    // the size comes from CSS, as a square of 440 px at most
    expect(style).toContain('#proof qtc-triad{display:block;width:100%;max-width:440px;aspect-ratio:1/1;margin:0 auto}')
    expect(src).not.toMatch(/<qtc-triad[^>]*style=/)
  })
})
