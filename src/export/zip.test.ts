/**
 * The stored zip writer. The expected values come from outside the writer: the published CRC-32 check values, and a
 * reader written here from the ZIP format note (local header, central directory, end record). When `unzip` is on PATH,
 * it tests the archive too.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, storedZip, ZipInputError } from './zip.js'

const CHECK = '123456789'
const FOX = 'The quick brown fox jumps over the lazy dog'

interface ReadEntry {
  name: string
  method: number
  crc: number
  size: number
  time: number
  date: number
  external: number
  madeBy: number
  data: string
}

/** A reader from the format note: the end record, then each central entry, then its local header and data. */
function readZip(zip: Uint8Array): ReadEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const end = zip.byteLength - 22
  expect(view.getUint32(end, true), 'end record signature').toBe(0x06054b50)
  const count = view.getUint16(end + 10, true)
  const cdSize = view.getUint32(end + 12, true)
  const cdStart = view.getUint32(end + 16, true)
  expect(cdStart + cdSize, 'the central directory ends where the end record starts').toBe(end)
  const entries: ReadEntry[] = []
  let at = cdStart
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true), 'central header signature').toBe(0x02014b50)
    const nameLength = view.getUint16(at + 28, true)
    const extra = view.getUint16(at + 30, true)
    const comment = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength))
    const size = view.getUint32(at + 24, true)
    expect(view.getUint32(local, true), 'local header signature').toBe(0x04034b50)
    expect(view.getUint32(local + 14, true), 'the local CRC equals the central CRC').toBe(view.getUint32(at + 16, true))
    const localName = view.getUint16(local + 26, true)
    const localExtra = view.getUint16(local + 28, true)
    const dataStart = local + 30 + localName + localExtra
    entries.push({
      name,
      method: view.getUint16(at + 10, true),
      crc: view.getUint32(at + 16, true),
      size,
      time: view.getUint16(at + 12, true),
      date: view.getUint16(at + 14, true),
      external: view.getUint32(at + 38, true),
      madeBy: view.getUint16(at + 4, true),
      data: new TextDecoder().decode(zip.subarray(dataStart, dataStart + size)),
    })
    at += 46 + nameLength + extra + comment
  }
  return entries
}

const FIXTURE = [
  { name: 'pack/notes/fox.txt', data: FOX },
  { name: 'pack/', data: '' },
  { name: 'pack/check.txt', data: new TextEncoder().encode(CHECK) },
]

describe('crc32', () => {
  it('gives the published CRC-32 check values', () => {
    expect(crc32(new Uint8Array())).toBe(0)
    expect(crc32(new TextEncoder().encode(CHECK))).toBe(0xcbf43926)
    expect(crc32(new TextEncoder().encode(FOX))).toBe(0x414fa339)
  })
})

describe('storedZip', () => {
  it('stores each entry with its CRC-32, sorted by name, at a fixed time', () => {
    const entries = readZip(storedZip(FIXTURE))
    expect(entries.map((e) => e.name)).toEqual(['pack/', 'pack/check.txt', 'pack/notes/fox.txt'])
    const [folder, check, fox] = entries
    expect(check).toMatchObject({ method: 0, crc: 0xcbf43926, size: 9, data: CHECK })
    expect(fox).toMatchObject({ method: 0, crc: 0x414fa339, size: FOX.length, data: FOX })
    expect(folder).toMatchObject({ method: 0, crc: 0, size: 0, data: '' })
    // 1980-01-01 00:00:00, the first MS-DOS date: no clock reaches the archive
    for (const entry of entries) expect([entry.date, entry.time]).toEqual([0x0021, 0])
    // made on Unix (3), so the mode is in the high half of the external attributes: 0644 files, 0755 folders
    for (const entry of entries) expect(entry.madeBy >> 8).toBe(3)
    expect(check!.external >>> 16).toBe(0o100644)
    expect(folder!.external >>> 16).toBe(0o040755)
    expect(folder!.external & 0x10, 'the MS-DOS folder bit').toBe(0x10)
  })

  it('gives the same bytes on 2 runs, in any input order', () => {
    const first = storedZip(FIXTURE)
    const second = storedZip([...FIXTURE].reverse())
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true)
    expect(Buffer.from(storedZip(FIXTURE)).equals(Buffer.from(first))).toBe(true)
  })

  it('gives an empty archive: only the end record', () => {
    expect(Array.from(storedZip([]))).toEqual([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)])
  })

  it('refuses a name that can leave the folder of the archive, a duplicate, and a folder with data', () => {
    const bad = ['', '/abs.txt', '../up.txt', 'a/../b.txt', 'a/./b.txt', 'a//b.txt', 'back\\slash.txt', 'sp ace.txt', 'ünï.txt', 'C:/x.txt', `${'a'.repeat(256)}.txt`]
    for (const name of bad) expect(() => storedZip([{ name, data: 'x' }]), JSON.stringify(name)).toThrow(ZipInputError)
    expect(() => storedZip([{ name: 'a.txt', data: 'x' }, { name: 'a.txt', data: 'y' }])).toThrow(/a\.txt/)
    expect(() => storedZip([{ name: 'dir/', data: 'x' }])).toThrow(ZipInputError)
  })

  const unzip = spawnSync('unzip', ['-v'], { encoding: 'utf8' })
  it.skipIf(unzip.status !== 0)('passes the archive test of unzip', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orangu-zip-')), 'pack.zip')
    writeFileSync(path, storedZip(FIXTURE))
    const run = spawnSync('unzip', ['-t', path], { encoding: 'utf8' })
    expect(run.status, run.stdout + run.stderr).toBe(0)
    expect(run.stdout).toContain('No errors detected')
    expect(spawnSync('unzip', ['-p', path, 'pack/check.txt'], { encoding: 'utf8' }).stdout).toBe(CHECK)
  })
})
