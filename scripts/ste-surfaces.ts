/**
 * The STE gate's surfaces: which user-visible copy orangu measures, how each kind of source becomes
 * blocks of prose for scripts/ste.mjs, and which chunk of work owns each row. test/ste.test.ts holds
 * every row to its floor in test/ste-floors.ts.
 *
 * Dev-only. It reads the repository and parses TypeScript with the typescript devDependency. Nothing in
 * this file ships.
 *
 * How each kind is measured:
 * - Markdown, HTML and text files: the checker's file mode (HTML through htmlToText). The frontmatter
 *   description of a Markdown file is one more block.
 * - CLI help: `node plugin/bin/orangu.cli.mjs --help` with NO_COLOR=1, one block per line. The tracked
 *   bin prints the same bytes as dist/, and the gate runs before the build.
 * - Copy in TS string and template literals: every literal outside a non-copy position (see notCopy),
 *   with 3 in place of each ${}. The values of title=, aria-label= and placeholder= are lifted out, the
 *   markup is read as text, and each line is one block.
 * - Rule copy: the title, detail and recommendation property values in src/analyze/insights.ts, one row
 *   each, following a local constant. The src/analyze row measures every other string, so no string
 *   counts twice.
 * - JSON and YAML copy fields, catalog notes and the golden emitted copy: each value is a block.
 * Every surface except the files and the help is a fragment surface: it drops a block under 3 words (a
 * label, not a sentence) and scores each distinct block once.
 */
import ts from 'typescript'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBlocks, checkText, htmlToText, wrapCommands, type SteBlock, type SteResult } from './ste.mjs'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** the tracked CLI bundle; `npm run build` regenerates it from src/, and verify:generated pins it */
export const HELP_BIN = 'plugin/bin/orangu.cli.mjs'

export type RuleField = 'title' | 'detail' | 'recommendation'
const RULE_FIELDS: readonly RuleField[] = ['title', 'detail', 'recommendation']

export interface TsOptions {
  /** measure only the strings inside these top-level function declarations */
  within?: readonly string[]
  /** skip the arguments of a call or a `new` whose callee reads exactly like one of these */
  skipCalls?: readonly string[]
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
const LIFTED_ATTRIBUTES = /\b(?:title|aria-label|placeholder)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
// An attribute string outside its tag is markup (measured: src/report/client/mascot.ts, `width="3" height="3"`).
// Its title, aria-label and placeholder values are lifted out first.
const ATTRIBUTE_PAIR = /\b[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*')/g
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
    for (const piece of row.split(' ')) {
      const flat = piece.replace(/\s+/g, ' ').trim()
      if (flat) blocks.push({ file, line: line + offset, text: flat })
    }
  })
  return blocks
}

/** One literal's copy: the lifted attribute values first, then its markup read as text, one block per line. */
function copyBlocks(raw: string, line: number, file: string): SteBlock[] {
  const lineAt = (index: number): number => line + (raw.slice(0, index).match(/\n/g)?.length ?? 0)
  const lifted = [...raw.matchAll(LIFTED_ATTRIBUTES)].flatMap((match) => lineBlocks(htmlToText(match[1] ?? match[2] ?? ''), lineAt(match.index ?? 0), file))
  const markup = raw.replace(ATTRIBUTE_PAIR, (pair) => ` ${pair.replace(/[^\n]/g, '')} `)
  return [...lifted, ...lineBlocks(htmlToText(markup), line, file)]
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
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return take(node, node.text)
    if (ts.isTemplateExpression(node)) {
      if (notCopy(node, sf)) return
      take(node, node.head.text + node.templateSpans.map((span) => `3${span.literal.text}`).join(''))
      for (const span of node.templateSpans) visit(span.expression)
      return
    }
    ts.forEachChild(node, visit)
  }
  if (options.within) {
    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && options.within.includes(statement.name.text)) visit(statement)
    }
  } else visit(sf)
  return blocks
}

/** The copy blocks of one TS source, in source order. */
export function tsBlocks(source: string, file: string, options: TsOptions = {}): SteBlock[] {
  return sourceBlocks(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), file, options)
}

/**
 * Words with a letter, after a command collapses to one technical name. A placeholder (3), a count
 * (×3) or a path is not a word, so "3 · 3 sessions" and SVG path data ("M 3 3") stay labels.
 */
