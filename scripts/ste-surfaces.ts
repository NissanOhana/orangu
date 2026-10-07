/**
 * The STE gate's surfaces: which user-visible copy orangu measures, how each kind of source becomes
 * blocks of prose for the checker in src/ste, and which chunk of work owns each row. test/ste.test.ts holds
 * every row to its floor in test/ste-floors.ts.
 *
 * Dev-only. It reads the repository (the files git tracks, plus new files git does not ignore) and parses
 * TypeScript with the typescript devDependency. Nothing in this file ships.
 *
 * How each kind is measured:
 * - Markdown and text files: the checker's file mode. The frontmatter description of a Markdown file is
 *   one more block. Table cells are blocks; a heading or a short cell is a label.
 * - HTML files: the page text in file mode, plus the copy that is not page text: the content of the
 *   description, og:* and twitter:* meta tags, the title, aria-label, alt and placeholder values, the
 *   strings in inline scripts, and the JSON-LD descriptions.
 * - CLI help: `node plugin/bin/orangu.cli.mjs --help` with NO_COLOR=1, one block per line. The tracked
 *   bin prints the same bytes as dist/, and the gate runs before the build.
 * - Copy in TS string and template literals: every literal outside a non-copy position (see notCopy),
 *   with 3 in place of each ${}. When a literal holds markup, the values of title=, aria-label= and
 *   placeholder= are lifted out and the markup is read as text. Each line is one block.
 * - Rule copy: the title and detail property values in src/analyze/insights.ts, and the 3 parts of the rule
 *   text (improvement, why, method), one row each, following a local constant. The src/analyze row measures
 *   every other string, so no string counts twice.
 * - JSON and YAML copy fields, catalog notes and the golden emitted copy: each value is a block.
 * A fragment (anything but the page text of a file, and the help) under 3 words is a label: its banned
 * tokens count, but it is not scored. Each distinct fragment counts once per surface.
 *
 * Coverage is derived, not listed: every top-level src/ folder, every user doc at the root and in docs/,
 * and every plugin skill or agent file is a surface. What is left out is named with its reason
 * (SRC_EXEMPT, DOC_EXEMPT), so a new folder or doc fails the gate until it has a row.
 */
import ts from 'typescript'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PARAGRAPH, checkBlocks, htmlToText, proseBlocks, proseWords, frontmatterDescription, type SteBlock, type SteResult } from '../src/ste/index.js'
import type { SteRow } from '../test/ste-floors.js'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** the tracked CLI bundle; `npm run build` regenerates it from src/, and verify:generated pins it */
export const HELP_BIN = 'plugin/bin/orangu.cli.mjs'

/** Paths under src/ that are not gated, with the reason. Everything else under src/ is a surface. */
export const SRC_EXEMPT: Readonly<Record<string, string>> = {
  'src/report/generated': 'built output of src/report/client (scripts/build.mjs); its sources are measured',
  'src/ste/words.ts': 'the word tables of the STE checker: the words it flags and the word lists it reads. Data, not copy.',
  'src/show-me/generated': 'built output of the show-me templates (scripts/build.mjs); their .src.html sources are measured',
}

/** Markdown at the root and in docs/ that is not gated, with the reason. Every other doc is a surface. */
export const DOC_EXEMPT: Readonly<Record<string, string>> = {
  'CONTRIBUTING.md': 'contributor doc; the copy scope is what a user of orangu reads',
  'SECURITY.md': 'security policy, legal text (carve-out 8)',
  'docs/ARCHITECTURE.md': 'contributor doc',
  'docs/DATA-CONTRACTS.md': 'contributor doc',
  'docs/DESIGN.md': 'contributor doc',
  'docs/PRIVACY.md': 'privacy text (carve-out 8)',
}

/**
 * Copy that a user's records store and that orangu compares byte for byte on read, so it is frozen and not
 * gated. Each entry names the file, its top-level functions and the reason. Everything else in the file is
 * still measured. To change this copy, version the record instead of rewording it.
 */
export const STORED_COPY_EXEMPT: Readonly<Record<string, { functions: readonly string[]; reason: string }>> = {
  'src/suggest/verification-policy.ts': {
    functions: ['verificationReceiptSummary', 'cohortReceiptSummary'],
    reason:
      'receipt summaries: each verified record stores one, and on every read the store renders it again and compares it byte for byte (isTrustedComputedVerification, cohortReceiptViolation). New words would demote every verified record on disk.',
  },
  'src/suggest/cohort-stats.ts': {
    functions: ['checkEvidence'],
    reason:
      'check evidence: each cohort receipt stores one line per check, and on every read cohortReceiptViolation renders it again and compares it byte for byte. New words would demote every verified record on disk.',
  },
}

