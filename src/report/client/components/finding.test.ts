/**
 * The shared finding card. The closed summary names the change. The reason and the method wait one click
 * away, behind one Why disclosure that is first in the card body and closed by default. The disclosure has
 * an id, so the app's re-render seam (details[id]) keeps it open, and dom.ts stamps aria-expanded on it.
 */
import { describe, expect, it } from 'vitest'
import type { Insight } from '../../../model/analysis.js'
import { findingHtml, whyHtml } from './finding.js'

const WHY = 'Each re-read sends the whole file to the model again.'
const METHOD = 'The rule skips reads inside subagents, which cannot see the parent context.'

function insight(over: Partial<Insight> = {}): Insight {
  return {
    id: 'reread-files-1',
    ruleId: 'reread-files',
    severity: 'medium',
    axis: 'tokens',
    title: 'Read the same file 6 times',
    detail: '',
    recommendation: `Read each file once. ${WHY} ${METHOD}`,
    improvement: 'Read each file once.',
    why: WHY,
    method: METHOD,
    evidence: {},
    turnIndexes: [],
    personas: ['developer'],
    ...over,
  }
}

/** Everything inside the card's own <summary>: what a reader sees while the card is closed. */
function summaryOf(card: string): string {
  return card.slice(card.indexOf('<summary>'), card.indexOf('</summary>'))
}

/** The card body, from its first child on. */
function bodyOf(card: string): string {
  const open = '<div class="fbody">'
  return card.slice(card.indexOf(open) + open.length).trimStart()
}

/** The opening tag of the Why disclosure, or '' when the card has none. */
function whyTag(card: string): string {
  return /<details class="why"[^>]*>/.exec(card)?.[0] ?? ''
}

describe('findingHtml: the improvement leads, the reason waits behind Why', () => {
  it('leads the closed summary with the improvement, never the whole rule text', () => {
    const summary = summaryOf(findingHtml(insight(), 'dev'))
    expect(summary).toContain('<span class="rec sg-lead"><b>Improvement:</b> Read each file once.</span>')
    expect(summary).not.toContain(WHY)
    expect(summary).not.toContain(METHOD)
  })

  it('leads with the recommendation for an insight written before the rule text had parts', () => {
    const old = insight({ improvement: undefined, why: undefined, method: undefined, recommendation: 'Cache it.' }) as Insight
    expect(summaryOf(findingHtml(old, 'dev'))).toContain('<b>Improvement:</b> Cache it.</span>')
  })

  it('puts one Why disclosure first in the card body, closed, with the reason and then the method in the muted style', () => {
    const card = findingHtml(insight(), 'dev', { id: 'sg_0123456789ab' })
    const body = bodyOf(card)
    expect(body.startsWith('<details class="why" id="why-sg_0123456789ab">')).toBe(true)
    expect(card.split('<details class="why"').length - 1).toBe(1)
    expect(whyTag(card)).not.toMatch(/\bopen\b/)
    expect(body).toContain('<summary><span class="chev" aria-hidden="true">▸</span>Why</summary>')
    expect(body).toContain(`<p>${WHY}</p>`)
    expect(body).toContain(`<p class="muted">${METHOD}</p>`)
    expect(body.indexOf(WHY)).toBeLessThan(body.indexOf(METHOD))
  })

  it('keeps the Why disclosure closed inside the top card, which renders open', () => {
    const card = findingHtml(insight(), 'dev', { open: true, id: 'sg_0123456789ab' })
    expect(card.startsWith('<details class="finding top" open>')).toBe(true)
    expect(whyTag(card)).toBe('<details class="why" id="why-sg_0123456789ab">')
  })

  it('gives two cards on one screen two different disclosure ids, and keys a card with no sg_ id by its insight id', () => {
    const first = whyTag(findingHtml(insight(), 'dev', { id: 'sg_0000000000a1' }))
    const second = whyTag(findingHtml(insight({ id: 'reread-files-2' }), 'dev', { id: 'sg_0000000000a2' }))
    expect(first).not.toBe(second)
    expect(whyTag(findingHtml(insight(), 'dev'))).toBe('<details class="why" id="why-reread-files-1">')
  })

  it('words the reason and the method for the Plain audience', () => {
    const card = findingHtml(insight({ why: 'The context window fills.', method: 'A compaction counts once.' }), 'plain')
    expect(card).toContain('<p>The working memory fills.</p>')
    expect(card).toContain('<p class="muted">A memory refresh counts once.</p>')
  })

  it('draws no disclosure for a finding that has no reason and no method', () => {
    const card = findingHtml(insight({ why: undefined, method: undefined }), 'dev')
    expect(card).not.toContain('class="why"')
    expect(card).not.toContain('>Why</summary>')
  })
})

describe('whyHtml', () => {
  it('shows a reason with no method, and a method with no reason', () => {
    expect(whyHtml('k', WHY, undefined, 'dev')).toBe(`<details class="why" id="why-k"><summary><span class="chev" aria-hidden="true">▸</span>Why</summary><p>${WHY}</p></details>`)
    expect(whyHtml('k', undefined, METHOD, 'dev')).toContain(`<p class="muted">${METHOD}</p>`)
    expect(whyHtml('k', '', '', 'dev')).toBe('')
  })

  it('escapes the key and the text', () => {
    const html = whyHtml('a"b', '<b>x</b>', '<i>y</i>', 'dev')
    expect(html).toContain('id="why-a&quot;b"')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<i>y</i>')
  })
})
