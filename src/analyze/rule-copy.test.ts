/**
 * Rule copy, read from the source of src/analyze/insights.ts (its TypeScript AST), not from a run. A rule
 * that never fires on a fixture still has its copy checked.
 *
 * Each rule writes three texts for a finding: a title, a detail and the improvement (`recommendation`).
 * - The improvement is fixed rule text. Default redaction keeps it (src/redact/redact.ts), and the session
 *   report, the repo and global outputs, `--json` and `orangu evidence` all carry it
 *   (CrossFinding.recommendation). An improvement built from session data would leak that data into all of
 *   them, so every value must be a string literal, a conditional of literals, or a local constant of those.
 * - The improvement starts with the change. Its first word is an imperative verb from the list below, and
 *   its first sentence is one short instruction. A rule that only informs starts with "No change needed."
 * - Rule copy uses no semicolon. A list in a detail uses the client separator " · ".
 * - The Plain view maps terms by substring (PLAIN_TERMS in src/report/client/strings.ts). Each term that a
 *   rule's copy carried when this test landed is still in that rule's copy, so the Plain view still maps it.
 */
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PLAIN_TERMS } from '../report/client/strings.js'

const FILE = join(dirname(fileURLToPath(import.meta.url)), 'insights.ts')
const SOURCE = ts.createSourceFile(FILE, readFileSync(FILE, 'utf8'), ts.ScriptTarget.Latest, true)

type Field = 'title' | 'detail' | 'recommendation'
const FIELDS: readonly Field[] = ['title', 'detail', 'recommendation']

/** The first word of every improvement that advises a change. Add a verb here only with the copy that uses it. */
const IMPROVEMENT_VERBS = new Set([
  'Add',
  'Ask',
  'Batch',
  'Check',
  'Convert',
  'Disable',
  'Do',
  'Fix',
  'Generate',
  'Give',
  'Keep',
  'Load',
  'Lower',
  'Make',
  'Plan',
  'Put',
  'Read',
  'Replace',
  'Run',
  'Send',
  'Set',
  'Spawn',
  'Split',
  'Start',
  'Time',
  'Trim',
  'Use',
])
const NO_CHANGE = 'No change needed.'
/** STE rule 1: an instruction has 20 words or fewer. */
const INSTRUCTION_WORDS = 20
/**
 * Born 2026-10-06 at its own count: 45 rule sites, plus one more text each for the two improvements that
 * pick between two fixed texts (time-budget, hidden-iterations). The count only goes up.
 */
const IMPROVEMENT_TEXTS_FLOOR = 47

/**
 * The PLAIN_TERMS keys that each rule's copy carried on 2026-10-06, before the copy rewrite. The Plain view
 * replaces them by substring, so each one must stay in the same rule and field, or the map must change too.
 */
const PLAIN_TERMS_IN_RULE_COPY: Readonly<Record<string, Partial<Record<Field, readonly string[]>>>> = {
  compactions: { title: ['compaction'], recommendation: ['compaction'] },
  'context-near-limit': { recommendation: ['compaction'] },
  'cache-dominates-tokens': { detail: ['cache read', 'cache write'] },
}

interface Site {
  ruleId: string
  line: number
  node: ts.ObjectLiteralExpression
  props: Map<string, ts.Expression>
}

/** Every argument of an `mk(...)` call: the object literal each rule builds an Insight from. */
function ruleSites(): { calls: number; sites: Site[] } {
  let calls = 0
  const sites: Site[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'mk') {
      calls++
      const arg = node.arguments[0]
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const props = new Map<string, ts.Expression>()
        for (const p of arg.properties) if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) props.set(p.name.text, p.initializer)
        const id = props.get('ruleId')
        if (id && ts.isStringLiteral(id)) sites.push({ ruleId: id.text, line: SOURCE.getLineAndCharacterOfPosition(arg.getStart(SOURCE)).line + 1, node: arg, props })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(SOURCE)
  return { calls, sites }
}

/** The initializer of the constant `name`, declared in a function that encloses `from`. */
function localConst(from: ts.Node, name: string): ts.Expression | undefined {
  for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
    if (!ts.isFunctionLike(scope)) continue
    let found: ts.Expression | undefined
    const look = (node: ts.Node): void => {
      if (found) return
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
        const list = node.parent
        if (ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const) found = node.initializer
      } else if (!ts.isFunctionLike(node)) ts.forEachChild(node, look)
    }
    ts.forEachChild(scope, look)
    if (found) return found
  }
  return undefined
}

