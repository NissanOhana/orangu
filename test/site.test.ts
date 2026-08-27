/**
 * Public landing contract.
 *
 * site/index.src.html is the authored source. `node scripts/build.mjs --site`
 * injects shared tokens, the package version, and local brand assets into the
 * committed site/index.html. This suite checks the source contract, generated
 * artifact, public-copy hygiene, and the published sample.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { currencyHits, moneyHits } from './money-vocabulary.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcPath = join(root, 'site/index.src.html')
const outPath = join(root, 'site/index.html')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const b64 = (path: string) => readFileSync(join(root, path)).toString('base64')

const htmlText = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&rarr;|→/g, ' -> ')
    .replace(/\s+/g, ' ')

const publicText = (raw: string, kind: 'text' | 'html' | 'sample') => kind === 'html' ? htmlText(raw) : raw

const publicSurfaces = [
  ['README.md', join(root, 'README.md'), 'text'],
  ['package.json', join(root, 'package.json'), 'text'],
  ['site/index.src.html', srcPath, 'html'],
  ['site/index.html', outPath, 'html'],
  // The sample's visible app is rendered from inline data + client JS. Scan the raw artifact;
  // stripping scripts would leave only its empty mount and title.
  ['site/sample.html', join(root, 'site/sample.html'), 'sample'],
  ['site/llms.txt', join(root, 'site/llms.txt'), 'text'],
  ['site/llms-full.txt', join(root, 'site/llms-full.txt'), 'text'],
] as const

const forbiddenPublicClaims = [
  /software\s*,?\s*not\s+(?:a\s+)?model/i,
  /\b(?:verified|tested|validated|proven|evaluated)\b.{0,120}\b\d[\d,.]*\+?\s+(?:production\s+|real\s+|local\s+)?sessions?\b/i,
  /\b\d+\+?\s+(?:Claude Code )?(?:client )?versions\b/i,
  /\b(?:author's machine|author's real corpus|real corpus)\b/i,
  /\bif you use an AI agent\b/i,
  /\bAI (?:coding )?agent\b/i,
  /\b(?:works?|supports?|built)\s+(?:with\s+|for\s+)?(?:all|any|every)\s+(?:AI\s+)?(?:coding\s+)?agents?\b/i,
  /\b(?:saved?|reduced?|cut)\s+(?:about\s+|~)?\d+(?:\.\d+)?%\s+(?:of\s+)?(?:tokens?|time)\b/i,
  /\bquality\s+(?:improved|increased|rose)\s+(?:by\s+)?\d+(?:\.\d+)?%/i,
  /\bfrom real sessions\b/i,
  /\breal output\b/i,
  /\bwhat changed after the fix\b/i,
  /\btook the session to \d/i,
]

const forbiddenClaimFixtures = [
  'Tested across 500 production sessions.',
  'Works with all AI agents.',
  'Saved 40% of tokens after the change.',
  'Quality improved 20% in actual runs.',
  'Software, not a model, does the counting.',
]

describe('site/index.src.html (authored landing source)', () => {
  const src = existsSync(srcPath) ? readFileSync(srcPath, 'utf8') : ''

  it('uses only current build placeholders', () => {
    expect(existsSync(srcPath)).toBe(true)
    for (const placeholder of [
      '<!-- @tokens -->',
      '{{mascot:main}}',
      '{{mascot:logo}}',
      '{{favicon:32}}',
      '{{favicon:180}}',
      '{{version}}',
    ]) expect(src, `missing placeholder ${placeholder}`).toContain(placeholder)
    expect(readFileSync(join(root, 'site/llms.src.txt'), 'utf8')).toContain('{{version}}')
    expect(src).not.toMatch(/\{\{stats\./)
    expect(src).not.toMatch(/\{\{role:/)
    expect(src, 'stale hand-typed version').not.toMatch(/\bv0\.\d+/)
    expect(existsSync(join(root, 'site/stats.json')), 'obsolete corpus-claim input').toBe(false)
    const builder = readFileSync(join(root, 'scripts/build.mjs'), 'utf8')
    expect(builder).not.toMatch(/site\/stats\.json|\{\{stats\.|\{\{role:/)
  })

  it('authors the 3D triad inline with depth, shadow, and reduced motion', () => {
    expect(src).toContain("customElements.define('qtc-triad'")
    expect(src).toContain('prefers-reduced-motion')
    expect(src).toContain('sort((a,b)=>a.z-b.z)')
    expect(src).toContain('rotX')
    expect(src).toContain('createRadialGradient')
    expect(src).not.toMatch(/\bfps\b/i)
  })

  it('sizes the triad figure from CSS and uses shared color tokens only', () => {
    expect(src).toContain('.triad-fig qtc-triad{display:block;height:clamp(220px,26vw,300px)}')
    expect(src).not.toMatch(/<qtc-triad[^>]*style=/)
    const hexes = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
    expect(hexes, `hand-duplicated palette: ${hexes.join(' ')}`).toHaveLength(0)
  })

  it('uses no ad-prefixed classes or attributes', () => {
    const adish = [...src.matchAll(/class="([^"]*)"/g)]
      .flatMap((match) => (match[1] ?? '').split(/\s+/))
      .filter((name) => /^ad[-_]/i.test(name))
    expect([...new Set(adish)]).toEqual([])
    expect(src).not.toContain('data-adview')
  })

  it('turns local AI history into a clear inspect, discover, improve journey in the first viewport', () => {
    const hero = src.match(/<section class="hero"[\s\S]*?<\/section>/)?.[0] ?? ''
    expect(htmlText(hero)).toContain('Turn your AI history into actionable insights.')
    expect(hero).toContain("Orangu reads your local AI sessions so you don't have to guess what went right (or wrong).")
    expect(hero).toContain('Inspect:</strong> <span>Dive deep into steps and tool calls from a single run.')
    expect(hero).toContain('Discover:</strong> <span>Spot recurring patterns across your whole repository.')
    expect(hero).toContain('Improve:</strong> <span>Use real evidence to build smarter, faster workflows.')
    expect(hero).toContain('Inspect a session')
    expect(hero).toContain('npx orangu report')
    expect(hero).toContain('href="sample.html"')
    expect(hero).toContain('See a real report')
    // the read-only promise sits directly under the command (owner direction)
    expect(hero).toContain('Read-only. It reads the session files already on your disk and writes one HTML file. No proxy, no account, no telemetry.')
    // the eyebrow line was removed on owner direction
    expect(src).not.toContain('class="eyebrow"')
    expect(src).not.toContain('{ Local · offline reports · no instrumentation }')
  })

  it('authors the desktop insights title as two balanced lines beside the report screenshot', () => {
    const hero = src.match(/<section class="hero"[\s\S]*?<\/section>/)?.[0] ?? ''
    const heading = hero.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? ''
    expect([...heading.matchAll(/<span>([^<]+)<\/span>/g)].map((match) => match[1])).toEqual([
      'Turn your AI history',
      'into actionable insights.',
    ])
    expect(src).toContain('@media (min-width:1024px){.hero h1 span{display:block;white-space:nowrap}}')
    expect(src).toContain('.hero-grid{grid-template-columns:minmax(0,1.08fr) minmax(360px,.92fr);column-gap:40px;align-items:center}')
    // the hero visual is the real report screenshot, referenced relatively (site/ deploys as-is)
    expect(hero).toContain('<figure class="hero-shot"><img src="assets/report-overview.png"')
    expect(src).not.toContain('term-wrap')
  })

  it('opens every report-sample action in a new tab without opener access', () => {
    const sampleLinks = [...src.matchAll(/<a\b[^>]*href="sample\.html"[^>]*>/g)].map((match) => match[0])
    expect(sampleLinks).toHaveLength(3)
    for (const link of sampleLinks) {
      expect(link).toContain('target="_blank"')
      expect(link).toMatch(/rel="[^"]*\bnoopener\b[^"]*"/)
      expect(link).toContain('opens in a new tab')
    }
  })

  it('tells the story in six blocks, in order, with a wired nav', () => {
    const order = ['<section class="hero"', '<section id="what"', '<section id="report"', '<section id="fixes"', '<section id="privacy"', '<section id="install"']
    let last = -1
    for (const marker of order) {
      const at = src.indexOf(marker)
      expect(at, `missing or out-of-order block: ${marker}`).toBeGreaterThan(last)
      last = at
    }
    const nav = src.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? ''
    for (const [label, id] of [['What it does', 'what'], ['See a report', 'report'], ['Fixes', 'fixes'], ['Privacy', 'privacy'], ['Install', 'install']])
      expect(nav).toContain(`<a href="#${id}">${label}</a>`)
    expect(nav).toContain('https://github.com/NissanOhana/orangu/blob/main/docs/README.md')
    for (const [, id] of src.matchAll(/href="#([^"]+)"/g))
      expect(src, `dead anchor #${id}`).toContain(`id="${id}"`)
  })

  it('tells the situation, the mechanism, and the goal, then proves it with the hides-shows table and the triad figure', () => {
    const what = src.match(/<section id="what"[\s\S]*?<\/section>/)?.[0] ?? ''
    const text = htmlText(what)
    expect(text).toContain('You run coding agents for hours.')
    expect(text).toContain('the only record of what happened')
    expect(text).toContain('orangu reads it for you.')
    expect(text).toContain('Plain code, no model.')
    expect(text).toContain('no network, no clock')
    expect(text).toContain('The goal is not a score.')
    expect(text).toContain('better outcomes with less time and fewer tokens')
    // the hides/shows table (peers P0-1): what the session says vs what orangu shows
    for (const [hides, shows] of [
      ['"compacted"', 'which turns filled the context window, and with what'],
      ["a subagent's final answer", 'its full tree: tools, tokens, time, errors'],
      ['that a skill is installed', 'whether it ever fired, and what it weighs in context'],
      ['nothing about repetition', 'the same file read again and again, and the same context re-read on every request'],
    ] as const) {
      expect(text, `hides column: ${hides}`).toContain(hides.replace(/"/g, '"'))
      expect(text, `shows column: ${shows}`).toContain(shows)
    }
    // the triad shrinks to a captioned figure; it is not the hero visual
    const figure = what.match(/<figure class="triad-fig">[\s\S]*?<\/figure>/)?.[0] ?? ''
    expect(figure).toContain('<qtc-triad role="img" aria-label="Quality up, Time down, Tokens down: the three axes orangu measures. Never a single score."')
    expect(figure).toContain('<figcaption class="triad-cap">Quality ↑ × Time ↓ × Tokens ↓ · the three axes orangu measures. Never a single score.</figcaption>')
  })

  it('proves the product with the report screenshot and one tokens-only number', () => {
    const report = src.match(/<section id="report"[\s\S]*?<\/section>/)?.[0] ?? ''
    expect(report).toContain('<img src="assets/report-overview.png"')
    const caption = report.match(/<figcaption>([\s\S]*?)<\/figcaption>/)?.[1] ?? ''
    // shape, not exact values: Wave 3 regenerates the screenshot and the caption together
    expect(htmlText(caption)).toMatch(/\d+(?:\.\d+)?M of the \d+(?:\.\d+)?M tokens/)
    expect(caption).toContain('cache reads')
    expect(report).toContain('See a real report')
    expect(htmlText(report)).toContain('The published sample uses synthetic input, so nothing private ships.')
  })

  it('walks the improve loop in four steps and states the session-repo-global rule exactly once', () => {
    const fixes = src.match(/<section id="fixes"[\s\S]*?<\/section>/)?.[0] ?? ''
    const steps = [...fixes.matchAll(/<li><h3>([^<]+)<\/h3>/g)].map((match) => match[1])
    expect(steps).toEqual(['Observe', 'See', 'Propose', 'Apply, with a receipt'])
    expect(fixes).toContain('<code>npx orangu report</code>')
    expect(fixes).toContain('<code>/orangu:improve</code>')
    expect(fixes).toContain('It never edits your project.')
    expect(fixes).toContain('<code>/orangu:apply</code>')
    expect(fixes).toContain('records what changed and which checks ran')
    // the scope rule appears exactly once on the whole page (site-audit D8)
    const rule = 'One run can be fixed and re-checked against a later session from the same workspace. Repo-wide changes are applied on request. Whole-harness changes stay review-only.'
    expect(src.split(rule)).toHaveLength(2)
    expect(fixes).toContain('A later comparison is evidence, not proof of cause.')
    const text = htmlText(src)
    expect(text).not.toMatch(/\bglobal\b[^.]{0,80}\b(?:can|may) be (?:applied|verified)\b/i)
    expect(text).not.toMatch(/\b(?:apply|verify) (?:a )?global (?:proposal|change)\b/i)
  })

  it('backs every privacy claim with a resolving document link', () => {
    const privacy = src.match(/<section id="privacy"[\s\S]*?<\/section>/)?.[0] ?? ''
    expect(privacy).toContain("default-src 'none'")
    expect(privacy).toContain('127.0.0.1')
    expect(privacy).toContain('--strip-paths')
    expect(privacy).toContain('Your whole history is analyzable the minute orangu is')
    for (const doc of ['docs/PRIVACY.md', 'docs/DETERMINISM.md', 'SECURITY.md']) {
      expect(privacy, `missing link to ${doc}`).toContain(`https://github.com/NissanOhana/orangu/blob/main/${doc}`)
      expect(existsSync(join(root, doc)), `${doc} must exist`).toBe(true)
    }
    expect(htmlText(privacy)).toContain('(This page loads Google Fonts; generated reports load nothing.)')
  })

  it('installs npx-first and names only improve and apply, each a shipped skill', () => {
    const install = src.match(/<section id="install"[\s\S]*?<\/section>/)?.[0] ?? ''
    expect(install.match(/class="card install-card"/g) ?? []).toHaveLength(2)
    expect(install.indexOf('npx orangu report')).toBeLessThan(install.indexOf('/plugin marketplace add'))
    expect(install).toContain('/plugin marketplace add NissanOhana/orangu')
    expect(install).toContain('/plugin install orangu')
    expect(install).toContain('https://github.com/NissanOhana/orangu/tree/main/plugin/skills')
    // subset, not equality: Track B owns plugin/skills and renames in parallel
    const named = [...new Set([...htmlText(src).matchAll(/\/orangu:([a-z-]+)/g)].map((match) => match[1] ?? ''))]
    expect(named.sort()).toEqual(['apply', 'improve'])
    for (const skill of named)
      expect(existsSync(join(root, 'plugin/skills', skill, 'SKILL.md')), `unshipped skill on the page: ${skill}`).toBe(true)
    expect(install).not.toContain('Add the Codex plugin')
    expect(install).not.toContain('codex plugin marketplace add')
    expect(install).not.toContain('codex plugin add')
    expect(install).not.toContain('$orangu-')
  })

  it('addresses machines from the footer', () => {
    const footer = src.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? ''
    expect(footer).toContain('are you an LLM? Read <a href="llms.txt">/llms.txt</a>')
    expect(footer).toContain('https://www.npmjs.com/package/orangu')
    expect(footer).toContain('https://github.com/NissanOhana/orangu/blob/main/docs/PRIVACY.md')
    expect(footer).toContain('MIT © Nissan Ohana')
    expect(footer).toContain('orangu is not affiliated with Anthropic. Claude and Claude Code are trademarks of Anthropic.')
  })

  it('keeps the story inside the word and vocabulary budget', () => {
    const body = src.slice(src.indexOf('<body>'))
    const words = htmlText(body).trim().split(/\s+/)
    expect(words.length, 'the page must stay a story, not a feature list').toBeLessThanOrEqual(800)
    expect(words.length, 'the page must still tell the whole story').toBeGreaterThanOrEqual(550)
    const banned = [
      /\bscopes?\b/i, /\blifecycles?\b/i, /\battestations?\b/i, /\bchange class(?:es)?\b/i, /\bcatalogs?\b/i,
      /\bcrosswalks?\b/i, /\bmanifests?\b/i, /\bcohorts?\b/i, /\bslim\b/i, /\bdigests?\b/i,
      /\bbounded evidence\b/i, /\bobserve-to-proposal\b/i, /\bSlimAnalysis\b/, /\bAggregate\b/,
    ]
    const text = htmlText(body)
    for (const jargon of banned) expect(text, `jargon on the landing page: ${jargon}`).not.toMatch(jargon)
  })

  it('declares the social preview from the published screenshot', () => {
    const head = src.slice(0, src.indexOf('</head>'))
    expect(head).toContain('<meta property="og:image" content="https://nissanohana.github.io/orangu/assets/report-overview.png"/>')
    expect(head).toContain('<meta name="twitter:image" content="https://nissanohana.github.io/orangu/assets/report-overview.png"/>')
    expect(head).toContain('<meta name="twitter:card" content="summary_large_image"/>')
    expect(head).toContain('<meta property="og:url" content="https://nissanohana.github.io/orangu/"/>')
    // the in-page references stay relative: pages.yml deploys site/ as-is
    expect(src).not.toMatch(/<img[^>]+src="https?:/)
  })

  it('keeps the primary command and full-sample actions wired', async () => {
    const primaryButtons = src.match(
      /<button class="cmd cmd-btn" type="button" data-cmd="npx orangu report" data-copied="Copied">/g,
    ) ?? []
    expect(primaryButtons, 'hero and final command buttons').toHaveLength(2)
    const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    const interactions = scripts.at(-1)?.[1] ?? ''
    expect(interactions).toContain("closest('button[data-cmd]')")

    const exerciseCopy = async (withClipboard: boolean) => {
      let click: ((event: unknown) => void) | undefined
      let copied = ''
      let legacyCopy = false
      const timers: Array<() => void> = []
      const label = { textContent: 'Inspect a session' }
      const button = {
        offsetWidth: 180,
        style: { minWidth: '' },
        querySelector: () => label,
        getAttribute: (name: string) => name === 'data-cmd' ? 'npx orangu report' : name === 'data-copied' ? 'Copied' : null,
      }
      const themeButton = { addEventListener: () => {}, setAttribute: () => {} }
      const themeLabel = { textContent: '' }
      const area = { value: '', style: { position: '', opacity: '' }, setAttribute: () => {}, select: () => {}, remove: () => {} }
      const document = {
        documentElement: { removeAttribute: () => {}, setAttribute: () => {} },
        getElementById: (id: string) => id === 'themeBtn' ? themeButton : themeLabel,
        addEventListener: (type: string, fn: (event: unknown) => void) => { if (type === 'click') click = fn },
        createElement: () => area,
        execCommand: (command: string) => { legacyCopy = command === 'copy'; return true },
        body: { appendChild: () => {} },
      }
      const navigator = withClipboard
        ? { clipboard: { writeText: async (command: string) => { copied = command } } }
        : {}
      runInNewContext(interactions, {
        document,
        navigator,
        localStorage: { getItem: () => null, setItem: () => {} },
        matchMedia: () => ({ matches: false }),
        setTimeout: (fn: () => void) => { timers.push(fn); return 1 },
      })
      expect(click).toBeTypeOf('function')
      click!({ target: { closest: () => button } })
      await Promise.resolve()
      await Promise.resolve()
      if (withClipboard) expect(copied).toBe('npx orangu report')
      else expect(legacyCopy).toBe(true)
      expect(label.textContent).toBe('Copied')
      timers.forEach((timer) => timer())
      expect(label.textContent).toBe('Inspect a session')
    }

    await exerciseCopy(true)
    await exerciseCopy(false)
  })

  it('keeps accessible interactions and ships none of the design-canvas runtime', () => {
    expect(src).toContain(':focus-visible')
    expect(src).toContain('prefers-reduced-motion')
    expect(src).toContain('aria-live="polite"')
    for (const bad of ['support.js', 'DCLogic', 'sc-for', 'sc-if', '{{ copyAny }}', '{{ toggleTheme }}'])
      expect(src, `must not contain ${bad}`).not.toContain(bad)
    expect(src).not.toContain('class="card role"')
  })

  it('avoids AI-marketing cliches and keeps American spelling', () => {
    const text = htmlText(src)
    expect(text).not.toMatch(/unlock|supercharge|seamless|effortless|revolutioni[sz]e/i)
    expect(text).not.toMatch(/\b(colour|behaviour|analyse|optimis(e|ed|ing)|organis(e|ed|ing)|licence|prioritis)\w*/i)
  })
})

