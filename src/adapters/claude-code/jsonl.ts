/**
 * Resilient JSONL reading.
 *
 * Design goals:
 * - never throw on a corrupted or partial line (live files are written mid-turn); count instead
 * - stream: never hold the whole file as one string when reading from disk
 * - support incremental reads from a byte offset (used by --watch)
 * - keep line numbers so a raw-explorer can jump back to the source line
 */
import { constants, createReadStream } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'

export type JsonObject = Record<string, unknown>

export interface JsonlParseResult {
  records: JsonObject[]
  /** 1-based line number of each record in `records` */
  lineNumbers: number[]
  totalLines: number
  badLines: number
  /** true when the input ended without a trailing newline and the last fragment did not parse */
  trailingPartial: boolean
  maxLineBytes: number
}

export interface ReadJsonlOptions {
  /** start reading at this byte offset (incremental tail) */
  fromByte?: number
  /** Maximum physical bytes retained by one read. */
  maxBytes?: number
  /** Maximum bytes in one JSONL record before decoding/parsing. */
  maxLineBytes?: number
  /** Maximum non-empty records (valid or malformed) retained/counted. */
  maxRecords?: number
  /** Maximum total size of this file, independent of an incremental offset. */
  maxFileBytes?: number
  /** Open the path with O_NOFOLLOW and stream through that descriptor. */
  noFollow?: boolean
}

export interface JsonlFileResult extends JsonlParseResult {
  /** number of bytes consumed from `fromByte` to the end of the last complete line */
  bytesRead: number
  /** absolute byte offset just after the last complete line (pass as fromByte next time) */
  nextByte: number
  fileSize: number
  /** Descriptor identity used by incremental tails to detect path replacement. */
  fileIdentity?: JsonlFileIdentity
}

export interface JsonlFileIdentity {
  device: string
  inode: string
}

/** A JSONL result read from an already-open descriptor. `physicalBytesRead` is
 * the exact number of bytes obtained from that descriptor, including an
 * unterminated trailing fragment. */
export interface JsonlHandleResult extends JsonlFileResult {
  physicalBytesRead: number
}

export interface ReadJsonlHandleOptions extends ReadJsonlOptions {
  /** Immutable size snapshot chosen by the caller before streaming. */
  fileSize: number
}

export const DEFAULT_MAX_JSONL_BYTES = 256 * 1024 * 1024
export const DEFAULT_MAX_JSONL_LINE_BYTES = 8 * 1024 * 1024
export const DEFAULT_MAX_JSONL_RECORDS = 100_000

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse a whole JSONL string. Used for tests and for small in-memory inputs. */
export function parseJsonlText(text: string): JsonlParseResult {
  const records: JsonObject[] = []
  const lineNumbers: number[] = []
  let badLines = 0
  let maxLineBytes = 0
  let trailingPartial = false
  const lines = text.split('\n')
  const endsWithNewline = text.endsWith('\n')
  // split() on a text ending with '\n' yields a final '' element; ignore it
  const last = endsWithNewline ? lines.length - 1 : lines.length
  let totalLines = 0
  for (let i = 0; i < last; i++) {
    let line = lines[i] as string
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line.length === 0) continue
    totalLines++
    const bytes = Buffer.byteLength(line)
    if (bytes > maxLineBytes) maxLineBytes = bytes
    const parsed = tryParseObject(line)
    if (parsed) {
      records.push(parsed)
      lineNumbers.push(i + 1)
    } else {
      badLines++
      if (!endsWithNewline && i === last - 1) trailingPartial = true
    }
  }
  return { records, lineNumbers, totalLines, badLines, trailingPartial, maxLineBytes }
}

export function tryParseObject(line: string): JsonObject | null {
  const t = line.charCodeAt(0)
  // fast reject: a JSONL record must be an object
  if (t !== 123 /* { */) return null
  try {
    const v: unknown = JSON.parse(line)
    return isPlainObject(v) ? v : null
  } catch {
    return null
  }
}

function emptyJsonlResult(fromByte: number, fileSize: number): JsonlHandleResult {
  return {
    records: [],
    lineNumbers: [],
    totalLines: 0,
    badLines: 0,
    trailingPartial: false,
    maxLineBytes: 0,
    bytesRead: 0,
    nextByte: fromByte,
    fileSize,
    physicalBytesRead: 0,
  }
}

