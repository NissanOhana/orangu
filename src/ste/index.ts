/**
 * Simplified Technical English checker (ASD-STE100 subset).
 *
 * It scores text against a subset of the ASD-STE100 writing rules: sentence length (20 words for an
 * instruction, 25 for a description), paragraph length, the simple tenses, no semicolon, no em dash,
 * and a short word table. The score is the percent of sentences with no finding. It is a heuristic:
 * it cannot see the passive, a long noun cluster or a telegram, and it can flag an -ing noun.
 *
 * Node built-ins only: orangu ships no runtime dependency. `orangu ste` (src/cli/commands/ste.ts) runs it
 * on a file, and the dev gate (scripts/ste-surfaces.ts) runs it on every copy surface.
 *
 * orangu adds these to the rule set it ports:
 * - a contraction rule. A possessive 's ("Claude's") is not a contraction.
 * - line mode (lines: true): every line is its own block, for columnar text such as --help.
 * - Markdown table cells are scored one cell per block (columnar text). A cell under 3 words is a label.
 * - a label (a heading, a short cell, a short fragment) is not scored, but its banned tokens are counted.
 * - a command or a flag is one technical name. `npx orangu report --open` counts as one word, and the
 *   "--" in `git checkout -- <ref>` is not an em dash. A "--" used as a dash after a command still is one.
 * - a count of the banned tokens (em dash, e.g., i.e., etc., contractions), one finding per token.
 * Markdown files also score their frontmatter description as one block.
 *
 * Every non-ASCII character in this file's code is built from its code point, so none hides as a space.
 * The word tables are data, in ./words.ts.
 */
import { BANNED_WORDS, GIT_VERBS, IMPERATIVES, ING_NOUNS, ORANGU_VERBS, PLAIN_WORDS, STE_WORDS } from './words.js'

export { ING_NOUNS, PLAIN_WORDS, STE_WORDS }

export interface SteBlock {
  /** 1-based line of the block's first character */
  line: number
  text: string
  /** the file the block came from, carried onto each finding */
  file?: string
  /** a label (a heading, a short cell or fragment): not scored, but its banned tokens count */
  label?: boolean
}

export type SteRule = 'sentence-length' | 'paragraph-length' | 'ste-word' | 'plain-word' | 'progressive' | 'perfect' | 'semicolon' | 'em-dash' | 'contraction'

export interface SteFinding {
  line: number
  file?: string
  rule: SteRule
  text: string
  hint: string
}

export interface SteBanned {
  emDash: number
  eg: number
  ie: number
  etc: number
  contractions: number
}

export interface SteResult {
  sentences: number
  clean: number
  /** percent of sentences with no finding, rounded; 100 when there is no sentence */
  score: number
  findings: SteFinding[]
  banned: SteBanned
}

export interface SteOptions {
  html?: boolean
  lines?: boolean
  frontmatter?: boolean
}

const ch = (code: number): string => String.fromCharCode(code)
/** U+2029, the block break that htmlToText puts in place of a block tag */
export const PARAGRAPH: string = ch(0x2029)
const EM = ch(0x2014)
const LSQUO = ch(0x2018)
const RSQUO = ch(0x2019)
const LDQUO = ch(0x201c)
const RDQUO = ch(0x201d)
const ELLIPSIS = ch(0x2026)

export const LIMITS: { readonly procedural: number; readonly descriptive: number; readonly paragraphSentences: number } = { procedural: 20, descriptive: 25, paragraphSentences: 6 }

export const PROGRESSIVE = /\b(am|is|are|was|were|be|been)\s+(?:not\s+|still\s+|now\s+)?([a-z]+ing)\b/gi
export const PERFECT = /\b(has|have|had)\s+(?:not\s+|already\s+|never\s+|just\s+|now\s+)?(been|[a-z]+ed|done|gone|seen|made|written|run|taken|given|found|built|sent|shown|known|got|gotten|begun|broken|chosen|left|kept|held|put|set|read)\b/gi
/** n't, 're, 've, 'll, 'm and 'd, plus the 's forms that always mean "is", "has" or "us", never a possessive */
export const CONTRACTION = new RegExp(
  `\\b[A-Za-z]+n['${RSQUO}]t\\b|\\b[A-Za-z]+['${RSQUO}](?:re|ve|ll|m|d)\\b|\\b(?:it|that|there|what|here|let|who|where|how|he|she)['${RSQUO}]s\\b`,
  'gi',
)
const EM_DASH = new RegExp(`${EM}|\\s--\\s`, 'g')
const ABBREVIATIONS = /\b(e\.g|i\.e|etc|vs|approx|fig)\./gi
const SENTENCE_END = new RegExp(`(?<=[.!?][*_)"'${RDQUO}${RSQUO}]*)\\s+(?=[A-Z0-9"${LDQUO}(\`*[_])`, 'g')
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/

