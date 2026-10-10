/**
 * Where each character of a changed text comes from. A rule of the redaction replaces parts of its input, and the
 * god cleaner (src/god/sanitize.ts) takes parts out of a text to read it in another way. To hide in the text that
 * the pane shows only the places that such a reading hides, each changed text keeps, for each of its characters,
 * the index in the first text that the character comes from, or -1 for a character that a change wrote.
 */

/** A change of a text: the part [from, to) became `by`. */
export type Edit = readonly [from: number, to: number, by: string]

/** A rule calls `mark` once for each part of its input that it replaces, in the order of the text. */
export type Mark = (from: number, to: number, by: string) => void

/**
 * The origins of the text that `edits` (in order, never overlapping) make from `text`, whose own origins are
 * `origins` (none: each character is its own). A character that an edit keeps at the start or the end of what it
 * writes (a key name, `Bearer `, a quote) keeps its origin; each other character that it writes gets -1.
 */
export function originsAfter(text: string, origins: Int32Array | undefined, edits: readonly Edit[], length: number): Int32Array {
  const next = new Int32Array(length)
  const origin = (i: number): number => (origins ? origins[i]! : i)
  let at = 0
  let j = 0
  for (const [from, to, by] of edits) {
    while (at < from) next[j++] = origin(at++)
    let head = 0
    while (head < by.length && head < to - from && by[head] === text[from + head]) head++
    let tail = 0
    while (tail < by.length - head && tail < to - from - head && by[by.length - 1 - tail] === text[to - 1 - tail]) tail++
    for (let k = 0; k < by.length; k++) next[j++] = k < head ? origin(from + k) : k >= by.length - tail ? origin(to - by.length + k) : -1
    at = to
  }
  while (at < text.length) next[j++] = origin(at++)
  if (j !== length) throw new Error(`the edits give ${j} characters, not ${length}`)
  return next
}

/** The text with `edits` (in order, never overlapping) applied. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = ''
  let at = 0
  for (const [from, to, by] of edits) {
    out += text.slice(at, from) + by
    at = to
  }
  return out + text.slice(at)
}
