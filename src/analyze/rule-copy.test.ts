/**
 * Rule copy, read from the source of src/analyze/insights.ts (its TypeScript AST), not from a run. A rule
 * that never fires on a fixture still has its copy checked.
 *
 * Each rule writes a title and a detail for a finding, and its rule text in 3 parts: the `improvement` (the
 * change to make), the `why` (what the finding costs or means) and, where the rule needs one, the `method`
 * (what the rule counts and skips, and how to read the finding). mk() joins the parts, in that order, into
 * `recommendation`, which older readers still read.
 * - The parts are fixed rule text. Default redaction keeps them (src/redact/redact.ts), and the session
 *   report, the repo and global outputs, `--json` and `orangu evidence` all carry them
 *   (CrossFinding.recommendation). A part built from session data would leak that data into all of them,
 *   so every value must be a string literal, a conditional of literals, or a local constant of those.
 * - The improvement starts with the change: an imperative verb from the list below, or a condition and then
 *   that verb ("If <condition>, <verb> ...", STE rule 6). Its first sentence is one short instruction. A rule
 *   whose finding is not a problem by itself starts with its verdict, "No change needed." No sentence of
 *   the why or the method gives a change.
 * - Rule copy uses no semicolon. A list in a detail uses the client separator " · ".
 * - The Plain view maps terms by substring (PLAIN_TERMS in src/report/client/strings.ts). Each term that a
 *   rule's copy carried when this test landed is still in that rule's copy, so the Plain view still maps it.
 * - A cached Analysis carries this copy, and the cache key does not read it. So a copy change must move
 *   ANALYSIS_PAYLOAD_GENERATION, or a warm cache serves the old copy. The fingerprint below enforces that.
 *   It reads this copy, and only this copy:
 *   - the rule sites of insights.ts and narrative() in analyze.ts;
 *   - quality.ts: the quality signals, and every `label` (the "gh pr create" PR link too);
 *   - parse.ts: the parse warnings, and every event `label` and block `note` (the model-fallback note
 *     becomes an event label);
 *   - the tool-call summaries of summarizeToolInput (src/adapters/claude-code/tools.ts).
 *   A sweep on 2026-10-06 found no other literal of 2 or more words in src/analyze or
 *   src/adapters/claude-code that lands in an Analysis. New cached copy elsewhere joins this list.
 */
import ts from 'typescript'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ANALYSIS_PAYLOAD_GENERATION } from '../model/analysis.js'
import { PLAIN_TERMS } from '../report/client/strings.js'
import { NO_CHANGE } from './insights.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = join(HERE, 'insights.ts')
const SOURCE = ts.createSourceFile(FILE, readFileSync(FILE, 'utf8'), ts.ScriptTarget.Latest, true)
const ANALYZE_FILE = join(HERE, 'analyze.ts')
const ANALYZE_SOURCE = ts.createSourceFile(ANALYZE_FILE, readFileSync(ANALYZE_FILE, 'utf8'), ts.ScriptTarget.Latest, true)
const QUALITY_FILE = join(HERE, 'quality.ts')
const QUALITY_SOURCE = ts.createSourceFile(QUALITY_FILE, readFileSync(QUALITY_FILE, 'utf8'), ts.ScriptTarget.Latest, true)
const PARSE_FILE = join(HERE, '..', 'adapters', 'claude-code', 'parse.ts')
const PARSE_SOURCE = ts.createSourceFile(PARSE_FILE, readFileSync(PARSE_FILE, 'utf8'), ts.ScriptTarget.Latest, true)
const TOOLS_FILE = join(HERE, '..', 'adapters', 'claude-code', 'tools.ts')
const TOOLS_SOURCE = ts.createSourceFile(TOOLS_FILE, readFileSync(TOOLS_FILE, 'utf8'), ts.ScriptTarget.Latest, true)

