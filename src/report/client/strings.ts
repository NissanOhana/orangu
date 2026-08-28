/**
 * Plain-language vocabulary. Applied wherever a string is rendered:
 * the Plain language view avoids implementation jargon; Detailed is the identity map.
 *
 * One vocabulary: the word is "tokens" in both audiences (the only usage metric orangu has), and
 * turns, tool calls and subagents keep their names. Plain mode removes panels, it does not rename
 * nouns (A3). Only terms that name a mechanism a non-developer cannot be expected to know are mapped.
 */
export type Audience = 'dev' | 'plain'

/** detailed term → plain replacement. Longest keys first when substituting whole sentences. */
export const PLAIN_TERMS: Record<string, string> = {
  'context window': 'working memory',
  'cache reads': 'reused context',
  'cache read': 'reused context',
  'cache writes': 'saved context',
  'cache write': 'saved context',
  'cache hits': 'reused context',
  compactions: 'memory refreshes',
  compaction: 'memory refresh',
}

/** Translate one term for the audience. */
export function term(word: string, aud: Audience): string {
  if (aud !== 'plain') return word
  return PLAIN_TERMS[word] ?? word
}

const ORDERED = Object.keys(PLAIN_TERMS).sort((a, b) => b.length - a.length)

/** Rewrite every mapped term inside a sentence (Plain audience only). */
export function plainSentence(s: string, aud: Audience): string {
  if (aud !== 'plain') return s
  let out = s
  for (const k of ORDERED) out = out.split(k).join(PLAIN_TERMS[k]!)
  return out
}

/** Abbreviations the narrative uses mid-sentence; a period after one of them ends no sentence. */
const ABBREVIATIONS = /\b(?:incl|e\.g|i\.e|approx|vs|etc)\.$/i

/**
 * The first sentence of generated prose, for the Plain "What happened" line. The narrative is not
 * split on the first ". ": "made 19 requests (26 turns incl. commands/automation) over 34h" would
 * end at "incl." with an open parenthesis. A period ends the sentence only outside parentheses,
 * before whitespace or the end, and not after a known abbreviation; otherwise the whole text is returned.
 */
export function leadSentence(text: string): string {
  const t = text.trim()
  let depth = 0
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === '.' && !depth && (i + 1 === t.length || t[i + 1] === ' ') && !ABBREVIATIONS.test(t.slice(0, i + 1))) return t.slice(0, i + 1)
  }
  return t
}