export function proseWords(text: string): number {
  return wrapCommands(text)
    .replace(/`[^`]*`/g, 'CODE')
    .split(/\s+/)
    .map((token) => token.replace(/^[([{"'“‘]+|[)\]}"'”’.,;:!?…]+$/g, ''))
    .filter((token) => /^[A-Za-z][A-Za-z'’-]*$/.test(token)).length
}

/** Score a fragment surface: drop a block under 3 words (a label, not a sentence), and score each distinct block once. */
export function fragmentResult(blocks: readonly SteBlock[]): SteResult {
  const seen = new Set<string>()
  return checkBlocks(
    blocks.filter((block) => {
      if (proseWords(block.text) < 3 || seen.has(block.text)) return false
      seen.add(block.text)
      return true
    }),
  )
}

// ---------- the surfaces ----------

interface Reader {
  root: string
  text(path: string): string
  sourceFile(path: string): ts.SourceFile
}

function reader(root: string): Reader {
  const texts = new Map<string, string>()
  const files = new Map<string, ts.SourceFile>()
  const text = (path: string): string => {
    if (!texts.has(path)) texts.set(path, readFileSync(join(root, path), 'utf8'))
    return texts.get(path)!
  }
  const sourceFile = (path: string): ts.SourceFile => {
    if (!files.has(path)) files.set(path, ts.createSourceFile(path, text(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS))
    return files.get(path)!
  }
  return { root, text, sourceFile }
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

const posix = (path: string): string => path.split(sep).join('/')

function walk(root: string, path: string): string[] {
  const absolute = join(root, path)
  if (!existsSync(absolute)) return []
  if (!statSync(absolute).isDirectory()) return [path]
  return readdirSync(absolute)
    .sort()
    .flatMap((entry) => walk(root, posix(join(path, entry))))
}

function tsFiles(root: string, paths: readonly string[], exclude: readonly string[] = []): string[] {
  return paths
    .flatMap((path) => walk(root, path))
    .filter((file) => file.endsWith('.ts') && !/\.(test|spec|d)\.ts$/.test(file) && !exclude.some((prefix) => file.startsWith(`${prefix}/`)))
    .sort()
}

const withFile = (result: SteResult, file: string): SteResult => ({ ...result, findings: result.findings.map((finding) => ({ file, ...finding })) })

function fileSurface(path: string, owner: string, kind: 'markdown' | 'html' | 'text'): Surface {
  return {
    id: path,
    owner,
    source: `${kind} file`,
    measure: (read) => withFile(checkText(read.text(path), { html: kind === 'html', frontmatter: kind === 'markdown' }), path),
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
  measure: (read) => withFile(checkText(helpText(read.root), { lines: true }), 'orangu --help'),
}

function tsSurface(id: string, owner: string, paths: readonly string[], options: { exclude?: readonly string[]; for?: (file: string) => TsOptions } = {}): Surface {
  return {
    id,
    owner,
    source: 'TS string and template literals',
    measure: (read) => fragmentResult(tsFiles(read.root, paths, options.exclude).flatMap((file) => sourceBlocks(read.sourceFile(file), file, options.for?.(file) ?? {}))),
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
  return index < 0 ? 1 : raw.slice(0, index).split('\n').length
}

type Json = Record<string, unknown>
const strings = (values: unknown[]): string[] => values.filter((value): value is string => typeof value === 'string')
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : [])

function jsonSurface(id: string, owner: string, files: (root: string) => string[], pick: (json: Json, file: string) => string[]): Surface {
  return {
    id,
    owner,
    source: 'JSON copy fields',
    measure: (read) =>
      fragmentResult(
        files(read.root).flatMap((file) => {
          const raw = read.text(file)
          return pick(JSON.parse(raw) as Json, file).map((text) => ({ file, line: lineOf(raw, text), text }))
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
      walk(read.root, 'plugin/codex')
        .filter((file) => file.endsWith('/openai.yaml'))
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

/** Every Markdown file under plugin/skills and plugin/agents, and every .src.html template under plugin/skills. */
function pluginFiles(root: string): string[] {
  return [...walk(root, 'plugin/skills'), ...walk(root, 'plugin/agents')].filter((file) => file.endsWith('.md') || file.endsWith('.src.html')).sort()
}

/** P1a owns the skills the build mirrors to Codex; P1b the Claude-only ones. A new directory has no owner yet. */
function pluginOwner(file: string): string {
  if (/^plugin\/skills\/(improve|apply|feedback|shared)\//.test(file)) return 'P1a'
  if (/^plugin\/skills\/(analyze|harness)\//.test(file) || file === 'plugin/skills/README.md' || file.startsWith('plugin/agents/')) return 'P1b'
  return 'new'
}

function pluginSurfaces(root: string, owner: string): Surface[] {
  return pluginFiles(root)
    .filter((file) => pluginOwner(file) === owner)
    .map((file) => fileSurface(file, owner, file.endsWith('.md') ? 'markdown' : 'html'))
}

const GOLDEN = 'test/golden'
const goldenAnalyses = (root: string): string[] => walk(root, GOLDEN).filter((file) => file.endsWith('.analysis.json'))
const goldenAggregate = (root: string): string[] => walk(root, GOLDEN).filter((file) => file.endsWith('/aggregate.json'))

function goldenSurface(kind: 'insight' | 'crossFinding', field: RuleField): Surface {
  const files = kind === 'insight' ? goldenAnalyses : goldenAggregate
  const key = kind === 'insight' ? 'insights' : 'crossFindings'
  return { ...jsonSurface(`${GOLDEN}#${kind}.${field}`, 'B1, B2', files, (json) => strings(list(json[key]).map((item) => item[field]))), source: `emitted ${kind} ${field}s` }
}

