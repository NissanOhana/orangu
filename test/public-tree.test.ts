import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = join(process.cwd(), 'scripts/assert-public-tree.mjs')

function runJson(args: string[]): string[] {
  return JSON.parse(execFileSync('node', [script, ...args], { encoding: 'utf8' }))
}

function probe(value: string, path = 'probe.md'): string[] {
  return runJson(['--probe', value, path])
}

describe('public tree guard', () => {
  it('accepts the current publication tree', () => {
    const output = execFileSync('node', [script], { encoding: 'utf8' }).trim()
    expect(output).toMatch(/^public tree OK \(\d+ files, \d+ Markdown files\)$/)
  })

  it('detects private identities and process artifacts', () => {
    const macPath = ['', 'Users', 'private-user', 'Code', 'project'].join('/')
    const email = ['person', 'private.invalid'].join('@')
    const designPrompt = ['paste', 'this', 'to', 'Claude', 'Design'].join(' ')
    const internalSpec = ['SPEC', 'P1'].join(' ')

    expect(probe(macPath)).toContain('personal macOS home path')
    expect(probe(email)).toContain('personal email address')
    expect(probe(designPrompt)).toContain('private design prompt')
    expect(probe(internalSpec)).toContain('private process artifact')
    expect(probe('The HTTP SPEC defines this wire format.')).toEqual([])
  })

  it('allows reserved identities only inside synthetic fixture paths', () => {
    const testPath = ['', 'Users', 'test', 'Code', 'demo'].join('/')
    const exampleEmail = ['dev', 'mail.example.com'].join('@')
    expect(probe(`${testPath} ${exampleEmail}`, 'test/fixtures/probe.ts')).toEqual([])
    expect(probe(testPath)).toContain('personal macOS home path')
  })

  it('detects credential-like filenames, blocked paths, and fine-grained GitHub tokens', () => {
    const emailPath = ['docs/person', 'private.invalid.md'].join('@')
    const token = ['github', 'pat', '11AA0bbCCddEEffGGhhIIjjKKllMMnn'].join('_')
    expect(runJson(['--probe-path', 'docs/plans/release.md'])).toContain('private working path is publishable')
    expect(runJson(['--probe-path', emailPath])).toContain('personal email address')
    expect(runJson(['--probe-path', '.env.example'])).toEqual([])
    expect(probe(token)).toContain('GitHub token')
  })

  it('rejects unknown or changed binary files', () => {
    const bytes = Buffer.from([0, 255, 0]).toString('base64')
    expect(runJson(['--probe-binary', 'docs/blob.bin', bytes])).toContain('unexpected binary file')
    expect(runJson(['--probe-binary', 'design/brand/favicon-16.png', bytes])).toContain('approved binary digest changed')
  })

  it('parses local links with titles, nested parentheses, and angle brackets', () => {
    const markdown = '[one](docs/file(name).md) [two](docs/README.md "Docs") [three](<docs/file with spaces.md>)'
    expect(runJson(['--probe-links', 'README.md', markdown])).toEqual([
      'docs/file(name).md',
      'docs/README.md',
      'docs/file with spaces.md',
    ])
  })
})
