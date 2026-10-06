/**
 * The STE checker (scripts/ste.mjs): one bad and one good sample for each rule, then the orangu
 * additions and carve-outs. The gate that applies it to every surface is test/ste.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { checkBlocks, checkText, frontmatterDescription, htmlToText, proseBlocks, wordCount, wrapCommands } from '../scripts/ste.mjs'

const EM_DASH = String.fromCharCode(0x2014)
const rules = (text: string, options: Parameters<typeof checkText>[1] = {}): string[] => checkText(text, options).findings.map((f) => f.rule)
/** a sentence of exactly `n` words that opens with `first` */
const sentence = (first: string, n: number): string => [first, ...Array.from({ length: n - 1 }, () => 'tokens')].join(' ') + '.'

describe('ste checker: the ported rules', () => {
  it('sentence-length: an instruction has 20 words or fewer', () => {
    expect(rules(sentence('Run', 21))).toEqual(['sentence-length'])
    expect(rules(sentence('Run', 20))).toEqual([])
  })

  it('sentence-length: a description has 25 words or fewer', () => {
    expect(rules(sentence('The', 26))).toEqual(['sentence-length'])
    expect(rules(sentence('The', 25))).toEqual([])
  })

  it('paragraph-length: a paragraph has 6 sentences or fewer', () => {
    expect(rules(Array(7).fill('The gate is red.').join(' '))).toEqual(['paragraph-length'])
    expect(rules(Array(6).fill('The gate is red.').join(' '))).toEqual([])
  })

  it('ste-word: the dictionary word, not the long one', () => {
    expect(rules('Utilize the cache.')).toEqual(['ste-word'])
    expect(rules('Use the cache.')).toEqual([])
  })

  it('plain-word: the house word table', () => {
    expect(rules('Leverage the cache.')).toEqual(['plain-word'])
    expect(rules('Read the cache, for example the first entry.')).toEqual([])
  })

  it('progressive: the simple present, not "is ranking"', () => {
    expect(rules('The agent is ranking the files.')).toEqual(['progressive'])
    expect(rules('The agent ranks the files.')).toEqual([])
  })

  it('progressive: an -ing noun on the list is not a verb', () => {
    expect(rules('The value is missing.')).toEqual([])
  })

  it('perfect: the simple past, not "has merged"', () => {
    expect(rules('The branch has merged.')).toEqual(['perfect'])
    expect(rules('The branch merged.')).toEqual([])
  })

  it('semicolon: two sentences, not one joined by a semicolon', () => {
    expect(rules('The gate is red; do not merge.')).toEqual(['semicolon'])
    expect(rules('The gate is red. Do not merge.')).toEqual([])
  })

  it('em-dash: a comma, a colon or a period, never an em dash or a spaced double hyphen', () => {
    expect(rules(`The gate is red ${EM_DASH} do not merge.`)).toEqual(['em-dash'])
    expect(rules('The gate is red -- do not merge.')).toEqual(['em-dash'])
    expect(rules('The gate is red, so do not merge.')).toEqual([])
  })

  it('scores the percent of sentences with no finding', () => {
    const result = checkText('The gate is red; do not merge. The build passed.')
    expect(result).toMatchObject({ sentences: 2, clean: 1, score: 50 })
  })

  it('reads HTML as text: code, pre, script, style and svg are blank, block tags end a block', () => {
    const html = '<p>Open the report.</p><code>utilize --leverage</code><pre>a; b</pre><script>x; y</script><div>Read the cache.</div>'
    expect(htmlToText(html)).not.toMatch(/utilize|a; b|x; y/)
    expect(checkText(html, { html: true })).toMatchObject({ sentences: 2, clean: 2 })
  })

  it('skips fences, headings, tables and quotes in Markdown', () => {
    const md = ['# A heading; with a semicolon', '', '```', 'code; here', '```', '', '| a; b | c |', '', '> quoted; text', '', 'Read the cache.'].join('\n')
    expect(checkText(md)).toMatchObject({ sentences: 1, clean: 1 })
  })
})

