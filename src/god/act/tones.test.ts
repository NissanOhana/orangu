/**
 * The 3 tones of the god alerts, made from code: 16-bit PCM mono WAV clips at a fixed sample rate, as base64 with
 * the MIME type audio/wav. Each clip is short and soft, fades in and out so it does not click, and has the same
 * bytes on each build. The base64 encoder is pure and matches the known vectors.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stripComments } from '../../../test/money-vocabulary.js'
import type { AlertKind } from '../types.js'
import { TONES, TONE_SAMPLE_RATE, base64, sineOfTurns, wavBytes } from './tones.js'

const KINDS: readonly AlertKind[] = ['needs-you', 'stuck', 'done']
const FULL_SCALE = 32767
const HEADER_BYTES = 44

const bytesOf = (kind: AlertKind): Uint8Array => new Uint8Array(Buffer.from(TONES[kind].base64, 'base64'))
const ascii = (bytes: Uint8Array, from: number): string => String.fromCharCode(...bytes.slice(from, from + 4))
const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** the PCM samples of 1 clip, as signed 16-bit numbers */
function samplesOf(kind: AlertKind): number[] {
  const bytes = bytesOf(kind)
  const data = view(bytes)
  return Array.from({ length: (bytes.length - HEADER_BYTES) / 2 }, (_, index) => data.getInt16(HEADER_BYTES + 2 * index, true))
}

describe('each tone is a 16-bit PCM mono WAV clip', () => {
  const lengths: Readonly<Record<AlertKind, number>> = { 'needs-you': 10284, stuck: 12844, done: 7724 }

  for (const kind of KINDS) {
    it(`${kind}: starts with RIFF and WAVE, has the PCM header of 16 bits, 1 channel and 16000 Hz, and is ${lengths[kind]} bytes`, () => {
      const bytes = bytesOf(kind)
      const data = view(bytes)
      expect(TONES[kind].mime).toBe('audio/wav')
      expect(bytes.length).toBe(lengths[kind])
      expect(ascii(bytes, 0)).toBe('RIFF')
      expect(data.getUint32(4, true)).toBe(bytes.length - 8)
      expect(ascii(bytes, 8)).toBe('WAVE')
      expect(ascii(bytes, 12)).toBe('fmt ')
      expect(data.getUint32(16, true)).toBe(16)
      expect(data.getUint16(20, true)).toBe(1)
      expect(data.getUint16(22, true)).toBe(1)
      expect(data.getUint32(24, true)).toBe(16000)
      expect(data.getUint32(28, true)).toBe(32000)
      expect(data.getUint16(32, true)).toBe(2)
      expect(data.getUint16(34, true)).toBe(16)
      expect(ascii(bytes, 36)).toBe('data')
      expect(data.getUint32(40, true)).toBe(bytes.length - HEADER_BYTES)
    })
  }

  it('uses 1 fixed sample rate', () => {
    expect(TONE_SAMPLE_RATE).toBe(16000)
  })

  it('gives the 3 kinds 3 different clips', () => {
    expect(new Set(KINDS.map((kind) => TONES[kind].base64)).size).toBe(3)
  })

  it('writes a known header and little-endian samples for a known input', () => {
    const bytes = wavBytes([0, 1, -1, 32767, -32768], 8000)
    expect([...bytes]).toEqual([
      ...[82, 73, 70, 70], 46, 0, 0, 0, ...[87, 65, 86, 69],
      ...[102, 109, 116, 32], 16, 0, 0, 0, 1, 0, 1, 0, 64, 31, 0, 0, 128, 62, 0, 0, 2, 0, 16, 0,
      ...[100, 97, 116, 97], 10, 0, 0, 0,
      0, 0, 1, 0, 255, 255, 255, 127, 0, 128,
    ])
  })
})