describe('public-copy hygiene', () => {
  it('catches paraphrases of every forbidden claim class', () => {
    for (const fixture of forbiddenClaimFixtures)
      expect(forbiddenPublicClaims.some((claim) => claim.test(fixture)), `unguarded fixture: ${fixture}`).toBe(true)
  })

  it('scans copy inside the sample bundle instead of only its empty HTML mount', () => {
    const sample = readFileSync(join(root, 'site/sample.html'), 'utf8')
    const poisoned = sample.replace('</body>', '<script>const publicClaim = "Works with all AI agents."</script></body>')
    const scanned = publicText(poisoned, 'sample')
    expect(scanned).toContain('Works with all AI agents.')
    expect(forbiddenPublicClaims.some((claim) => claim.test(scanned))).toBe(true)
  })

  for (const [label, path, kind] of publicSurfaces) {
    it(`${label} has no forbidden launch claims`, () => {
      const raw = readFileSync(path, 'utf8')
      const text = publicText(raw, kind)
      expect(currencyHits(text), `${label}: currency amount`).toEqual([])
      const vocabulary = moneyHits(text)
      expect(vocabulary, `${label}: money vocabulary`).toEqual([])
      expect(text, `${label}: em dash`).not.toContain('—')
      for (const claim of forbiddenPublicClaims)
        expect(text, `${label}: forbidden claim ${claim}`).not.toMatch(claim)
    })
  }
})

