#!/usr/bin/env node
/**
 * Simplified Technical English checker (ASD-STE100 subset).
 *
 * It scores text against a subset of the ASD-STE100 writing rules: sentence length (20 words for an
 * instruction, 25 for a description), paragraph length, the simple tenses, no semicolon, no em dash,
 * and a short word table. The score is the percent of sentences with no finding. It is a heuristic:
 * it cannot see the passive, a long noun cluster or a telegram, and it can flag an -ing noun.
 *
 * Node built-ins only. orangu ships no runtime dependency, and this file ships nowhere.
 *
 *   node scripts/ste.mjs <file...|-> [--json] [--lines]
 *
 * orangu adds four things to the rule set it ports:
 * - a contraction rule. A possessive 's ("Claude's") is not a contraction.
 * - line mode (--lines): every line is its own block, for columnar text such as --help.
 * - a command or a flag is one technical name. `npx orangu report --open` counts as one word, and the
 *   "--" in `git checkout -- <ref>` is not an em dash.
 * - a count of the banned tokens (em dash, e.g., i.e., etc., contractions), one finding per token.
 * Markdown files also score their frontmatter description as one block.
 */
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const LIMITS = { procedural: 20, descriptive: 25, paragraphSentences: 6 }

const USAGE = 'Usage: node scripts/ste.mjs <file.md|file.html|file.txt|-> [more files] [--json] [--lines]'

export const STE_WORDS = {
  commence: 'start',
  commencing: 'starting',
  ensure: 'make sure',
  ensures: 'makes sure',
  'prior to': 'before',
  replenish: 'fill',
  utilize: 'use',
  utilizes: 'uses',
  utilise: 'use',
  utilized: 'used',
  utilizing: 'using',
  ensured: 'made sure',
  ensuring: 'making sure',
  approximately: 'about',
  'in order to': 'to',
}

export const PLAIN_WORDS = {
  leverage: 'use',
  leverages: 'uses',
  leveraging: 'using',
  leveraged: 'used',
  facilitate: 'help',
  facilitates: 'helps',
  additional: 'more',
  numerous: 'many',
  sufficient: 'enough',
  assist: 'help',
  obtain: 'get',
  terminate: 'stop',
  initiate: 'start',
  initiated: 'started',
  subsequently: 'then',
  'in the event that': 'if',
  'due to the fact that': 'because',
  'is able to': 'can',
  'are able to': 'can',
  'a number of': 'some, or the count',
  'at this point in time': 'now',
  'e.g.': 'for example',
  'i.e.': 'that is',
  'etc.': 'the full list',
  via: 'through, or with',
  whilst: 'while',
  seamless: 'nothing, or the measured fact',
  seamlessly: 'nothing',
  robust: 'the measured fact',
  powerful: 'the measured fact',
  'cutting-edge': 'nothing',
  simply: 'nothing',
  just: 'nothing',
  easily: 'nothing',
  basically: 'nothing',
  essentially: 'nothing',
  actually: 'nothing',
  very: 'nothing, or a number',
  really: 'nothing',
}