const SAMPLE_PAGE: TsOptions = { within: ['publish', 'main'], skipCalls: ['process.stdout.write', 'process.stderr.write', 'Error'] }

/** Every gated surface, grouped by the chunk that owns it, in the order of test/ste-floors.ts. */
export function surfaces(root = ROOT): Surface[] {
  return [
    // S1: the landing, 404 and llms sources, README, the npm description, the sample page copy
    fileSurface('README.md', 'S1', 'markdown'),
    fileSurface('site/index.src.html', 'S1', 'html'),
    fileSurface('site/404.html', 'S1', 'html'),
    fileSurface('site/llms.src.txt', 'S1', 'text'),
    jsonSurface('package.json#description', 'S1', one('package.json'), (json) => strings([json['description']])),
    // the page titles, descriptions, links and noscript note; the synthetic transcripts are quoted text
    { ...tsSurface('scripts/build-sample.ts', 'S1', ['scripts/build-sample.ts'], { for: () => SAMPLE_PAGE }), source: 'publish() and main() literals' },
    // S2: the usage and determinism docs
    fileSurface('docs/USAGE.md', 'S2', 'markdown'),
    fileSurface('docs/DETERMINISM.md', 'S2', 'markdown'),
    // P1a: improve, apply, feedback, shared, and the Codex copy
    ...pluginSurfaces(root, 'P1a'),
    codexYamlSurface,
    jsonSurface('plugins/orangu/.codex-plugin/plugin.json#interface', 'P1a', one('plugins/orangu/.codex-plugin/plugin.json'), (json) => {
      const ui = (json['interface'] ?? {}) as Json
      return strings([json['description'], ui['shortDescription'], ui['longDescription'], ...(Array.isArray(ui['defaultPrompt']) ? ui['defaultPrompt'] : [])])
    }),
    // P1b: analyze, harness, the agents, the catalog, the plugin and marketplace descriptions
    ...pluginSurfaces(root, 'P1b'),
    jsonSurface('plugin/.claude-plugin/plugin.json#description', 'P1b', one('plugin/.claude-plugin/plugin.json'), (json) => strings([json['description']])),
    jsonSurface('.claude-plugin/marketplace.json#description', 'P1b', one('.claude-plugin/marketplace.json'), (json) =>
      strings([json['description'], ...list(json['plugins']).map((plugin) => plugin['description'])]),
    ),
    // a plugin file no chunk owns yet (a new skill): its chunk adds the row and the owner
    ...pluginSurfaces(root, 'new'),
    // K: help, the CLI and engine strings, the catalog notes
    helpSurface,
    tsSurface('src/cli', 'K', ['src/cli']),
    tsSurface('src/serve', 'K', ['src/serve']),
    tsSurface('src/harness', 'K', ['src/harness']),
    tsSurface('src/suggest', 'K', ['src/suggest']),
    tsSurface('src/feedback', 'K', ['src/feedback']),
    tsSurface('src/discover', 'K', ['src/discover']),
    tsSurface('src/cache', 'K', ['src/cache']),
    tsSurface('src/adapters', 'K', ['src/adapters']),
    jsonSurface('src/suggest/catalog.json#note', 'K', one('src/suggest/catalog.json'), (json) => strings(list(json['entries']).map((entry) => entry['note']))),
    jsonSurface('src/suggest/features.json#note', 'K', one('src/suggest/features.json'), (json) => strings(list(json['entries']).map((entry) => entry['note']))),
    // R1, R2: the report client and the report renderer
    tsSurface('src/report/client', 'R1, R2', ['src/report/client']),
    tsSurface('src/report/*.ts', 'R1, R2', ['src/report'], { exclude: ['src/report/client', 'src/report/generated'] }),
    // B2: rule copy, and every other analyzer string
    ruleSurface('title'),
    ruleSurface('detail'),
    ruleSurface('recommendation'),
    tsSurface('src/analyze', 'B2', ['src/analyze'], { for: (file) => (file === INSIGHTS ? { ruleCopy: 'exclude' } : {}) }),
    // B1, B2: the golden emitted copy, the one place where copy built from parts at run time is measured
    goldenSurface('insight', 'title'),
    goldenSurface('insight', 'detail'),
    goldenSurface('insight', 'recommendation'),
    goldenSurface('crossFinding', 'title'),
    goldenSurface('crossFinding', 'recommendation'),
  ]
}

export interface SurfaceMeasure extends SteResult {
  id: string
  owner: string
  source: string
}

/** Measure every surface. A surface with no sentence is still listed; the gate treats it as absent. */
export function measureAll(root = ROOT): SurfaceMeasure[] {
  const read = reader(root)
  return surfaces(root).map((surface) => ({ id: surface.id, owner: surface.owner, source: surface.source, ...surface.measure(read) }))
}