/** The rule copy fields a rule site passes: the title, the detail and the 3 parts of the rule text. */
export type RuleField = 'title' | 'detail' | 'improvement' | 'why' | 'method'
const RULE_FIELDS: readonly RuleField[] = ['title', 'detail', 'improvement', 'why', 'method']
/**
 * An emitted insight also carries `recommendation`, the parts joined, which older readers read. An emitted
 * cross finding also carries `exampleTitle`, the title of its example insight without the marker.
 */
type GoldenField = RuleField | 'recommendation' | 'exampleTitle'

export interface TsOptions {
  /** measure only the strings inside these top-level function declarations (and `consts`, when given) */
  within?: readonly string[]
  /** measure only the initializers of these top-level constants (and `within`, when given) */
  consts?: readonly string[]
  /** skip the arguments of a call or a `new` whose callee reads exactly like one of these */
  skipCalls?: readonly string[]
  /** skip these top-level function declarations (STORED_COPY_EXEMPT) */
  skipFunctions?: readonly string[]
  /** keep only the copy of one rule field, or every string except the rule copy ('exclude') */
  ruleCopy?: RuleField | 'exclude'
}

// ---------- copy in TS string and template literals ----------

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.InKeyword,
])
/** callees whose first argument is a selector, an attribute name or an event name (querySelector* too) */
const FIRST_ARG_NOT_COPY = new Set(['closest', 'getAttribute', 'setAttribute', 'removeAttribute', 'addEventListener'])
const LIFTED_ATTRIBUTES = /(?<![\w-])(?:title|aria-label|placeholder)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
// An attribute string outside its tag is markup (measured: src/report/client/mascot.ts, `width="3" height="3"`).
// Its title, aria-label and placeholder values are lifted out first.
const ATTRIBUTE_PAIR = /(?<![\w-])[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*')/g
// A literal is markup only when it holds a closing tag, a self-closing tag, a tag with an attribute or a
// comment. Measured: src/analyze/insights.ts ("< 200 chars ... >= 60%") is text, not a tag.
const HAS_MARKUP = /<\/[A-Za-z]|\/>|<[A-Za-z][\w-]*\s+[\w:-]+\s*=|<!--/
// A Content-Security-Policy value is policy syntax (measured: src/report/render.ts, CSP and CSP_SERVE).
const NOT_COPY_TEXT = /^\s*default-src\s/

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return undefined
}

function isClassListCall(expression: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expression)) return false
  const target = expression.expression
  return (ts.isPropertyAccessExpression(target) && target.name.text === 'classList') || (ts.isIdentifier(target) && target.text === 'classList')
}

/** True when code reads the literal as a key, a module, a selector or a name, never as copy. */
function notCopy(node: ts.Node, sf: ts.SourceFile): boolean {
  const parent = node.parent
  if (!parent) return false
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) return true
  if (ts.isModuleDeclaration(parent) || ts.isLiteralTypeNode(parent)) return true
  // a property, method, enum-member or binding name
  if ((parent as { name?: ts.Node }).name === node) return true
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return true
  if (ts.isCaseClause(parent) && parent.expression === node) return true
  if (ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) return true
  if (ts.isCallExpression(parent)) {
    const name = calleeName(parent.expression)
    if (parent.expression.kind === ts.SyntaxKind.ImportKeyword || name === 'require') return true
    if (isClassListCall(parent.expression)) return true
    if (parent.arguments[0] === node && name && (name.startsWith('querySelector') || FIRST_ARG_NOT_COPY.has(name))) return true
  }
  if (ts.isNewExpression(parent) && calleeName(parent.expression) === 'RegExp' && parent.arguments?.[0] === node) return true
  if (ts.isTaggedTemplateExpression(parent) && parent.tag.getText(sf) === 'String.raw') return true
  return false
}

/** The declaration of `name` in the nearest enclosing function (or the file) that declares it. */
function localConst(from: ts.Node, name: string): ts.VariableDeclaration | undefined {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    if (!ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) continue
    let found: ts.VariableDeclaration | undefined
    const look = (node: ts.Node): void => {
      if (found) return
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node
      else if (!ts.isFunctionLike(node)) ts.forEachChild(node, look)
    }
    ts.forEachChild(scope, look)
    if (found) return found
  }
  return undefined
}