const IMPERATIVES = new Set(
  "add ask call check click copy create delete do don't draw enter find fix give keep list load make mark merge move name never open pick publish push put read record remove render run save select send set show start stop test type update use wait write".split(' '),
)
// Extend only for a measured false positive, and name the case in a comment.
export const ING_NOUNS = new Set(['thing', 'nothing', 'something', 'anything', 'everything', 'during', 'morning', 'evening', 'string', 'ring', 'king', 'bring', 'spring', 'wing', 'ceiling', 'building', 'meaning', 'setting', 'warning', 'booking', 'pending', 'missing', 'funding', 'onboarding', 'bookkeeping', 'billing', 'pricing', 'routing', 'logging', 'testing', 'scheduling', 'matching'])
export const PROGRESSIVE = /\b(am|is|are|was|were|be|been)\s+(?:not\s+|still\s+|now\s+)?([a-z]+ing)\b/gi
export const PERFECT = /\b(has|have|had)\s+(?:not\s+|already\s+|never\s+|just\s+|now\s+)?(been|[a-z]+ed|done|gone|seen|made|written|run|taken|given|found|built|sent|shown|known|got|gotten|begun|broken|chosen|left|kept|held|put|set|read)\b/gi
/** n't, 're, 've, 'll, 'm and 'd, plus the six 's forms that always mean "is" or "us", never a possessive */
export const CONTRACTION = /\b[A-Za-z]+n['’]t\b|\b[A-Za-z]+['’](?:re|ve|ll|m|d)\b|\b(?:it|that|there|what|here|let)['’]s\b/gi
const EM_DASH = /—|\s--\s/g
const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|approx|fig)\./gi
const SENTENCE_END = /(?<=[.!?][*_)"'”’]*)\s+(?=[A-Z0-9"“(`*[_])/g
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/

/** The verbs that make `orangu <verb>` a command. "orangu reads the file" is the product noun, not a command. */
const ORANGU_VERBS = new Set('report analyze list pick repo global watch serve feedback evidence estimate harness suggest help'.split(' '))
const GIT_VERBS = new Set('add apply blame branch checkout cherry-pick clone commit config diff fetch grep init log merge mv pull push rebase reset restore revert rm show stash status switch tag worktree'.split(' '))
const FLAG = /^--?[A-Za-z][\w-]*(?:=\S*)?$|^--$/
const PATHISH = /^[\w./~:@=+*-]*[/.~_:=@*\d][\w./~:@=+*-]*$/
const OPEN_QUOTE = /["“'‘]/
const CLOSE_QUOTE = /["”'’]/

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const WORD_RULES = [
  ...Object.entries(STE_WORDS).map(([word, use]) => ({ word, use, source: 'ste' })),
  ...Object.entries(PLAIN_WORDS).map(([word, use]) => ({ word, use, source: 'plain' })),
].map((entry) => ({ ...entry, pattern: new RegExp(`(?<![\\w-])${escapeRegExp(entry.word)}(?![\\w-])`, 'gi') }))

export function htmlToText(html) {
  const blank = (match) => match.replace(/[^\n]/g, '')
  return html
    .replace(/<(script|style|svg|pre|code)\b[\s\S]*?<\/\1>/gi, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<\/?(p|li|h[1-6]|div|section|article|td|th|tr|br|ul|ol|header|footer|figcaption|blockquote)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
}

/** Prose blocks of Markdown or text. With `lines`, every line closes its block (columnar text). */
export function proseBlocks(text, { lines: lineMode = false } = {}) {
  const lines = text.split('\n')
  const blocks = []
  let current = null
  let fence = null
  let start = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (end > 0) start = end + 1
  }
  const close = () => {
    if (current) blocks.push(current)
    current = null
  }
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker || fence) {
      close()
      if (marker && !fence) fence = marker[0]
      else if (marker && marker[0] === fence) fence = null
      continue
    }
    if (/^\s*$/.test(line) || /^\s*#{1,6}\s/.test(line) || /^\s*\|/.test(line) || /^\s*>/.test(line)) {
      close()
      continue
    }
    const pieces = line.split(' ')
    pieces.forEach((piece, pieceIndex) => {
      if (pieceIndex > 0) close()
      if (LIST_ITEM.test(piece)) close()
      const clean = piece.replace(LIST_ITEM, '')
      if (!clean.trim()) return
      if (!current) current = { line: index + 1, text: clean }
      else current.text += `${pieceIndex > 0 ? '' : '\n'}${clean}`
    })
    if (lineMode) close()
  }
  close()
  return blocks
}

/** The frontmatter `description:` of a Markdown file, as one block (the line is 1-based). */
export function frontmatterDescription(text) {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return null
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  for (let index = 1; index < end; index += 1) {
    const match = /^description:\s*(.*)$/.exec(lines[index])
    if (!match) continue
    let value = match[1].trim()
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value)
      } catch {
        value = value.slice(1, -1)
      }
    } else if (value.startsWith("'")) value = value.slice(1, -1).replace(/''/g, "'")
    return value ? { line: index + 1, text: value } : null
  }
  return null
}

function tokenize(segment) {
  return [...segment.matchAll(/\S+/g)].map((match) => {
    const raw = match[0]
    const lead = /^[(“‘"']*/.exec(raw)[0]
    const rest = raw.slice(lead.length)
    const trail = /[.,;:!?)"”’']*$/.exec(rest)[0]
    const core = rest.slice(0, rest.length - trail.length)
    const coreStart = match.index + lead.length
    return { lead, core, trail, coreStart, coreEnd: coreStart + core.length }
  })
}

const isArg = (core) => FLAG.test(core) || /^[<[]/.test(core) || PATHISH.test(core) || core === '...' || core === '…'

/** How many tokens from `i` name a command, or 0 when no command starts there. */
function commandHead(tokens, i) {
  // the core of token k, when no punctuation breaks the run from i to k
  const at = (k) => {
    for (let j = i; j < k; j += 1) if (tokens[j].trail) return undefined
    const token = tokens[k]
    return token && !token.lead ? token.core : undefined
  }
  const word = tokens[i].core
  if (word === 'npx' && at(i + 1)) return at(i + 1) === 'orangu' && ORANGU_VERBS.has(at(i + 2)) ? 3 : 2
  if (word === 'orangu' && ORANGU_VERBS.has(at(i + 1))) return 2
  if (word === 'orangu' && FLAG.test(at(i + 1) ?? '')) return 1
  if (word === 'git' && GIT_VERBS.has(at(i + 1))) return 2
  // a bare git verb before "--", as in "checkout -- <path>" inside a sentence about git
  if (GIT_VERBS.has(word) && at(i + 1) === '--') return 1
  if (word === 'claude' && !tokens[i].trail && tokens[i + 1]) {
    if (/^["“]/.test(tokens[i + 1].lead)) return 1
    if (FLAG.test(at(i + 1) ?? '')) return 1
    if (at(i + 1) === 'plugin' || at(i + 1) === 'mcp') return 2
  }
  if (word.startsWith('/orangu:')) return 1
  // a lone flag; a bare "--" outside a command is the dash it looks like
  if (/^--[A-Za-z]/.test(word) && FLAG.test(word)) return 1
  return 0
}

function wrapSegment(segment) {
  const tokens = tokenize(segment)
  const spans = []
  for (let i = 0; i < tokens.length; ) {
    const head = commandHead(tokens, i)
    if (!head) {
      i += 1
      continue
    }
    let last = i + head - 1
    let end = tokens[last].coreEnd
    for (let j = last + 1; j < tokens.length && !tokens[j - 1].trail; ) {
      const token = tokens[j]
      if (OPEN_QUOTE.test(token.lead) && !token.lead.includes('(')) {
        // a quoted argument runs to the token that closes the quote
        let k = j
        while (k < tokens.length && k - j <= 12 && !CLOSE_QUOTE.test(tokens[k].trail)) k += 1
        if (k === tokens.length || k - j > 12) break
        const close = tokens[k].trail.search(CLOSE_QUOTE)
        last = k
        end = tokens[k].coreEnd + close + 1
        if (tokens[k].trail.length > close + 1) break
        j = k + 1
        continue
      }
      if (token.lead || !isArg(token.core)) break
      last = j
      end = token.coreEnd
      j += 1
    }
    spans.push([tokens[i].coreStart, end])
    i = last + 1
  }
  let out = ''
  let cursor = 0
  for (const [from, to] of spans) {
    out += `${segment.slice(cursor, from)}\`${segment.slice(from, to)}\``
    cursor = to
  }
  return out + segment.slice(cursor)
}