describe('each tone is short and soft, and fades in and out so it does not click', () => {
  for (const kind of KINDS) {
    it(`${kind}: lasts 400 ms or less, peaks at a quarter of full scale or less, and starts and ends at 0`, () => {
      const samples = samplesOf(kind)
      const ms = (samples.length / TONE_SAMPLE_RATE) * 1000
      expect(ms).toBeGreaterThanOrEqual(200)
      expect(ms).toBeLessThanOrEqual(400)
      const peak = Math.max(...samples.map(Math.abs))
      expect(peak).toBeGreaterThan(FULL_SCALE / 8)
      expect(peak).toBeLessThanOrEqual(Math.ceil(FULL_SCALE / 4))
      expect(samples[0]).toBe(0)
      expect(samples[samples.length - 1]).toBe(0)
    })

    it(`${kind}: stays under 2% of full scale in its first and last 1 ms, and never jumps more than a pure sine of its top note can`, () => {
      const samples = samplesOf(kind)
      const oneMs = TONE_SAMPLE_RATE / 1000
      expect(samples.length).toBeGreaterThan(100 * oneMs)
      const edges = [...samples.slice(0, oneMs), ...samples.slice(-oneMs)]
      expect(Math.max(...edges.map(Math.abs))).toBeLessThan(FULL_SCALE * 0.02)
      // a pure sine of amplitude A at f Hz moves at most A * 2 * pi * f / rate in 1 sample; the top note is 880 Hz
      const sineStep = (FULL_SCALE / 4) * ((2 * Math.PI * 880) / TONE_SAMPLE_RATE)
      const steps = samples.slice(1).map((sample, index) => Math.abs(sample - (samples[index] as number)))
      expect(Math.max(...steps)).toBeLessThan(sineStep * 1.1)
    })
  }
})

describe('the tones have the same bytes on each build', () => {
  // A tone change moves these on purpose: write the new digests with the reason in the commit body.
  it('pins the bytes of each clip by its SHA-256', () => {
    const digests = Object.fromEntries(KINDS.map((kind) => [kind, createHash('sha256').update(bytesOf(kind)).digest('hex')]))
    expect(digests).toEqual({
      'needs-you': '79a1c47fbce3725eec593bc5cbeea4e23226f53790d5c5d7c4b2efd5c53d6536',
      stuck: '135dcf2afbb6d1d92cd50e19e13947462cbf29f160a89be683ca9040a8db8967',
      done: '7fef5e7139a38c37ae7c10f5c54f082d7c72e7edf329643ccd0488ce277e0d1a',
    })
  })

  it('makes the samples with + - * / and Math.floor and Math.round only: no engine-made sine, power, log or random', () => {
    const source = stripComments(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tones.ts'), 'utf8'))
    expect(source).toContain('sineOfTurns(')
    expect(source.match(/Math\.(?:sin|cos|tan|exp|expm1|log\w*|pow|sqrt|cbrt|hypot|random|atan\w*|asin|acos)\b|\*\*|\bDate\b/g)).toBeNull()
  })

  it('computes a sine within 1e-7 of Math.sin over 3 turns, with exact values at 0, 1/4 and 1/2 turn', () => {
    let worst = 0
    for (let step = 0; step <= 30000; step += 1) {
      const turns = step / 10000
      worst = Math.max(worst, Math.abs(sineOfTurns(turns) - Math.sin(2 * Math.PI * turns)))
    }
    expect(worst).toBeLessThan(1e-7)
    expect(sineOfTurns(0)).toBe(0)
    expect(sineOfTurns(0.5)).toBe(0)
    expect(Math.abs(sineOfTurns(0.25) - 1)).toBeLessThan(1e-7)
  })
})

describe('base64', () => {
  it('matches the RFC 4648 test vectors', () => {
    const encode = (text: string): string => base64(new TextEncoder().encode(text))
    expect(['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar'].map(encode)).toEqual(['', 'Zg==', 'Zm8=', 'Zm9v', 'Zm9vYg==', 'Zm9vYmE=', 'Zm9vYmFy'])
  })

  it('matches the Node encoder on every byte value and on each clip', () => {
    const every = Uint8Array.from({ length: 256 }, (_, index) => index)
    for (const length of [256, 255, 254]) expect(base64(every.slice(0, length))).toBe(Buffer.from(every.slice(0, length)).toString('base64'))
    for (const kind of KINDS) expect(TONES[kind].base64).toBe(Buffer.from(bytesOf(kind)).toString('base64'))
  })
})