describe('site/index.html (generated landing)', () => {
  const html = existsSync(outPath) ? readFileSync(outPath, 'utf8') : ''

  it('exists, stays bounded, and has no unresolved placeholders', () => {
    expect(existsSync(outPath)).toBe(true)
    expect(statSync(outPath).size).toBeLessThan(1_500_000)
    expect(html).toContain(`v${pkg.version} · open source, MIT`)
    expect(html).not.toMatch(/\{\{[^}]+\}\}|<!-- @[a-z]+ -->/)
  })

  it('ships none of the design-canvas runtime', () => {
    for (const bad of ['support.js', 'DCLogic', 'sc-for']) expect(html).not.toContain(bad)
  })

  it('inlines the current brand assets', () => {
    expect(html).toContain(b64('design/brand/mascot-main-320.png').slice(0, 512))
    expect(html).toContain(b64('design/brand/mascot-96.png').slice(0, 512))
    expect(html).toContain(b64('design/brand/favicon-32.png').slice(0, 512))
    expect(html).toContain(b64('design/brand/favicon-180.png').slice(0, 512))
    expect(html).not.toContain('{{role:')
  })

  it('keeps the inline triad and three-state theme cascade', () => {
    expect(html).toContain('qtc-triad')
    expect(html).toContain('prefers-reduced-motion')
    expect(html).toContain('sort((a,b)=>a.z-b.z)')
    expect(html).toContain(':root[data-theme="dark"]')
    expect(html).toContain('@media (prefers-color-scheme:dark)')
    expect(html).toContain(':root:not([data-theme="light"])')
  })

  it('references only approved public origins', () => {
    const allowed = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'github.com', 'nissanohana.github.io', 'www.npmjs.com'])
    const urls = html.match(/https?:\/\/[^\s"'<>)]+/g) ?? []
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) expect(allowed.has(new URL(url).host), `disallowed origin: ${url}`).toBe(true)
  })

  it('passes scripts/assert-offline.mjs --site', () => {
    const out = execFileSync('node', [join(root, 'scripts/assert-offline.mjs'), '--site'], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(out).toContain('offline OK')
  })
})

