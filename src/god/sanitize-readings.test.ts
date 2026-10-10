/**
 * The readings of orangu god's text gate: a secret that a control or a terminal sequence split is whole only in another
 * reading of the text, and the pane hides each place that such a reading hides, and nothing else. The control
 * characters are built from their code points, so this file spells no escape sequence.
 */
import { describe, expect, it } from 'vitest'
import { AFTER_WORD_CHAR, KEY_PREFIX_SHAPES } from '../../test/fixtures/key-prefix-shapes.js'
import { cleanText } from './sanitize.js'

const HOME = '/Users/test'
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const CSI = String.fromCharCode(0x9b)
const ZWSP = String.fromCharCode(0x200b)

describe('cleanText readings', () => {
  it('masks a secret that a sequence or a control glued to a word, or that a sequence split', () => {
    const s = 'Zq9xW2pL7mN4vB8k'
    const ghp = ['ghp', `${s}${s}`].join('_')
    const aws = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')
    const jwt = `eyJ${s}aa.${s}bbbb.${s}`
    const NUL = String.fromCharCode(0)
    const shapes = [
      `alpha${ESC}[31msk-ant-api03-${s}`,
      `<bash-stdout>${ESC}[33m${ghp}${ESC}[0m</bash-stdout>`,
      `${ESC}[2mBearer ${s}${s}`,
      `x${CSI}31msk-ant-api03-${s}`,
      `${ESC}]0;title${BEL}${ghp}`,
      `${ESC}]2;title${ESC}\\${aws}`,
      `alpha${ESC}${ghp}`,
      `alpha${NUL}${aws}`,
      `token${ESC}[1m${jwt}`,
      `file.txt:${ESC}[01;31m${ESC}[K${ghp}${ESC}[m${ESC}[K`,
      `sk-ant-${ESC}[01;31m${ESC}[Kapi03${ESC}[m${ESC}[K-${s}${s}`,
      `pass${ESC}[01;31m${ESC}[Kword${ESC}[m${ESC}[K=${s}`,
      `x${CSI} sk-ant-api03-${s}${s}`,
      `ignore${String.fromCodePoint(0xe0041)}${ghp}`,
      `alpha${String.fromCharCode(0x200b)}${ghp}`,
      `x${ESC}(B${ghp}`,
      `x${ESC}[0 q${ghp}`,
      `x${ESC}Pq#0${ESC}\\${ghp}`,
      `x${String.fromCharCode(0x90)}dcs${String.fromCharCode(0x9c)}${ghp}`,
      `${ESC}]0;title ${ghp}`,
      `pass${String.fromCharCode(0x00ad)}word=${s}`,
      `x${String.fromCharCode(0xfe0f)}${ghp}`,
    ]
    for (const shape of shapes) expect(cleanText(shape, HOME), JSON.stringify(shape)).not.toMatch(/Zq9x|W2pL|7mN4|vB8k|IOSFODNN/)
  })

  it('masks a secret that a sequence split where a terminal takes more than the pane shows: a space, a byte out of place, no final byte', () => {
    const s = 'Zq9xW2pL7mN4vB8k'
    const ghp = ['ghp', `${s}${s}`].join('_')
    const aws = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')
    const C1 = (code: number): string => String.fromCharCode(code)
    const shapes = [
      // ESC SP F: a space is an intermediate byte to a terminal
      `${ESC} F${ghp}`,
      // a CSI with a byte out of place: a terminal drops it, and the parts join
      `${ghp.slice(0, 1)}${ESC}[31${C1(0x80)}${ghp.slice(1)}`,
      `${aws.slice(0, 12)}${ESC}[ ${aws.slice(12)}`,
      `password${ESC}[1 =${s}`,
      `${ghp.slice(0, 4)}${ESC}[31;${CSI}${ghp.slice(4)}`,
      // the pane keeps a character that a terminal takes as the final byte
      `password=${s.slice(0, 1)}${ESC}[ ${s.slice(1)}`,
      `"api_key":${ESC}( "${s}"`,
      // a sequence takes the first characters of the part after a join
      `${aws.slice(0, 1)}${CSI}${aws.slice(1)}`,
      `${aws.slice(0, 1)}${ESC}${aws.slice(1)}`,
      `${aws.slice(0, 1)}${ESC}${ESC}${aws.slice(1)}`,
      // a sequence takes the first character of a secret, or a C0 control sits among its bytes
      `${ghp.slice(0, 1)}${ESC}[${ghp.slice(1)}`,
      `${ESC}[31${ghp}`,
      `${aws.slice(0, 6)}${ESC}[ ${aws.slice(6)}`,
      `${ghp.slice(0, 1)}${ESC}[31${String.fromCharCode(7)}${ghp.slice(1)}`,
      `x${ESC}[0\r q${ghp}.`,
      `x${ESC} F${ghp}.`,
      `${aws.slice(0, 6)}${ESC}[1${String.fromCharCode(0)}${aws.slice(6)}`,
      `password${ESC}[31${String.fromCharCode(7)}=${s}`,
    ]
    for (const shape of shapes) expect(cleanText(shape, HOME), JSON.stringify(shape)).not.toMatch(/Zq9x|q9xW|W2pL|7mN4|vB8k|IOSF|OSFO|SFOD|FODN|ODNN/)
  })

  it('hides each shape that only a reading with a gap shows whole: a hash after an 8-bit CSI or ESC SP F, a Bearer token after ESC (', () => {
    const hash = '3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a'
    const token = 'Zq9xW2pL7mN4vB8k'
    for (const shape of [`x${CSI}${hash}.`, `x${ESC} F${hash}.`, `x${ESC}[0\r q${hash}.`, `Bearer${ESC}(  ${token}`, `Bearer${ESC}[31;  ${token}`]) {
      expect(cleanText(shape, HOME), JSON.stringify(shape)).not.toMatch(/3f9a|f9a1|9a1c|8f0a|q9xW|W2pL|vB8k/)
    }
  })

  it('hides a hash that a CSI with a space before its final byte glues to that byte', () => {
    const hash = '3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a'
    // a run of the pane that holds a hidden place goes whole: here the `m` that the reading took as the final byte
    expect(cleanText(`key: ${ESC}[ m${hash}`, HOME)).toBe('key:  ‹redacted›')
  })

  it('hides only the places that another reading hides, so an equal word elsewhere in the text stays', () => {
    expect(cleanText(`password=${ESC}[1mtest-secret-1234${ESC}[0m && npm test passed`, HOME)).toBe('password=‹redacted› && npm test passed')
    const confirm = cleanText(`api_key=${ESC}[2mprojects-9f8e7d6c${ESC}[0m; rm -rf ~/projects/acme`, HOME)
    expect(confirm).toContain('rm -rf ~/projects/acme')
    expect(confirm).not.toMatch(/9f8e7d6c/)
    // a key that a control split keeps its other part hidden, and the same part elsewhere stays
    expect(cleanText(`sk-ant-api03-FAKE${BEL}FAKEFAKEFAKE FAKEFAKEFAKE`, HOME)).toBe('‹anthropic-key› ‹redacted› FAKEFAKEFAKE')
    // a key that only the narrow strip shows whole holds `projects`: the path and the command stay
    const narrow = cleanText(`npm test passed && rm -rf ~/projects/acme; w${ZWSP}ghp_projectsZq9xW2${BEL}pL7mN4vB8kZq9xW2pL7mN4vB8k`, HOME)
    expect(narrow).toContain('npm test passed && rm -rf ~/projects/acme; w ')
    expect(narrow).not.toMatch(/Zq9x|W2pL|7mN4|vB8k/)
  })

  it('hides a key that only the narrow strip shows whole: a word, an invisible character that it keeps, and a control inside the key', () => {
    const s = 'Zq9xW2pL7mN4vB8k'
    expect(cleanText(`w${ZWSP}ghp_${s.slice(0, 8)}${BEL}${s.slice(8)}${s}`, HOME)).not.toMatch(/Zq9x|q9xW|W2pL|7mN4|vB8k/)
    const keys = [`sk-ant-api03-${s}${s}`, `ghp_${s}${s}`, `sk-${s}${s}`, `AIza${s}${s}`, `eyJ${s}aa.${s}bbbb.${s}`, `Bearer ${s}${s}`, '3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a', `xoxb-${s}${s}`]
    const kept = [0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xfe0f, 0x034f, 0x3164, 0xe0041].map((code) => String.fromCodePoint(code))
    const gone = [0x07, 0x00, 0x7f, 0x85, 0x9b, 0x202e, 0x18, 0x1b].map((code) => String.fromCharCode(code))
    for (const key of keys) {
      for (const invisible of kept) {
        for (const control of gone) {
          const text = `w${invisible}${key.slice(0, 8)}${control}${key.slice(8)} end`
          expect(cleanText(text, HOME), JSON.stringify(text)).not.toMatch(/Zq9x|q9xW|W2pL|pL7m|7mN4|N4vB|vB8k|3f9a1c|7e5b2d|9c2e4b/)
        }
      }
    }
  })

  it('keeps the word start of main on each key rule, the JWT rule, Bearer and Authorization: a run with a key prefix goes whole, a key after a word character stays', () => {
    for (const [text, out] of KEY_PREFIX_SHAPES) expect(cleanText(text, HOME), text.slice(0, 30)).toBe(out)
    for (const text of AFTER_WORD_CHAR) expect(cleanText(text, HOME), text.slice(0, 30)).toBe(text)
  })
})