/** The 3 parts of a rule text, in the order mk() joins them into `recommendation`. */
type Part = 'improvement' | 'why' | 'method'
const PARTS: readonly Part[] = ['improvement', 'why', 'method']
type Field = 'title' | 'detail' | Part
const FIELDS: readonly Field[] = ['title', 'detail', ...PARTS]

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
/**
 * The rules whose finding is not a problem by itself, and how many of their improvement texts lead with
 * NO_CHANGE. A card and a show-me slide show the improvement first, so the verdict must come first there,
 * and any advice after it is conditional. hidden-iterations has 2 texts; the one for a session-wide fallback
 * leads with its fix.
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
 * 2026-10-06, re-recorded at generation 2 with no copy change: the fingerprint now also reads the quality
 * signals and labels, the parse warnings, the event labels and block notes, and the tool-call summaries.
 * quality.ts, adapters/claude-code/tools.ts and every warn(), label and note in parse.ts are byte-identical to main.
 * 2026-10-07, generation 3: the narrative in STE (analyze.ts narrative()), and "1 tool call" in the singular. The
 * copy changed, so the generation moved. Re-recorded at 3 on the same unmerged branch: the tool-errors title says
 * "1 tool error (100% of 1 call)" in the singular.
 * 2026-10-07, generation 4: each rule text is 3 parts (improvement, why, method), and the fingerprint reads each
 * part. The words are the 0.9.0 words (the test "the split keeps every 0.9.0 word" proves it), but 3 texts now
 * put their sentences in a new order, so `recommendation` changed for them and the generation moved.
 * 2026-10-07, generation 4 again: the narrative puts its top finding titles in a second paragraph, each title its
 * own sentence, and keeps the session title on one line (NARRATIVE_0_9_0). Re-recorded at 4, because generation 4
 * is not released: 0.9.0 ships generation 3, and the 0.10.0 release moves the engine segment of the cache
 * directory, so no shipped cache holds a generation 4 entry.
 */
const COPY_FINGERPRINT = { generation: 4, sha256: '5fd967f5e2d749c4472f840d6a699c69d5efc13c09ae37dd61a1e3a6c21e3534' }
/**
 * The generation 3 fingerprint, as `git show v0.9.0:src/analyze/rule-copy.test.ts` records it. The split of each
 * rule text into its 3 parts, and the narrative with its NARRATIVE_0_9_0 literals put back, must rebuild this
 * value exactly. So no word, title or detail changed in the split, and no narrative word changed.
 * A later copy rewrite deletes this constant and its test, and runs its own qualifier audit.
 */
const COPY_FINGERPRINT_0_9_0 = 'd0cc1f29c96a54443516e6b7b34569ba46fd06e4225584163a9dc8d3165c31c0'
/**
 * The texts whose parts do not join in their 0.9.0 sentence order: a conditional instruction came after the
 * reason, and it now moves into the improvement. Each entry gives the opening words of each sentence, in the
 * 0.9.0 order. The key is the rule id, with `#<n>` for the n-th text of a rule that picks between texts.
 * Every other text joins as improvement, then why, then method, which was its 0.9.0 order.
 */
const ORDER_0_9_0: Readonly<Record<string, readonly string[]>> = {
  // 0.9.0: verdict, reason, then the 2 conditional instructions. Now: improvement = verdict and the 2 instructions.
  'human-wait-dominates': ['No change needed.', 'A long wait is not a problem by itself', 'If you want more throughput', 'You can also batch'],
  // the no-change text. 0.9.0: verdict, reason, then the conditional check. Now: improvement = verdict and the check.
  'hidden-iterations#2': ['No change needed.', 'These attempts used tokens', 'If fallbacks recur'],
  // 0.9.0: the instruction, the reason, then the exception. Now: improvement = the instruction and the exception.
  'fanout-opportunity': ['Spawn independent subagents', 'Then the wall-clock time', 'Keep serial spawns'],
}
/**
 * The narrative literals that changed after 0.9.0, as staticParts reads them (a substitution reads as "3"): the
 * 0.9.0 run of parts and the run that replaced it. 0.9.0 joined the top finding titles into one list sentence at
 * the end of one paragraph. Now the titles are a second paragraph, after one blank line: "Look at these first." is
 * its own sentence, and so is each title, with a period added only where the title has no end mark. The quoted
 * session title is on one line, so that blank line is the only one. Every other narrative literal is the 0.9.0
 * literal, and no word changed.
 */