/** Source ranges of the rule-copy property values for these fields, plus the local constants they name. */
function ruleSpans(sf: ts.SourceFile, fields: readonly RuleField[]): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && (fields as readonly string[]).includes(node.name.text)) {
      spans.push([node.initializer.getStart(sf), node.initializer.end])
      if (ts.isIdentifier(node.initializer)) {
        const initializer = localConst(node, node.initializer.text)?.initializer
        if (initializer) spans.push([initializer.getStart(sf), initializer.end])
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return spans
}

function lineBlocks(text: string, line: number, file: string): SteBlock[] {
  const blocks: SteBlock[] = []
  text.split('\n').forEach((row, offset) => {
    for (const piece of row.split(PARAGRAPH)) {
      const flat = piece.replace(/\s+/g, ' ').trim()
      if (flat) blocks.push({ file, line: line + offset, text: flat })
    }
  })
  return blocks
}

/**
 * One literal's copy, one block per line: the lifted title, aria-label and placeholder values first, then
 * the rest without its attribute pairs. Only a literal that holds markup is read through htmlToText.
 */
function copyBlocks(raw: string, line: number, file: string): SteBlock[] {
  const lineAt = (index: number): number => line + (raw.slice(0, index).match(/\n/g)?.length ?? 0)
  const lifted = [...raw.matchAll(LIFTED_ATTRIBUTES)].flatMap((match) => lineBlocks(htmlToText(match[1] ?? match[2] ?? ''), lineAt(match.index ?? 0), file))
  const rest = raw.replace(ATTRIBUTE_PAIR, (pair) => ` ${pair.replace(/[^\n]/g, '')} `)
  return [...lifted, ...lineBlocks(HAS_MARKUP.test(raw) ? htmlToText(rest) : rest, line, file)]
}

function topLevelNames(statement: ts.Statement): string[] {
  if (ts.isFunctionDeclaration(statement)) return statement.name ? [statement.name.text] : []
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []))
  return []
}

function sourceBlocks(sf: ts.SourceFile, file: string, options: TsOptions): SteBlock[] {
  const rule = options.ruleCopy
  const spans = rule === undefined ? [] : ruleSpans(sf, rule === 'exclude' ? RULE_FIELDS : [rule])
  const inSpan = (node: ts.Node): boolean => spans.some(([from, to]) => node.getStart(sf) >= from && node.end <= to)
  const wanted = (node: ts.Node): boolean => (rule === undefined ? true : rule === 'exclude' ? !inSpan(node) : inSpan(node))
  const blocks: SteBlock[] = []
  const take = (node: ts.Node, text: string): void => {
    if (notCopy(node, sf) || !wanted(node) || NOT_COPY_TEXT.test(text)) return
    blocks.push(...copyBlocks(text, sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, file))
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && options.skipCalls?.includes(node.expression.getText(sf))) return
    if (ts.isFunctionDeclaration(node) && node.name && options.skipFunctions?.includes(node.name.text)) return
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return take(node, node.text)
    if (ts.isTemplateExpression(node)) {
      if (notCopy(node, sf)) return
      take(node, node.head.text + node.templateSpans.map((span) => `3${span.literal.text}`).join(''))
      for (const span of node.templateSpans) visit(span.expression)
      return
    }
    ts.forEachChild(node, visit)
  }
  if (options.within || options.consts) {
    const names = [...(options.within ?? []), ...(options.consts ?? [])]
    for (const statement of sf.statements) if (topLevelNames(statement).some((name) => names.includes(name))) visit(statement)
  } else visit(sf)
  return blocks
}

const parse = (file: string, source: string): ts.SourceFile =>
  ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /\.(m?js|cjs)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS)

/** The copy blocks of one TS (or JS) source, in source order. */
export function tsBlocks(source: string, file: string, options: TsOptions = {}): SteBlock[] {
  return sourceBlocks(parse(file, source), file, options)
}

/** Fragments: each distinct block once, and a block under 3 words marked as a label. */
export function fragmentBlocks(blocks: readonly SteBlock[]): SteBlock[] {
  const seen = new Set<string>()
  return blocks.flatMap((block) => {
    if (seen.has(block.text)) return []
    seen.add(block.text)
    return [{ ...block, label: proseWords(block.text) < 3 }]
  })
}