describe('site/llms.txt and site/llms-full.txt (generated machine-readable index)', () => {
  const llmsPath = join(root, 'site/llms.txt')
  const fullPath = join(root, 'site/llms-full.txt')
  const llms = existsSync(llmsPath) ? readFileSync(llmsPath, 'utf8') : ''
  const full = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : ''
  const privatePaths = ['docs/research', 'docs/plans', 'docs/runs', 'docs/handoff']

  it('exist, are non-empty, and carry no unresolved placeholders', () => {
    expect(llms.length).toBeGreaterThan(0)
    expect(full.length).toBeGreaterThan(0)
    expect(llms).not.toMatch(/\{\{[^}]+\}\}/)
    expect(full).not.toMatch(/\{\{[^}]+\}\}/)
    expect(llms).toContain(`orangu ${pkg.version}`)
  })

  it('follows the llmstxt.org shape: H1, blockquote, commands, facts, three H2 sections', () => {
    const lines = llms.split('\n').filter((line) => line.trim() !== '')
    expect(lines[0]).toBe('# orangu')
    expect(lines[1]?.startsWith('>')).toBe(true)
    expect(llms).toContain('Concretely, you can:')
    expect(llms).toContain('Facts an LLM should not get wrong')
    expect(llms).toContain('Tokens only')
    for (const heading of ['## Docs', '## Getting started', '## Optional']) expect(llms).toContain(`\n${heading}\n`)
    expect(llms.indexOf('## Docs')).toBeLessThan(llms.indexOf('## Getting started'))
    expect(llms.indexOf('## Getting started')).toBeLessThan(llms.indexOf('## Optional'))
    expect(llms).toContain('llms-full.txt')
    expect(llms).toContain('https://www.npmjs.com/package/orangu')
  })

  it('names only the final five skills and every CLI verb from --help', () => {
    const skills = [...llms.matchAll(/\/orangu:([a-z-]+)/g)].map((m) => m[1])
    expect(new Set(skills)).toEqual(new Set(['analyze', 'improve', 'apply', 'harness', 'feedback']))
    expect(llms).not.toContain('/orangu:mega')
    for (const verb of ['report', 'serve', 'repo', 'global', 'harness', 'analyze']) expect(llms).toContain(`npx orangu ${verb}`)
  })

  it('llms-full.txt concatenates README, USAGE, and DETERMINISM verbatim with absolute links, under the 40 KB ratchet', () => {
    expect(full.startsWith('# orangu llms-full.txt')).toBe(true)
    for (const source of ['README.md', 'docs/USAGE.md', 'docs/DETERMINISM.md']) expect(full).toContain(`\n# ${source}\n`)
    expect(full.indexOf('# README.md')).toBeLessThan(full.indexOf('# docs/USAGE.md'))
    expect(full.indexOf('# docs/USAGE.md')).toBeLessThan(full.indexOf('# docs/DETERMINISM.md'))
    // a relative link from the README becomes absolute so a fetching agent can follow it
    expect(full).toContain('https://github.com/NissanOhana/orangu/blob/main/docs/README.md')
    expect(full).not.toMatch(/\]\((?!https?:|#)[^)]+\)/)
    // Ratchet: only down. It grows with the README; trim before raising.
    expect(Buffer.byteLength(full, 'utf8')).toBeLessThan(40_000)
  })

  it('never leaks a private working path', () => {
    for (const path of privatePaths) {
      expect(llms, `llms.txt mentions ${path}`).not.toContain(path)
      expect(full, `llms-full.txt mentions ${path}`).not.toContain(path)
    }
    const builder = readFileSync(join(root, 'scripts/build.mjs'), 'utf8')
    expect(builder).not.toMatch(/readdirSync\([^)]*docs/)
  })

  it('is generated by build.mjs --site and guarded by assert-generated and assert-offline', () => {
    const generated = readFileSync(join(root, 'scripts/assert-generated.mjs'), 'utf8')
    expect(generated).toContain("'site/llms.txt'")
    expect(generated).toContain("'site/llms-full.txt'")
    const offline = readFileSync(join(root, 'scripts/assert-offline.mjs'), 'utf8')
    expect(offline).toContain('site/llms.txt')
    expect(offline).toContain('site/llms-full.txt')
  })
})