const NARRATIVE_0_9_0: ReadonlyArray<{ readonly was: readonly string[]; readonly now: readonly string[] }> = [
  // 0.9.0: `“${s.meta.title.slice(0, 80)}”`. Now the title first joins its whitespace with ' '.
  { was: ['“3”', 'this session'], now: ['“3”', ' ', 'this session'] },
  // 0.9.0: `Look at these first: ${top.join(' · ')}.`, then `return parts.join(' ')`. Now: `facts = parts.join(' ')`,
  // then 'Look at these first.' and `${title}.` for each title, joined with ' ', and the 2 paragraphs joined with '\n\n'.
  { was: ['Look at these first: 3.', ' · ', ' '], now: [' ', 'Look at these first.', '3.', ' ', '\n\n'] },
]
/**
 * Born 2026-10-06 at its own count: 45 rule sites, plus one more text each for the two improvements that
 * pick between two fixed texts (time-budget, hidden-iterations). The count only goes up.
 */
const IMPROVEMENT_TEXTS_FLOOR = 47

/**
 * The PLAIN_TERMS keys that each rule's copy carried on 2026-10-06, before the copy rewrite. The Plain view
 * replaces them by substring, so each one must stay in the same rule and field, or the map must change too.
 * 2026-10-07: the recommendation terms now sit in the part that holds them.
 */
const PLAIN_TERMS_IN_RULE_COPY: Readonly<Record<string, Partial<Record<Field, readonly string[]>>>> = {
  compactions: { title: ['compaction'], improvement: ['compaction'], why: ['compaction'] },
  'context-near-limit': { why: ['compaction'] },
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

/** The literal parts of a node, in source order: every string literal part, each substitution read as "3". */
function staticParts(node: ts.Node): string[] {
  const parts: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts.push(n.text)
    else if (ts.isTemplateExpression(n)) {
      parts.push(n.head.text + n.templateSpans.map((span) => `3${span.literal.text}`).join(''))
      for (const span of n.templateSpans) visit(span.expression)
    } else ts.forEachChild(n, visit)
  }
  visit(node)
  return parts
}

/** The static text of a title or detail: its literal parts, joined with one space. */
function staticText(node: ts.Node): string {
  return staticParts(node).join(' ')
}

const isPart = (field: Field): field is Part => (PARTS as readonly string[]).includes(field)

function copyOf(site: Site, field: Field): string {
  const value = site.props.get(field)
  if (!value) return ''
  if (isPart(field)) return (fixedTexts(value) ?? []).join(' ')
  return staticText(value)
}

/** The texts of one part of a site, one for each text the rule can pick, or [] when the site has no such part. */
function partTexts(site: Site, part: Part): string[] {
  const value = site.props.get(part)
  return value ? (fixedTexts(value) ?? []) : []
}

/** A sentence ends at a `.`, `!` or `?` that a space and a capital, a digit or a quote follow. */
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"“(`])/

const sentencesOf = (text: string): string[] => text.split(SENTENCE_END)

/** The first sentence: up to the first `.`, `!` or `?` that a space and a capital, a digit or a quote follow. */
function firstSentence(text: string): string {
  return sentencesOf(text)[0] ?? text
}

const words = (sentence: string): number => sentence.split(/\s+/).filter((token) => /[A-Za-z0-9]/.test(token)).length

/** STE rule 6 puts the condition first: "If <condition>, <verb> ...". The condition ends at its first comma. */
const CONDITION = /^If [^,.]+, /

/** True when the text is the verdict, alone or with conditional advice after it. */
const isVerdict = (text: string): boolean => text === NO_CHANGE || text.startsWith(`${NO_CHANGE} `)

/** True when the text leads with the change: a listed verb, a condition and then that verb, or the verdict. */
function startsWithChange(text: string): boolean {
  if (isVerdict(text)) return true
  const word = text.replace(CONDITION, '').split(/\s+/)[0] ?? ''
  return IMPROVEMENT_VERBS.has(word.charAt(0).toUpperCase() + word.slice(1))
}

/** The string literal values of the evidence object: the notes a rule writes for a developer. */
function evidenceNotes(site: Site): string[] {
  const evidence = site.props.get('evidence')
  if (!evidence || !ts.isObjectLiteralExpression(evidence)) return []
  return evidence.properties.flatMap((p) => (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && ts.isStringLiteral(p.initializer) ? [`${p.name.text}=${p.initializer.text}`] : []))
}

/** The literal parts of narrative() in analyze.ts: the summary sentence every Analysis carries. */
function narrativeParts(): string[] {
  const fn = ANALYZE_SOURCE.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'narrative')
  return fn ? staticParts(fn) : []
}

/** The static text of narrative() in analyze.ts. */
function narrativeCopy(): string {
  return narrativeParts().join(' ')
}

