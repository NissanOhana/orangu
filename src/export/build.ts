/**
 * orangu-export.json v1 (docs/DATA-CONTRACTS.md, "Export v1"): the bounded, redacted evidence that the brain reads in a
 * Claude chat outside Claude Code. A pure builder: `orangu export` reads the sessions, the store and the profile, and
 * this module gives the exact text of the file. It reads no clock, so the same input gives the same bytes.
 *
 * The file holds 6 sections, 1 on each line, in a fixed order: summary, index, profile, evidence, harness, lessons.
 * It is 131,072 B at most. The summary is 4,096 B at most, and the profile and the lessons are 16,384 B each at most.
 * The evidence and the harness share the rest. The evidence comes first: it takes the top findings that fit in half of
 * the rest, or in more when the harness needs less. Then the harness takes the heaviest rows that fit. The index gives
 * the size of each other section. For a section that a cut or a failed read made shorter, it says what it left out.
 *
 * No prompt text goes in. The evidence is the projection of `orangu evidence`, already scrubbed. The harness keeps no
 * rule text, no shared note word, no complaint and no preview. The profile keeps the words of the user, scrubbed here.
 */
import { plural } from '../harness/report.js'
import type { HarnessCrosswalk, HarnessEnforcementCounts, HarnessMemoryLoadRow, HarnessNoteRow, HarnessPromptRef, HarnessReport, HarnessRuleRow } from '../harness/types.js'
import { redactValue } from '../redact/redact.js'
import type { EvidenceBundle } from '../suggest/evidence.js'
import { fitFirst, LESSONS_MAX_BYTES, type LessonRead } from '../suggest/lessons.js'
import { PROFILE_MAX_BYTES, type ProfileV1 } from '../suggest/profile.js'

export const EXPORT_VERSION = 1
export const EXPORT_MAX_BYTES = 131_072
export const SUMMARY_MAX_BYTES = 4_096
/** The room that the index keeps in the file. Its 5 short entries need far less. */
const INDEX_MAX_BYTES = 2_048

export const EXPORT_SECTIONS = ['summary', 'index', 'profile', 'evidence', 'harness', 'lessons'] as const
type Section = (typeof EXPORT_SECTIONS)[number]

export interface ExportInput {
  /** the orangu version */
  version: string
  /** the Claude roots that the read covered */
  roots: number
  /** each session that discovery found */
  found: number
  /** the sessions that orangu read */
  sessions: number
  /** the sessions that orangu tried and could not read */
  unreadable: number
  /** epoch ms: the end of the newest session that orangu read, or null when no session has a time */
  asOf: number | null
  /** the profile as loadProfile gives it, with the raw words of the user. The builder scrubs it. */
  profile: ProfileV1 | null
  /** the projection of the global aggregate (projectEvidence), already scrubbed. The builder only cuts it. */
  evidence: EvidenceBundle
  /** the harness report after its redaction. The builder keeps the rows and drops each text field. */
  harness: HarnessReport
  /** every lesson of every workspace, or null when the store did not read */
  lessons: LessonRead | null
  /** the home that the scrub shows as `~`. The default is $HOME. */
  home?: string
}

export interface ExportSummary {
  v: typeof EXPORT_VERSION
  version: string
  scope: 'global'
  roots: number
  found: number
  sessions: number
  unreadable: number
  /** the end of the newest session, as an ISO 8601 UTC time: never the clock of the export */
  asOf: string | null
  redacted: true
  text: false
}

export interface ExportIndexEntry {
  section: Exclude<Section, 'index'>
  /** the bytes of the section value, as compact JSON on its line of the file */
  bytes: number
  /** what a cut or a failed read left out of the section */
  cut?: string
  /** the harness only: the rows that a cut left out, for each row array that lost rows (`skills`, `broken`, ...) */
  omitted?: Record<string, number>
}

/** A prompt reference with no preview: a session id, a turn and a time. */
type PromptRef = Omit<HarnessPromptRef, 'preview'>

export interface ExportHarness {
  schemaVersion: string
  crosswalk: HarnessCrosswalk
  enforcement: {
    counts: HarnessEnforcementCounts
    broken: Array<Omit<HarnessRuleRow, 'text' | 'examples'>>
    notes: Array<Omit<HarnessNoteRow, 'sharedWords' | 'trigger' | 'examples'> & { trigger?: PromptRef; examples: PromptRef[] }>
    memory: HarnessMemoryLoadRow[]
  }
}

export interface ExportFile {
  /** the exact text of orangu-export.json, with its trailing newline */
  text: string
  index: ExportIndexEntry[]
}

/** A section value, and the sentence that says what a cut or a failed read left out of it. */
interface Part<T> {
  value: T
  cut?: string
  omitted?: Record<string, number>
}

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

/** The text of the file: `{`, then 1 section on each line as compact JSON, then `}` and a newline. */
function fileText(values: Readonly<Record<Section, unknown>>): string {
  return `{\n${EXPORT_SECTIONS.map((section) => `${JSON.stringify(section)}:${JSON.stringify(values[section])}`).join(',\n')}\n}\n`
}

