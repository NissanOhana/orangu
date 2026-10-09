/**
 * The purity lint of orangu god. The god mod runs in an engine environment with no Node and no DOM, and only
 * the engine shell (the .tsx files) may call `$`. So:
 * - no source under src/god imports a `node:` module or any bare module but `claude-code`, and only a .tsx
 *   file may import `claude-code`;
 * - no source uses the Node globals `process`, `require`, `Buffer`, `setTimeout` or `setInterval`, by name or
 *   through `globalThis`, and no source loads a module with `import()`;
 * - only src/god/engine.tsx reads the clock (`Date.now`, `new Date()` with no argument, `Date()`), so the pure code
 *   takes the time as a value;
 * - no .ts file imports a .tsx file, so the pure core type-checks with no engine types;
 * - a .tsx file holds no copy (no JSX text with a letter, no string with a space and a letter), no em dash and no escape
 *   spelling: copy lives in .ts files, where the STE gate, the em dash ratchet and the escape ratchet read it;
 * - no hex color outside src/god/generated, as a string (`'#d97757'`, `color:#abc`) or as a 0xRRGGBB number (a
 *   Raster cell color): the colors come from tokens.css through the build.
 * Known gaps, each a rule that reads names, not values: an alias (`const D = Date; D.now()`,
 * `const g = globalThis; g.process`) and a color number with 8 digits (`0x00d97757`) pass.
 * The built bundle god/hooks/god.mjs declares `function register(on` at its top level (the engine validator
 * refuses an exported arrow), holds no `import(` and imports nothing but `claude-code`.
 */
import ts from 'typescript'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const GOD = 'src/god'
const BUNDLE = 'god/hooks/god.mjs'
const ENGINE_CLOCK_FILE = 'src/god/engine.tsx'
const GENERATED = 'src/god/generated/'
const EM_DASH = String.fromCharCode(0x2014)
const NODE_GLOBALS = new Set(['process', 'require', 'Buffer', 'setTimeout', 'setInterval'])
/** the escape spellings that test/lint.test.ts bans in .ts files, written so this file does not spell them */
const ESCAPE_SPELLING = new RegExp(['\\\\x1b', '\\\\u001b', '\\\\033'].join('|'))
/**
 * a CSS hex color in a string: 3, 4, 6 or 8 hex digits after #, at the start of the string or after `:`, `=`, `(`
 * or `,` (a CSS value). So `PR #1234` and `see #abc` in text are not colors.
 */
const HEX_COLOR = /(?:^\s*|[:=(,]\s*)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/
/** a color as a number: exactly 6 hex digits after 0x (a Raster cell color is 0x00RRGGBB) */
const HEX_COLOR_NUMBER = /^0[xX][0-9a-fA-F]{6}$/

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(ROOT, dir)).sort()) {
    const path = `${dir}/${entry}`
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) out.push(path)
  }
  return out
}

/** True when the identifier is a free reference, not a property name, a member name or a declared name. */
function isFreeReference(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false
  if (ts.isQualifiedName(parent) && parent.right === node) return false
  if ((parent as { name?: ts.Node }).name === node && !ts.isShorthandPropertyAssignment(parent)) return false
  return true
}

function stringish(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text
  return undefined
}