describe('site/assets (published proof image)', () => {
  const shot = join(root, 'site/assets/report-overview.png')

  it('ships the report screenshot as a real PNG under the size ratchet', () => {
    expect(existsSync(shot)).toBe(true)
    const bytes = readFileSync(shot)
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    // Ratchet: only down. Wave 3 regenerates this image; if a rerun exceeds it, crop or scale.
    expect(bytes.length).toBeLessThanOrEqual(350_000)
    // width from the IHDR chunk: the image is captured at 1280 CSS px, scale factor 1
    expect(bytes.readUInt32BE(16)).toBe(1280)
  })

  it('is served by the browser-test static server', () => {
    const server = readFileSync(join(root, 'test/browser/static-server.mjs'), 'utf8')
    expect(server).toContain("'/assets/report-overview.png'")
    expect(server).toContain('image/png')
  })

  it('is regenerated by a developer-only script, never by the gate', () => {
    const script = readFileSync(join(root, 'scripts/site-screenshot.mjs'), 'utf8')
    expect(script).toContain('--strip-paths')
    expect(script).toContain("colorScheme: 'light'")
    expect(script).toContain("reducedMotion: 'reduce'")
    expect(pkg.scripts.verify).not.toContain('site-screenshot')
    for (const workflow of readdirSync(join(root, '.github/workflows')))
      expect(readFileSync(join(root, '.github/workflows', workflow), 'utf8')).not.toContain('site-screenshot')
  })
})