/** The bytes of the file around its 6 values: each value `null` is 4 B. */
const FRAME_BYTES = Buffer.byteLength(fileText({ summary: null, index: null, profile: null, evidence: null, harness: null, lessons: null })) - 4 * EXPORT_SECTIONS.length

function summaryOf(input: ExportInput): ExportSummary {
  return {
    v: EXPORT_VERSION,
    version: input.version,
    scope: 'global',
    roots: input.roots,
    found: input.found,
    sessions: input.sessions,
    unreadable: input.unreadable,
    asOf: input.asOf !== null && Number.isFinite(input.asOf) ? new Date(input.asOf).toISOString() : null,
    redacted: true,
    text: false,
  }
}

/** The profile with each secret scrubbed from the words of the user. The answers go first when it does not fit. */
function profilePart(profile: ProfileV1 | null, home: string | undefined): Part<ProfileV1 | null> {
  if (!profile) return { value: null }
  const clean = redactValue(profile, { scrub: true, ...(home !== undefined ? { home } : {}) })
  if (bytesOf(clean) <= PROFILE_MAX_BYTES) return { value: clean }
  const { answers: _answers, ...keyed } = clean
  if (bytesOf(keyed) <= PROFILE_MAX_BYTES) return { value: keyed, cut: 'The answers did not fit, so the profile has only its keyed values.' }
  return { value: null, cut: 'The profile did not fit.' }
}

/** The newest lessons that fit in 16,384 B, and the count of the rest in `omitted`, as `--lessons` keeps them. */
function lessonsPart(read: LessonRead | null, home: string | undefined): Part<LessonRead | null> {
  if (!read) return { value: null, cut: 'orangu could not read the suggestion store, so the export has no lessons.' }
  const clean = redactValue(read, { scrub: true, ...(home !== undefined ? { home } : {}) })
  const build = (lessons: LessonRead['lessons'], omitted: number): LessonRead => ({ ...clean, maxBytes: LESSONS_MAX_BYTES, omitted: clean.omitted + omitted, lessons })
  const value = fitFirst(clean.lessons, build, bytesOf, LESSONS_MAX_BYTES)
  return { value, ...(value.omitted > 0 ? { cut: `${plural(value.omitted, 'older lesson')} did not fit.` } : {}) }
}

/** The bundle with only its first findings, and only the catalog matches of those findings. */
function evidenceWith(bundle: EvidenceBundle, findings: EvidenceBundle['findings']): EvidenceBundle {
  if (findings.length === bundle.findings.length) return bundle
  const kept = new Set(findings.map((finding) => finding.suggestionId))
  return { ...bundle, selectedFindings: findings.length, truncated: true, catalogMatches: bundle.catalogMatches.filter((match) => kept.has(match.suggestionId)), findings }
}

/** The top findings that fit in `budget` bytes. */
function evidencePart(bundle: EvidenceBundle, budget: number): Part<EvidenceBundle> {
  const value = fitFirst(bundle.findings, (findings) => evidenceWith(bundle, findings), bytesOf, budget)
  const left = value.totalFindings - value.selectedFindings
  return { value, ...(left > 0 ? { cut: `${plural(left, 'finding')} did not fit, with ${left === 1 ? 'its' : 'their'} catalog matches.` } : {}) }
}

/** A prompt reference with no preview, whatever the report holds. */
function promptRef(ref: HarnessPromptRef): PromptRef {
  return { sessionId: ref.sessionId, turnIndex: ref.turnIndex, ...(ref.at !== undefined ? { at: ref.at } : {}) }
}

/** A subcommand as a command target can name one (`git push`, `npm run`): lowercase letters and dashes, never a value. */
const SUBCOMMAND = /^[a-z][a-z-]*$/

/**
 * The target of a broken rule, with no value from its code span. A command target is up to 6 words of the rule line
 * (`deploy --token <t>`), so the export keeps only the program word and a subcommand. A flag, a tool and a server name
 * have a fixed form, and they stay.
 */
function exportTarget(target: HarnessRuleRow['target']): HarnessRuleRow['target'] {
  if (target.kind !== 'command') return target
  const [program = '', next] = target.name.split(' ')
  return { kind: 'command', name: next !== undefined && SUBCOMMAND.test(next) ? `${program} ${next}` : program }
}

/** A hook row with no name when its name holds an assignment (`NAME=value`): the value can be a secret. */
function exportHook(row: HarnessCrosswalk['hooks'][number]): HarnessCrosswalk['hooks'][number] {
  if (!row.commandBasename?.includes('=')) return row
  const { commandBasename: _name, ...rest } = row
  return rest
}

/**
 * The declared versus used rows and the rules that did not hold, with no text that a person or a model wrote: no rule
 * line, no command example, no value of a rule target, no hook name with an assignment, no shared note word, no
 * complaint and no preview. The clock fields of the report (the generator time and the retention ages) and the
 * inventory paths stay out.
 */
