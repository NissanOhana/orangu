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

  it('sizes the hero triad from CSS and uses shared color tokens only', () => {
    expect(src).toContain('.hero qtc-triad{display:block;height:clamp(440px,44vw,620px)}')
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
    expect(hero).toContain('See the observe-to-proposal sample')
  })

  it('authors the desktop insights title as two balanced lines and closes the hero gap', () => {
    const hero = src.match(/<section class="hero"[\s\S]*?<\/section>/)?.[0] ?? ''
    const heading = hero.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? ''
    expect([...heading.matchAll(/<span>([^<]+)<\/span>/g)].map((match) => match[1])).toEqual([
      'Turn your AI history',
      'into actionable insights.',
    ])
    expect(src).toContain('@media (min-width:1024px){.hero h1 span{display:block;white-space:nowrap}}')
    expect(src).toContain('grid-template-areas:"copy viz" "term viz"')
    expect(src).toContain('.hero-viz{grid-area:viz;align-self:center;margin-left:-40px}')
    expect(hero.indexOf('class="term-wrap"')).toBeGreaterThan(hero.indexOf('class="hero-viz"'))
  })

  it('opens every report-sample action in a new tab without opener access', () => {
    const sampleLinks = [...src.matchAll(/<a\b[^>]*href="sample\.html"[^>]*>/g)].map((match) => match[0])
    expect(sampleLinks).toHaveLength(2)
    for (const link of sampleLinks) {
      expect(link).toContain('target="_blank"')
      expect(link).toMatch(/rel="[^"]*\bnoopener\b[^"]*"/)
      expect(link).toContain('opens in a new tab')
    }
  })

  it('uses a live, outcome-led information hierarchy', () => {
    for (const id of ['jobs', 'demo', 'improve', 'scenarios', 'trust', 'install'])
      expect(src, `missing section #${id}`).toContain(`<section id="${id}"`)
    const nav = src.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? ''
    for (const [, id] of nav.matchAll(/href="#([^"]+)"/g))
      expect(src, `dead nav anchor #${id}`).toContain(`id="${id}"`)
    expect(src).toContain('Observe one session')
    expect(src).toContain('Improve repeated work')
    expect(src).toMatch(/<code>repo<\/code>[\s\S]*?<code>global<\/code>/)
  })

  it('shows the complete session observe-to-verified sequence in order', () => {
    const demo = src.match(/<section id="demo"[\s\S]*?<\/section>/)?.[0] ?? ''
    const steps = ['Tool call', 'Local evidence', 'Recurring pattern', 'Draft proposal', 'Explicit apply', 'Next-run verification']
    let last = -1
    for (const step of steps) {
      const at = demo.indexOf(step)
      expect(at, `missing or out-of-order demo step: ${step}`).toBeGreaterThan(last)
      last = at
    }
    expect(demo).toContain('Observe locally. Draft from evidence. Use only the lifecycle the scope supports.')
    expect(demo).toContain('Open the full sample report')
  })

  it('shows the current Suggestions experience first', () => {
    const demo = src.match(/<div class="appdemo" id="appdemo">[\s\S]*?<\/section>/)?.[0] ?? ''
    expect(demo).toContain('class="demo-body"')
    expect(demo).toContain('class="demo-rail"')
    const suggestionTab = demo.match(/<button\b[^>]*data-demo-view="suggest"[^>]*>/)?.[0] ?? ''
    expect(suggestionTab).toContain('aria-current="page"')
    expect(suggestionTab).toContain('aria-selected="true"')
    expect(suggestionTab).toContain('tabindex="0"')
    expect(suggestionTab).toContain('class="on"')
    const suggestionPanel = demo.match(/<div\b[^>]*data-demo-view="suggest"[^>]*>/)?.[0] ?? ''
    expect(suggestionPanel).toContain('class="demo-view on"')
    expect(suggestionPanel).not.toContain(' hidden')
    for (const scope of ['This session', 'Repo', 'Global']) expect(demo).toContain(`>${scope}<`)
    expect(demo).toContain('Session: proposed → applied → verified · Repo: proposed → applied · Global: proposed')
    for (const changeClass of [
      'Instruction files',
      'Scripts and CLIs',
      'Hooks',
      'Skills to create',
      'Skills to discover',
      'Subagents and agents',
      'MCP servers',
      'Plugins',
      'Workflow and configuration',
    ]) expect(demo, `missing preview change class: ${changeClass}`).toContain(changeClass)
    for (const copy of [
      '<b>Evidence.</b>',
      '<b>Proposal.</b>',
      '<b>Next-run verification.</b>',
      '<b>Explicit apply.</b>',
      'handled by orangu:improve',
      'Claude apply',
      'Orangu resolves a later session from the same workspace',
    ]) expect(demo).toContain(copy)
    expect(demo).not.toContain('Codex apply')
    expect(demo).not.toContain('Run locally')
  })

  it('previews the real overview, timeline, and tools-and-calls capabilities', () => {
    const demo = src.match(/<div class="appdemo" id="appdemo">[\s\S]*?<\/section>/)?.[0] ?? ''
    expect(demo).not.toContain('data-demo-view="evidence"')
    for (const tab of ['Overview', 'Timeline', 'Tools &amp; calls', 'Suggestions'])
      expect(demo, `missing preview tab: ${tab}`).toContain(`>${tab}<`)
    for (const view of ['overview', 'timeline', 'tools', 'suggest'])
      expect(demo, `missing preview view: ${view}`).toContain(`data-demo-view="${view}"`)
    expect(demo).toContain('role="tablist"')
    expect(demo).not.toContain('aria-live=')
    for (const view of ['overview', 'timeline', 'tools', 'suggest']) {
      const tab = demo.match(new RegExp(`<button\\b[^>]*id="demo-tab-${view}"[^>]*>`))?.[0] ?? ''
      expect(tab).toContain('role="tab"')
      expect(tab).toContain(`aria-controls="demo-panel-${view}"`)
      const panel = demo.match(new RegExp(`<div\\b[^>]*id="demo-panel-${view}"[^>]*>`))?.[0] ?? ''
      expect(panel).toContain('role="tabpanel"')
      expect(panel).toContain(`aria-labelledby="demo-tab-${view}"`)
      if (view !== 'suggest') expect(panel).toContain(' hidden')
    }
    expect(demo).toContain('id="demoMotion"')
    expect(demo).toContain('Automatic preview is static')

    for (const capability of [
      'Every tool call',
      'Parent + subagents',
      'one ordered session timeline',
      'verify session changes on a later run',
    ]) expect(demo, `missing truthful overview capability: ${capability}`).toContain(capability)

    for (const timelineEvidence of [
      'Illustrative session timeline',
      'Tool calls in order',
      'main',
      'agent-1',
      'error result stays on this call',
      'actor identity',
    ]) expect(demo, `missing timeline evidence: ${timelineEvidence}`).toContain(timelineEvidence)

    for (const toolEvidence of [
      'Usage · errors · latency',
      'avg / p95',
      'Recurring error',
      'Counts, errors, and latency come from parsed tool calls.',
    ]) expect(demo, `missing tools-and-calls evidence: ${toolEvidence}`).toContain(toolEvidence)
  })

  it('wires accessible manual preview navigation and visibility-aware autoplay', () => {
    const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    const interaction = scripts.map((match) => match[1] ?? '').find((code) => code.includes("getElementById('appdemo')")) ?? ''
    expect(interaction).toContain("querySelectorAll('.demo-rail [data-demo-view]')")
    expect(interaction).toContain("querySelectorAll('.demo-main [data-demo-view]')")
    expect(interaction).toContain('Array.prototype.map.call(buttons')
    expect(interaction).toContain("window.matchMedia('(prefers-reduced-motion: reduce)')")
    expect(interaction).toContain("document.addEventListener('visibilitychange', scheduleCycle)")
    expect(interaction).toContain("new window.IntersectionObserver")
    expect(interaction).toContain('entry.intersectionRatio >= 0.35')
    expect(interaction).not.toContain('visible = true')
    expect(interaction).toContain("button.setAttribute('aria-selected', String(active))")
    expect(interaction).toContain("button.setAttribute('tabindex', active ? '0' : '-1')")
    expect(interaction).toContain('view.hidden = !active')
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'])
      expect(interaction).toContain(`event.key === '${key}'`)
    expect(interaction).toContain("motionButton.textContent = userPaused ? 'Play' : 'Pause'")

    type MockEvent = { key?: string; relatedTarget?: unknown; preventDefault?: () => void }
    type Handler = (event?: MockEvent) => void
    type DemoNode = {
      attrs: Map<string, string>
      classes: Set<string>
      hidden: boolean
      focusCount: number
      click?: () => void
      handlers: Map<string, Handler>
      classList: { toggle: (name: string, active: boolean) => void }
      focus: () => void
      getAttribute: (name: string) => string | null
      setAttribute: (name: string, value: string) => void
      removeAttribute: (name: string) => void
      addEventListener: (type: string, fn: Handler) => void
    }
    const node = (name: string, active = false): DemoNode => {
      const attrs = new Map<string, string>([
        ['data-demo-view', name],
        ['aria-selected', String(active)],
        ['tabindex', active ? '0' : '-1'],
      ])
      if (active) attrs.set('aria-current', 'page')
      const classes = new Set(active ? ['on'] : [])
      const handlers = new Map<string, Handler>()
      const target: DemoNode = {
        attrs,
        classes,
        hidden: !active,
        focusCount: 0,
        handlers,
        classList: { toggle: (className, on) => { if (on) classes.add(className); else classes.delete(className) } },
        focus: () => { target.focusCount++ },
        getAttribute: (key) => attrs.get(key) ?? null,
        setAttribute: (key, value) => { attrs.set(key, value) },
        removeAttribute: (key) => { attrs.delete(key) },
        addEventListener: (type, fn) => {
          handlers.set(type, fn)
          if (type === 'click') target.click = fn
        },
      }
      return target
    }
    const buttons = [node('overview'), node('timeline'), node('tools'), node('suggest', true)]
    const views = [node('overview'), node('timeline'), node('tools'), node('suggest', true)]
    const demoHandlers = new Map<string, Handler>()
    const demo = {
      querySelectorAll: (selector: string) => selector.includes('.demo-rail') ? buttons : views,
      addEventListener: (type: string, fn: Handler) => demoHandlers.set(type, fn),
      contains: () => false,
    }
    const motionAttrs = new Map<string, string>()
    const motionButtonHandlers = new Map<string, Handler>()
    const motionButton = {
      disabled: true,
      textContent: 'Static',
      setAttribute: (key: string, value: string) => motionAttrs.set(key, value),
      addEventListener: (type: string, fn: Handler) => motionButtonHandlers.set(type, fn),
    }
    const documentHandlers = new Map<string, Handler>()
    const document = {
      hidden: false,
      getElementById: (id: string) => id === 'appdemo' ? demo : id === 'demoMotion' ? motionButton : null,
      addEventListener: (type: string, fn: Handler) => documentHandlers.set(type, fn),
    }
    const motionHandlers = new Map<string, Handler>()
    const motion = {
      matches: false,
      addEventListener: (type: string, fn: Handler) => motionHandlers.set(type, fn),
    }
    let timerId = 0
    let maxTimers = 0
    const timers = new Map<number, () => void>()
    let observerCallback: (entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void = () => {}
    const window = {
      matchMedia: () => motion,
      setTimeout: (fn: () => void) => {
        const id = ++timerId
        timers.set(id, fn)
        maxTimers = Math.max(maxTimers, timers.size)
        return id
      },
      clearTimeout: (id: number) => timers.delete(id),
      IntersectionObserver: class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean; intersectionRatio: number }>) => void) {
          observerCallback = callback
        }
        observe(): void { observerCallback([{ isIntersecting: true, intersectionRatio: 0.5 }]) }
      },
    }

    runInNewContext(interaction, { document, window })
    expect(motionButton.disabled).toBe(false)
    expect(motionButton.textContent).toBe('Pause')
    expect(buttons[3]!.classes.has('on')).toBe(true)
    expect(buttons[3]!.attrs.get('aria-current')).toBe('page')
    expect(timers.size).toBe(1)
    expect(maxTimers).toBe(1)

    observerCallback([{ isIntersecting: false, intersectionRatio: 0 }])
    expect(timers.size).toBe(0)
    observerCallback([{ isIntersecting: true, intersectionRatio: 0.35 }])
    expect(timers.size).toBe(1)

    demoHandlers.get('pointerenter')!()
    expect(timers.size).toBe(0)
    demoHandlers.get('pointerleave')!()
    expect(timers.size).toBe(1)

    const autoplay = [...timers.values()][0]!
    timers.clear()
    autoplay()
    expect(buttons[0]!.classes.has('on')).toBe(true)
    expect(buttons[0]!.attrs.get('aria-current')).toBe('page')
    expect(buttons[3]!.classes.has('on')).toBe(false)
    expect(buttons[3]!.attrs.has('aria-current')).toBe(false)
    expect(views[0]!.classes.has('on')).toBe(true)
    expect(views[0]!.hidden).toBe(false)
    expect(views[3]!.classes.has('on')).toBe(false)
    expect(views[3]!.hidden).toBe(true)
    expect(buttons.every((button) => button.focusCount === 0)).toBe(true)

    document.hidden = true
    documentHandlers.get('visibilitychange')!()
    expect(timers.size).toBe(0)
    document.hidden = false
    documentHandlers.get('visibilitychange')!()
    expect(timers.size).toBe(1)

    motion.matches = true
    motionHandlers.get('change')!()
    expect(timers.size).toBe(0)
    expect(motionButton.disabled).toBe(true)
    expect(motionButton.textContent).toBe('Motion off')
    motion.matches = false
    motionHandlers.get('change')!()
    expect(timers.size).toBe(1)
    expect(motionButton.disabled).toBe(false)

    buttons[2]!.click!()
    expect(buttons[2]!.classes.has('on')).toBe(true)
    expect(buttons[2]!.attrs.get('aria-current')).toBe('page')
    expect(views[2]!.classes.has('on')).toBe(true)
    expect(timers.size).toBe(0)
    expect(motionButton.textContent).toBe('Play')
    documentHandlers.get('visibilitychange')!()
    expect(timers.size).toBe(0)

    let prevented = false
    buttons[2]!.handlers.get('keydown')!({ key: 'Home', preventDefault: () => { prevented = true } })
    expect(prevented).toBe(true)
    expect(buttons[0]!.classes.has('on')).toBe(true)
    expect(buttons[0]!.attrs.get('tabindex')).toBe('0')
    expect(buttons[2]!.attrs.get('tabindex')).toBe('-1')
    expect(buttons[0]!.focusCount).toBe(1)
    expect(timers.size).toBe(0)

    motionButtonHandlers.get('click')!()
    expect(motionButton.textContent).toBe('Pause')
    expect(timers.size).toBe(1)
    const resumedAutoplay = [...timers.values()][0]!
    timers.clear()
    resumedAutoplay()
    expect(buttons[1]!.classes.has('on')).toBe(true)
    expect(buttons[0]!.focusCount).toBe(1)
    expect(maxTimers).toBe(1)

    motionButtonHandlers.get('click')!()
    expect(motionButton.textContent).toBe('Play')
    expect(timers.size).toBe(0)

    const staticButtons = [node('overview'), node('timeline'), node('tools'), node('suggest', true)]
    const staticViews = [node('overview'), node('timeline'), node('tools'), node('suggest', true)]
    const staticDemo = {
      querySelectorAll: (selector: string) => selector.includes('.demo-rail') ? staticButtons : staticViews,
      addEventListener: () => {},
      contains: () => false,
    }
    const staticMotionAttrs = new Map<string, string>()
    const staticMotionButton = {
      disabled: false,
      textContent: '',
      setAttribute: (key: string, value: string) => staticMotionAttrs.set(key, value),
      addEventListener: () => {},
    }
    const staticDocument = {
      hidden: false,
      getElementById: (id: string) => id === 'appdemo' ? staticDemo : id === 'demoMotion' ? staticMotionButton : null,
      addEventListener: () => {},
    }
    const staticTimers = new Map<number, () => void>()
    const staticWindow = {
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      setTimeout: (fn: () => void) => { staticTimers.set(1, fn); return 1 },
      clearTimeout: (id: number) => staticTimers.delete(id),
    }
    runInNewContext(interaction, { document: staticDocument, window: staticWindow })
    expect(staticMotionButton.disabled).toBe(true)
    expect(staticMotionButton.textContent).toBe('Static')
    expect(staticMotionAttrs.get('aria-label')).toBe('Automatic preview unavailable in this browser')
    expect(staticTimers.size).toBe(0)
  })

  it('shows the full change-class breadth', () => {
    const improve = src.match(/<section id="improve"[\s\S]*?<\/section>/)?.[0] ?? ''
    for (const changeClass of [
      'Instruction files',
      'Scripts and CLIs',
      'Hooks',
      'Skills to create',
      'Skills to discover',
      'Subagents and agents',
      'MCP servers',
      'Plugins',
      'Workflow and configuration',
    ]) expect(improve, `missing change class: ${changeClass}`).toContain(changeClass)
    expect(improve).toContain('class="change-grid"')
  })

  it('keeps the primary command and full-sample actions wired', async () => {
    const primaryButtons = src.match(
      /<button class="cmd cmd-btn" type="button" data-cmd="npx orangu report" data-copied="Copied">/g,
    ) ?? []
    expect(primaryButtons, 'hero and final command buttons').toHaveLength(2)
    const demo = src.match(/<section id="demo"[\s\S]*?<\/section>/)?.[0] ?? ''
    expect(demo).toContain('<a class="ghost" href="sample.html" target="_blank" rel="noopener"')

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

  it('defaults the theme to light, cycles two states, and round-trips the stored preference', () => {
    const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    const interactions = scripts.at(-1)?.[1] ?? ''
    const start = (stored: string | null) => {
      let click: (() => void) | undefined
      let saved = stored
      let attr: string | null = 'never touched'
      const attrs: Record<string, string> = {}
      const label = { textContent: '' }
      const button = {
        addEventListener: (type: string, fn: () => void) => { if (type === 'click') click = fn },
        setAttribute: (name: string, value: string) => { attrs[name] = value },
      }
      const document = {
        documentElement: {
          removeAttribute: () => { attr = null },
          setAttribute: (_name: string, value: string) => { attr = value },
        },
        getElementById: (id: string) => id === 'themeBtn' ? button : label,
        addEventListener: () => {},
        createElement: () => ({}),
        body: { appendChild: () => {} },
      }
      runInNewContext(interactions, {
        document,
        navigator: {},
        // a viewer whose system asks for dark: after the cascade change it changes nothing
        localStorage: { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value } },
        matchMedia: () => ({ matches: true }),
        setTimeout: () => 1,
      })
      expect(click).toBeTypeOf('function')
      return { click: click!, label, attrs, attr: () => attr, saved: () => saved }
    }

    const fresh = start(null)
    expect(fresh.label.textContent).toBe('light')
    expect(fresh.attr()).toBeNull()
    expect(fresh.attrs['aria-label']).toBe('theme light, switch to dark')
    fresh.click()
    expect(fresh.label.textContent).toBe('dark')
    expect(fresh.attr()).toBe('dark')
    expect(fresh.saved()).toBe('dark')
    expect(fresh.attrs['aria-label']).toBe('theme dark, switch to light')
    fresh.click()
    expect(fresh.label.textContent).toBe('light')
    expect(fresh.attr()).toBeNull()
    expect(fresh.saved()).toBe('light')

    // a stored preference is restored, and the removed third state reads as light rather than
    // printing a word the button can no longer reach
    expect(start('dark').label.textContent).toBe('dark')
    expect(start('light').attr()).toBeNull()
    const legacy = start('system')
    expect(legacy.label.textContent).toBe('light')
    expect(legacy.attr()).toBeNull()
  })

  it('uses work scenarios instead of profession cards', () => {
    const scenarios = src.match(/<section id="scenarios"[\s\S]*?<\/section>/)?.[0] ?? ''
    for (const title of ['Review delegated work', 'Diagnose a rough outcome', 'Improve a repeated workflow'])
      expect(scenarios).toContain(title)
    for (const profession of ['Developers', 'Engineers', 'Teachers', 'Product managers', 'Everyone else'])
      expect(scenarios).not.toContain(`<h3>${profession}</h3>`)
    expect(src).not.toContain('class="card role"')
  })

  it('presents deterministic evidence, optional interpretation, and receipted application as collaborators', () => {
    const trust = src.match(/<section id="trust"[\s\S]*?<\/section>/)?.[0] ?? ''
    expect(trust).toContain('Bounded local evidence')
    expect(trust).toContain('Optional AI interpretation')
    expect(trust).toContain('Explicit reviewed changes')
    // B7 vocabulary: one noun, "receipt"; the internal nouns never reach the public page
    expect(trust).toContain("receipt's shape and file list")
    expect(src).not.toMatch(/attestation|preflight/i)
    expect(trust).not.toContain('edits the declared repository files')
    expect(trust).toContain('No instrumentation')
    expect(trust).toContain('no upload')
    expect(trust).not.toMatch(/\b(?:versus|vs\.)\b/i)
  })

  it('states the conservative lifecycle without broadening repo or global authority', () => {
    const text = htmlText(src)
    expect(text).toContain('Session: proposed -> applied -> verified · Repo: proposed -> applied · Global: proposed')
    expect(text).toContain('repo may be applied explicitly. global is proposal-only.')
    expect(text).toContain('Session can propose, apply, and verify; repo can propose and apply; global stays proposal-only.')
    expect(text).toContain('session-scope later verification')
    expect(text).not.toMatch(/\bglobal\b[^.]{0,80}\b(?:can|may) be (?:applied|verified)\b/i)
    expect(text).not.toMatch(/\b(?:apply|verify) (?:a )?global (?:proposal|change)\b/i)
  })

  it('states the bounded evidence inputs without vendor-command comparisons', () => {
    const trust = src.match(/<section id="trust"[\s\S]*?<\/section>/)?.[0] ?? ''
    for (const input of ['orangu evidence', 'Analysis', 'SlimAnalysis', 'Aggregate']) expect(trust).toContain(input)
    expect(trust).toContain('How Orangu turns local evidence into improvement')
    expect(trust).not.toContain('Claude Code /insights')
    expect(trust).not.toContain('Codex commands')
    expect(trust).not.toContain('historical-session insights command')
  })

  it('stages inspection and Claude plugin activation in the install section', () => {
    const install = src.match(/<section id="install"[\s\S]*?<\/section>/)?.[0] ?? ''
    expect(install.match(/class="card install-card"/g) ?? []).toHaveLength(3)
    expect(install).toContain('Inspect a session')
    expect(install).toContain('Add the Claude Code plugin')
    expect(install).toContain('/plugin marketplace add NissanOhana/orangu')
    expect(install).toContain('/plugin install orangu')
    expect(install).toContain('Claude Code and Codex skills share the same scope-aware proposal')
    expect(install).not.toContain('Add the Codex plugin')
    expect(install).not.toContain('codex plugin marketplace add')
    expect(install).not.toContain('codex plugin add')
    expect(install).not.toContain('$orangu-')
  })

  it('lists the five shipped skills', () => {
    const install = src.match(/<section id="install"[\s\S]*?<\/section>/)?.[0] ?? ''
    const listed = [...install.matchAll(/<div class="skill"><b>\/orangu:([a-z-]+)<\/b>/g)].map((m) => m[1])
    expect(listed).toEqual(['improve', 'apply', 'analyze', 'harness', 'feedback'])
    for (const retired of ['/orangu:mega', '/orangu:watch', '/orangu:suggest']) expect(src).not.toContain(retired)
    const dirs = readdirSync(join(root, 'plugin/skills')).filter((dir) => existsSync(join(root, 'plugin/skills', dir, 'SKILL.md'))).sort()
    expect(dirs).toEqual([...listed].sort())
  })

  it('keeps accessible interactions and ships none of the design-canvas runtime', () => {
    expect(src).toContain(':focus-visible')
    expect(src).toContain('prefers-reduced-motion')
    expect(src).toContain('aria-live="polite"')
    for (const bad of ['support.js', 'DCLogic', 'sc-for', 'sc-if', '{{ copyAny }}', '{{ toggleTheme }}'])
      expect(src, `must not contain ${bad}`).not.toContain(bad)
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

  it('keeps the inline triad and the two-state theme cascade', () => {
    expect(html).toContain('qtc-triad')
    expect(html).toContain('prefers-reduced-motion')
    expect(html).toContain('sort((a,b)=>a.z-b.z)')
    expect(html).toContain(':root[data-theme="dark"]')
    // Light is the only default: dark exists solely under the explicit attribute, so nothing in the
    // generated page reads the system colour scheme, and the redraw listener that watched it is gone.
    expect(html).not.toContain('@media (prefers-color-scheme:dark)')
    expect(html).not.toContain(':root:not([data-theme="light"])')
    expect(html).not.toContain('prefers-color-scheme')
  })

  it('references only approved public origins', () => {
    // nissanohana.github.io: og:url / og:image link-unfurl metadata; the page never requests it
    const allowed = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'github.com', 'nissanohana.github.io'])
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

// C3: the page leans on privacy/determinism/security promises, so the footer links the documents that
// make them and discloses the one thing the page itself loads (Google Fonts; generated reports load nothing).
describe('landing footer', () => {
  const src = readFileSync(join(root, 'site/index.src.html'), 'utf8')
  const footer = src.match(/<footer>[\s\S]*?<\/footer>/)?.[0] ?? ''
  it('links the privacy, determinism and security documents', () => {
    for (const doc of ['docs/PRIVACY.md', 'docs/DETERMINISM.md', 'SECURITY.md']) {
      expect(footer).toContain(`https://github.com/NissanOhana/orangu/blob/main/${doc}`)
    }
  })
  it('discloses the font load and the report promise', () => {
    expect(footer).toContain('This page loads Google Fonts; generated reports load nothing.')
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
    const handle = ['nis', 'sano'].join('')
    const knownPrivateMarkers = [
      ['brain', 'iac'].join(''),
      ['', 'Users', ['nis', 'sano'].join('')].join('/'),
      ['try', 'brain', 'iac'].join(''),
      ['d3d3', 'adfd'].join(''),
    ]
    // The public plugin marketplace slug (the Suggest install line, README "Install the plugin") is the one
    // place the owner's handle may appear. Scope the exemption to exactly that: every occurrence of the
    // handle must be one of the slug, so a leak that merely happens to contain it still fails.
    const count = (re: RegExp): number => sample.match(re)?.length ?? 0
    const slugHits = count(/NissanOhana\/orangu/g)
    expect(slugHits).toBeGreaterThan(0)
    expect(count(new RegExp(handle, 'gi')), `the handle "${handle}" outside the marketplace slug`).toBe(slugHits)
    const scanned = sample.toLowerCase()
    for (const marker of ['private-user', 'private-project', privatePath, 'private-host', 'real-session-marker', ...knownPrivateMarkers])
      expect(scanned, `leak: ${marker}`).not.toContain(marker.toLowerCase())
    expect(sample).toContain('5a91c73e')
  })
})
