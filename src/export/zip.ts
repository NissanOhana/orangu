/**
 * A deterministic zip writer, with no dependency: stored entries (no compression), names sorted by their bytes, 1
 * fixed time, and CRC-32 in code. The same entries give the same bytes on each run, so a generated module can carry
 * the input and `verify:generated` compares text, not a binary file.
 *
 * The format is the PKWARE application note: a local header and the data for each entry, then the central directory,
 * then the end record. It writes no ZIP64 record, so it refuses more than 65,535 entries or 4 GiB. A name is a relative
 * path of plain parts (letters, digits, dot, dash, underscore), so no entry can leave the folder that an unzip makes.
 */

export interface ZipEntry {
  /** a relative path with `/` between its parts. A name that ends with `/` is a folder, and a folder holds no data. */
  name: string
  /** the bytes, or text that the writer encodes as UTF-8 */
  data: Uint8Array | string
}

/** An entry that the writer refuses. The message names the entry and the rule. */
export class ZipInputError extends Error {
  override readonly name = 'ZipInputError'
}

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50
/** version 2.0 of the format: the version that a folder entry needs */
const VERSION = 20
/** made on Unix (3), so an unzip reads the mode from the high half of the external attributes */
const MADE_BY = (3 << 8) | VERSION
/** 1980-01-01 00:00:00, the first MS-DOS date: the archive holds no clock */
const DOS_DATE = (0 << 9) | (1 << 5) | 1
const DOS_TIME = 0
/** a regular file with mode 0644, and a folder with mode 0755 and the MS-DOS folder bit */
const FILE_ATTRIBUTES = (0o100644 << 16) >>> 0
const FOLDER_ATTRIBUTES = ((0o040755 << 16) | 0x10) >>> 0
const MAX_ENTRIES = 0xffff
const MAX_BYTES = 0xffffffff
/** the longest name in bytes: a bound of the writer, far above any name of the portable skill */
const MAX_NAME_BYTES = 255
const PART = /^(?!\.\.?$)[A-Za-z0-9._-]+$/

let table: Uint32Array | undefined

/** The CRC-32 of the format (polynomial 0xEDB88320, reflected), as an unsigned 32-bit number. */
export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

interface Item {
  name: Uint8Array
  label: string
  data: Uint8Array
  folder: boolean
  crc: number
}

function item(entry: ZipEntry): Item {
  const folder = entry.name.endsWith('/')
  const parts = (folder ? entry.name.slice(0, -1) : entry.name).split('/')
  if (!parts.every((part) => PART.test(part))) {
    throw new ZipInputError(`${JSON.stringify(entry.name)} is not a safe entry name: use relative parts of letters, digits, dot, dash and underscore.`)
  }
  const name = new TextEncoder().encode(entry.name)
  if (name.length > MAX_NAME_BYTES) throw new ZipInputError(`${JSON.stringify(entry.name)} is longer than ${MAX_NAME_BYTES} bytes.`)
  const data = typeof entry.data === 'string' ? new TextEncoder().encode(entry.data) : entry.data
  if (folder && data.length) throw new ZipInputError(`${JSON.stringify(entry.name)} is a folder, so it holds no data.`)
  return { name, label: entry.name, data, folder, crc: crc32(data) }
}

/** The 30 B local header of an entry, before its name. */
function localHeader(it: Item): Uint8Array {
  const out = new Uint8Array(30 + it.name.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, LOCAL_SIGNATURE, true)
  view.setUint16(4, VERSION, true)
  // 6: no flag. 8: method 0, stored
  view.setUint16(10, DOS_TIME, true)
  view.setUint16(12, DOS_DATE, true)
  view.setUint32(14, it.crc, true)
  view.setUint32(18, it.data.length, true)
  view.setUint32(22, it.data.length, true)
  view.setUint16(26, it.name.length, true)
  out.set(it.name, 30)
  return out
}

/** The 46 B central directory header of an entry, before its name. */
function centralHeader(it: Item, offset: number): Uint8Array {
  const out = new Uint8Array(46 + it.name.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, CENTRAL_SIGNATURE, true)
  view.setUint16(4, MADE_BY, true)
  view.setUint16(6, VERSION, true)
  view.setUint16(12, DOS_TIME, true)
  view.setUint16(14, DOS_DATE, true)
  view.setUint32(16, it.crc, true)
  view.setUint32(20, it.data.length, true)
  view.setUint32(24, it.data.length, true)
  view.setUint16(28, it.name.length, true)
  // 30 to 37: no extra field, no comment, disk 0, no internal attribute
  view.setUint32(38, it.folder ? FOLDER_ATTRIBUTES : FILE_ATTRIBUTES, true)
  view.setUint32(42, offset, true)
  out.set(it.name, 46)
  return out
}

/** The 22 B end record: the entry count, and the size and the offset of the central directory. */
function endRecord(count: number, size: number, offset: number): Uint8Array {
  const out = new Uint8Array(22)
  const view = new DataView(out.buffer)
  view.setUint32(0, END_SIGNATURE, true)
  view.setUint16(8, count, true)
  view.setUint16(10, count, true)
  view.setUint32(12, size, true)
  view.setUint32(16, offset, true)
  return out
}

/** A stored zip archive of the entries, sorted by name. It refuses an unsafe name, a duplicate name and a folder with data. */
export function storedZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new ZipInputError(`A stored zip holds ${MAX_ENTRIES} entries at most.`)
  const items = entries.map(item).sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  for (let i = 1; i < items.length; i++) {
    if (items[i]!.label === items[i - 1]!.label) throw new ZipInputError(`${JSON.stringify(items[i]!.label)} is in the entries 2 times.`)
  }
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const it of items) {
    const local = localHeader(it)
    central.push(centralHeader(it, offset))
    parts.push(local, it.data)
    offset += local.length + it.data.length
  }
  const size = central.reduce((sum, header) => sum + header.length, 0)
  if (offset + size + 22 > MAX_BYTES) throw new ZipInputError('A stored zip holds 4 GiB at most.')
  parts.push(...central, endRecord(items.length, size, offset))
  const out = new Uint8Array(offset + size + 22)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