/** Each index in `parts` where the whole run `run` starts. */
function runsOf(parts: readonly string[], run: readonly string[]): number[] {
  const out: number[] = []
  for (let i = 0; i + run.length <= parts.length; i++) if (run.every((part, k) => parts[i + k] === part)) out.push(i)
  return out
}

/** The 0.9.0 static text of narrative(): its literal parts, with each NARRATIVE_0_9_0 entry put back in its 0.9.0 form. */
function legacyNarrativeCopy(): string {
  let parts = narrativeParts()
  for (const { was, now } of NARRATIVE_0_9_0) {
    const at = runsOf(parts, now)
    if (at.length !== 1) throw new Error(`NARRATIVE_0_9_0: ${JSON.stringify(now)} is in narrative() ${at.length} times`)
    parts = [...parts.slice(0, at[0]), ...was, ...parts.slice(at[0]! + now.length)]
  }
  return parts.join(' ')
}

/** The copy of quality.signals[] in quality.ts: per signal its id and the static text of its label, value and detail. */
function qualityCopy(): string[] {
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'signals' && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      for (const signal of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(signal)) continue
        const text = new Map<string, string>()
        for (const p of signal.properties) if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) text.set(p.name.text, staticText(p.initializer))
        out.push(JSON.stringify(['id', 'label', 'value', 'detail'].map((key) => text.get(key) ?? '')))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(QUALITY_SOURCE)
  return out
}

/** The copy of parse.warnings[] in parse.ts: the code and message of each warn() call and each pushed warning. */
function parseWarningCopy(): string[] {
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'warn' && node.arguments.length >= 2) {
      out.push(JSON.stringify([staticText(node.arguments[0]!), staticText(node.arguments[1]!)]))
    }
    const pushed = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'push' ? node.expression.expression : undefined
    if (pushed && ts.isPropertyAccessExpression(pushed) && pushed.name.text === 'warnings' && ts.isCallExpression(node)) {
      const arg = node.arguments[0]
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const text = new Map<string, string>()
        for (const p of arg.properties) if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) text.set(p.name.text, staticText(p.initializer))
        out.push(JSON.stringify([text.get('code') ?? '', text.get('message') ?? '']))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(PARSE_SOURCE)
  return out
}

/** The static text of every property named in `keys`, anywhere in the source, in source order. */
function propertyCopy(source: ts.SourceFile, keys: readonly string[]): string[] {
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && keys.includes(node.name.text)) out.push(JSON.stringify([node.name.text, staticText(node.initializer)]))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** The static text of one top-level function. */
function functionCopy(source: ts.SourceFile, name: string): string {
  const fn = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name)
  return fn ? staticText(fn) : ''
}

/**
 * sha256 of the copy that a cached Analysis carries, as the header lists it: per rule site its id, title,
 * detail, the 3 parts of its rule text and its evidence notes, the narrative, the quality signals and labels,
 * the parse warnings, the event labels and block notes, and the tool-call summaries.
 */
function copyFingerprint(): string {
  return fingerprintOf(sites.map((site) => JSON.stringify([site.ruleId, ...FIELDS.map((field) => copyOf(site, field)), ...evidenceNotes(site)])))
}

/**
 * The 0.9.0 recommendation of a site, rebuilt from its parts: per text the parts join as improvement, why,
 * method, or in the sentence order of ORDER_0_9_0, and the texts of a rule that picks join with one space
 * (as the 0.9.0 fingerprint read a conditional). Each part has one text per pick, or one text for every pick.
 */
function legacyRecommendation(site: Site): string {
  const parts = PARTS.map((part) => partTexts(site, part))
  const picks = Math.max(...parts.map((texts) => texts.length))
  const texts: string[] = []
  for (let pick = 0; pick < picks; pick++) {
    const joined = parts.flatMap((texts) => {
      if (texts.length !== 0 && texts.length !== 1 && texts.length !== picks) throw new Error(`${site.ruleId} (insights.ts:${site.line}): a part picks ${texts.length} ways, the others ${picks}`)
      const text = texts.length === 1 ? texts[0]! : texts[pick]
      return text ? [text] : []
    })
    const order = ORDER_0_9_0[picks > 1 ? `${site.ruleId}#${pick + 1}` : site.ruleId]
    texts.push(order ? inOrder(joined.flatMap(sentencesOf), order, site.ruleId) : joined.join(' '))
  }
  return texts.join(' ')
}

