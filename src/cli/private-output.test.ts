import { describe, expect, it } from 'vitest'
import { lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { link, mkdir, mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OUTPUT_HEAD_BYTES, PrivateOutputError, isOranguOutput, writePrivateOutput } from './private-output.js'
import type { Aggregate } from '../analyze/aggregate.js'
import type { Analysis } from '../model/analysis.js'
import { projectEvidence } from '../suggest/evidence.js'
import { slimAnalysis } from '../suggest/slim.js'
import { prepareAggregateForOutput, renderPreparedAggregateJson } from './json-out.js'

async function tempPath(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'orangu-private-output-')), name)
}

// The head of each kind of file that orangu writes, as it writes it (src/report/render.ts, the show-me templates,
// the aggregate, harness, slim and evidence JSON). The e2e tests prove the same on the built CLI's real output.
const ORANGU_HTML = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8"/>\n<meta name="viewport" content="width=device-width, initial-scale=1"/>\n<meta http-equiv="Content-Security-Policy" content="default-src \'none\'"/>\n<meta name="generator" content="orangu 0.9.0"/>\n<title>orangu · x</title>\n</head>\n</html>'
const ORANGU_JSON = '{\n  "schemaVersion": "2",\n  "generatedAt": 1,\n  "scope": "repo x"\n}'

describe('writePrivateOutput', () => {
  it('creates private files and safely rewrites an existing orangu output', async () => {
    const path = await tempPath('report.html')
    await writePrivateOutput(path, ORANGU_HTML)
    await writePrivateOutput(path, `${ORANGU_HTML}\n<!-- second -->`)

    expect(readFileSync(path, 'utf8')).toBe(`${ORANGU_HTML}\n<!-- second -->`)
    expect(lstatSync(path).isFile()).toBe(true)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('tightens a permissive existing orangu output before replacing its contents', async () => {
    const path = await tempPath('aggregate.json')
    writeFileSync(path, ORANGU_JSON, { mode: 0o644 })

    await writePrivateOutput(path, `${ORANGU_JSON} `)

    expect(readFileSync(path, 'utf8')).toBe(`${ORANGU_JSON} `)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink without changing its target', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orangu-private-output-link-'))
    const outside = join(dir, 'outside.txt')
    const path = join(dir, 'report.html')
    writeFileSync(outside, 'outside')
    await symlink(outside, path)

    await expect(writePrivateOutput(path, 'secret')).rejects.toThrow(/symbolic link|changed during access/)
    expect(lstatSync(path).isSymbolicLink()).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('outside')
  })

  it.skipIf(process.platform === 'win32')('rejects multiply-linked files without changing their contents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orangu-private-output-hardlink-'))
    const outside = join(dir, 'outside.txt')
    const path = join(dir, 'report.html')
    writeFileSync(outside, ORANGU_HTML)
    await link(outside, path)

    await expect(writePrivateOutput(path, 'secret')).rejects.toThrow(/multiple hard links/)
    expect(readFileSync(outside, 'utf8')).toBe(ORANGU_HTML)
  })

  it('rejects non-regular targets', async () => {
    const path = await tempPath('directory')
    await mkdir(path)
    await expect(writePrivateOutput(path, 'secret')).rejects.toThrow()
  })

  // A steered model can run a pre-approved `orangu report … -o <path>`. The writer is the last line: it replaces only
  // a file that orangu wrote, and there is no flag to force it, because a steered model could add that flag too.
  it('refuses to replace a file that orangu did not write, and leaves its bytes and its mode as they were', async () => {
    const path = await tempPath('.zshrc')
    const rc = 'export PATH="$HOME/bin:$PATH"\nalias ll="ls -la"\n'
    writeFileSync(path, rc, { mode: 0o644 })

    const refused = writePrivateOutput(path, ORANGU_HTML)
    await expect(refused).rejects.toBeInstanceOf(PrivateOutputError)
    await expect(writePrivateOutput(path, ORANGU_HTML)).rejects.toThrow(
      `${path} is not an orangu output, so orangu did not change it. Choose a new path, or delete the file by hand and run the command again.`,
    )
    expect(readFileSync(path, 'utf8')).toBe(rc)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o644)
  })

  it('refuses an empty file, because orangu did not write it', async () => {
    const path = await tempPath('empty.html')
    writeFileSync(path, '', { mode: 0o644 })
    await expect(writePrivateOutput(path, ORANGU_HTML)).rejects.toThrow(/is not an orangu output/)
    expect(readFileSync(path, 'utf8')).toBe('')
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o644)
  })

  it('names the path on one line with no control characters, so a hostile file name cannot forge output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orangu-private-output-name-'))
    // a file name may hold any byte but `/` and NUL
    const path = join(dir, 'rc\x1b[2J\x1b]8;;https:x\x07\nerror: forged\tline')
    writeFileSync(path, 'user data\n')
    const message = await writePrivateOutput(path, ORANGU_HTML).then(
      () => '',
      (error: unknown) => (error as Error).message,
    )
    expect(message).toContain('is not an orangu output')
    expect(message).not.toMatch(/[\x00-\x1f\x7f]/)
    expect(readdirSync(dir)).toHaveLength(1)
    expect(readFileSync(path, 'utf8')).toBe('user data\n')
  })

  // A model can choose the -o path, and the CLI prints each error on the terminal: every refusal names the path on
  // one line, so a file name cannot clear the screen, set a link or forge a line of output.
  it.skipIf(process.platform === 'win32')('names a hostile path on one line in each refusal: symlink, hard link and directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orangu-private-output-hostile-'))
    const hostile = (kind: string) => join(dir, `${kind}\x1b[2J\x1b]8;;https:x\x07\nerror: forged\tline`)
    const outside = join(dir, 'outside.html')
    writeFileSync(outside, ORANGU_HTML)
    await symlink(outside, hostile('link'))
    await link(outside, hostile('hard'))
    await mkdir(hostile('dir'))
    for (const kind of ['link', 'hard', 'dir']) {
      const message = await writePrivateOutput(hostile(kind), 'secret').then(
        () => '',
        (error: unknown) => (error as Error).message,
      )
      expect(message, kind).toMatch(/symbolic link|changed during access|multiple hard links|regular file|written safely/)
      expect(message, kind).not.toMatch(/[\x00-\x1f\x7f]/)
    }
    expect(readFileSync(outside, 'utf8')).toBe(ORANGU_HTML)
  })

  it('replaces an orangu JSON output in its compact form too', async () => {
    const path = await tempPath('harness.json')
    writeFileSync(path, '{"schemaVersion":"2","generator":{"name":"orangu"}}', { mode: 0o600 })
    await writePrivateOutput(path, ORANGU_JSON)
    expect(readFileSync(path, 'utf8')).toBe(ORANGU_JSON)
  })
})