/** Score a fragment surface: a label is counted for its banned tokens only, and each distinct block once. */
export function fragmentResult(blocks: readonly SteBlock[]): SteResult {
  return checkBlocks(fragmentBlocks(blocks))
}

// ---------- HTML pages ----------

const lineAtIndex = (text: string, index: number): number => text.slice(0, index).split('\n').length
const HTML_LIFTED = /(?<![\w-])(?:title|aria-label|alt|placeholder)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const META_COPY = /^(?:description|og:.+|twitter:.+)$/

function jsonDescriptions(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(jsonDescriptions)
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => (key === 'description' && typeof item === 'string' ? [item] : jsonDescriptions(item)))
}

/** One HTML page: its text in file mode, plus its meta copy, attribute values, script strings and JSON-LD. */
export function htmlResult(html: string, file: string): SteResult {
  const page = proseBlocks(htmlToText(html)).map((block) => ({ ...block, file }))
  const fragments: SteBlock[] = []
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = /(?:name|property)\s*=\s*"([^"]*)"/i.exec(match[0])?.[1] ?? ''
    const content = /content\s*=\s*"([^"]*)"/i.exec(match[0])?.[1]
    if (content !== undefined && META_COPY.test(key)) fragments.push(...lineBlocks(htmlToText(content), lineAtIndex(html, match.index ?? 0), file))
  }
  // attribute values outside a script (a script's markup is measured as script strings)
  const outsideScripts = html.replace(/<script\b[\s\S]*?<\/script>/gi, (script) => script.replace(/[^\n]/g, ' '))
  for (const match of outsideScripts.matchAll(HTML_LIFTED)) {
    fragments.push(...lineBlocks(htmlToText(match[1] ?? match[2] ?? ''), lineAtIndex(html, match.index ?? 0), file))
  }
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? ''
    const body = match[2] ?? ''
    const start = (match.index ?? 0) + match[0].indexOf('>') + 1
    if (/application\/ld\+json/i.test(attributes)) {
      for (const text of jsonDescriptions(JSON.parse(body))) fragments.push({ file, line: lineAtIndex(html, html.indexOf(JSON.stringify(text).slice(1, -1))), text })
    } else {
      const offset = lineAtIndex(html, start) - 1
      fragments.push(...tsBlocks(body, `${file}.js`).map((block) => ({ ...block, file, line: block.line + offset })))
    }
  }
  return checkBlocks([...page, ...fragmentBlocks(fragments)])
}

// ---------- the surfaces ----------

/** The files git tracks plus new files it does not ignore, that exist on disk, sorted. */
export function listFiles(root = ROOT): string[] {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
  return [...new Set(output.split('\0').filter(Boolean))].filter((file) => existsSync(join(root, file))).sort()
}

interface Reader {
  root: string
  files: readonly string[]
  text(path: string): string
  sourceFile(path: string): ts.SourceFile
}

function reader(root: string): Reader {
  const texts = new Map<string, string>()
  const parsed = new Map<string, ts.SourceFile>()
  const text = (path: string): string => {
    if (!texts.has(path)) texts.set(path, readFileSync(join(root, path), 'utf8'))
    return texts.get(path)!
  }
  const sourceFile = (path: string): ts.SourceFile => {
    if (!parsed.has(path)) parsed.set(path, parse(path, text(path)))
    return parsed.get(path)!
  }
  return { root, files: listFiles(root), text, sourceFile }
}

export interface Surface {
  /** the row key in test/ste-floors.ts */
  id: string
  /** the chunk of work that raises this row's floor */
  owner: string
  /** what is measured, in a few words */
  source: string
  measure(read: Reader): SteResult
}

const under = (file: string, path: string): boolean => file === path || file.startsWith(`${path}/`)

/** The .ts sources under these paths, without tests, specs and declarations, sorted. */
export function tsFiles(root: string, paths: readonly string[], exclude: readonly string[] = [], files: readonly string[] = listFiles(root)): string[] {
  return files.filter(
    (file) =>
      file.endsWith('.ts') &&
      !/\.(test|spec|d)\.ts$/.test(file) &&
      paths.some((path) => under(file, path)) &&
      !exclude.some((path) => under(file, path)) &&
      !Object.keys(SRC_EXEMPT).some((path) => under(file, path)),
  )
}

const withFile = (result: SteResult, file: string): SteResult => ({ ...result, findings: result.findings.map((finding) => ({ file, ...finding })) })

