/**
 * The check of the input box between 2 steps of a prompt (matchTyped): the box under the last prompt row holds the
 * text typed so far, with no dialog and no numbered row under it. White space does not count, because the box wraps a
 * long line at a space. The screens are synthetic: the fixtures under test/fixtures/god/screens and rows made here.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { matchTyped } from './screen-match.js'

const SCREENS = join(dirname(fileURLToPath(import.meta.url)), '../../../test/fixtures/god/screens')
const fixture = (name: string): string => readFileSync(join(SCREENS, `${name}.txt`), 'utf8')

describe('matchTyped: the input box between 2 steps of a prompt', () => {
  const RULE = '─'.repeat(72)
  const NBSP = String.fromCharCode(0xa0)
  /** a screen whose input box holds `rows`: the first after the prompt mark, the next ones after 2 spaces */
  const boxed = (rows: readonly string[], below: readonly string[] = ['  ? for shortcuts']): string =>
    ['❯ run the unit tests', '', '⏺ The unit tests pass.', '', RULE, `❯${NBSP}${rows[0] ?? ''}`, ...rows.slice(1).map((row) => `  ${row}`), RULE, ...below].join('\n')

  it('takes an empty box for no text, and the box of each line typed so far', () => {
    expect(matchTyped(boxed([]), '')).toBeUndefined()
    expect(matchTyped(boxed(['Run the tests.']), 'Run the tests.')).toBeUndefined()
    expect(matchTyped(boxed(['Run the tests.', '']), 'Run the tests.\n')).toBeUndefined()
    expect(matchTyped(boxed(['Run the tests.', 'Then run test 2 again.']), 'Run the tests.\nThen run test 2 again.')).toBeUndefined()
  })

  it('takes a long line that the box wraps at a space', () => {
    expect(matchTyped(boxed(['Run the eval tests again and then', 'write the result in the notes.']), 'Run the eval tests again and then write the result in the notes.')).toBeUndefined()
  })

  it('refuses a box that lost a character, holds 1 more, or holds ghost text', () => {
    expect(matchTyped(boxed(['Then run test again.']), 'Then run test 2 again.')).toBe('screen-changed')
    expect(matchTyped(boxed(['Run the tests.2']), 'Run the tests.')).toBe('screen-changed')
    expect(matchTyped(boxed(['Run the tests. Try "fix lint errors"']), 'Run the tests.')).toBe('screen-changed')
    expect(matchTyped(boxed(['Run the tests.']), '')).toBe('screen-changed')
  })

  it('refuses a dialog on the screen, a box with no rule over it or under it, and a numbered row under the box', () => {
    expect(matchTyped(fixture('permission'), '')).toBe('screen-changed')
    expect(matchTyped(fixture('question'), '')).toBe('screen-changed')
    expect(matchTyped(boxed(['Run the tests.']).replace(`${RULE}\n❯`, '❯'), 'Run the tests.')).toBe('screen-changed')
    expect(matchTyped(['❯ run it', '', RULE, `❯${NBSP}Run the tests.`, '  more'].join('\n'), 'Run the tests.\nmore')).toBe('screen-changed')
    expect(matchTyped(boxed(['Run the tests.'], [' ❯ 1. Yes', '   2. No']), 'Run the tests.')).toBe('screen-changed')
    expect(matchTyped(boxed(['Run the tests.'], ['  1. Yes']), 'Run the tests.')).toBe('screen-changed')
  })

  it('takes a numbered line of the typed text inside the box, as any other line of the text', () => {
    expect(matchTyped(boxed(['Do these:', '1. Run the lint.']), 'Do these:\n1. Run the lint.')).toBeUndefined()
    expect(matchTyped(boxed(['Do these:', '1. Run the lint.']), 'Do these:\n1. Run the tests.')).toBe('screen-changed')
  })
})
