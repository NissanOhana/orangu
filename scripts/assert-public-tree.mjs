#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const blockedPaths = [
  '.claude/',
  '.codex/',
  '.cursor/',
  'AGENTS.md',
  'CLAUDE.md',
  'HANDOVER.md',
  'PROGRESS.md',
  'design/import/',
  'docs/handoff/',
  'docs/launch/',
  'docs/plans/',
  'docs/research/',
  'docs/runs/',
]

const processRules = [
  ['private design prompt', /paste\s+this\s+to\s+Claude\s+Design/i],
  ['private process artifact', /\b(?:SPEC\s+(?:§|[A-Z]{1,5}[- ]?\d)|UX-HANDOFF|SUGGESTION-POOL|REVIEW-\d+|QA-\d+|AC-\d+|AV-\d+|CR-\d+|harness-suggest run)\b/],
  ['private release ledger', /\bworld\s+launch\s+evaluation\b/i],
  ['private provenance note', /\bkept\s+for\s+provenance\b/i],
  ['private owner directive', /\bowner(?:'s)?\s+(?:ask|asks|decision|request|brief)\b/i],
  ['private corpus measurement', /\b(?:\d{2,4}\s+of\s+\d{2,4}\s+(?:corpus\s+)?sessions?|\d{2,4}\s+(?:real|local|corpus)\s+sessions?)\b/i],
  ['private project marker', new RegExp(['brain', 'iac'].join(''), 'i')],
  ['private session marker', new RegExp(['d3d3', 'adfd'].join(''), 'i')],
]

const strictIdentityRules = [
  ['personal macOS home path', /\/Users\/[A-Za-z0-9._-]+/i],
  ['personal Linux home path', /\/home\/[A-Za-z0-9._-]+/i],
  ['personal Windows home path', /[A-Z]:\\Users\\[A-Za-z0-9._-]+/i],
  ['personal email address', /[A-Z0-9._%+-]+@(?!users\.noreply\.github\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}/i],
]

const syntheticIdentityRules = [
  ['personal macOS home path', /\/Users\/(?!(?:test|dev|me\d*|x|y)(?=\/|[^A-Za-z0-9._-]|$))[A-Za-z0-9._-]+/i],
  ['personal Linux home path', /\/home\/(?!(?:test|tester\d*|dev)(?=\/|[^A-Za-z0-9._-]|$))[A-Za-z0-9._-]+/i],
  ['personal Windows home path', /[A-Z]:\\Users\\(?!(?:test|dev|me\d*|x|y)(?=\\|[^A-Za-z0-9._-]|$))[A-Za-z0-9._-]+/i],
  ['personal email address', /[A-Z0-9._%+-]+@(?![A-Z0-9.-]*example\.(?:com|org|net)\b)(?!users\.noreply\.github\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}/i],
]

const secretRules = [
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI project key', /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{20,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
]

const syntheticSecrets = [
  'ghp_1234567890abcdef1234567890abcdef1234',
  'sk-ant-abc123def456ghi789jkl',
  'sk-ant-alsoplanted0000',
  'sk-ant-api03-AbC123_def-456ghi789',
  'sk-ant-api03-EXPORTMARKER9073',
  'sk-ant-api03-FAKEFAKEFAKEFAKE',
  'sk-ant-api03-PRIVATEPURPLEFERRET9073',
  'sk-ant-api03-abc123def456ghi789',
  'sk-ant-api03-browsersecret123456',
  'sk-ant-leakedsecret012345678',
  'sk-ant-plantedsecretvalue00000',
  'sk-ant-thisisthesecretvalue0123456789',
]

const binaryDigests = new Map([
  ['design/brand/favicon-16.png', '9515bf8aa41e3291e348adc4a4923f8a74b189d814d17dc2b525f613c7829e96'],
  ['design/brand/favicon-180.png', 'ae99855480239ed1435059d38d4e7738417085cc429e446970e49d96ad053659'],
  ['design/brand/favicon-32.png', '68893cbd13ef92160399d77ad22652c4645b1d42a7e32196717abd9da0089aa4'],
  ['design/brand/favicon-512.png', '1dc0daaaeb10cd23b3e49e36929a84d2002bec521ba7e3839e7e8a176195d970'],
  ['design/brand/favicon-64.png', '3be627a8e18dfd2d1f3d26dbfc224f15f9c1c563cbdddb73a587f031d2328cba'],
  ['design/brand/mascot-96.png', 'fdfa669b261ee9e61e2178d573f7c982502b1009c6cfed35713fc99dbfb77549'],
  ['design/brand/mascot-main-320.png', 'e856607480b137ffc8dcf2a547549de4826edec68f2658748aeaaa2f8a626508'],
  ['design/brand/mascot-main-transparent.png', '91be2625136579826ff0f650a249f7924243bbf7e0e1e5c759b581fd060870fb'],
  ['plugins/orangu/assets/icon.png', '3be627a8e18dfd2d1f3d26dbfc224f15f9c1c563cbdddb73a587f031d2328cba'],
  ['plugins/orangu/assets/logo.png', '91be2625136579826ff0f650a249f7924243bbf7e0e1e5c759b581fd060870fb'],
  // link-unfurl card: the landing hero at 1200x630 (node scripts/og-card.mjs, then paste the digest)
  ['site/assets/og.png', '31ea9b4db2b156f22e1affc34976e38792943eb0cd2bddc43bf427164de5abf1'],
])

const binaryExtensions = new Set(['.7z', '.avi', '.bin', '.bmp', '.dmg', '.doc', '.docx', '.gif', '.gz', '.ico', '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.pdf', '.png', '.tar', '.tgz', '.wasm', '.webp', '.xls', '.xlsx', '.zip'])

function isSyntheticFixture(path) {
  return path.endsWith('.test.ts') || path.startsWith('test/fixtures/') || path.startsWith('test/golden/')
}

export function contentFindings(path, text) {
  const findings = []
  const identityRules = isSyntheticFixture(path) ? syntheticIdentityRules : strictIdentityRules
  const rules = path === 'scripts/assert-public-tree.mjs' || path === 'test/public-tree.test.ts'
    ? identityRules
    : [...processRules, ...identityRules]
  for (const [label, pattern] of rules) {
    if (pattern.test(text)) findings.push(label)
  }
  const secretInput = syntheticSecrets.reduce((value, marker) => value.replaceAll(marker, ''), text)
  for (const [label, pattern] of secretRules) {
    if (pattern.test(secretInput)) findings.push(label)
  }
  return findings
}

export function pathFindings(path) {
  const findings = []
  if (blockedPaths.some((blocked) => path === blocked || path.startsWith(blocked))) {
    findings.push('private working path is publishable')
  }
  const name = basename(path)
  if (
    name === '.npmrc' ||
    name === '.env' ||
    (name.startsWith('.env.') && name !== '.env.example') ||
    path.endsWith('.key') ||
    path.endsWith('.pem')
  ) {
    findings.push('credential-bearing file is publishable')
  }
  const pathRules = [...processRules, ...strictIdentityRules, ...secretRules]
  for (const [label, pattern] of pathRules) {
    if (pattern.test(path)) findings.push(label)
  }
  return findings
}

export function binaryFindings(path, bytes) {
  const expected = binaryDigests.get(path)
  if (!expected) return ['unexpected binary file']
  const actual = createHash('sha256').update(bytes).digest('hex')
  return actual === expected ? [] : ['approved binary digest changed']
}

function decodeText(bytes) {
  if (bytes.includes(0)) return undefined
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    let controls = 0
    for (const code of text) {
      const value = code.charCodeAt(0)
      if (value < 32 && value !== 9 && value !== 10 && value !== 13) controls++
    }
    return controls > Math.max(2, text.length * 0.01) ? undefined : text
  } catch {
    return undefined
  }
}

function candidateFiles() {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT },
  )
  return [...new Set(output.toString('utf8').split('\0').filter(Boolean))]
    .sort()
}

