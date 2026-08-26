import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonlFile, parseJsonlText } from './jsonl.js'

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'orangu-jsonl-'))
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

describe('parseJsonlText', () => {
  it('parses well-formed lines and reports zero bad lines', () => {
    const r = parseJsonlText('{"a":1}\n{"b":2}\n')
    expect(r.records).toEqual([{ a: 1 }, { b: 2 }])
    expect(r.badLines).toBe(0)
    expect(r.totalLines).toBe(2)
  })

  it('skips corrupted lines, counts them, and keeps line numbers for the good ones', () => {
    const r = parseJsonlText('{"a":1}\n{not json\n\n{"c":3}')
    expect(r.records).toEqual([{ a: 1 }, { c: 3 }])
    expect(r.badLines).toBe(1)
    expect(r.lineNumbers).toEqual([1, 4])
  })

  it('ignores non-object JSON values (arrays, numbers) but counts them as bad', () => {
    const r = parseJsonlText('[1,2]\n42\n{"ok":true}\n')
    expect(r.records).toEqual([{ ok: true }])
    expect(r.badLines).toBe(2)
  })

  it('handles CRLF and a trailing partial line (live file being written)', () => {
    const r = parseJsonlText('{"a":1}\r\n{"b":2}\r\n{"partial":')
    expect(r.records).toEqual([{ a: 1 }, { b: 2 }])
    expect(r.badLines).toBe(1)
    expect(r.trailingPartial).toBe(true)
  })
})

describe('readJsonlFile', () => {
  it('streams a file and returns records with byte offset bookkeeping', async () => {
    const p = tmpFile('s.jsonl', '{"type":"user"}\n{"type":"assistant"}\n')
    const r = await readJsonlFile(p)
    expect(r.records.map((x) => x['type'])).toEqual(['user', 'assistant'])
    expect(r.bytesRead).toBe(Buffer.byteLength('{"type":"user"}\n{"type":"assistant"}\n'))
  })

  it('supports reading from a byte offset (incremental tail for --watch)', async () => {
    const first = '{"type":"user"}\n'
    const p = tmpFile('s.jsonl', first + '{"type":"assistant"}\n')
    const r = await readJsonlFile(p, { fromByte: Buffer.byteLength(first) })
    expect(r.records.map((x) => x['type'])).toEqual(['assistant'])
  })

  it('does not throw on a very long line (>1MB)', async () => {
    const big = JSON.stringify({ type: 'user', blob: 'x'.repeat(1_500_000) })
    const p = tmpFile('big.jsonl', big + '\n{"type":"assistant"}\n')
    const r = await readJsonlFile(p)
    expect(r.records.length).toBe(2)
    expect(r.maxLineBytes).toBeGreaterThan(1_000_000)
  })

  it('fails before decoding an oversized line', async () => {
    const p = tmpFile('oversized-line.jsonl', JSON.stringify({ blob: 'x'.repeat(128) }) + '\n')
    await expect(readJsonlFile(p, { maxLineBytes: 64 })).rejects.toThrow(/line exceeds 64 bytes/)
  })

  it('bounds retained records independently of the byte ceiling', async () => {
    const p = tmpFile('too-many-records.jsonl', '{}\n{}\n{}\n')
    await expect(readJsonlFile(p, { maxRecords: 2 })).rejects.toThrow(/exceeds 2 records/)
  })
})
