import { beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { checkText } from '../../ste/index.js'
import { MAX_EVIDENCE_ARTIFACT_BYTES } from '../../suggest/evidence.js'
import { cmdSte, type SteIo } from './ste.js'

let dir: string
let written: string[]

/** a file path in this test's own folder */
const at = (name: string): string => join(dir, name)

const io = (stdin: string | Buffer = ''): SteIo => ({
  stdin: Readable.from([Buffer.from(stdin)]),
  stdout: {
    write: (chunk: string) => {
      written.push(chunk)
      return true
    },
  },
})
const stdout = (): string => written.join('')

beforeEach(() => {
  written = []
  dir = mkdtempSync(join(tmpdir(), 'orangu-ste-'))
})

const LONG = 'The checker reads this file as Markdown and finds one sentence in it that has more words than the limit of twenty-five words for a description.'

describe('orangu ste', () => {
  it('reports each file in the order given, and resolves (exit 0) when it finds a finding', async () => {
    writeFileSync(at('a.md'), `${LONG}\n`)
    writeFileSync(at('b.txt'), 'Run the check.\n')
    await cmdSte([at('a.md'), at('b.txt')], {}, io())
    expect(stdout()).toBe(
      [
        `${at('a.md')}:1  sentence-length  "The checker reads this file as Markdown and finds one sentence in it that has more word..."  26 words: split it (limit 25)`,
        `${at('a.md')}: 1 sentences, 0 clean, STE score 0%, 1 findings`,
        `${at('b.txt')}: 1 sentences, 1 clean, STE score 100%, 0 findings`,
        '',
      ].join('\n'),
    )
  })

  it('scores the frontmatter description of a .md file, and not of stdin', async () => {
    const text = `---\ndescription: ${LONG}\n---\n\nRun the check.\n`
    writeFileSync(at('skill.md'), text)
    await cmdSte([at('skill.md'), '-'], { json: true }, io(text))
    const [file, stdin] = JSON.parse(stdout()) as Array<{ file: string }>
    expect(file).toEqual({ file: at('skill.md'), ...checkText(text, { frontmatter: true }) })
    expect(stdin).toEqual({ file: '-', ...checkText(text) })
    expect(checkText(text, { frontmatter: true }).findings).toHaveLength(1)
  })

  it('--lines makes each line its own block, for columnar text', async () => {
    const text = 'Run the check\nRead the result\n'
    writeFileSync(at('help.txt'), text)
    await cmdSte([at('help.txt')], { json: true, lines: true }, io())
    const [result] = JSON.parse(stdout()) as Array<{ sentences: number }>
    expect(result).toEqual({ file: at('help.txt'), ...checkText(text, { lines: true }) })
    expect(result!.sentences).toBe(2)
    expect(checkText(text).sentences).toBe(1)
  })

  it('scores .htm and .HTML files as HTML', async () => {
    const html = '<p>Run the check.</p><script>const a = 1; const b = 2</script><p>Read it.</p>'
    writeFileSync(at('a.htm'), html)
    writeFileSync(at('b.HTML'), html)
    await cmdSte([at('a.htm'), at('b.HTML')], { json: true }, io())
    expect(JSON.parse(stdout())).toEqual([
      { file: at('a.htm'), ...checkText(html, { html: true }) },
      { file: at('b.HTML'), ...checkText(html, { html: true }) },
    ])
    expect(checkText(html, { html: true }).findings).toEqual([])
  })

  it('follows a symbolic link to a file, as any reader of a named file does', async () => {
    writeFileSync(at('target.md'), 'Run the check.\n')
    symlinkSync(at('target.md'), at('link.md'))
    await cmdSte([at('link.md')], {}, io())
    expect(stdout()).toBe(`${at('link.md')}: 1 sentences, 1 clean, STE score 100%, 0 findings\n`)
  })

  it('refuses a usage error: no file, stdin twice, or a flag that it does not read', async () => {
    await expect(cmdSte([], {}, io())).rejects.toThrow(/^usage: orangu ste <file\.\.\.\|-> \[--json\] \[--lines\]/)
    await expect(cmdSte(['-', '-'], {}, io('text'))).rejects.toThrow(/stdin/)
    await expect(cmdSte([at('a.md')], { open: true }, io())).rejects.toThrow('--open is not an orangu ste flag')
    await expect(cmdSte([at('a.md')], { out: 'x.json' }, io())).rejects.toThrow('--out is not an orangu ste flag')
    await expect(cmdSte([at('a.md')], { s: true }, io())).rejects.toThrow('-s is not an orangu ste flag')
    expect(stdout()).toBe('')
  })

  it('refuses a file that it cannot read, and prints nothing for the files before it', async () => {
    writeFileSync(at('ok.md'), 'Run the check.\n')
    mkdirSync(at('folder'))
    writeFileSync(at('locked.md'), 'Run the check.\n')
    chmodSync(at('locked.md'), 0o000)
    await expect(cmdSte([at('ok.md'), at('missing.md')], {}, io())).rejects.toThrow(`orangu ste cannot read ${at('missing.md')}: the file does not exist.`)
    await expect(cmdSte([at('ok.md'), at('folder')], {}, io())).rejects.toThrow(`orangu ste cannot read ${at('folder')}: it is a folder, not a file.`)
    if (process.getuid?.() !== 0) await expect(cmdSte([at('locked.md')], {}, io())).rejects.toThrow(`orangu ste cannot read ${at('locked.md')}: permission denied.`)
    expect(stdout()).toBe('')
  })

  it('refuses a file or stdin over the input bound, the evidence artifact bound', async () => {
    writeFileSync(at('big.md'), '')
    truncateSync(at('big.md'), MAX_EVIDENCE_ARTIFACT_BYTES + 1)
    await expect(cmdSte([at('big.md')], {}, io())).rejects.toThrow(`${at('big.md')} has more than ${MAX_EVIDENCE_ARTIFACT_BYTES} bytes, the most that orangu ste reads.`)
    await expect(cmdSte(['-'], {}, io(Buffer.alloc(MAX_EVIDENCE_ARTIFACT_BYTES + 1, 0x61)))).rejects.toThrow(`- has more than ${MAX_EVIDENCE_ARTIFACT_BYTES} bytes`)
    expect(stdout()).toBe('')
  })

  it('reads an input at the bound whole', async () => {
    writeFileSync(at('edge.txt'), '')
    truncateSync(at('edge.txt'), MAX_EVIDENCE_ARTIFACT_BYTES)
    await cmdSte([at('edge.txt'), '-'], { json: true }, io(Buffer.alloc(MAX_EVIDENCE_ARTIFACT_BYTES, 0x20)))
    expect((JSON.parse(stdout()) as Array<{ sentences: number }>).map((r) => r.sentences)).toEqual([0, 0])
  })
})