/** The sentences in the order of their openings. Each opening names exactly one sentence, and each sentence is named once. */
function inOrder(sentences: string[], openings: readonly string[], ruleId: string): string {
  const ordered = openings.map((opening) => {
    const named = sentences.filter((sentence) => sentence.startsWith(opening))
    if (named.length !== 1) throw new Error(`${ruleId}: "${opening}" opens ${named.length} sentences`)
    return named[0]!
  })
  if (new Set(ordered).size !== sentences.length) throw new Error(`${ruleId}: the 0.9.0 order names ${new Set(ordered).size} of ${sentences.length} sentences`)
  return ordered.join(' ')
}

/**
 * The generation 3 fingerprint function of v0.9.0: per rule site its id, title, detail, the recommendation and its
 * evidence notes, and the narrative with its 0.9.0 literals.
 */
function legacyCopyFingerprint(): string {
  return fingerprintOf(
    sites.map((site) => JSON.stringify([site.ruleId, copyOf(site, 'title'), copyOf(site, 'detail'), legacyRecommendation(site), ...evidenceNotes(site)])),
    legacyNarrativeCopy(),
  )
}

function fingerprintOf(ruleCopy: string[], narrative: string = narrativeCopy()): string {
  const rules = [...ruleCopy].sort()
  return createHash('sha256')
    .update(
      JSON.stringify({
        rules,
        narrative,
        quality: qualityCopy(),
        qualityLabels: propertyCopy(QUALITY_SOURCE, ['label']),
        parseWarnings: parseWarningCopy(),
        eventLabels: propertyCopy(PARSE_SOURCE, ['label', 'note']),
        toolSummaries: functionCopy(TOOLS_SOURCE, 'summarizeToolInput'),
      }),
    )
    .digest('hex')
}

const { calls, sites } = ruleSites()
const textsOf = (part: Part) => sites.flatMap((site) => partTexts(site, part).map((text) => ({ ruleId: site.ruleId, line: site.line, text })))
const improvements = textsOf('improvement')

describe('rule copy: the rule text is fixed text in 3 parts', () => {
  it('reads every rule site: each mk() call passes an object literal with a literal ruleId', () => {
    expect(calls).toBeGreaterThan(0)
    expect(sites.length).toBe(calls)
  })

  it('passes the parts, never the joined recommendation, at every rule site', () => {
    expect(sites.filter((site) => site.props.has('recommendation')).map((site) => `${site.ruleId} (insights.ts:${site.line})`)).toEqual([])
  })

  it('builds a non-empty improvement and why, and any method, from string literals, never from session data', () => {
    const bad = sites.flatMap((site) =>
      PARTS.flatMap((part) => {
        const value = site.props.get(part)
        if (!value) return part === 'method' ? [] : [`${site.ruleId}.${part} (insights.ts:${site.line}): missing`]
        const texts = fixedTexts(value)
        if (texts === undefined) return [`${site.ruleId}.${part} (insights.ts:${site.line}): not fixed text`]
        return texts.some((text) => !text.trim()) ? [`${site.ruleId}.${part} (insights.ts:${site.line}): empty`] : []
      }),
    )
    expect(bad, 'a part must be a non-empty string literal, a conditional of literals, or a local const of those').toEqual([])
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
    expect(startsWithChange('No change needed.')).toBe(true)
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
    for (const { ruleId, text } of improvements) if (isVerdict(text)) verdicts[ruleId] = (verdicts[ruleId] ?? 0) + 1
    expect(verdicts).toEqual(VERDICT_FIRST)
    // human-wait-dominates: the verdict, then advice that is conditional, never an order. The reason says why
    // no change is needed.
    const [wait] = improvements.filter(({ ruleId }) => ruleId === 'human-wait-dominates')
    expect(wait?.text).toMatch(/^No change needed\. If you want more throughput, /)
    const [waitWhy] = textsOf('why').filter(({ ruleId }) => ruleId === 'human-wait-dominates')
    expect(waitWhy?.text).toMatch(/^A long wait is not a problem by itself\b/)
  })

  it(`opens with one instruction of ${INSTRUCTION_WORDS} words or fewer`, () => {
    const long = improvements.filter(({ text }) => words(firstSentence(text)) > INSTRUCTION_WORDS)
    expect(long.map(({ ruleId, line, text }) => `${ruleId} (insights.ts:${line}): ${words(firstSentence(text))} words: ${firstSentence(text)}`)).toEqual([])
  })

  it('gives no change in the why or the method: no sentence there starts with a listed verb or "If ..., <verb>"', () => {
    const orders = (['why', 'method'] as const).flatMap((part) =>
      textsOf(part).flatMap(({ ruleId, line, text }) => sentencesOf(text).filter(startsWithChange).map((sentence) => `${ruleId}.${part} (insights.ts:${line}): ${sentence}`)),
    )
    expect(orders).toEqual([])
  })
})

