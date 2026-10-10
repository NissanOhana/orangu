/**
 * The text check of a prompt (textRefusal), which runs before any host call: an empty text, a control character, a
 * character that does not show, a backslash that cmux types as a key, and a text that is no prompt for the model (a
 * shell command, the help, or an exit that ends the session) each give 1 refusal, so no key goes out.
 */
import { describe, expect, it } from 'vitest'
import { textRefusal } from './deliver-plan.js'

/** a text from code points, so no invisible character hides in this file */
const ch = (...codes: number[]): string => String.fromCodePoint(...codes)

describe('textRefusal', () => {
  it('refuses an empty text and a text of white space only', () => {
    for (const text of ['', ' ', '\n', ` \n ${ch(0xa0)}`]) expect(textRefusal(text)).toBe('empty')
  })

  it('refuses a text of only blank or invisible characters as empty', () => {
    const invisible = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x00ad, 0x2028, 0x2029, 0xfeff, 0x2060, 0x202e, 0x3000, 0xfe0f]
    for (const code of invisible) expect(textRefusal(ch(code)), `U+${code.toString(16)}`).toBe('empty')
    expect(textRefusal(ch(0x200b, 0x20, 0xad, 0xfeff, 0x0a, 0x2028))).toBe('empty')
  })

  it('refuses every control character but the newline: C0, DEL and C1', () => {
    for (const code of [0x00, 0x03, 0x07, 0x08, 0x09, 0x0b, 0x0c, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9b, 0x9f]) {
      expect(textRefusal(`a${ch(code)}b`), `U+${code.toString(16)}`).toBe('control-char')
    }
  })

  it('refuses a format character or a default ignorable character anywhere in a text that shows', () => {
    // the last 3 are format characters that are not default ignorable: each class has its own case
    const hidden = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x00ad, 0xfeff, 0x2060, 0x202e, 0x2066, 0x061c, 0x180e, 0xfe0f, 0x034f, 0x115f, 0x3164, 0xe0041, 0xe0001, 0x0600, 0xfff9, 0x110bd]
    for (const code of hidden) {
      expect(textRefusal(`a${ch(code)}b`), `U+${code.toString(16)}`).toBe('control-char')
      expect(textRefusal(`Run the tests.${ch(code)}`), `U+${code.toString(16)}`).toBe('control-char')
    }
  })

  it('refuses a backslash right before n, r or t in either case, which cmux can type as Enter or Tab', () => {
    for (const text of ['a\\nb', 'a\\rb', 'a\\tb', 'C:\\new', 'a\\\\nb', '\\t', 'a\\Nb', 'a\\Rb', 'a\\Tb', 'C:\\Temp']) expect(textRefusal(text), text).toBe('backslash-escape')
  })

  it('refuses a line that ends with a backslash, which Claude Code reads as a new line in place of Enter', () => {
    for (const text of ['ends with \\', 'ends with \\  ', `ends with \\${ch(0xa0)}`, 'first\\\nsecond', 'first\\  \nsecond', '\\']) {
      expect(textRefusal(text), JSON.stringify(text)).toBe('backslash-escape')
    }
  })

  it('refuses a line or paragraph separator in a text with a visible character, which cmux can type as a line break', () => {
    for (const code of [0x2028, 0x2029]) {
      expect(textRefusal(`a${ch(code)}b`), `U+${code.toString(16)}`).toBe('control-char')
      expect(textRefusal(`line one${ch(code)}`), `U+${code.toString(16)}`).toBe('control-char')
    }
  })

  it('passes a newline, a backslash before any other character, a no-break space and a wide character', () => {
    for (const text of ['line one\nline two', 'a\\b', 'a\\x41', 'a\\u0041', 'a\\ b', `a${ch(0xa0)}b`, `a${ch(0x3000)}b`, '色を選ぶ']) expect(textRefusal(text), text).toBeUndefined()
  })
})

describe('textRefusal: a text that is no prompt for the model', () => {
  it('refuses a text whose first character that is not a space is ! (a shell command) or ? (the help)', () => {
    for (const text of ['!ls', '! rm -rf build', '   !ls', '\n\n!git status', `${ch(0xa0)}!ls`, '?', '? shortcuts', ' \n ?help\nmore']) {
      expect(textRefusal(text), JSON.stringify(text)).toBe('not-a-prompt')
    }
  })

  it('refuses a text whose first line, trimmed, ends the session', () => {
    for (const text of ['exit', 'quit', ':q', ':q!', ':wq', ':wq!', '  exit  ', '\n exit\nthen more', 'Quit', 'EXIT']) {
      expect(textRefusal(text), JSON.stringify(text)).toBe('not-a-prompt')
    }
  })

  it('passes a command, a ! or ? later in the text, and a first line that only starts with an exit word', () => {
    for (const text of ['/clear', '   \n/compact', 'Run !ls', 'Why? Explain it.', 'exit the loop when it ends', 'quit early', ':qa', 'wq', 'Run the tests.\nexit']) {
      expect(textRefusal(text), JSON.stringify(text)).toBeUndefined()
    }
  })
})
