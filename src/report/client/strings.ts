/**
 * Plain-language vocabulary. Applied wherever a string is rendered:
 * the Plain language view avoids implementation jargon; Detailed is the identity map.
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
  'tool calls': 'steps',
  'tool call': 'step',
  'tool errors': 'failed steps',
  compactions: 'memory refreshes',
  compaction: 'memory refresh',
  subagents: 'helpers',
  subagent: 'helper',
  agents: 'helpers',
  tokens: 'work units',
  turns: 'exchanges',
  turn: 'exchange',
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