function harnessOf(report: HarnessReport): ExportHarness {
  const e = report.enforcement
  return {
    schemaVersion: report.schemaVersion,
    crosswalk: { ...report.crosswalk, hooks: report.crosswalk.hooks.map(exportHook) },
    enforcement: {
      counts: e.counts,
      broken: e.broken.map(({ text: _text, examples: _examples, ...row }) => ({ ...row, target: exportTarget(row.target) })),
      notes: e.notes.map(({ sharedWords: _words, trigger, examples, ...row }) => ({ ...row, ...(trigger ? { trigger: promptRef(trigger) } : {}), examples: examples.map(promptRef) })),
      memory: e.memory,
    },
  }
}

/** The key of each row array that a cut can make shorter, as the harness JSON names it, in the order of `rowCounts`. */
const ROW_KEYS = ['skills', 'mcpServers', 'agents', 'hooks', 'claudeMd', 'injectedListings', 'broken', 'notes', 'memory'] as const

function rowCounts(h: ExportHarness): number[] {
  const x = h.crosswalk
  const e = h.enforcement
  return [x.skills.length, x.mcpServers.length, x.agents.length, x.hooks.length, x.claudeMd.length, x.injectedListings.length, e.broken.length, e.notes.length, e.memory.length]
}

/** The harness with the first `keep[a]` rows of each array `a`, in the order of `rowCounts`. */
function harnessWith(h: ExportHarness, keep: readonly number[]): ExportHarness {
  const n = (a: number): number => keep[a] ?? 0
  const x = h.crosswalk
  const e = h.enforcement
  return {
    schemaVersion: h.schemaVersion,
    crosswalk: {
      ...x,
      skills: x.skills.slice(0, n(0)),
      mcpServers: x.mcpServers.slice(0, n(1)),
      agents: x.agents.slice(0, n(2)),
      hooks: x.hooks.slice(0, n(3)),
      claudeMd: x.claudeMd.slice(0, n(4)),
      injectedListings: x.injectedListings.slice(0, n(5)),
    },
    enforcement: { counts: e.counts, broken: e.broken.slice(0, n(6)), notes: e.notes.slice(0, n(7)), memory: e.memory.slice(0, n(8)) },
  }
}

/**
 * The heaviest rows that fit in `budget` bytes. Each array comes heaviest first from the harness, so a cut keeps the
 * first rows of each array, by rank: the first row of each array, then the second row of each array, and on.
 */
function harnessPart(full: ExportHarness, budget: number): Part<ExportHarness> {
  const lengths = rowCounts(full)
  const order: number[] = []
  for (let rank = 0; rank < Math.max(0, ...lengths); rank++) lengths.forEach((n, a) => rank < n && order.push(a))
  const keep = (kept: readonly number[]): number[] => lengths.map((_, a) => kept.filter((x) => x === a).length)
  const value = fitFirst(order, (kept) => harnessWith(full, keep(kept)), bytesOf, budget)
  // the count of each array goes in `omitted` as data: 1 sentence that names 9 arrays is too long to read
  const omitted = Object.fromEntries(rowCounts(value).flatMap((n, a) => (n < lengths[a]! ? [[ROW_KEYS[a]!, lengths[a]! - n]] : [])))
  const total = Object.values(omitted).reduce((sum, n) => sum + n, 0)
  return { value, ...(total > 0 ? { cut: `${plural(total, 'row')} did not fit. Each array keeps its heaviest rows.`, omitted } : {}) }
}

/** The exact text of orangu-export.json v1, and its index. It throws when a limit does not hold. */
export function buildExport(input: ExportInput): ExportFile {
  const summary = summaryOf(input)
  const profile = profilePart(input.profile, input.home)
  const lessons = lessonsPart(input.lessons, input.home)
  const harnessFull = harnessOf(input.harness)
  // what is left for the evidence and the harness: the cap, less the frame, the summary, the room of the index, the profile and the lessons
  const rest = EXPORT_MAX_BYTES - FRAME_BYTES - bytesOf(summary) - INDEX_MAX_BYTES - bytesOf(profile.value) - bytesOf(lessons.value)
  const evidence = evidencePart(input.evidence, Math.max(Math.floor(rest / 2), rest - bytesOf(harnessFull)))
  const harness = harnessPart(harnessFull, rest - bytesOf(evidence.value))
  const entry = (section: ExportIndexEntry['section'], part: Part<unknown>): ExportIndexEntry => ({
    section,
    bytes: bytesOf(part.value),
    ...(part.cut !== undefined ? { cut: part.cut } : {}),
    ...(part.omitted !== undefined ? { omitted: part.omitted } : {}),
  })
  const index = [entry('summary', { value: summary }), entry('profile', profile), entry('evidence', evidence), entry('harness', harness), entry('lessons', lessons)]
  const text = fileText({ summary, index, profile: profile.value, evidence: evidence.value, harness: harness.value, lessons: lessons.value })
  // each part keeps its own limit, so a breach here is a defect: the export stops and writes nothing
  if (bytesOf(summary) > SUMMARY_MAX_BYTES || bytesOf(index) > INDEX_MAX_BYTES || Buffer.byteLength(text) > EXPORT_MAX_BYTES) {
    throw new Error(`orangu could not fit the export in ${EXPORT_MAX_BYTES.toLocaleString('en-US')} B.`)
  }
  return { text, index }
}