/** Every text the expression can produce, or undefined when any branch is not fixed text. */
function fixedTexts(node: ts.Expression): string[] | undefined {
  if (ts.isParenthesizedExpression(node)) return fixedTexts(node.expression)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isConditionalExpression(node)) {
    const yes = fixedTexts(node.whenTrue)
    const no = fixedTexts(node.whenFalse)
    return yes && no ? [...yes, ...no] : undefined
  }
  if (ts.isIdentifier(node)) {
    const init = localConst(node, node.text)
    return init ? fixedTexts(init) : undefined
  }
  return undefined
}

/** The static text of a title or detail: every string literal part, each substitution read as "3". */
function staticText(node: ts.Node): string {
  const parts: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts.push(n.text)
    else if (ts.isTemplateExpression(n)) {
      parts.push(n.head.text + n.templateSpans.map((span) => `3${span.literal.text}`).join(''))
      for (const span of n.templateSpans) visit(span.expression)
    } else ts.forEachChild(n, visit)
  }
  visit(node)
  return parts.join(' ')
}

function copyOf(site: Site, field: Field): string {
  const value = site.props.get(field)
  if (!value) return ''
  if (field === 'recommendation') return (fixedTexts(value) ?? []).join(' ')
  return staticText(value)
}

/** The first sentence: up to the first `.`, `!` or `?` that a space and a capital, a digit or a quote follow. */
function firstSentence(text: string): string {
  const end = /[.!?](?=\s+[A-Z0-9"“(`])/.exec(text)
  return end ? text.slice(0, end.index + 1) : text
}

const words = (sentence: string): number => sentence.split(/\s+/).filter((token) => /[A-Za-z0-9]/.test(token)).length

const { calls, sites } = ruleSites()
const improvements = sites.flatMap((site) => (fixedTexts(site.props.get('recommendation')!) ?? []).map((text) => ({ ruleId: site.ruleId, line: site.line, text })))

describe('rule copy: the improvement is fixed rule text', () => {
  it('reads every rule site: each mk() call passes an object literal with a literal ruleId', () => {
    expect(calls).toBeGreaterThan(0)
    expect(sites.length).toBe(calls)
  })

  it('builds every recommendation from string literals, never from session data', () => {
    const built = sites.filter((site) => {
      const value = site.props.get('recommendation')
      return !value || fixedTexts(value) === undefined
    })
    expect(
      built.map((site) => `${site.ruleId} (insights.ts:${site.line})`),
      'a recommendation must be a string literal, a conditional of literals, or a local const of those',
    ).toEqual([])
  })

  it(`counts at least ${IMPROVEMENT_TEXTS_FLOOR} improvement texts`, () => {
    expect(improvements.length).toBeGreaterThanOrEqual(IMPROVEMENT_TEXTS_FLOOR)
  })
})

describe('rule copy: each improvement starts with the change', () => {
  it('starts with an imperative verb, or with "No change needed."', () => {
    const bad = improvements.filter(({ text }) => !text.startsWith(`${NO_CHANGE} `) && !IMPROVEMENT_VERBS.has(text.split(/\s+/)[0] ?? ''))
    expect(bad.map(({ ruleId, line, text }) => `${ruleId} (insights.ts:${line}): ${text.slice(0, 60)}`)).toEqual([])
  })

  it(`opens with one instruction of ${INSTRUCTION_WORDS} words or fewer`, () => {
    const long = improvements.filter(({ text }) => words(firstSentence(text)) > INSTRUCTION_WORDS)
    expect(long.map(({ ruleId, line, text }) => `${ruleId} (insights.ts:${line}): ${words(firstSentence(text))} words: ${firstSentence(text)}`)).toEqual([])
  })
})

describe('rule copy: STE punctuation', () => {
  it('uses no semicolon in a title, a detail or an improvement', () => {
    const hits = sites.flatMap((site) => FIELDS.filter((field) => copyOf(site, field).includes(';')).map((field) => `${site.ruleId}.${field} (insights.ts:${site.line})`))
    expect(hits).toEqual([])
  })
})

describe('rule copy: the Plain view still maps the terms the copy carried', () => {
  it.each(Object.entries(PLAIN_TERMS_IN_RULE_COPY))('%s', (ruleId, fields) => {
    const own = sites.filter((site) => site.ruleId === ruleId)
    expect(own.length, `no rule site for ${ruleId}`).toBeGreaterThan(0)
    for (const [field, terms] of Object.entries(fields) as Array<[Field, readonly string[]]>) {
      const copy = own.map((site) => copyOf(site, field)).join(' ')
      for (const term of terms) {
        expect(PLAIN_TERMS, `PLAIN_TERMS lost "${term}"`).toHaveProperty([term])
        expect(copy, `${ruleId}.${field} lost the Plain term "${term}"`).toContain(term)
      }
    }
  })
})