function fileSurface(path: string, owner: string, kind: 'markdown' | 'html' | 'text'): Surface {
  return {
    id: path,
    owner,
    source: `${kind} file`,
    measure: (read) => {
      const text = read.text(path)
      if (kind === 'html') return htmlResult(text, path)
      const description = kind === 'markdown' ? frontmatterDescription(text) : null
      return withFile(checkBlocks([...(description ? [description] : []), ...proseBlocks(text)]), path)
    },
  }
}

/** The CLI help from the tracked bin, NO_COLOR=1, so the gate needs no dist/. */
export function helpText(root = ROOT): string {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', TERM: 'dumb' }
  delete env['FORCE_COLOR']
  const result = spawnSync(process.execPath, [join(root, HELP_BIN), '--help'], { cwd: root, encoding: 'utf8', env })
  if (result.status !== 0) throw new Error(`${HELP_BIN} --help exited ${result.status}: ${result.stderr}`)
  return result.stdout
}

const helpSurface: Surface = {
  id: 'orangu --help',
  owner: 'K',
  source: `${HELP_BIN} --help, one block per line`,
  measure: (read) => withFile(checkBlocks(proseBlocks(helpText(read.root), { lines: true })), 'orangu --help'),
}

function tsSurface(id: string, owner: string, paths: readonly string[], options: { exclude?: readonly string[]; for?: (file: string) => TsOptions; files?: (read: Reader) => string[] } = {}): Surface {
  return {
    id,
    owner,
    source: 'TS string and template literals',
    measure: (read) =>
      fragmentResult((options.files?.(read) ?? tsFiles(read.root, paths, options.exclude, read.files)).flatMap((file) => sourceBlocks(read.sourceFile(file), file, options.for?.(file) ?? {}))),
  }
}

const INSIGHTS = 'src/analyze/insights.ts'

function ruleSurface(field: RuleField): Surface {
  return {
    id: `${INSIGHTS}#${field}`,
    owner: 'B2',
    source: `the ${field} property values of the rules`,
    measure: (read) => fragmentResult(sourceBlocks(read.sourceFile(INSIGHTS), INSIGHTS, { ruleCopy: field })),
  }
}

/** The 1-based line where a JSON string value first appears in its file, or 1. */
function lineOf(raw: string, value: string): number {
  const index = raw.indexOf(JSON.stringify(value).slice(1, -1))
  return index < 0 ? 1 : lineAtIndex(raw, index)
}

type Json = Record<string, unknown>
const strings = (values: unknown[]): string[] => values.filter((value): value is string => typeof value === 'string')
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : [])

function jsonSurface(id: string, owner: string, files: (read: Reader) => string[], pick: (json: Json) => string[]): Surface {
  return {
    id,
    owner,
    source: 'JSON copy fields',
    measure: (read) =>
      fragmentResult(
        files(read).flatMap((file) => {
          const raw = read.text(file)
          return pick(JSON.parse(raw) as Json).map((text) => ({ file, line: lineOf(raw, text), text }))
        }),
      ),
  }
}

const one = (file: string) => (): string[] => [file]

const YAML_COPY = /^\s*(?:short_description|default_prompt):\s*(.+?)\s*$/

const codexYamlSurface: Surface = {
  id: 'plugin/codex/*/openai.yaml',
  owner: 'P1a',
  source: 'short_description and default_prompt',
  measure: (read) =>
    fragmentResult(
      read.files
        .filter((file) => file.startsWith('plugin/codex/') && file.endsWith('/openai.yaml'))
        .flatMap((file) =>
          read
            .text(file)
            .split('\n')
            .flatMap((row, index) => {
              const value = YAML_COPY.exec(row)?.[1]
              if (!value) return []
              const text = value.startsWith('"') ? (JSON.parse(value) as string) : value.replace(/^'(.*)'$/, '$1')
              return [{ file, line: index + 1, text }]
            }),
        ),
    ),
}

// The copy the build injects into the Codex mirrors (scripts/build.mjs): the CLI fallback sentence that
// replaces the Claude one, and the words codexNames writes in place of a Claude-only skill.
const codexMirrorSurface: Surface = {
  ...tsSurface('scripts/build.mjs#codex', 'P1a', [], { files: () => ['scripts/build.mjs'], for: () => ({ consts: ['CODEX_FALLBACK'], within: ['codexNames'] }) }),
  source: 'CODEX_FALLBACK and codexNames in scripts/build.mjs',
}