/** Wrap each command and each flag outside a code span in backticks, so that it reads as one technical name. */
export function wrapCommands(text) {
  return text
    .split(/(`[^`]*`)/)
    .map((part, index) => (index % 2 ? part : wrapSegment(part)))
    .join('')
}

function plainSentence(sentence) {
  return wrapCommands(sentence)
    .replace(/`[^`]*`/g, 'CODE')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'URL')
    .replace(/[*_]{1,3}/g, '')
}

export function splitSentences(text) {
  const guarded = text.replace(ABBREVIATIONS, (match) => match.replace(/\./g, '\u0000'))
  const sentences = []
  let cursor = 0
  for (const match of guarded.matchAll(SENTENCE_END)) {
    sentences.push({ offset: cursor, text: guarded.slice(cursor, match.index) })
    cursor = match.index + match[0].length
  }
  sentences.push({ offset: cursor, text: guarded.slice(cursor) })
  return sentences
    .map((sentence) => ({ ...sentence, text: sentence.text.replace(/\u0000/g, '.').trim() }))
    .filter((sentence) => /[A-Za-z]/.test(sentence.text))
}

export function wordCount(sentence) {
  return plainSentence(sentence).split(/\s+/).filter((token) => /[A-Za-z0-9]/.test(token)).length
}

function excerpt(text) {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > 90 ? `${flat.slice(0, 87)}...` : flat
}