describe('site/sample.html (published sample report)', () => {
  const sample = readFileSync(new URL('../site/sample.html', import.meta.url), 'utf8')

  it('is self-contained, offline, and free of money claims', () => {
    expect(sample).toContain('Content-Security-Policy')
    expect(sample).toContain("default-src 'none'")
    expect(/<link\b/i.test(sample)).toBe(false)
    expect(/https?:\/\/(?!localhost|127\.0\.0\.1)/.test(sample.slice(sample.indexOf('</head>')))).toBe(false)
    expect(currencyHits(sample)).toEqual([])
    expect(moneyHits(sample)).toEqual([])
  })

  it('tells a no-script reader what the page is, without any URL', () => {
    const noscript = sample.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? ''
    expect(noscript).toContain('Enable JavaScript for this page to read it.')
    expect(noscript).not.toMatch(/https?:/)
    expect(noscript).not.toContain('\u2014')
    expect(sample.indexOf('<noscript>')).toBeGreaterThan(sample.indexOf('<div id="app" class="app"></div>'))
  })

  it('uses synthetic fixture data only', () => {
    const privatePath = ['', 'Users', 'private-user'].join('/')
    const knownPrivateMarkers = [
      ['nis', 'sano'].join(''),
      ['brain', 'iac'].join(''),
      ['', 'Users', ['nis', 'sano'].join('')].join('/'),
      ['try', 'brain', 'iac'].join(''),
      ['d3d3', 'adfd'].join(''),
    ]
    for (const marker of ['private-user', 'private-project', privatePath, 'private-host', 'real-session-marker', ...knownPrivateMarkers])
      expect(sample.toLowerCase(), `leak: ${marker}`).not.toContain(marker.toLowerCase())
    expect(sample).toContain('5a91c73e')
  })
})