describe('ste checker: orangu additions', () => {
  it('contraction: every n\'t, \'re, \'ve, \'ll, \'m, \'d form is a finding', () => {
    for (const bad of ["Don't merge it.", 'You’re done.', "We've merged it.", "I'll check it.", "I'm done.", "I'd stop here.", "It can't run."]) {
      expect(rules(bad), bad).toContain('contraction')
    }
  })

  it("contraction: it's, that's, there's, what's, here's and let's are findings", () => {
    for (const bad of ["It's red.", "That's the gate.", "There's one finding.", "What's next.", "Here's the list.", "Let's run it."]) {
      expect(rules(bad), bad).toContain('contraction')
    }
  })

  it("contraction: a possessive 's is not a contraction", () => {
    expect(rules("Claude's report is ready.")).toEqual([])
    expect(rules('The agent’s brief is short.')).toEqual([])
    expect(rules('Do not merge it.')).toEqual([])
  })

  it('counts the banned tokens of each surface: em dash, e.g., i.e., etc. and contractions', () => {
    const text = [
      `Read the cache ${EM_DASH} it is warm ${EM_DASH} and stop.`,
      'Pick a tool, e.g. the first one.',
      'Read the file, i.e. the log.',
      'Check the tests, the build, etc.',
      "Don't stop. It's red.",
    ].join(' ')
    expect(checkText(text).banned).toEqual({ emDash: 2, eg: 1, ie: 1, etc: 1, contractions: 2 })
  })

  it('line mode: every line is its own block, for columnar text such as --help', () => {
    const help = ['usage', '  orangu list      list the sessions on this machine', '  orangu serve     open the local viewer for every session'].join('\n')
    expect(checkText(help).sentences).toBe(1)
    expect(checkText(help, { lines: true }).sentences).toBe(3)
    expect(proseBlocks(help, { lines: true }).map((b) => b.line)).toEqual([1, 2, 3])
  })

  it('scores the frontmatter description of a Markdown file as its own block', () => {
    const md = ['---', 'name: demo', 'description: "Read the report; then stop."', 'allowed-tools: Read', '---', '', 'Read the cache.'].join('\n')
    expect(frontmatterDescription(md)).toEqual({ line: 3, text: 'Read the report; then stop.' })
    expect(checkText(md)).toMatchObject({ sentences: 1, clean: 1 })
    expect(checkText(md, { frontmatter: true })).toMatchObject({ sentences: 2, clean: 1 })
  })

  it('checkBlocks scores given blocks and keeps the file of each finding', () => {
    const result = checkBlocks([
      { file: 'src/a.ts', line: 4, text: 'The gate is red; do not merge.' },
      { file: 'src/b.ts', line: 9, text: 'Open the report.' },
    ])
    expect(result).toMatchObject({ sentences: 2, clean: 1, score: 50 })
    expect(result.findings).toEqual([expect.objectContaining({ file: 'src/a.ts', line: 4, rule: 'semicolon' })])
  })
})

describe('ste checker: a command or a flag is one technical name', () => {
  it('wraps an orangu, npx, git or claude command and its arguments as code', () => {
    expect(wrapCommands('Run npx orangu report --open now.')).toBe('Run `npx orangu report --open` now.')
    expect(wrapCommands('Then run orangu suggest --show sg_1a2b, and read it.')).toBe('Then run `orangu suggest --show sg_1a2b`, and read it.')
    expect(wrapCommands('Type /orangu:improve <id> in Claude Code.')).toBe('Type `/orangu:improve <id>` in Claude Code.')
    expect(wrapCommands('Paste claude "/orangu:improve sg_1" in a terminal.')).toBe('Paste `claude "/orangu:improve sg_1"` in a terminal.')
    expect(wrapCommands('Pass --json to print it.')).toBe('Pass `--json` to print it.')
  })

  it('leaves the product noun alone when no verb follows it', () => {
    expect(wrapCommands('orangu reads the transcript on disk.')).toBe('orangu reads the transcript on disk.')
    expect(wrapCommands('Claude Code writes the session.')).toBe('Claude Code writes the session.')
  })

  it('never wraps text that is already code', () => {
    expect(wrapCommands('Run `orangu report` first.')).toBe('Run `orangu report` first.')
  })

  it('counts a command as one word', () => {
    expect(wordCount('Run npx orangu report --open --no-cache now')).toBe(3)
    expect(wordCount('orangu reads the transcript')).toBe(4)
  })

  it('the "--" inside a git command is not an em dash', () => {
    expect(rules('Use git checkout -- <ref> to restore the file.')).toEqual([])
    // measured false positive, src/analyze/insights.ts (the reverts recommendation): "checkout -- from a named branch ref"
    expect(rules('It skips checkout -- from a named branch ref.')).toEqual([])
    expect(rules('The gate is red -- do not merge.')).toEqual(['em-dash'])
  })

  it('a word from the table inside a code span or a command is not a finding', () => {
    expect(rules('Run `utilize --leverage` now.')).toEqual([])
    expect(rules('Run orangu report --leverage now.')).toEqual([])
  })
})
