/**
 * Rule copy, read from the source of src/analyze/insights.ts (its TypeScript AST), not from a run. A rule
 * that never fires on a fixture still has its copy checked.
 *
 * Each rule writes three texts for a finding: a title, a detail and the improvement (`recommendation`).
 * - The improvement is fixed rule text. Default redaction keeps it (src/redact/redact.ts), and the session
 *   report, the repo and global outputs, `--json` and `orangu evidence` all carry it
 *   (CrossFinding.recommendation). An improvement built from session data would leak that data into all of
 *   them, so every value must be a string literal, a conditional of literals, or a local constant of those.
 * - The improvement starts with the change: an imperative verb from the list below, or a condition and then
 *   that verb ("If <condition>, <verb> ...", STE rule 6). Its first sentence is one short instruction. A rule
 *   whose finding is not a problem by itself starts with its verdict, "No change needed."
 * - Rule copy uses no semicolon. A list in a detail uses the client separator " · ".
 * - The Plain view maps terms by substring (PLAIN_TERMS in src/report/client/strings.ts). Each term that a
 *   rule's copy carried when this test landed is still in that rule's copy, so the Plain view still maps it.
 * - A cached Analysis carries this copy, and the cache key does not read it. So a copy change must move
 *   ANALYSIS_PAYLOAD_GENERATION, or a warm cache serves the old copy. The fingerprint below enforces that.
 */
import ts from 'typescript'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ANALYSIS_PAYLOAD_GENERATION } from '../model/analysis.js'
import { PLAIN_TERMS } from '../report/client/strings.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = join(HERE, 'insights.ts')
const SOURCE = ts.createSourceFile(FILE, readFileSync(FILE, 'utf8'), ts.ScriptTarget.Latest, true)
const ANALYZE_FILE = join(HERE, 'analyze.ts')
const ANALYZE_SOURCE = ts.createSourceFile(ANALYZE_FILE, readFileSync(ANALYZE_FILE, 'utf8'), ts.ScriptTarget.Latest, true)

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
  'Tell',
  'Time',
  'Trim',
  'Use',
])
const NO_CHANGE = 'No change needed.'
/**
 * The rules whose finding is not a problem by itself, and how many of their texts lead with NO_CHANGE. A card
 * and a show-me slide show only the lead, so the verdict must come first there, and any advice after it is
 * conditional. hidden-iterations has 2 texts; the one for a session-wide fallback leads with its fix.
 */
const VERDICT_FIRST: Readonly<Record<string, number>> = {
  'human-wait-dominates': 1,
  'cache-ttl-churn': 1,
  'hidden-iterations': 1,
  'queued-prompts': 1,
}
/** STE rule 1: an instruction has 20 words or fewer. */
const INSTRUCTION_WORDS = 20
/**
 * The rule copy that cached Analysis payloads carry, recorded with the payload generation it ships under.
 * When the copy changes, this test fails until ANALYSIS_PAYLOAD_GENERATION moves (src/model/analysis.ts, with
 * its dated line) and the pair below is recorded again. A branch that already moved the generation above main
 * for its own unmerged copy change records the new fingerprint at that same generation.
 */
const COPY_FINGERPRINT = { generation: 2, sha256: '74205674ccf09cb7c236512eec94f4870a8d9b677417a9afdbcddb4dec36c487' }
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

/** STE rule 6 puts the condition first: "If <condition>, <verb> ...". The condition ends at its first comma. */
const CONDITION = /^If [^,.]+, /

/** True when the text leads with the change: a listed verb, a condition and then that verb, or the verdict. */
function startsWithChange(text: string): boolean {
  if (text.startsWith(`${NO_CHANGE} `)) return true
  const word = text.replace(CONDITION, '').split(/\s+/)[0] ?? ''
  return IMPROVEMENT_VERBS.has(word.charAt(0).toUpperCase() + word.slice(1))
}

