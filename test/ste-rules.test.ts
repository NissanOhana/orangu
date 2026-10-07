/**
 * The STE checker (src/ste): one bad and one good sample for each rule, then the orangu
 * additions and carve-outs. Then the extraction of copy from TS sources (scripts/ste-surfaces.ts).
 * The gate that applies both to every surface is test/ste.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { checkBlocks, checkText, frontmatterDescription, htmlToText, proseBlocks, wordCount, wrapCommands } from '../src/ste/index.js'
import { fragmentResult, htmlResult, tsBlocks, type TsOptions } from '../scripts/ste-surfaces.js'

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
    // "incl." is the abbreviation the session narrative used ("26 turns incl. commands"): write "including"
    expect(rules('It made 26 turns incl. commands.')).toEqual(['plain-word'])
    expect(rules('It made 26 turns, including commands.')).toEqual([])
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

  it('skips fences and quotes, and scores neither a heading nor a table label in Markdown', () => {
    const md = ['# A heading; with a semicolon', '', '```', 'code; here', '```', '', '| a; b | c |', '', '> quoted; text', '', 'Read the cache.'].join('\n')
    expect(checkText(md)).toMatchObject({ sentences: 1, clean: 1 })
  })
})

describe('ste checker: table cells and headings (columnar text is scored line by line)', () => {
  it('scores each table cell of 3 or more words as its own block, and drops a cell that is only code', () => {
    // measured miss: plugin/skills/analyze/references/reading-the-report.md:25 has "can't" in a table cell
    const md = ['| Rule | What it means here |', '|---|:---:|', "| `tool-errors` | agents can't see parent context; read it again |", '| `x` | `only code` |'].join('\n')
    const result = checkText(md)
    expect(result).toMatchObject({ sentences: 2, clean: 1 })
    expect(result.findings.map((f) => f.rule).sort()).toEqual(['contraction', 'semicolon'])
    expect(result.findings[0]).toMatchObject({ line: 3 })
  })

  it('counts the banned tokens of a heading or a short cell, without scoring it', () => {
    const md = ["# Don't skip e.g. this", '', '| Ok | Can\'t |', '|---|---|', '', 'Read the cache.'].join('\n')
    expect(checkText(md)).toMatchObject({ sentences: 1, clean: 1, banned: { emDash: 0, eg: 1, ie: 0, etc: 0, contractions: 2 } })
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

  it("contraction: who's, where's, how's, he's and she's are findings", () => {
    for (const bad of ["Who's next.", "Where's the log.", "How's the run.", "He's done.", "She's done."]) {
      expect(rules(bad), bad).toContain('contraction')
    }
  })

  it('reads a folded or literal frontmatter description', () => {
    const folded = ['---', 'name: demo', 'description: >', '  Read the report;', '  then stop.', 'allowed-tools: Read', '---'].join('\n')
    expect(frontmatterDescription(folded)).toEqual({ line: 3, text: 'Read the report; then stop.' })
    const literal = ['---', 'description: |-', '  Read the report.', '  Then stop.', '---'].join('\n')
    expect(frontmatterDescription(literal)).toEqual({ line: 2, text: 'Read the report.\nThen stop.' })
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

  it('wraps the ste and show-me verbs as a command too', () => {
    expect(wrapCommands('Run orangu ste draft.md --json first.')).toBe('Run `orangu ste draft.md --json` first.')
    expect(wrapCommands('Then run npx orangu show-me --render <dir> once.')).toBe('Then run `npx orangu show-me --render <dir>` once.')
    expect(wordCount('Run orangu ste - now')).toBe(3)
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

  it('a " -- " used as a dash after a command is still a dash', () => {
    expect(rules('Run orangu report -- it opens the file in a browser.')).toEqual(['em-dash'])
    expect(rules('Run npx orangu -- it needs no install.')).toEqual(['em-dash'])
    expect(checkText('Then apply -- after you approve it -- the change.').banned.emDash).toBe(2)
    expect(rules('Run git restore -- src/a.ts to undo it.')).toEqual([])
  })

  it('a word from the table inside a code span or a command is not a finding', () => {
    expect(rules('Run `utilize --leverage` now.')).toEqual([])
    expect(rules('Run orangu report --leverage now.')).toEqual([])
  })
})

describe('ste surfaces: copy in TS string and template literals', () => {
  const texts = (source: string, options: TsOptions = {}): string[] => tsBlocks(source, 'x.ts', options).map((b) => b.text)

  it('takes string and template literals, with 3 in place of each ${}', () => {
    const source = ["const a = 'Open the report in a browser.'", 'const b = `${n} files were read twice`'].join('\n')
    expect(texts(source)).toEqual(['Open the report in a browser.', '3 files were read twice'])
  })

  it('skips module specifiers, property keys, element-access keys and case labels', () => {
    const source = [
      "import { x } from './a module path with words.js'",
      "export * from './another module path here.js'",
      "const o = { 'a key with four words': 'The value is copy.' }",
      "const v = o['an access key here']",
      "switch (k) { case 'a case label here': break }",
    ].join('\n')
    expect(texts(source)).toEqual(['The value is copy.'])
  })

  it('skips comparison operands and literal types', () => {
    const source = [
      "if (mode === 'a compared value here') f('Stop the run now.')",
      "if ('a key we test' in o) g()",
      "type T = 'a literal type here' | 'another literal type here'",
    ].join('\n')
    expect(texts(source)).toEqual(['Stop the run now.'])
  })

  it('skips selectors, attribute names, event names, class names and RegExp sources', () => {
    const source = [
      "el.querySelector('.a .b .c')",
      "el.closest('div p span')",
      "el.setAttribute('aria-label', 'Copy the command text.')",
      "el.addEventListener('some event name here', f)",
      "el.classList.add('one two three', 'four five six')",
      "const re = new RegExp('a b c d')",
    ].join('\n')
    expect(texts(source)).toEqual(['Copy the command text.'])
  })

  it('skips String.raw templates', () => {
    expect(texts('const s = String.raw`a raw template; with a semicolon`')).toEqual([])
  })

  it('lifts title, aria-label and placeholder values, then reads the markup as text', () => {
    const source = 'const h = `<button title="Copy the improve command">Copy it now</button><code>leverage it; now</code><p>Read the cache first.</p>`'
    expect(texts(source)).toEqual(['Copy the improve command', 'Copy it now', 'Read the cache first.'])
  })

  it('makes each line of a multi-line literal its own block, at its source line', () => {
    const source = ['', 'const help = `usage', '  orangu list    list the sessions here', '  orangu serve   open the local viewer`'].join('\n')
    expect(tsBlocks(source, 'src/cli/x.ts')).toEqual([
      { file: 'src/cli/x.ts', line: 2, text: 'usage' },
      { file: 'src/cli/x.ts', line: 3, text: 'orangu list list the sessions here' },
      { file: 'src/cli/x.ts', line: 4, text: 'orangu serve open the local viewer' },
    ])
  })

  it('measures only the named functions and skips the arguments of the named calls', () => {
    const source = [
      "function publish() { return 'The page copy is here.' }",
      "function story() { return 'Synthetic transcript text here.' }",
      "function main() { process.stdout.write('built the sample page now'); throw new Error('the sample build failed here') }",
    ].join('\n')
    expect(texts(source, { within: ['publish', 'main'], skipCalls: ['process.stdout.write', 'Error'] })).toEqual(['The page copy is here.'])
  })

  // measured false positives: src/report/client/mascot.ts (an attribute string outside its tag) and
  // src/report/render.ts (the Content-Security-Policy value)
  it('skips attribute strings outside a tag and the Content-Security-Policy value', () => {
    const source = [
      'const a = `width="${n}" height="${n}" style="display:block"`',
      "const csp = \"default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'\"",
      "const b = 'Read the cache first.'",
    ].join('\n')
    expect(texts(source)).toEqual(['Read the cache first.'])
  })

  it('a placeholder or a number is not a word: a fragment needs 3 words with letters', () => {
    const result = fragmentResult([
      { line: 1, text: '3 · 3 sessions; 3' },
      { line: 2, text: 'M 3 3; L 3 3' },
      { line: 3, text: '3 files were read twice; 3' },
    ])
    expect(result).toMatchObject({ sentences: 1, clean: 0 })
  })

  it('counts the banned tokens of a label, though it scores no label', () => {
    // a chip or a button is a label (carve-out 6), but the em dash, e.g., i.e., etc. and contractions are banned everywhere
    const result = fragmentResult([
      { line: 1, text: "Don't show" },
      { line: 2, text: "Can't load" },
      { line: 3, text: 'e.g. 3' },
      { line: 4, text: 'Tokens -- total' },
    ])
    expect(result).toMatchObject({ sentences: 0, banned: { emDash: 1, eg: 1, ie: 0, etc: 0, contractions: 2 } })
  })

  it('reads a literal as markup only when it holds a tag', () => {
    // measured: src/analyze/insights.ts:1582 ("< 200 ... >=") lost two semicolons to the tag stripper
    expect(texts("const s = 'a preview < 200 chars; a share >= 60%'")).toEqual(['a preview < 200 chars; a share >= 60%'])
    expect(texts("const s = '<p>Read the cache.</p>'")).toEqual(['Read the cache.'])
  })

  it('measures only the named top-level constants when asked', () => {
    const source = ["const A = 'Copy the text now.'", "const B = 'Other text is here.'"].join('\n')
    expect(texts(source, { consts: ['A'] })).toEqual(['Copy the text now.'])
  })

  it('drops a label under 3 words and scores each distinct block once per surface', () => {
    const result = fragmentResult([
      { file: 'a.ts', line: 1, text: 'Copy it' },
      { file: 'a.ts', line: 2, text: 'Run orangu report --open' },
      { file: 'a.ts', line: 3, text: 'Open the report; then stop.' },
      { file: 'b.ts', line: 9, text: 'Open the report; then stop.' },
    ])
    expect(result).toMatchObject({ sentences: 1, clean: 0 })
    expect(result.findings).toEqual([expect.objectContaining({ file: 'a.ts', line: 3, rule: 'semicolon' })])
  })
})

describe('ste surfaces: rule copy', () => {
  const texts = (options: TsOptions): string[] => tsBlocks(RULE, 'src/analyze/insights.ts', options).map((b) => b.text)
  const RULE = [
    'const rule = (ctx) => {',
    "  const change = ok ? 'Run the tests before the commit.' : 'Split the session in two.'",
    '  return [mk({',
    "    ruleId: 'some-rule-id',",
    '    title: `${n} tool errors in this session`,',
    "    detail: 'the agent stopped mid-turn',",
    '    improvement: change,',
    "    why: 'A failed commit costs one more turn.',",
    "    method: 'The rule counts only shell calls.',",
    "    evidence: { note: 'An evidence string here.' },",
    '  })]',
    '}',
  ].join('\n')

  it('takes each field from its property value, and follows a local constant', () => {
    expect(texts({ ruleCopy: 'title' })).toEqual(['3 tool errors in this session'])
    expect(texts({ ruleCopy: 'detail' })).toEqual(['the agent stopped mid-turn'])
    expect(texts({ ruleCopy: 'improvement' })).toEqual(['Run the tests before the commit.', 'Split the session in two.'])
    expect(texts({ ruleCopy: 'why' })).toEqual(['A failed commit costs one more turn.'])
    expect(texts({ ruleCopy: 'method' })).toEqual(['The rule counts only shell calls.'])
  })

  it('leaves every other string to the analyzer surface, so no string is measured twice', () => {
    expect(texts({ ruleCopy: 'exclude' })).toEqual(['some-rule-id', 'An evidence string here.'])
  })
})

describe('ste surfaces: HTML pages', () => {
  it('measures the meta copy, title, aria-label, alt and placeholder values, inline scripts and JSON-LD descriptions', () => {
    const html = [
      '<meta name="description" content="Don&#39;t miss it; it is short."/>',
      '<meta property="og:title" content="orangu: a report for every session"/>',
      '<meta property="og:url" content="https://example.com/orangu/"/>',
      '<p>Read the cache.</p>',
      '<button aria-label="Copy the install command; then paste it">Copy</button>',
      '<img alt="The orangu mascot waves; it is happy"/>',
      "<script>el.textContent = 'Motion is paused; press play'</script>",
      '<script type="application/ld+json">{"name":"orangu","description":"An offline report; no network."}</script>',
    ].join('\n')
    const result = htmlResult(html, 'site/x.html')
    expect(result.banned.contractions).toBe(1)
    expect(result.findings.filter((f) => f.rule === 'semicolon').map((f) => f.line).sort((a, b) => a - b)).toEqual([1, 5, 6, 7, 8])
    expect(result.findings.every((f) => f.file === 'site/x.html')).toBe(true)
  })
})
