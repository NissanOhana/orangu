import { describe, expect, it } from 'vitest'
import { longestImprovements, ruleImprovements } from './fixtures/rule-improvements.js'

// The show-me browser spec renders a deck from the longest shipped improvement texts. The reader must see every
// rule site, the texts behind a conditional and behind a local constant too.
describe('the improvement texts of the rule sites', () => {
  it('reads every improvement text, the ones behind a conditional and a local constant included', () => {
    const texts = ruleImprovements()
    // rule-copy.test.ts counts 47 texts by site; 2 sites share 1 text, so 46 are distinct
    expect(texts.length).toBeGreaterThanOrEqual(46)
    // a local constant of 2 texts (time-budget) and a conditional of 2 texts (hidden-iterations)
    expect(texts).toContain('Fix the slowest tools first: add timeouts, cache their work, or narrow their scope. Run long commands in the background.')
    expect(texts).toContain('Start a new session to use the model that you chose again.')
    expect(texts).toContain('No change needed. If fallbacks recur, check the model column in the timeline.')
  })

  it('gives the longest texts first', () => {
    const longest = longestImprovements(5)
    expect(longest).toHaveLength(5)
    const lengths = longest.map((text) => text.length)
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a))
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(Math.max(...ruleImprovements().filter((t) => !longest.includes(t)).map((t) => t.length)))
  })
})