function sentenceFindings(sentence, line) {
  const plain = plainSentence(sentence)
  const findings = []
  const words = wordCount(sentence)
  const first = plain.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z']/g, '') ?? ''
  const limit = IMPERATIVES.has(first) ? LIMITS.procedural : LIMITS.descriptive
  if (words > limit) findings.push({ line, rule: 'sentence-length', text: excerpt(sentence), hint: `${words} words; split it (limit ${limit})` })
  for (const rule of WORD_RULES) {
    for (const match of plain.matchAll(rule.pattern)) {
      findings.push({ line, rule: rule.source === 'ste' ? 'ste-word' : 'plain-word', text: match[0], hint: `write "${rule.use}"` })
    }
  }
  for (const match of plain.matchAll(PROGRESSIVE)) {
    if (ING_NOUNS.has(match[2].toLowerCase())) continue
    findings.push({ line, rule: 'progressive', text: match[0], hint: 'use the simple present or past' })
  }
  for (const match of plain.matchAll(PERFECT)) {
    findings.push({ line, rule: 'perfect', text: match[0], hint: 'use the simple past' })
  }
  if (/;\s/.test(plain)) findings.push({ line, rule: 'semicolon', text: excerpt(sentence), hint: 'split it into two sentences' })
  // one finding per em dash, so the count of em-dash findings is the count of em dashes
  for (const _ of plain.matchAll(EM_DASH)) {
    findings.push({ line, rule: 'em-dash', text: excerpt(sentence), hint: 'use a comma, colon, period or parentheses' })
  }
  for (const match of plain.matchAll(CONTRACTION)) {
    findings.push({ line, rule: 'contraction', text: match[0], hint: 'write the two words ("do not", "it is")' })
  }
  return findings
}

/** The banned tokens a surface carries: the em dash, e.g., i.e., etc. and contractions. */
export function bannedCounts(findings) {
  const banned = { emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }
  for (const finding of findings) {
    if (finding.rule === 'em-dash') banned.emDash += 1
    else if (finding.rule === 'contraction') banned.contractions += 1
    else if (finding.rule === 'plain-word') {
      const word = finding.text.toLowerCase()
      if (word === 'e.g.') banned.eg += 1
      else if (word === 'i.e.') banned.ie += 1
      else if (word === 'etc.') banned.etc += 1
    }
  }
  return banned
}

/** Score blocks of prose ({ line, text, file? }). Each finding keeps the file of its block. */
export function checkBlocks(blocks) {
  const findings = []
  let sentences = 0
  let clean = 0
  for (const block of blocks) {
    const where = block.file === undefined ? {} : { file: block.file }
    const parts = splitSentences(block.text)
    if (parts.length > LIMITS.paragraphSentences) {
      findings.push({ ...where, line: block.line, rule: 'paragraph-length', text: excerpt(parts[0].text), hint: `${parts.length} sentences; keep one topic in at most ${LIMITS.paragraphSentences}` })
    }
    for (const part of parts) {
      const line = block.line + (block.text.slice(0, part.offset).match(/\n/g)?.length ?? 0)
      const own = sentenceFindings(part.text, line).map((finding) => ({ ...where, ...finding }))
      sentences += 1
      if (own.length === 0) clean += 1
      findings.push(...own)
    }
  }
  const score = sentences === 0 ? 100 : Math.round((clean / sentences) * 100)
  return { sentences, clean, score, findings, banned: bannedCounts(findings) }
}

export function checkText(text, { html = false, lines = false, frontmatter = false } = {}) {
  const source = html ? htmlToText(text) : text
  const blocks = proseBlocks(source, { lines })
  const description = frontmatter ? frontmatterDescription(source) : null
  return checkBlocks(description ? [description, ...blocks] : blocks)
}

function parseArgs(argv) {
  const args = { files: [], json: false, lines: false }
  for (const arg of argv) {
    if (arg === '--json') args.json = true
    else if (arg === '--lines') args.lines = true
    else if (arg.startsWith('--')) throw new Error(`${USAGE}\nUnknown flag: ${arg}`)
    else args.files.push(arg)
  }
  if (args.files.length === 0) throw new Error(USAGE)
  return args
}

function report(name, result) {
  const lines = result.findings.map((finding) => `${name}:${finding.line}  ${finding.rule}  "${finding.text}"  ${finding.hint}`)
  lines.push(`${name}: ${result.sentences} sentences, ${result.clean} clean, STE score ${result.score}%, ${result.findings.length} findings`)
  return lines
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const results = args.files.map((file) => {
    const text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(path.resolve(file), 'utf8')
    return { file, ...checkText(text, { html: /\.html?$/i.test(file), lines: args.lines, frontmatter: /\.md$/i.test(file) }) }
  })
  const output = args.json ? [JSON.stringify(results, null, 2)] : results.flatMap((result) => report(result.file, result))
  process.stdout.write(`${output.join('\n')}\n`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