export function localMarkdownLinks(path, text) {
  const links = []
  let cursor = 0
  while ((cursor = text.indexOf('](', cursor)) !== -1) {
    let index = cursor + 2
    let target = ''
    if (text[index] === '<') {
      const close = text.indexOf('>', index + 1)
      if (close === -1) {
        cursor = index
        continue
      }
      target = text.slice(index + 1, close)
      index = close + 1
    } else {
      let depth = 1
      let escaped = false
      for (; index < text.length; index++) {
        const char = text[index]
        if (escaped) {
          target += char
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === '(') {
          depth++
          target += char
        } else if (char === ')') {
          depth--
          if (depth === 0) break
          target += char
        } else if (/\s/.test(char) && depth === 1) {
          break
        } else {
          target += char
        }
      }
    }
    cursor = Math.max(index + 1, cursor + 2)
    if (!target || target.startsWith('#') || /^(?:https?:|mailto:|data:)/i.test(target)) continue
    target = target.split('#', 1)[0]?.split('?', 1)[0] ?? ''
    if (target) links.push(target)
  }
  return links
}

export function assertPublicTree() {
  const files = candidateFiles()
  const failures = []

  for (const path of files) {
    for (const finding of pathFindings(path)) failures.push(`${path}: ${finding}`)

    const absolute = resolve(ROOT, path)
    if (!existsSync(absolute)) {
      failures.push(`${path}: tracked file is missing; stage its deletion`)
      continue
    }
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) {
      failures.push(`${path}: symbolic links are not publishable`)
      continue
    }

    const bytes = readFileSync(absolute)
    if (binaryDigests.has(path)) {
      for (const finding of binaryFindings(path, bytes)) failures.push(`${path}: ${finding}`)
      continue
    }
    const text = decodeText(bytes)
    if (text === undefined || binaryExtensions.has(extname(path).toLowerCase())) {
      failures.push(`${path}: unexpected binary file`)
      continue
    }

    for (const finding of contentFindings(path, text)) {
      failures.push(`${path}: ${finding}`)
    }

    if (path.endsWith('.md')) {
      for (const target of localMarkdownLinks(path, text)) {
        let decoded
        try {
          decoded = decodeURIComponent(target)
        } catch {
          failures.push(`${path}: invalid encoded local link ${target}`)
          continue
        }
        const linked = resolve(ROOT, dirname(path), decoded)
        if (linked !== ROOT && !linked.startsWith(`${ROOT}${sep}`)) {
          failures.push(`${path}: local link escapes the repository ${target}`)
        } else if (!existsSync(linked)) {
          failures.push(`${path}: broken local link ${target}`)
        }
      }
    }
  }

  const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8')
  const readmeLines = readme.trimEnd().split('\n').length
  if (readmeLines > 140) failures.push(`README.md: ${readmeLines} lines exceeds the 140-line public-entry limit`)
  if (!readme.includes('(docs/README.md)')) failures.push('README.md: missing documentation index link')

  const ignore = readFileSync(resolve(ROOT, '.gitignore'), 'utf8')
  for (const required of [
    '/.claude/',
    '/HANDOVER.md',
    '/PROGRESS.md',
    '/docs/plans/',
    '/docs/research/',
    '/docs/runs/',
    '/design/import/',
  ]) {
    if (!ignore.includes(required)) failures.push(`.gitignore: missing private-work rule ${required}`)
  }

  if (failures.length) {
    throw new Error(`public tree check failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`)
  }

  return { files: files.length, markdown: files.filter((path) => path.endsWith('.md')).length }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  if (process.argv[2] === '--probe') {
    const findings = contentFindings(process.argv[4] ?? 'probe.md', process.argv[3] ?? '')
    process.stdout.write(JSON.stringify(findings))
  } else if (process.argv[2] === '--probe-path') {
    const findings = pathFindings(process.argv[3] ?? '')
    process.stdout.write(JSON.stringify(findings))
  } else if (process.argv[2] === '--probe-binary') {
    const findings = binaryFindings(process.argv[3] ?? '', Buffer.from(process.argv[4] ?? '', 'base64'))
    process.stdout.write(JSON.stringify(findings))
  } else if (process.argv[2] === '--probe-links') {
    const findings = localMarkdownLinks(process.argv[3] ?? 'probe.md', process.argv[4] ?? '')
    process.stdout.write(JSON.stringify(findings))
  } else {
    try {
      const result = assertPublicTree()
      process.stdout.write(`public tree OK (${result.files} files, ${result.markdown} Markdown files)\n`)
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    }
  }
}