describe('rule copy: since 0.9.0, sentences moved and no word changed', () => {
  it('the split keeps every 0.9.0 word', () => {
    // the parts, joined in their 0.9.0 sentence order, and the narrative with its NARRATIVE_0_9_0 literals in
    // their 0.9.0 form, give back the 0.9.0 copy fingerprint exactly
    expect(legacyCopyFingerprint()).toBe(COPY_FINGERPRINT_0_9_0)
  })

  it('names in NARRATIVE_0_9_0 only narrative literals that changed, each once', () => {
    const parts = narrativeParts()
    for (const { was, now } of NARRATIVE_0_9_0) {
      expect(runsOf(parts, now), `${JSON.stringify(now)} is in narrative() once`).toHaveLength(1)
      expect(runsOf(parts, was), `${JSON.stringify(was)} is no longer in narrative()`).toEqual([])
    }
  })

  it('names in ORDER_0_9_0 only texts that do not join in their 0.9.0 order', () => {
    for (const key of Object.keys(ORDER_0_9_0)) {
      const [ruleId, pick] = key.split('#')
      const own = sites.filter((site) => site.ruleId === ruleId)
      expect(own.length, key).toBe(1)
      const parts = PARTS.map((part) => partTexts(own[0]!, part)).map((texts) => (texts.length === 1 ? texts[0]! : (texts[Number(pick ?? 1) - 1] ?? '')))
      // joined as improvement, why, method, the text differs from the 0.9.0 order, so the entry is needed
      const joined = parts.filter((text) => text).join(' ')
      expect(inOrder(sentencesOf(joined), ORDER_0_9_0[key]!, key), key).not.toBe(joined)
    }
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
    expect(narrativeCopy()).toContain('Look at these first.')
    expect(new Set(sites.map((site) => site.ruleId)).size).toBeGreaterThanOrEqual(44)
  })

  it('reads the quality signals, parse warnings, event labels and tool summaries into the fingerprint', () => {
    // each of these is copy in a cached Analysis, and the report shows each one
    const quality = qualityCopy().map((entry) => JSON.parse(entry) as string[])
    expect(quality.map(([id]) => id)).toEqual(['tests', 'builds', 'commits', 'prs', 'tool-error-rate', 'corrections', 'interruptions', 'api-errors', 'rework', 'reverts'])
    expect(quality.find(([id]) => id === 'builds')?.[1]).toBe('Build / typecheck / lint runs')
    expect(quality.find(([id]) => id === 'tests')?.join(' ')).toContain('no test command detected')
    const warnings = parseWarningCopy().map((entry) => JSON.parse(entry) as string[])
    expect(warnings.map(([code]) => code).sort()).toEqual(['duplicate_uuid', 'multiple_session_ids', 'orphan_tool_result', 'unresolved_tool_calls'])
    expect(warnings.find(([code]) => code === 'orphan_tool_result')?.[1]).toBe('tool_result without a matching tool_use')
    const labels = (source: ts.SourceFile, keys: readonly string[]): string[] => propertyCopy(source, keys).map((entry) => (JSON.parse(entry) as string[]).join('='))
    expect(labels(QUALITY_SOURCE, ['label'])).toContain('label=gh pr create')
    const events = labels(PARSE_SOURCE, ['label', 'note'])
    for (const label of ['frame link', 'queued command', 'queued notification queued message', 'Request interrupted by user', 'model fallback', 'away summary']) {
      expect(events.some((entry) => entry.startsWith('label=') && entry.includes(label)), label).toBe(true)
    }
    expect(events.some((entry) => entry.startsWith('note=model fallback 3 → 3')), 'the model-fallback note').toBe(true)
    expect(functionCopy(TOOLS_SOURCE, 'summarizeToolInput')).toContain('inline script')
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