async function parseJsonlChunks(
  chunks: AsyncIterable<Buffer>,
  fromByte: number,
  fileSize: number,
  maxBytes?: number,
  maxRecordBytes = DEFAULT_MAX_JSONL_LINE_BYTES,
  maxRecords = DEFAULT_MAX_JSONL_RECORDS,
): Promise<JsonlHandleResult> {
  const records: JsonObject[] = []
  const lineNumbers: number[] = []
  let totalLines = 0
  let badLines = 0
  let maxLineBytes = 0
  let trailingPartial = false
  let lineNo = 0
  let carry: Buffer[] = []
  let carryLen = 0

  const handleLine = (buf: Buffer, terminated: boolean) => {
    lineNo++
    if (buf.length > maxRecordBytes) throw new Error(`JSONL line exceeds ${maxRecordBytes} bytes`)
    let s = buf.toString('utf8')
    if (s.endsWith('\r')) s = s.slice(0, -1)
    if (s.length === 0) return
    totalLines++
    if (totalLines > maxRecords) throw new Error(`JSONL input exceeds ${maxRecords} records`)
    if (buf.length > maxLineBytes) maxLineBytes = buf.length
    const parsed = tryParseObject(s)
    if (parsed) {
      records.push(parsed)
      lineNumbers.push(lineNo)
    } else {
      badLines++
      if (!terminated) trailingPartial = true
    }
  }

  if (fromByte >= fileSize) {
    return { records, lineNumbers, totalLines, badLines, trailingPartial, maxLineBytes, bytesRead: 0, nextByte: fromByte, fileSize, physicalBytesRead: 0 }
  }

  let streamed = 0 // exact bytes seen; the file may grow while we read it (live session)
  for await (const chunk of chunks) {
    streamed += chunk.length
    if (maxBytes !== undefined && streamed > maxBytes) throw new Error(`JSONL input exceeds ${maxBytes} bytes`)
    let start = 0
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 10 /* \n */) {
        const piece = chunk.subarray(start, i)
        if (carryLen + piece.length > maxRecordBytes) throw new Error(`JSONL line exceeds ${maxRecordBytes} bytes`)
        const line = carryLen ? Buffer.concat([...carry, piece], carryLen + piece.length) : piece
        carry = []
        carryLen = 0
        handleLine(line, true)
        start = i + 1
      }
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start)
      if (carryLen + rest.length > maxRecordBytes) throw new Error(`JSONL line exceeds ${maxRecordBytes} bytes`)
      carry.push(Buffer.from(rest))
      carryLen += rest.length
    }
  }
  // bytesRead = bytes of complete lines (+ their newline) = streamed bytes minus the unterminated carry.
  const bytesRead = streamed - carryLen
  if (carryLen > 0) {
    // trailing fragment without newline: try to parse it (a fully written last line without \n), else mark partial
    const line = Buffer.concat(carry, carryLen)
    const before = records.length
    handleLine(line, false)
    if (records.length > before) {
      // it parsed: count it as consumed
      return { records, lineNumbers, totalLines, badLines, trailingPartial, maxLineBytes, bytesRead: streamed, nextByte: fromByte + streamed, fileSize, physicalBytesRead: streamed }
    }
  }
  return { records, lineNumbers, totalLines, badLines, trailingPartial, maxLineBytes, bytesRead, nextByte: fromByte + bytesRead, fileSize, physicalBytesRead: streamed }
}

/** Stream a JSONL file from disk (optionally from a byte offset). */
export async function readJsonlFile(path: string, opts: ReadJsonlOptions = {}): Promise<JsonlFileResult> {
  const fromByte = opts.fromByte ?? 0
  if (opts.noFollow) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const st = await handle.stat({ bigint: true })
      if (!st.isFile()) throw new Error(`JSONL input must be a regular file: ${path}`)
      if (st.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`JSONL input is too large to address safely: ${path}`)
      const fileSize = Number(st.size)
      if (opts.maxFileBytes !== undefined && fileSize > opts.maxFileBytes) {
        throw new Error(`JSONL input exceeds the ${opts.maxFileBytes}-byte file budget`)
      }
      const value = await readJsonlHandle(handle, { ...opts, fileSize })
      const { physicalBytesRead: _physicalBytesRead, ...result } = value
      return { ...result, fileIdentity: { device: String(st.dev), inode: String(st.ino) } }
    } finally {
      await handle.close()
    }
  }
  const st = await stat(path, { bigint: true })
  if (st.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`JSONL input is too large to address safely: ${path}`)
  const fileSize = Number(st.size)
  if (opts.maxFileBytes !== undefined && fileSize > opts.maxFileBytes) {
    throw new Error(`JSONL input exceeds the ${opts.maxFileBytes}-byte file budget`)
  }
  const fileIdentity = { device: String(st.dev), inode: String(st.ino) }
  if (fromByte >= fileSize) {
    const { physicalBytesRead: _physicalBytesRead, ...result } = emptyJsonlResult(fromByte, fileSize)
    return { ...result, fileIdentity }
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSONL_BYTES
  if (fileSize - fromByte > maxBytes) throw new Error(`JSONL input exceeds ${maxBytes} bytes`)
  const stream = createReadStream(path, { start: fromByte, highWaterMark: 1 << 20 })
  const { physicalBytesRead: _physicalBytesRead, ...result } = await parseJsonlChunks(
    stream as AsyncIterable<Buffer>,
    fromByte,
    fileSize,
    maxBytes,
    opts.maxLineBytes,
    opts.maxRecords,
  )
  return { ...result, fileIdentity }
}

/** Stream exactly the caller-selected size from an already-open file handle.
 * The handle remains owned by the caller and is never closed here. */
export async function readJsonlHandle(handle: FileHandle, opts: ReadJsonlHandleOptions): Promise<JsonlHandleResult> {
  const fromByte = opts.fromByte ?? 0
  if (fromByte >= opts.fileSize) return emptyJsonlResult(fromByte, opts.fileSize)
  const end = opts.fileSize > fromByte ? opts.fileSize - 1 : fromByte
  const stream = handle.createReadStream({ start: fromByte, end, highWaterMark: 1 << 20, autoClose: false })
  return parseJsonlChunks(
    stream as AsyncIterable<Buffer>,
    fromByte,
    opts.fileSize,
    opts.maxBytes ?? DEFAULT_MAX_JSONL_BYTES,
    opts.maxLineBytes,
    opts.maxRecords,
  )
}
