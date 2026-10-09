/**
 * The 3 alert tones of orangu god, made from code when the module loads: no audio file ships, and no tone comes
 * from a third party. Each tone is a WAV clip (16-bit PCM, 1 channel, 16000 Hz) as base64 with the MIME type
 * audio/wav, which the engine plays as bytes.
 * - needs-you: 2 short notes that go up (660 Hz, then 880 Hz), 320 ms;
 * - stuck: 2 lower notes that go down (440 Hz, then 330 Hz), 400 ms;
 * - done: 1 soft note (784 Hz), 240 ms.
 * Each note is a sine at a quarter of full scale. It fades in over 8 ms and fades out to 0 at its last sample,
 * so a clip starts and ends at 0 and does not click, also between 2 notes.
 *
 * The bytes are the same on each build and in each engine: the samples come from + - * / and Math.floor and
 * Math.round only, which the language defines to the last bit. The language lets each engine approximate
 * Math.sin, so sineOfTurns computes its own. The header numbers are decimal, and the 4-letter chunk names are text.
 */
import type { ToneClip } from '../host.js'
import type { AlertKind } from '../types.js'

/** The sample rate of each tone: 16 samples in 1 ms, far above the 880 Hz top note. */
export const TONE_SAMPLE_RATE = 16000

/** A quarter of full scale, so each tone is soft. */
const AMPLITUDE = 0.25
const FULL_SCALE = 32767
const FADE_IN_MS = 8

const HEADER_BYTES = 44
const FMT_CHUNK_BYTES = 16
const PCM_FORMAT = 1
const CHANNELS = 1
const BITS_PER_SAMPLE = 16
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8

/** 1 note of a tone: a sine from `fromMs` to `toMs`. */
type Note = { hz: number; fromMs: number; toMs: number }

const TONE_NOTES: Readonly<Record<AlertKind, readonly Note[]>> = {
  'needs-you': [
    { hz: 660, fromMs: 0, toMs: 140 },
    { hz: 880, fromMs: 140, toMs: 320 },
  ],
  stuck: [
    { hz: 440, fromMs: 0, toMs: 180 },
    { hz: 330, fromMs: 180, toMs: 400 },
  ],
  done: [{ hz: 784, fromMs: 0, toMs: 240 }],
}

// ---------- samples ----------

/**
 * sin(2 pi t) for t in turns, from + - * / and Math.floor only. The turn folds into a quarter turn on each side
 * of 0, where the sine series to the 11th power is within 1e-7 of the true value.
 */
export function sineOfTurns(turns: number): number {
  const turn = turns - Math.floor(turns)
  const folded = turn < 0.25 ? turn : turn < 0.75 ? 0.5 - turn : turn - 1
  const x = 2 * Math.PI * folded
  const x2 = x * x
  return x * (1 - (x2 / 6) * (1 - (x2 / 20) * (1 - (x2 / 42) * (1 - (x2 / 72) * (1 - x2 / 110)))))
}

/** The level of a note at its sample `index` of `length`: a smooth fade in, then a fall to 0 at the last sample. */
function envelope(index: number, length: number, fadeIn: number): number {
  if (index < fadeIn) {
    const t = index / fadeIn
    return t * t * (3 - 2 * t)
  }
  const left = 1 - (index - fadeIn) / (length - 1 - fadeIn)
  return left * left
}

const samplesIn = (ms: number): number => Math.round((ms * TONE_SAMPLE_RATE) / 1000)

/**
 * The 16-bit samples of the given notes, each note at its place in the clip. The notes add, and each one starts
 * and ends at 0, so 2 notes that touch or overlap make no cut.
 */
function toneSamples(notes: readonly Note[]): number[] {
  const levels: number[] = new Array<number>(samplesIn(Math.max(...notes.map((note) => note.toMs)))).fill(0)
  const fadeIn = samplesIn(FADE_IN_MS)
  for (const note of notes) {
    const start = samplesIn(note.fromMs)
    const length = samplesIn(note.toMs) - start
    for (let index = 0; index < length; index += 1) {
      levels[start + index] = (levels[start + index] ?? 0) + AMPLITUDE * envelope(index, length, fadeIn) * sineOfTurns((index * note.hz) / TONE_SAMPLE_RATE)
    }
  }
  return levels.map((level) => Math.round(level * FULL_SCALE))
}

// ---------- WAV ----------

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0))
/** The low `bytes` bytes of a whole number below 2^32, the low byte first. */
const littleEndian = (value: number, bytes: number): number[] => Array.from({ length: bytes }, (_, index) => (value >>> (8 * index)) & 255)

/** A WAV file of 16-bit PCM samples, 1 channel, at the given sample rate. Each sample is a whole number in [-32768, 32767]. */
export function wavBytes(samples: readonly number[], sampleRate: number): Uint8Array {
  const dataBytes = samples.length * BYTES_PER_SAMPLE
  const header = [
    ...ascii('RIFF'),
    ...littleEndian(HEADER_BYTES - 8 + dataBytes, 4),
    ...ascii('WAVE'),
    ...ascii('fmt '),
    ...littleEndian(FMT_CHUNK_BYTES, 4),
    ...littleEndian(PCM_FORMAT, 2),
    ...littleEndian(CHANNELS, 2),
    ...littleEndian(sampleRate, 4),
    ...littleEndian(sampleRate * CHANNELS * BYTES_PER_SAMPLE, 4),
    ...littleEndian(CHANNELS * BYTES_PER_SAMPLE, 2),
    ...littleEndian(BITS_PER_SAMPLE, 2),
    ...ascii('data'),
    ...littleEndian(dataBytes, 4),
  ]
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes)
  bytes.set(header)
  samples.forEach((sample, index) => {
    bytes[HEADER_BYTES + 2 * index] = sample & 255
    bytes[HEADER_BYTES + 2 * index + 1] = (sample >> 8) & 255
  })
  return bytes
}

// ---------- base64 ----------

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** The standard base64 text of the bytes, with `=` padding (RFC 4648). */
export function base64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let at = 0; at < bytes.length; at += 3) {
    const group = ((bytes[at] ?? 0) << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0)
    const digit = (shift: number): string => BASE64_ALPHABET.charAt((group >> shift) & 63)
    parts.push(digit(18), digit(12), at + 1 < bytes.length ? digit(6) : '=', at + 2 < bytes.length ? digit(0) : '=')
  }
  return parts.join('')
}

// ---------- the clips ----------

const clipOf = (notes: readonly Note[]): ToneClip => ({ base64: base64(wavBytes(toneSamples(notes), TONE_SAMPLE_RATE)), mime: 'audio/wav' })

/** The tone of each alert kind, made once when the module loads. */
export const TONES: Readonly<Record<AlertKind, ToneClip>> = {
  'needs-you': clipOf(TONE_NOTES['needs-you']),
  stuck: clipOf(TONE_NOTES.stuck),
  done: clipOf(TONE_NOTES.done),
}