/** a flag word; a bare "--" is taken only inside a command, before an argument */
const FLAG = /^--?[A-Za-z][\w-]*(?:=\S*)?$/
const PATHISH = /^[\w./~:@=+*-]*[/.~_:=@*\d][\w./~:@=+*-]*$/
const OPEN_QUOTE = new RegExp(`["${LDQUO}'${LSQUO}]`)
const CLOSE_QUOTE = new RegExp(`["${RDQUO}'${RSQUO}]`)
const LEAD = new RegExp(`^[(${LDQUO}${LSQUO}"']*`)
const TRAIL = new RegExp(`[.,;:!?)"${RDQUO}${RSQUO}']*$`)
const WORD_EDGE = new RegExp(`^[([{"'${LDQUO}${LSQUO}]+|[)\\]}"'${RDQUO}${RSQUO}.,;:!?${ELLIPSIS}]+$`, 'g')
const WORD = new RegExp(`^[A-Za-z][A-Za-z'${RSQUO}-]*$`)
const QUOTED_ARGUMENT = new RegExp(`^["${LDQUO}]`)

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface WordRule {
  word: string
  use: string
  source: 'ste' | 'plain'
  pattern: RegExp
}

const WORD_RULES: readonly WordRule[] = [
  ...Object.entries(STE_WORDS).map(([word, use]) => ({ word, use, source: 'ste' as const })),
  ...Object.entries(PLAIN_WORDS).map(([word, use]) => ({ word, use, source: 'plain' as const })),
].map((entry) => ({ ...entry, pattern: new RegExp(`(?<![\\w-])${escapeRegExp(entry.word)}(?![\\w-])`, 'gi') }))

export function htmlToText(html: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, '')
  return html
    .replace(/<(script|style|svg|pre|code)\b[\s\S]*?<\/\1>/gi, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<\/?(p|li|h[1-6]|div|section|article|td|th|tr|br|ul|ol|header|footer|figcaption|blockquote)\b[^>]*>/gi, PARAGRAPH)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
}

/**
 * Words with a letter, after a command collapses to one technical name. A placeholder (3), a count
 * or a path is not a word. A block under 3 such words is a label, not a sentence (carve-out 6).
 */
export function proseWords(text: string): number {
  return wrapCommands(text)
    .replace(/`[^`]*`/g, 'CODE')
    .split(/\s+/)
    .map((token) => token.replace(WORD_EDGE, ''))
    .filter((token) => WORD.test(token)).length
}

/** The cells of one Markdown table row; a pipe inside a code span or escaped as \| stays in its cell. */
function tableCells(line: string): string[] {
  if (/^[\s|:-]+$/.test(line) && line.includes('-')) return []
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  const cells: string[] = []
  let cell = ''
  let code = false
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '\\' && body[index + 1] === '|') {
      cell += '|'
      index += 1
      continue
    }
    if (char === '`') code = !code
    if (char === '|' && !code) {
      cells.push(cell)
      cell = ''
      continue
    }
    cell += char
  }
  cells.push(cell)
  return cells.map((text) => text.trim())
}

/**
 * Prose blocks of Markdown or text. With `lines`, every line closes its block (columnar text). A heading
 * is a label block. Each table cell is its own block: a label under 3 words, dropped when it is only code.
 */