/** The string literal values of the evidence object: the notes a rule writes for a developer. */
function evidenceNotes(site: Site): string[] {
  const evidence = site.props.get('evidence')
  if (!evidence || !ts.isObjectLiteralExpression(evidence)) return []
  return evidence.properties.flatMap((p) => (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && ts.isStringLiteral(p.initializer) ? [`${p.name.text}=${p.initializer.text}`] : []))
}

/** The static text of narrative() in analyze.ts: the summary sentence every Analysis carries. */
function narrativeCopy(): string {
  const fn = ANALYZE_SOURCE.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'narrative')
  return fn ? staticText(fn) : ''
}

/** sha256 of all rule copy: per rule site its id, title, detail, improvements and evidence notes, plus the narrative. */
function copyFingerprint(): string {
  const rules = sites.map((site) => JSON.stringify([site.ruleId, ...FIELDS.map((field) => copyOf(site, field)), ...evidenceNotes(site)])).sort()
  return createHash('sha256').update(JSON.stringify({ rules, narrative: narrativeCopy() })).digest('hex')
}

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
  it('reads a lead the way STE writes it: a verb, a condition and then a verb, or the verdict', () => {
    expect(startsWithChange('Fix the failing hooks in settings.json.')).toBe(true)
    expect(startsWithChange('If unresolved calls recur with the same tool, check for a hanging command.')).toBe(true)
    expect(startsWithChange('No change needed. The session worked well.')).toBe(true)
    expect(startsWithChange('If the tool hangs again, the agent waits.')).toBe(false)
    expect(startsWithChange('A slow tool stalls every turn that uses it.')).toBe(false)
    expect(startsWithChange('No change needed, probably.')).toBe(false)
  })

  it('starts with an imperative verb, a condition and then a verb, or "No change needed."', () => {
    const bad = improvements.filter(({ text }) => !startsWithChange(text))
    expect(bad.map(({ ruleId, line, text }) => `${ruleId} (insights.ts:${line}): ${text.slice(0, 60)}`)).toEqual([])
  })

  it('leads with "No change needed." exactly where the finding is not a problem by itself', () => {
    const verdicts: Record<string, number> = {}
    for (const { ruleId, text } of improvements) if (text.startsWith(`${NO_CHANGE} `)) verdicts[ruleId] = (verdicts[ruleId] ?? 0) + 1
    expect(verdicts).toEqual(VERDICT_FIRST)
    // human-wait-dominates: the verdict, then advice that is conditional, never an order
    const [wait] = improvements.filter(({ ruleId }) => ruleId === 'human-wait-dominates')
    expect(wait?.text).toMatch(/^No change needed\. A long wait is not a problem by itself\b/)
    expect(wait?.text).toContain('If you want more throughput, ')
  })

  it(`opens with one instruction of ${INSTRUCTION_WORDS} words or fewer`, () => {
    const long = improvements.filter(({ text }) => words(firstSentence(text)) > INSTRUCTION_WORDS)
    expect(long.map(({ ruleId, line, text }) => `${ruleId} (insights.ts:${line}): ${words(firstSentence(text))} words: ${firstSentence(text)}`)).toEqual([])
  })
})

describe('rule copy: a copy change moves the payload generation', () => {
  it('records the copy fingerprint with ANALYSIS_PAYLOAD_GENERATION', () => {
    expect(
      { generation: ANALYSIS_PAYLOAD_GENERATION, sha256: copyFingerprint() },
      'Rule copy changed but ANALYSIS_PAYLOAD_GENERATION did not, so a warm cache would serve the old copy. Bump the generation in src/model/analysis.ts (with its dated line), then record the new generation and fingerprint in COPY_FINGERPRINT.',
    ).toEqual(COPY_FINGERPRINT)
  })

  it('reads the narrative and every rule site into the fingerprint', () => {
    expect(narrativeCopy()).toContain('Biggest things to look at: ')
    expect(new Set(sites.map((site) => site.ruleId)).size).toBeGreaterThanOrEqual(44)
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