/** Every Markdown file under plugin/skills and plugin/agents, and every .src.html template under plugin/skills. */
const pluginFiles = (files: readonly string[]): string[] =>
  files.filter((file) => (file.startsWith('plugin/skills/') || file.startsWith('plugin/agents/')) && (file.endsWith('.md') || file.endsWith('.src.html')))

/** P1a owns the skills the build mirrors to Codex; P1b the Claude-only ones. A new directory has no owner yet. */
function pluginOwner(file: string): string {
  if (/^plugin\/skills\/(improve|apply|feedback|shared)\//.test(file)) return 'P1a'
  if (/^plugin\/skills\/(analyze|harness)\//.test(file) || file === 'plugin/skills/README.md' || file.startsWith('plugin/agents/')) return 'P1b'
  if (file.startsWith('plugin/skills/show-me/')) return 'P2'
  return 'new'
}

function pluginSurfaces(files: readonly string[], owner: string): Surface[] {
  return pluginFiles(files)
    .filter((file) => pluginOwner(file) === owner)
    .map((file) => fileSurface(file, owner, file.endsWith('.md') ? 'markdown' : 'html'))
}

/** Every user doc: Markdown at the root and in docs/, except DOC_EXEMPT. */
function docSurfaces(files: readonly string[], where: 'root' | 'docs'): Surface[] {
  const pattern = where === 'root' ? /^[^/]+\.md$/ : /^docs\/[^/]+\.md$/
  return files
    .filter((file) => pattern.test(file) && DOC_EXEMPT[file] === undefined)
    .map((file) => fileSurface(file, file === 'README.md' ? 'S1' : where === 'docs' ? 'S2' : 'new', 'markdown'))
}

/** K owns the CLI and engine folders; a new src/ folder has no owner until its chunk names one. */
const SRC_OWNERS: Readonly<Record<string, string>> = Object.fromEntries(
  ['adapters', 'cache', 'cli', 'discover', 'feedback', 'harness', 'model', 'models', 'redact', 'serve', 'show-me', 'ste', 'suggest', 'util'].map((dir) => [dir, 'K']),
)
/** split into their own rows below: report (client and renderer) and analyze (rule copy and the rest) */
const SRC_SPLIT = new Set(['report', 'analyze'])

function srcSurfaces(files: readonly string[]): Surface[] {
  const dirs = [...new Set(files.filter((file) => /^src\/[^/]+\//.test(file)).map((file) => file.split('/')[1]!))].sort()
  return [
    ...dirs
      .filter((dir) => !SRC_SPLIT.has(dir))
      .map((dir) => tsSurface(`src/${dir}`, SRC_OWNERS[dir] ?? 'new', [`src/${dir}`], { for: (file) => ({ skipFunctions: STORED_COPY_EXEMPT[file]?.functions ?? [] }) })),
    { ...tsSurface('src/*.ts', 'K', [], { files: (read) => tsFiles(read.root, ['src'], [], read.files).filter((file) => /^src\/[^/]+\.ts$/.test(file)) }), source: 'TS literals in the top-level src files' },
  ]
}

const GOLDEN = 'test/golden/'

function goldenSurface(kind: 'insight' | 'crossFinding', field: GoldenField): Surface {
  const files = (read: Reader): string[] => read.files.filter((file) => file.startsWith(GOLDEN) && (kind === 'insight' ? file.endsWith('.analysis.json') : file.endsWith('/aggregate.json')))
  const key = kind === 'insight' ? 'insights' : 'crossFindings'
  return { ...jsonSurface(`test/golden#${kind}.${field}`, 'B1, B2', files, (json) => strings(list(json[key]).map((item) => item[field]))), source: `emitted ${kind} ${field}s` }
}

/**
 * The session narrative each golden fixture emits: the first prose of every session report. It is built from
 * many template parts, so a short part ("(3 turns including ...)") is a label in the src/analyze row and only
 * the assembled text is scored as sentences. The quoted session title is transcript text, not copy, so its
 * clause is read as "In this session, " (the redactor's own rewrite).
 */
const goldenNarrativeSurface: Surface = {
  ...jsonSurface('test/golden#summary.narrative', 'Z', (read) => read.files.filter((file) => file.startsWith(GOLDEN) && file.endsWith('.analysis.json')), (json) =>
    strings([((json['summary'] ?? {}) as Json)['narrative']]).map((text) => text.replace(/^In “[\s\S]*?”, /, 'In this session, ')),
  ),
  source: 'emitted session narratives, the title clause read as "In this session"',
}

const SAMPLE_PAGE: TsOptions ={ within: ['publish', 'main'], skipCalls: ['process.stdout.write', 'process.stderr.write', 'Error'] }

/** Every gated surface, grouped by the chunk that owns it, in the order of test/ste-floors.ts. */
export function surfaces(root = ROOT, files: readonly string[] = listFiles(root)): Surface[] {
  return [
    // S1: README, the landing, 404 and llms sources, the npm description, the sample page copy
    ...docSurfaces(files, 'root'),
    fileSurface('site/index.src.html', 'S1', 'html'),
    fileSurface('site/404.html', 'S1', 'html'),
    fileSurface('site/llms.src.txt', 'S1', 'text'),
    jsonSurface('package.json#description', 'S1', one('package.json'), (json) => strings([json['description']])),
    // the page titles, descriptions, links and noscript note; the synthetic transcripts are quoted text
    { ...tsSurface('scripts/build-sample.ts', 'S1', [], { files: () => ['scripts/build-sample.ts'], for: () => SAMPLE_PAGE }), source: 'publish() and main() literals' },
    // S2: every user doc in docs/
    ...docSurfaces(files, 'docs'),
    // P1a: improve, apply, feedback, shared, and the Codex copy
    ...pluginSurfaces(files, 'P1a'),
    codexYamlSurface,
    jsonSurface('plugins/orangu/.codex-plugin/plugin.json#interface', 'P1a', one('plugins/orangu/.codex-plugin/plugin.json'), (json) => {
      const ui = (json['interface'] ?? {}) as Json
      return strings([json['description'], ui['shortDescription'], ui['longDescription'], ...(Array.isArray(ui['defaultPrompt']) ? ui['defaultPrompt'] : [])])
    }),
    codexMirrorSurface,
    // P1b: analyze, harness, the agents, the catalog, the plugin and marketplace descriptions
    ...pluginSurfaces(files, 'P1b'),
    jsonSurface('plugin/.claude-plugin/plugin.json#description', 'P1b', one('plugin/.claude-plugin/plugin.json'), (json) => strings([json['description']])),
    jsonSurface('.claude-plugin/marketplace.json#description', 'P1b', one('.claude-plugin/marketplace.json'), (json) =>
      strings([json['description'], ...list(json['plugins']).map((plugin) => plugin['description'])]),
    ),
    // P2: the show-me skill, its slot rules and its two template sources
    ...pluginSurfaces(files, 'P2'),
    // a plugin file no chunk owns yet (a new skill): its chunk adds the row and the owner
    ...pluginSurfaces(files, 'new'),
    // K: help, every CLI and engine folder under src/, the catalog notes
    helpSurface,
    ...srcSurfaces(files),
    jsonSurface('src/suggest/catalog.json#note', 'K', one('src/suggest/catalog.json'), (json) => strings(list(json['entries']).map((entry) => entry['note']))),
    jsonSurface('src/suggest/features.json#note', 'K', one('src/suggest/features.json'), (json) => strings(list(json['entries']).map((entry) => entry['note']))),
    // R1, R2: the report client and the report renderer
    tsSurface('src/report/client', 'R1, R2', ['src/report/client']),
    tsSurface('src/report/*.ts', 'R1, R2', ['src/report'], { exclude: ['src/report/client'] }),
    // B2: rule copy, and every other analyzer string
    ruleSurface('title'),
    ruleSurface('detail'),
    ruleSurface('improvement'),
    ruleSurface('why'),
    ruleSurface('method'),
    tsSurface('src/analyze', 'B2', ['src/analyze'], { for: (file) => (file === INSIGHTS ? { ruleCopy: 'exclude' } : {}) }),
    // B1, B2: the golden emitted copy, the one place where copy built from parts at run time is measured
    goldenSurface('insight', 'title'),
    goldenSurface('insight', 'detail'),
    goldenSurface('insight', 'recommendation'),
    goldenSurface('insight', 'improvement'),
    goldenSurface('insight', 'why'),
    goldenSurface('insight', 'method'),
    goldenSurface('crossFinding', 'title'),
    goldenSurface('crossFinding', 'exampleTitle'),
    goldenSurface('crossFinding', 'recommendation'),
    goldenSurface('crossFinding', 'improvement'),
    goldenSurface('crossFinding', 'why'),
    goldenSurface('crossFinding', 'method'),
    // Z: the emitted session narrative
    goldenNarrativeSurface,
  ]
}

export interface SurfaceMeasure extends SteResult {
  id: string
  owner: string
  source: string
}

/**
 * Why a surface fails its row, empty when it passes: the score under its floor, a banned token over its
 * ceiling, or more findings than its findings ceiling. test/ste.test.ts and the "!" marks of `npm run ste`
 * both use it, so the table and the gate agree.
 */
export function rowFailures(surface: Pick<SteResult, 'score' | 'banned' | 'findings'>, row: SteRow): string[] {
  const out: string[] = []
  if (surface.score < row.floor) out.push(`score ${surface.score} is under its floor ${row.floor}`)
  for (const key of BANNED_KEYS) if (surface.banned[key] > row[key]) out.push(`${key} ${surface.banned[key]} is over its ceiling ${row[key]}`)
  if (surface.findings.length > row.findings) out.push(`${surface.findings.length} findings is over its findings ceiling ${row.findings}`)
  return out
}

/** Measure every surface. A surface with no sentence is still listed; the gate treats it as absent. */
export function measureAll(root = ROOT): SurfaceMeasure[] {
  const read = reader(root)
  return surfaces(root, read.files).map((surface) => ({ id: surface.id, owner: surface.owner, source: surface.source, ...surface.measure(read) }))
}

// ---------- npm run ste ----------

const BANNED_KEYS = ['emDash', 'eg', 'ie', 'etc', 'contractions'] as const
const BANNED_LABELS = ['em-dash', 'e.g.', 'i.e.', 'etc.', 'contr.']

function topFindings(surface: SurfaceMeasure): string {
  const counts = new Map<string, number>()
  for (const finding of surface.findings) counts.set(finding.rule, (counts.get(finding.rule) ?? 0) + 1)
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([rule, count]) => `${rule} ${count}`)
    .join(', ')
}

function table(measures: readonly SurfaceMeasure[], floors: Readonly<Record<string, SteRow>>): string[] {
  const width = Math.max(...measures.map((surface) => surface.id.length))
  const head = ['surface'.padEnd(width), 'owner ', 'sentences', 'score', 'floor', ...BANNED_LABELS, 'findings', 'top findings'].join('  ')
  const rows = measures.map((surface) => {
    const row = floors[surface.id]
    const floor = row ? `${row.floor}${surface.score < row.floor ? '!' : ''}` : surface.sentences ? 'none!' : '-'
    const banned = BANNED_KEYS.map((key, index) => `${surface.banned[key]}${row && surface.banned[key] > row[key] ? '!' : ''}`.padStart(BANNED_LABELS[index]!.length))
    const findings = `${surface.findings.length}/${row ? row.findings : '-'}${row && surface.findings.length > row.findings ? '!' : ''}`.padStart(8)
    return [surface.id.padEnd(width), surface.owner.padEnd(6), String(surface.sentences).padStart(9), String(surface.score).padStart(5), floor.padStart(5), ...banned, findings, topFindings(surface)].join('  ').trimEnd()
  })
  return [
    'STE score by surface: the percent of sentences with no finding. The floor, the banned-token ceilings and the',
    'findings ceiling (findings: measured/ceiling) come from test/ste-floors.ts. "!" marks a row that fails the',
    'gate. Details: npm run ste -- <surface>',
    '',
    head,
    ...rows,
  ]
}

function details(measures: readonly SurfaceMeasure[]): string[] {
  return measures.flatMap((surface) => [
    `${surface.id} (${surface.owner}, ${surface.source}): ${surface.sentences} sentences, ${surface.clean} clean, STE score ${surface.score}`,
    ...surface.findings.map((finding) => `  ${finding.file ?? surface.id}:${finding.line}  ${finding.rule}  "${finding.text}"  ${finding.hint}`),
    '',
  ])
}

async function main(argv: readonly string[]): Promise<void> {
  const { STE_FLOORS } = await import('../test/ste-floors.js')
  const json = argv.includes('--json')
  const wanted = argv.filter((arg) => arg !== '--json')
  const all = measureAll()
  const measures = wanted.length ? all.filter((surface) => wanted.some((id) => surface.id === id || surface.id.startsWith(id))) : all
  if (wanted.length && !measures.length) throw new Error(`no surface matches ${wanted.join(', ')}; run npm run ste for the list`)
  const lines = json ? [JSON.stringify(measures, null, 2)] : wanted.length ? details(measures) : table(measures, STE_FLOORS)
  process.stdout.write(`${lines.join('\n')}\n`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