describe('isOranguOutput', () => {
  it('accepts the head of each kind of file that orangu writes', () => {
    const heads = [
      ORANGU_HTML,
      // the show-me templates: attributes on <html>, and a robots meta before the generator
      '<!doctype html>\n<html lang="en" data-scope="session">\n<head>\n<meta charset="utf-8"/>\n<meta name="robots" content="noindex"/>\n<meta name="generator" content="orangu 0.9.0"/>\n<title data-slot="title">x</title>',
      ORANGU_JSON,
      '{\n  "schemaVersion": "2",\n  "generator": {\n    "name": "orangu",',
      '{\n  "schemaVersion": "1",\n  "source": {\n    "kind": "aggregate",\n    "schemaVersion": "2",',
      '{"schemaVersion":"2","generatedAt":1,"scope":"global"}',
    ]
    for (const head of heads) expect(isOranguOutput(head), head).toBe(true)
  })

  // Each JSON file that orangu writes, built by its real writer from the golden corpus: analyze --json (pretty and
  // compact), the slim projection, the aggregate (repo/global --out) and both evidence bundles (show-me data.json).
  // The harness report is checked on the built CLI (src/cli/commands/harness.e2e.test.ts).
  it('accepts the head of each JSON output that orangu writes, from its real writer', () => {
    const analysis = JSON.parse(readFileSync(join(process.cwd(), 'test/golden/canonical.analysis.json'), 'utf8')) as Analysis
    const agg = JSON.parse(readFileSync(join(process.cwd(), 'test/golden/aggregate.json'), 'utf8')) as Aggregate
    const outputs: Record<string, string> = {
      'analyze --json': JSON.stringify(analysis, null, 2),
      'analyze --json --quiet': JSON.stringify(analysis),
      'analyze --json --slim': JSON.stringify(slimAnalysis(analysis), null, 2),
      'repo --out': renderPreparedAggregateJson(prepareAggregateForOutput(agg, {}), {}, { pretty: true, trailingNewline: false }),
      'evidence (session)': JSON.stringify(projectEvidence(analysis), null, 2),
      'evidence (repo)': JSON.stringify(projectEvidence(agg, { scope: 'repo' }), null, 2),
    }
    for (const [name, text] of Object.entries(outputs)) expect(isOranguOutput(text.slice(0, OUTPUT_HEAD_BYTES)), name).toBe(true)
  })

  it('accepts the head of both built show-me templates, so a rendered deck or report is an orangu output too', () => {
    for (const file of ['slides.html', 'report.html']) {
      const head = readFileSync(join(process.cwd(), 'plugin/skills/show-me/references', file), 'utf8').slice(0, OUTPUT_HEAD_BYTES)
      expect(isOranguOutput(head), file).toBe(true)
    }
  })

  it('refuses a file that only names the marker somewhere other than where orangu writes it', () => {
    const heads = [
      '',
      'export PATH="$HOME/bin:$PATH"\n',
      // a document that quotes the marker
      '# Notes\n\n<!doctype html>\n<html lang="en">\n<head>\n<meta name="generator" content="orangu 0.9.0"/>',
      '<!-- <!doctype html><html><head><meta name="generator" content="orangu 1"/> -->',
      // another generator, or the marker after the title
      '<!doctype html>\n<html lang="en">\n<head>\n<meta name="generator" content="Hugo 0.1"/>\n<title>x</title>',
      '<!doctype html>\n<html lang="en">\n<head>\n<title>x</title>\n<meta name="generator" content="orangu 0.9.0"/>',
      // JSON that is not an orangu output: a Docker manifest, an AWS SSM document, a key in the wrong place
      '{\n  "schemaVersion": 2,\n  "mediaType": "application/vnd.oci.image.manifest.v1+json"',
      '{\n  "schemaVersion": "2.2",\n  "description": "Run a shell script."',
      '{\n  "name": "x",\n  "schemaVersion": "2",\n  "generatedAt": 1',
      '[{"schemaVersion":"2","generatedAt":1}]',
      'alias x=1 # {"schemaVersion":"2","generatedAt":1}',
      // a file with sorted keys, or another tool's generator: orangu writes none of these shapes
      '{"schemaVersion":"1.0","source":{"url":"https://example.com"}}',
      '{\n  "schemaVersion": "1.0",\n  "source": "src",\n  "target": "dist"\n}',
      '{"schemaVersion":"1.0","generator":{"name":"other-tool","version":"1"}}',
      '{"schemaVersion":"1.0","generator":"other-tool"}',
      '{"schemaVersion":"1.0","generatedAt":"2026-10-07","owner":"x"}',
      '{"schemaVersion":"1.0","generatedAt":1}',
    ]
    for (const head of heads) expect(isOranguOutput(head), head).toBe(false)
  })

  it('refuses to replace a JSON file with sorted keys that orangu did not write', async () => {
    const path = await tempPath('config.json')
    const text = '{"schemaVersion":"1.0","source":{"url":"https://example.com"}}\n'
    writeFileSync(path, text, { mode: 0o644 })
    await expect(writePrivateOutput(path, ORANGU_JSON)).rejects.toThrow(/is not an orangu output/)
    expect(readFileSync(path, 'utf8')).toBe(text)
  })

  it('reads the marker only inside the bounded head', () => {
    const filler = '<meta name="x" content="y"/>\n'.repeat(Math.ceil(OUTPUT_HEAD_BYTES / 28))
    const late = `<!doctype html>\n<html lang="en">\n<head>\n${filler}<meta name="generator" content="orangu 0.9.0"/>`
    expect(isOranguOutput(late), 'the whole text').toBe(true)
    expect(isOranguOutput(late.slice(0, OUTPUT_HEAD_BYTES)), 'the bounded head').toBe(false)
  })

  it.skipIf(process.platform === 'win32')('refuses a large file whose orangu marker sits past the bounded head', async () => {
    const path = await tempPath('late.html')
    const filler = '<meta name="x" content="y"/>\n'.repeat(Math.ceil(OUTPUT_HEAD_BYTES / 28))
    const late = `<!doctype html>\n<html lang="en">\n<head>\n${filler}<meta name="generator" content="orangu 0.9.0"/>`
    writeFileSync(path, late)
    await expect(writePrivateOutput(path, ORANGU_HTML)).rejects.toThrow(/is not an orangu output/)
    expect(readFileSync(path, 'utf8')).toBe(late)
  })
})