/** Every purity finding of one source file under src/god, as `<file>:<line> <rule>`. */
export function purityFindings(file: string, source: string, exists: (path: string) => boolean = (path) => existsSync(join(ROOT, path))): string[] {
  const isTsx = file.endsWith('.tsx')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const findings: string[] = []
  const add = (node: ts.Node, rule: string): void => {
    findings.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${rule}`)
  }
  const specifier = (spec: string, node: ts.Node): void => {
    if (spec.startsWith('node:')) add(node, `imports the Node module ${spec}`)
    else if (spec === 'claude-code') {
      if (!isTsx) add(node, 'a .ts file imports claude-code')
    } else if (!spec.startsWith('.')) add(node, `imports the bare module ${spec}`)
    else {
      const target = join(dirname(file), spec).replace(/\.(?:js|jsx|ts|tsx)$/, '')
      if (!isTsx && (/\.(?:tsx|jsx)$/.test(spec) || exists(`${target}.tsx`))) add(node, `a .ts file imports the .tsx file ${spec}`)
    }
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifier(node.moduleSpecifier.text, node)
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, 'loads a module with import()')
    if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text) && isFreeReference(node)) add(node, `uses the Node global ${node.text}`)
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(sf) === 'globalThis' && NODE_GLOBALS.has(node.name.text)) {
      add(node, `uses the Node global ${node.name.text}`)
    }
    if (ts.isElementAccessExpression(node) && node.expression.getText(sf) === 'globalThis' && ts.isStringLiteralLike(node.argumentExpression) && NODE_GLOBALS.has(node.argumentExpression.text)) {
      add(node, `uses the Node global ${node.argumentExpression.text}`)
    }
    if (file !== ENGINE_CLOCK_FILE) {
      if (ts.isPropertyAccessExpression(node) && node.expression.getText(sf) === 'Date' && node.name.text === 'now') add(node, `reads Date.now outside ${ENGINE_CLOCK_FILE}`)
      if (ts.isNewExpression(node) && node.expression.getText(sf) === 'Date' && (node.arguments?.length ?? 0) === 0) add(node, `reads the clock with new Date() outside ${ENGINE_CLOCK_FILE}`)
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date') add(node, `reads the clock with Date() outside ${ENGINE_CLOCK_FILE}`)
    }
    const text = stringish(node)
    if (!file.startsWith(GENERATED)) {
      if (text !== undefined && HEX_COLOR.test(text)) add(node, 'holds a hex color: take it from src/god/generated/tokens.ts')
      if (ts.isNumericLiteral(node) && HEX_COLOR_NUMBER.test(node.getText(sf).replace(/_/g, ''))) add(node, 'holds a hex color number: take it from src/god/generated/tokens.ts')
    }
    if (isTsx) {
      if (ts.isJsxText(node) && /\p{L}/u.test(node.text)) add(node, 'holds JSX text: move the copy to a .ts module')
      if (text !== undefined && /\s/.test(text) && /\p{L}/u.test(text)) add(node, 'holds a string with a space: move the copy to a .ts module')
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  if (isTsx) {
    source.split('\n').forEach((row, index) => {
      if (row.includes(EM_DASH)) findings.push(`${file}:${index + 1} holds an em dash`)
      if (ESCAPE_SPELLING.test(row)) findings.push(`${file}:${index + 1} spells an escape sequence`)
    })
  }
  return findings
}

/** Every finding of the built bundle that the engine loads. */
export function bundleFindings(bundle: string): string[] {
  const findings: string[] = []
  if (!/^function register\(on[,)]/m.test(bundle)) findings.push('no top-level function register(on')
  if (/\bimport\s*\(/.test(bundle)) findings.push('holds import(')
  for (const match of bundle.matchAll(/^\s*(?:import|export)\b[^'"\n;]*?(?:\bfrom\s*)?['"]([^'"]+)['"]/gm)) {
    if (match[1] !== 'claude-code') findings.push(`imports ${match[1]}`)
  }
  return findings
}

describe('purity lint: src/god', () => {
  it('walks every source of src/god (the walk is not empty)', () => {
    const files = sourceFiles(GOD)
    expect(files).toEqual(expect.arrayContaining(['src/god/types.ts', 'src/god/host.ts', 'src/god/register.tsx']))
  })

  it('no source under src/god breaks a purity rule', () => {
    const findings = sourceFiles(GOD).flatMap((file) => purityFindings(file, readFileSync(join(ROOT, file), 'utf8')))
    expect(findings).toEqual([])
  })

  it('each rule fails its planted line, and the allowed forms pass', () => {
    const plant = (file: string, source: string, exists: (path: string) => boolean = () => false): string[] =>
      purityFindings(file, source, exists).map((finding) => finding.replace(/^\S+ /, ''))
    const pure = 'src/god/model/plant.ts'
    const shell = 'src/god/ui/plant.tsx'
    expect(plant(pure, "import { readFileSync } from 'node:fs'\n")).toEqual(['imports the Node module node:fs'])
    expect(plant(pure, "import ts from 'typescript'\n")).toEqual(['imports the bare module typescript'])
    expect(plant(pure, "import type { On } from 'claude-code'\n")).toEqual(['a .ts file imports claude-code'])
    expect(plant(pure, "import { board } from '../ui/board.js'\n", (path) => path === 'src/god/ui/board.tsx')).toEqual(['a .ts file imports the .tsx file ../ui/board.js'])
    expect(plant(pure, "export { board } from './board.tsx'\n")).toEqual(['a .ts file imports the .tsx file ./board.tsx'])
    expect(plant(pure, 'const home = process.env.HOME\n')).toEqual(['uses the Node global process'])
    expect(plant(pure, "const lib = require('x')\n")).toEqual(['uses the Node global require'])
    expect(plant(pure, "const bytes = Buffer.from('x')\n")).toEqual(['uses the Node global Buffer'])
    expect(plant(pure, 'setTimeout(() => undefined, 1)\n')).toEqual(['uses the Node global setTimeout'])
    expect(plant(pure, 'setInterval(() => undefined, 1)\n')).toEqual(['uses the Node global setInterval'])
    expect(plant(pure, "const mod = await import('./x.js')\n")).toEqual(['loads a module with import()'])
    expect(plant(pure, 'const now = Date.now()\n')).toEqual(['reads Date.now outside src/god/engine.tsx'])
    expect(plant(pure, "const color = '#d97757'\n")).toEqual(['holds a hex color: take it from src/god/generated/tokens.ts'])
    expect(plant(pure, 'const color = `#abc`\n')).toEqual(['holds a hex color: take it from src/god/generated/tokens.ts'])
    expect(plant(shell, 'const row = <Text>Reading sessions.</Text>\n')).toEqual(['holds JSX text: move the copy to a .ts module'])
    expect(plant(shell, "const line = 'No other session runs now.'\n")).toEqual(['holds a string with a space: move the copy to a .ts module'])
    expect(plant(shell, 'const line = `${n} need you`\n')).toEqual(['holds a string with a space: move the copy to a .ts module'])
    expect(plant(shell, `// a note ${EM_DASH} with a dash\n`)).toEqual(['holds an em dash'])
    expect(plant(shell, ["const clear = '", '\\', "x1b[2J'\n"].join(''))).toEqual(['spells an escape sequence'])
    // allowed: the engine noun, a member named like a global, the engine clock, the generated colors
    expect(plant(shell, "import { atom } from 'claude-code'\nconst r = await $.process.run(['ps'])\nconst t = Date.now()\n")).toEqual(['reads Date.now outside src/god/engine.tsx'])
    expect(purityFindings(ENGINE_CLOCK_FILE, 'const t = Date.now()\n', () => false)).toEqual([])
    expect(plant(pure, 'type Host = { process: number }\nconst host = { process: 1 }\nconst n = host.process\n')).toEqual([])
    expect(purityFindings('src/god/generated/tokens.ts', "export const ACCENT = '#d97757'\n", () => false)).toEqual([])
    expect(plant(shell, "on('session.start', async ($, e, next) => next(e))\nconst row = <Text dimColor>{label}{' '}</Text>\n")).toEqual([])
  })

  it('fails a global reached through globalThis, the clock read through new Date() or Date(), and a hex color written as a number', () => {
    const plant = (file: string, source: string): string[] => purityFindings(file, source, () => false).map((finding) => finding.replace(/^\S+ /, ''))
    const pure = 'src/god/model/plant.ts'
    expect(plant(pure, 'const home = globalThis.process.env.HOME\n')).toEqual(['uses the Node global process'])
    expect(plant(pure, 'globalThis.setTimeout(() => undefined, 1)\n')).toEqual(['uses the Node global setTimeout'])
    expect(plant(pure, "const bytes = globalThis['Buffer']\n")).toEqual(['uses the Node global Buffer'])
    expect(plant(pure, 'const now = new Date()\n')).toEqual(['reads the clock with new Date() outside src/god/engine.tsx'])
    expect(plant(pure, 'const now = Date()\n')).toEqual(['reads the clock with Date() outside src/god/engine.tsx'])
    expect(plant(pure, 'const cell = 0xd97757\n')).toEqual(['holds a hex color number: take it from src/god/generated/tokens.ts'])
    expect(plant(pure, 'const cell = 0xD9_77_57\n')).toEqual(['holds a hex color number: take it from src/god/generated/tokens.ts'])
    expect(plant(pure, "const css = 'color:#abc'\n")).toEqual(['holds a hex color: take it from src/god/generated/tokens.ts'])
    // allowed: a date from a value, the engine clock, a glyph or a WAV field as a number, a pull request number in text
    expect(plant(pure, "const at = new Date(ms)\nconst parsed = Date.parse('2026-10-09')\n")).toEqual([])
    expect(purityFindings(ENGINE_CLOCK_FILE, 'const now = new Date()\n', () => false)).toEqual([])
    expect(plant(pure, 'const glyph = 0x2588\nconst riff = 0x46464952\nconst plain = 0x01000000\nconst rate = 44100\n')).toEqual([])
    expect(plant(pure, "const line = 'PR #1234'\nconst issue = `see #abc`\n")).toEqual([])
    expect(purityFindings('src/god/generated/colors.ts', 'export const ACCENT = 0xd97757\n', () => false)).toEqual([])
  })
})

describe('purity lint: the bundle the engine loads', () => {
  it(`${BUNDLE} declares register at its top level and imports nothing but claude-code`, () => {
    expect(existsSync(join(ROOT, BUNDLE)), `${BUNDLE} exists: npm run build writes it`).toBe(true)
    expect(bundleFindings(readFileSync(join(ROOT, BUNDLE), 'utf8'))).toEqual([])
  })

  it('each bundle rule fails its planted form', () => {
    expect(bundleFindings('var register = (on) => {};\nexport { register };\n')).toEqual(['no top-level function register(on'])
    expect(bundleFindings("function register(on) { import('x') }\nexport { register };\n")).toEqual(['holds import('])
    expect(bundleFindings("import { readFileSync } from 'node:fs';\nfunction register(on, options) {}\nexport { register };\n")).toEqual(['imports node:fs'])
    expect(bundleFindings("import { atom } from 'claude-code';\nfunction register(on, options) {}\nexport {\n  register\n};\n")).toEqual([])
  })
})