export function proseBlocks(text: string, { lines: lineMode = false }: { lines?: boolean } = {}): SteBlock[] {
  const lines = text.split('\n')
  const blocks: SteBlock[] = []
  let current: SteBlock | null = null
  let fence: string | null = null
  let start = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (end > 0) start = end + 1
  }
  const close = (): void => {
    if (current) blocks.push(current)
    current = null
  }
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker || fence) {
      close()
      if (marker && !fence) fence = marker[0]!
      else if (marker && marker[0] === fence) fence = null
      continue
    }
    if (/^\s*$/.test(line) || /^\s*>/.test(line)) {
      close()
      continue
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      close()
      blocks.push({ line: index + 1, text: heading[1]!, label: true })
      continue
    }
    if (/^\s*\|/.test(line)) {
      close()
      for (const cell of tableCells(line)) {
        if (!/[A-Za-z]/.test(cell.replace(/`[^`]*`/g, ''))) continue
        blocks.push({ line: index + 1, text: cell, label: proseWords(cell) < 3 })
      }
      continue
    }
    const pieces = line.split(PARAGRAPH)
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
export function frontmatterDescription(text: string): SteBlock | null {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return null
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  for (let index = 1; index < end; index += 1) {
    const match = /^description:\s*(.*)$/.exec(lines[index]!)
    if (!match) continue
    let value = match[1]!.trim()
    if (/^[>|][+-]?$/.test(value)) {
      // a block scalar: folded (>) joins its indented lines with spaces, literal (|) with newlines
      const body: string[] = []
      for (let next = index + 1; next < end && /^\s+\S/.test(lines[next]!); next += 1) body.push(lines[next]!.trim())
      value = body.join(value.startsWith('>') ? ' ' : '\n')
    } else if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string
      } catch {
        value = value.slice(1, -1)
      }
    } else if (value.startsWith("'")) value = value.slice(1, -1).replace(/''/g, "'")
    return value ? { line: index + 1, text: value } : null
  }
  return null
}

interface Token {
  lead: string
  core: string
  trail: string
  coreStart: number
  coreEnd: number
}

function tokenize(segment: string): Token[] {
  return [...segment.matchAll(/\S+/g)].map((match) => {
    const raw = match[0]
    const lead = LEAD.exec(raw)![0]
    const rest = raw.slice(lead.length)
    const trail = TRAIL.exec(rest)![0]
    const core = rest.slice(0, rest.length - trail.length)
    const coreStart = match.index + lead.length
    return { lead, core, trail, coreStart, coreEnd: coreStart + core.length }
  })
}

const isArg = (core: string): boolean => FLAG.test(core) || /^[<[]/.test(core) || PATHISH.test(core) || core === '...' || core === ELLIPSIS

/** How many tokens from `i` name a command, or 0 when no command starts there. */
function commandHead(tokens: readonly Token[], i: number): number {
  // the core of token k, when no punctuation breaks the run from i to k
  const at = (k: number): string | undefined => {
    for (let j = i; j < k; j += 1) if (tokens[j]!.trail) return undefined
    const token = tokens[k]
    return token && !token.lead ? token.core : undefined
  }
  const word = tokens[i]!.core
  if (word === 'npx' && at(i + 1) && at(i + 1) !== '--') return at(i + 1) === 'orangu' && ORANGU_VERBS.has(at(i + 2) ?? '') ? 3 : 2
  if (word === 'orangu' && ORANGU_VERBS.has(at(i + 1) ?? '')) return 2
  if (word === 'orangu' && FLAG.test(at(i + 1) ?? '')) return 1
  if (word === 'git' && GIT_VERBS.has(at(i + 1) ?? '')) return 2
  // measured (src/analyze/insights.ts, the reverts recommendation): "checkout -- from a named branch ref"
  if (word === 'checkout' && at(i + 1) === '--') return 2
  const next = tokens[i + 1]
  if (word === 'claude' && !tokens[i]!.trail && next) {
    if (QUOTED_ARGUMENT.test(next.lead)) return 1
    if (FLAG.test(at(i + 1) ?? '')) return 1
    if (at(i + 1) === 'plugin' || at(i + 1) === 'mcp') return 2
  }
  if (word.startsWith('/orangu:')) return 1
  if (word.startsWith('--') && FLAG.test(word)) return 1
  return 0
}

function wrapSegment(segment: string): string {
  const tokens = tokenize(segment)
  const spans: Array<[number, number]> = []
  for (let i = 0; i < tokens.length; ) {
    const head = commandHead(tokens, i)
    if (!head) {
      i += 1
      continue
    }
    let last = i + head - 1
    let end = tokens[last]!.coreEnd
    for (let j = last + 1; j < tokens.length && !tokens[j - 1]!.trail; ) {
      const token = tokens[j]!
      if (OPEN_QUOTE.test(token.lead) && !token.lead.includes('(')) {
        // a quoted argument runs to the token that closes the quote
        let k = j
        while (k < tokens.length && k - j <= 12 && !CLOSE_QUOTE.test(tokens[k]!.trail)) k += 1
        if (k === tokens.length || k - j > 12) break
        const close = tokens[k]!.trail.search(CLOSE_QUOTE)
        last = k
        end = tokens[k]!.coreEnd + close + 1
        if (tokens[k]!.trail.length > close + 1) break
        j = k + 1
        continue
      }
      if (token.core === '--') {
        // an end-of-options "--" only when an argument follows it; otherwise it is a dash in the prose
        const after = tokens[j + 1]
        if (token.lead || token.trail || !after || after.lead || after.core === '--' || !isArg(after.core)) break
      } else if (token.lead || !isArg(token.core)) break
      last = j
      end = token.coreEnd
      j += 1
    }
    spans.push([tokens[i]!.coreStart, end])
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
export function wrapCommands(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, index) => (index % 2 ? part : wrapSegment(part)))
    .join('')
}

function plainSentence(sentence: string): string {
  return wrapCommands(sentence)
    .replace(/`[^`]*`/g, 'CODE')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'URL')
    .replace(/[*_]{1,3}/g, '')
}

export function splitSentences(text: string): Array<{ offset: number; text: string }> {
  const guarded = text.replace(ABBREVIATIONS, (match) => match.replace(/\./g, '\u0000'))
  const sentences: Array<{ offset: number; text: string }> = []
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

export function wordCount(sentence: string): number {
  return plainSentence(sentence).split(/\s+/).filter((token) => /[A-Za-z0-9]/.test(token)).length
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > 90 ? `${flat.slice(0, 87)}...` : flat
}

function sentenceFindings(sentence: string, line: number): SteFinding[] {
  const plain = plainSentence(sentence)
  const findings: SteFinding[] = []
  const words = wordCount(sentence)
  const first = plain.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z']/g, '') ?? ''
  const limit = IMPERATIVES.has(first) ? LIMITS.procedural : LIMITS.descriptive
  if (words > limit) findings.push({ line, rule: 'sentence-length', text: excerpt(sentence), hint: `${words} words: split it (limit ${limit})` })
  for (const rule of WORD_RULES) {
    for (const match of plain.matchAll(rule.pattern)) {
      findings.push({ line, rule: rule.source === 'ste' ? 'ste-word' : 'plain-word', text: match[0], hint: `write "${rule.use}"` })
    }
  }
  for (const match of plain.matchAll(PROGRESSIVE)) {
    if (ING_NOUNS.has(match[2]!.toLowerCase())) continue
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

const isBanned = (finding: SteFinding): boolean =>
  finding.rule === 'em-dash' || finding.rule === 'contraction' || (finding.rule === 'plain-word' && BANNED_WORDS.has(finding.text.toLowerCase()))

/** The banned tokens a surface carries: the em dash, e.g., i.e., etc. and contractions. */
export function bannedCounts(findings: readonly SteFinding[]): SteBanned {
  const banned: SteBanned = { emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }
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

/**
 * Score blocks of prose ({ line, text, file?, label? }). Each finding keeps the file of its block. A label
 * block is not scored: only its banned tokens count.
 */
export function checkBlocks(blocks: readonly SteBlock[]): SteResult {
  const findings: SteFinding[] = []
  let sentences = 0
  let clean = 0
  for (const block of blocks) {
    const where = block.file === undefined ? {} : { file: block.file }
    const parts = splitSentences(block.text)
    if (!block.label && parts.length > LIMITS.paragraphSentences) {
      findings.push({ ...where, line: block.line, rule: 'paragraph-length', text: excerpt(parts[0]!.text), hint: `${parts.length} sentences: keep one topic in at most ${LIMITS.paragraphSentences}` })
    }
    // the newlines before each sentence, counted with a cursor that only moves forward: one pass per block
    let newlines = 0
    let nextNewline = block.text.indexOf('\n')
    for (const part of parts) {
      while (nextNewline !== -1 && nextNewline < part.offset) {
        newlines += 1
        nextNewline = block.text.indexOf('\n', nextNewline + 1)
      }
      const line = block.line + newlines
      const own = sentenceFindings(part.text, line).map((finding) => ({ ...where, ...finding }))
      if (block.label) {
        findings.push(...own.filter(isBanned))
        continue
      }
      sentences += 1
      if (own.length === 0) clean += 1
      findings.push(...own)
    }
  }
  const score = sentences === 0 ? 100 : Math.round((clean / sentences) * 100)
  return { sentences, clean, score, findings, banned: bannedCounts(findings) }
}

export function checkText(text: string, { html = false, lines = false, frontmatter = false }: SteOptions = {}): SteResult {
  const source = html ? htmlToText(text) : text
  const blocks = proseBlocks(source, { lines })
  const description = frontmatter ? frontmatterDescription(source) : null
  return checkBlocks(description ? [description, ...blocks] : blocks)
}
