/**
 * The shared definition of unsupported monetary language.
 *
 * Every public-surface guard imports this list so one update covers code, docs, the
 * landing page, the sample, plugin copy, and plain-language output.
 *
 * Deliberately not in the list:
 *   `budget`, `spend`  - the researcher agent and its reference use both to mean *web calls per run*
 *                        ("a per-run web budget of 10"), which is a count of requests, not money.
 *                        Banning them would force those files into worse English for no honesty gain.
 */

/**
 * The one exception is a string, not a file: the CLI must be able to name a flag it retired.
 * `--max-cost` was renamed to `--max-tokens`, and because the arg parser ignores unknown flags, a CI
 * pipeline still passing the old one would exit 0 forever. The migration message therefore has to
 * spell the dead flag. Stripped by exact literal before checking, so any OTHER money string added to
 * the same file still fails the guard.
 */
export const RETIRED_FLAG_LITERALS = ["'max-cost'", '--max-cost was removed; use --max-tokens <n>', '--max-cost']

/** Currency amounts: a symbol next to a number. */
export const CURRENCY_AMOUNT = /[$£€¥]\s?\d/

/**
 * Money vocabulary. Word-bounded so `billion` is not `bill` and `costly` IS caught.
 * `cheap` and `afford` and `invoice` and `charge` match their inflections by prefix.
 */
export const MONEY_WORDS =
  /\b(?:usd|dollars?|list.?rates?|list.?prices?|price[sd]?|pricing|cheap\w*|expensive|inexpensive|afford\w*|bill|bills|billed|billing|charge[sd]?|charging|currency|currencies|monetary|invoice\w*|costs?|costly|money|monies|paid|pays)\b/i

/** Every hit of the money vocabulary in `text`, with ~60 characters of context each. */
export function moneyHits(text: string): string[] {
  const re = new RegExp(MONEY_WORDS.source, 'gi')
  return [...text.matchAll(re)].map((m) => {
    const at = m.index ?? 0
    return text.slice(Math.max(0, at - 60), at + m[0].length + 60).replace(/\s+/g, ' ')
  })
}

/** Currency-amount hits, same shape. */
export function currencyHits(text: string): string[] {
  const re = new RegExp(CURRENCY_AMOUNT.source, 'g')
  return [...text.matchAll(re)].map((m) => {
    const at = m.index ?? 0
    return text.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, ' ')
  })
}

/**
 * Strip `//` and block comments from TypeScript source.
 *
 * The guards check what a USER can see — rendered HTML, `--json`, CLI output, rule prose, and the
 * markdown a model is instructed with. Source comments are exempt on purpose: several of them
 * explain *why* a threshold was re-derived ("the priced rule gated on cache read+write > 80% of
 * session COST"), and that history is the most valuable comment in the file. Banning the words there
 * would make the code less honest, not more.
 *
 * Crude but sufficient: it over-strips inside string literals containing `//`, which can only cause
 * a false PASS on a URL-shaped string, and no rule prose is URL-shaped.
 */
export function stripRetiredFlagLiterals(src: string): string {
  let out = src
  for (const lit of RETIRED_FLAG_LITERALS) out = out.split(lit).join(' ')
  return out
}

export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ')
}
