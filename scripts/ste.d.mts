/** Types for scripts/ste.mjs, the STE checker (ASD-STE100 subset). */

export interface SteBlock {
  /** 1-based line of the block's first character */
  line: number
  text: string
  /** the file the block came from, carried onto each finding */
  file?: string
}

export interface SteFinding {
  line: number
  file?: string
  rule: 'sentence-length' | 'paragraph-length' | 'ste-word' | 'plain-word' | 'progressive' | 'perfect' | 'semicolon' | 'em-dash' | 'contraction'
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

export const LIMITS: { procedural: number; descriptive: number; paragraphSentences: number }
export const STE_WORDS: Readonly<Record<string, string>>
export const PLAIN_WORDS: Readonly<Record<string, string>>
export const ING_NOUNS: ReadonlySet<string>
export const PROGRESSIVE: RegExp
export const PERFECT: RegExp
export const CONTRACTION: RegExp

export function htmlToText(html: string): string
export function proseBlocks(text: string, options?: { lines?: boolean }): SteBlock[]
export function frontmatterDescription(text: string): SteBlock | null
export function wrapCommands(text: string): string
export function splitSentences(text: string): Array<{ offset: number; text: string }>
export function wordCount(sentence: string): number
export function bannedCounts(findings: readonly SteFinding[]): SteBanned
export function checkBlocks(blocks: readonly SteBlock[]): SteResult
export function checkText(text: string, options?: SteOptions): SteResult
