/**
 * The executor of the key path: what y does with the intent of the confirm bar, as pure code over the host port. It
 * is the only code that types keys into another session, so every step fails closed:
 *
 * 1. With no cmux on the machine it refuses (no-cmux). With no cmux read that worked, or no mapped tab in the forms
 *    that the key guard takes, it refuses (no-tab). A prompt text that cmux would type as keys is refused, and so is
 *    a session that left the board. None of these runs a host call.
 * 2. It reads ps for the PID of the target, in UTC. Then it reads the registry file and the transcript tail of the
 *    target again, at once, and only then the screen of its tab. The PID must still run with the start time that the
 *    registry file writes and the TTY of the mapped tab, so a PID that macOS gave to a new process gets no key. The
 *    facts take the time of the host clock just before their reads, so a slow read makes them older, never younger.
 *    No fact of a board tick reaches the plan: the request carries only the row of the target (its PID, cwd and tab),
 *    and the open question and the running tasks come only from this fresh transcript read. The screen is read again
 *    for each delivery, never taken from the Screen tab or an earlier y.
 * 3. planDelivery (src/god/act/deliver-plan.ts) makes the plan of the intent from that screen and those facts, with
 *    the host clock right after the screen read. A refusal keeps the fresh screen for the Screen tab.
 * 4. It runs the plan steps in order and stops at the first one that fails: an exit code that is not 0, or a reject.
 *    Before each next step of a prompt it reads the registry file, the size of the transcript and the screen again,
 *    because a dialog can open between 2 steps: a new status time or another transcript size stops it, and
 *    nextStepRefusal checks the rest. The box shows through the text cleaner, so the typed text goes through it too.
 *    A check that refuses or fails stops. Before each step it reads the cancel mark of c. A stop keeps the newest
 *    screen, and no later step goes out.
 * 5. Its host runs only cmux send and send-key in the exact form of the plan (send for a text or a digit, send-key
 *    only for enter or shift+enter), cmux read-screen of 1 tab, ps of 1 PID in UTC, and the 3 reads of 1 transcript
 *    under the projects folder in their exact forms (stat, tail, head). Any other command, another cmux subcommand
 *    among them, is refused before the engine sees it: the host port checks only the command name.
 * 6. After the last step it gives the check of the next refreshes (src/god/act/deliver-check.ts), timed on the clock
 *    of the collector, which the refresh stats use.
 * A peer message has no keys: deliverPeer sends it through the engine with no screen check, and the confirm bar is its
 * only guard. A failure reason (FailureReason) holds no session text.
 */
import type { Effects, Host, RunOptions } from '../host.js'
import { readRegistryFile } from '../source/agents.js'
import { readPs, type PsRow } from '../source/cmux.js'
import { reduceRecords } from '../source/records.js'
import { readScreenOf } from '../source/screen.js'
import { HEAD_BYTES, projectsDir, readTranscripts } from '../source/transcript.js'
import type { DeliverIntent, DeliverOutcome, DeliverRefusal, ScreenRead, SessionFacts, SourceState, TranscriptFacts } from '../types.js'
import { expectOf, type DeliverCheck } from './deliver-check.js'
import { SURFACE_REF, WORKSPACE_REF, nextStepRefusal, planDelivery, textRefusal, typedBy, type KeyIntent, type TargetFacts } from './deliver-plan.js'
import { tabRefs } from './jump.js'

/** The reason when the host of the executor refuses a command. */
export const REFUSED_DELIVER_ARGV = 'The key path runs only cmux send, send-key and read-screen, ps of 1 process, and the reads of the transcript.'

/**
 * Why a delivery failed: a read before the keys (facts-unread, screen-unread), a cmux command of the plan
 * (step-failed), a change that the check between 2 steps of a prompt saw (stopped), or c (cancelled).
 */
export type FailureReason = 'facts-unread' | 'screen-unread' | 'step-failed' | 'stopped' | 'cancelled'

/** The ps argv of the process check: the PID, the TTY and the start time of 1 PID. */
const PS_HEAD: readonly string[] = ['ps', '-o', 'pid=,tty=,lstart=', '-p']

/**
 * The keys that the plan sends with send-key (src/god/act/deliver-plan.ts): the 2 keys of a prompt. The digit of an
 * option goes out with send, because cmux send-key exits 1 on a digit.
 */
const PLAN_KEYS: ReadonlySet<string> = new Set(['enter', 'shift+enter'])

/** True when the 2 refs are in the forms that the key guard takes. */
const isRefs = (workspaceRef: string | undefined, surfaceRef: string | undefined): boolean => WORKSPACE_REF.test(workspaceRef ?? '') && SURFACE_REF.test(surfaceRef ?? '')

/** True when the path is a transcript that the read takes: `<projects folder>/<folder>/<name>.jsonl`, with no `.` or `..` part. */
function isTranscriptPath(path: string | undefined, home: string): boolean {
  const root = `${projectsDir(home)}/`
  if (path === undefined || !path.startsWith(root) || !path.endsWith('.jsonl') || /[\n\r\0]/.test(path)) return false
  const parts = path.slice(root.length).split('/')
  return parts.length === 2 && parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

/** True when the argv is 1 of the 3 transcript reads (src/god/source/transcript.ts): the inode, the tail from a byte, the head of at most 64 KiB. */
function isTranscriptRead(argv: readonly string[], home: string): boolean {
  const [command, flag, value, path, ...more] = argv
  if (more.length > 0 || !isTranscriptPath(path, home)) return false
  if (command === 'stat') return flag === '-f' && value === '%i %N'
  if (command === 'tail') return flag === '-c' && /^\+[1-9][0-9]{0,15}$/.test(value ?? '')
  return command === 'head' && flag === '-c' && /^[1-9][0-9]{0,4}$/.test(value ?? '') && Number(value) <= HEAD_BYTES
}

/**
 * True when the executor may run the argv: `cmux send` of 1 text (a line of a prompt or the digit of an option) or
 * `cmux send-key` of enter or shift+enter, each with both refs and `--` right before the value, `cmux read-screen` of
 * 1 tab, ps of 1 PID, or a transcript read under the projects folder of `home`. A send-key of a digit is refused.
 */
export function isDeliverArgv(argv: readonly string[], home: string): boolean {
  const [command, verb, workspaceFlag, workspaceRef, surfaceFlag, surfaceRef, ...rest] = argv
  if (command === 'ps') return argv.length === PS_HEAD.length + 1 && PS_HEAD.every((arg, index) => argv[index] === arg) && /^[1-9][0-9]{0,9}$/.test(argv.at(-1) ?? '')
  if (command !== 'cmux') return isTranscriptRead(argv, home)
  if (workspaceFlag !== '--workspace' || surfaceFlag !== '--surface' || !isRefs(workspaceRef, surfaceRef)) return false
  if (verb === 'read-screen') return rest.length === 2 && rest[0] === '--lines' && /^[1-9][0-9]{0,3}$/.test(rest[1] ?? '')
  if (rest.length !== 2 || rest[0] !== '--') return false
  return verb === 'send' || (verb === 'send-key' && PLAN_KEYS.has(rest[1] ?? ''))
}

/** True when the run may set its environment so: ps only in UTC, every other command with no variable. */
function isDeliverEnv(argv: readonly string[], options: RunOptions | undefined): boolean {
  const env = options?.env ?? {}
  const keys = Object.keys(env)
  return argv[0] === 'ps' ? keys.length === 1 && env['TZ'] === 'UTC' : keys.length === 0
}

/**
 * The host of the executor: the host port, with every command that isDeliverArgv refuses for `home`, or that sets
 * another environment, rejected before it runs.
 */
export function deliverHost(host: Host, home: string): Host {
  return { ...host, run: (argv, options) => (isDeliverArgv(argv, home) && isDeliverEnv(argv, options) ? host.run(argv, options) : Promise.reject(new Error(REFUSED_DELIVER_ARGV))) }
}

/** What the executor reads and runs through. */
export type DeliverPorts = {
  host: Host
  /** the home folder that the engine gives: the registry and the transcripts live under it */
  home: string
  /** the text cleaner of the home folder (src/god/sanitize.ts) */
  clean: (text: string) => string
  /** the clock of the collector, with no wait: the check after a send compares it with the refresh stats */
  clock: () => number
  /** true once the person pressed c while this delivery runs: no later step goes out */
  isCancelled?: () => boolean
}

/** The row of the target on the board at y: the PID of its registry file, its cwd and its mapped tab. */
export type DeliverRow = Pick<SessionFacts, 'pid' | 'sessionId' | 'cwd' | 'tab'>

/** 1 delivery: the intent of the bar, the row of its target (absent when it left the board), and the state of cmux. */
export type DeliverRequest = { intent: KeyIntent; session?: DeliverRow; cmux: SourceState['status'] }

/** What 1 y gave: the outcome, and for keys that went out, the check of the next refreshes. */
export type DeliverResult = { outcome: DeliverOutcome; check?: DeliverCheck }

/**
 * The facts of the target read again, with the transcript facts for the check and the process start that the
 * registry file writes, or why they are not there.
 */
type FreshFacts = { kind: 'read'; facts: TargetFacts; transcript?: TranscriptFacts; procStart?: string; marks: WriteMarks } | { kind: 'gone' } | { kind: 'unread' }

/**
 * What the plan read saw of the writes of the session: the status time of its registry file, and the path and the
 * size of its transcript. A session that moves writes 1 of them, so the check before each next step compares them.
 */
type WriteMarks = { statusUpdatedAt?: number; transcript?: { path: string; size: number } }

/** The registry file and the transcript tail of the target, read again at once, timed just before the reads. */
async function readFresh(host: Host, ports: DeliverPorts, row: DeliverRow): Promise<FreshFacts> {
  const factsAt = await host.now()
  const [registry, reads] = await Promise.all([readRegistryFile(host, ports.home, row.pid, ports.clean), readTranscripts(host, ports.home, [{ sessionId: row.sessionId, cwd: row.cwd }])])
  if (registry === undefined || registry.sessionId !== row.sessionId) return { kind: 'gone' }
  const read = reads[0]
  if (read === undefined || (read.status !== 'read' && read.status !== 'missing')) return { kind: 'unread' }
  const transcript = read.status === 'read' ? reduceRecords(read.records, { home: ports.home, headRecords: read.headRecords, parseErrors: read.parseErrors }) : undefined
  const state = { sessionId: registry.sessionId, status: registry.status, ...(registry.waitingFor === undefined ? {} : { waitingFor: registry.waitingFor }) }
  const procStart = registry.procStart === undefined ? {} : { procStart: registry.procStart }
  const path = read.cursor.path
  const size = read.status === 'read' ? read.cursor.position?.size : undefined
  const marks: WriteMarks = { ...(registry.statusUpdatedAt === undefined ? {} : { statusUpdatedAt: registry.statusUpdatedAt }), ...(path === undefined || size === undefined ? {} : { transcript: { path, size } }) }
  return { kind: 'read', facts: { ...state, ...(transcript === undefined ? {} : { transcript }), factsAt }, ...(transcript === undefined ? {} : { transcript }), ...procStart, marks }
}

/** True when ps shows the PID with the start time of the registry file and the TTY of the mapped tab. */
function isSameProcess(rows: readonly PsRow[], pid: number, procStart: string | undefined, tty: string | undefined): boolean {
  const row = rows.find((candidate) => candidate.pid === pid)
  return row !== undefined && procStart !== undefined && procStart !== '' && row.lstart === procStart && tty !== undefined && row.tty === tty
}

/** What the check before a next step gave: why the step cannot go out, and the newest screen. */
type StepCheck = { refusal?: DeliverRefusal; screen?: ScreenRead }

/** The step of a prompt that the check reads before: the intent, the text typed so far, and the write marks of the plan read. */
type NextStep = { intent: KeyIntent; typed: string; marks: WriteMarks }

/**
 * The check before the next step of a prompt: the registry file of the target, the size of its transcript, then the
 * screen of its tab, read again, each timed on the host clock. A new status time or a transcript of another size
 * stops it: the session wrote since the plan read. The screen shows the box through the text cleaner, so the typed
 * text goes through it too (a home folder shows as ~). The screen is the newest read, for the Screen tab.
 */
async function nextStep(host: Host, ports: DeliverPorts, row: DeliverRow, refs: { workspaceRef: string; surfaceRef: string }, step: NextStep): Promise<StepCheck> {
  const { intent, typed, marks } = step
  const factsAt = await host.now()
  const registry = await readRegistryFile(host, ports.home, row.pid, ports.clean)
  const size = marks.transcript === undefined ? undefined : (await host.stat(marks.transcript.path).catch(() => undefined))?.size
  const screen = await readScreenOf(host, { sessionId: row.sessionId, ...refs }, ports.clean, () => host.now())
  if (registry === undefined || screen === undefined) return { refusal: 'screen-changed', ...(screen === undefined ? {} : { screen }) }
  if (registry.statusUpdatedAt !== marks.statusUpdatedAt || size !== marks.transcript?.size) return { refusal: 'screen-changed', screen }
  const facts: TargetFacts = { sessionId: registry.sessionId, status: registry.status, ...(registry.waitingFor === undefined ? {} : { waitingFor: registry.waitingFor }), factsAt }
  const refusal = nextStepRefusal(intent, screen, facts, ports.clean(typed), await host.now())
  return { ...(refusal === undefined ? {} : { refusal }), screen }
}

/** Delivers 1 confirmed intent that goes out as keys. It never rejects: a host call that fails gives an outcome. */
export async function deliver(ports: DeliverPorts, request: DeliverRequest): Promise<DeliverResult> {
  const { intent, session } = request
  const host = deliverHost(ports.host, ports.home)
  const at = (): Promise<number> => host.now().catch(() => ports.clock())
  const refused = async (refusal: DeliverRefusal, screen?: ScreenRead): Promise<DeliverResult> => ({ outcome: { status: 'refused', intent, at: await at(), refusal, ...(screen === undefined ? {} : { screen }) } })
  const failed = async (reason: FailureReason, screen?: ScreenRead): Promise<DeliverResult> => ({ outcome: { status: 'failed', intent, at: await at(), reason, ...(screen === undefined ? {} : { screen }) } })
  const isCancelled = (): boolean => ports.isCancelled?.() === true

  if (request.cmux === 'missing') return refused('no-cmux')
  const textRefused = intent.kind === 'prompt' ? textRefusal(intent.text) : undefined
  if (textRefused !== undefined) return refused(textRefused)
  if (session === undefined || session.sessionId !== intent.target.sessionId) return refused('screen-changed')
  const refs = request.cmux === 'ok' ? tabRefs(session.tab) : undefined
  if (refs === undefined) return refused('no-tab')

  const ps = await readPs(host, [session.pid])
  if (!ps.ok) return failed('facts-unread')
  const fresh = await readFresh(host, ports, session).catch((): FreshFacts => ({ kind: 'unread' }))
  if (fresh.kind === 'gone') return refused('screen-changed')
  if (fresh.kind === 'unread') return failed('facts-unread')
  if (!isSameProcess(ps.value.rows, session.pid, fresh.procStart, session.tab?.tty)) return refused('screen-changed')
  const screen = await readScreenOf(host, { sessionId: session.sessionId, ...refs }, ports.clean, () => host.now())
  if (screen === undefined) return failed('screen-unread')
  const now = await host.now().catch(() => Number.NaN)
  const plan = planDelivery(intent, screen, fresh.facts, now)
  if (plan.kind === 'refuse') return refused(plan.refusal, screen)

  let newest = screen
  for (const [index, step] of plan.steps.entries()) {
    if (index > 0) {
      const next: NextStep = { intent, typed: typedBy(plan.steps.slice(0, index)), marks: fresh.marks }
      const between = await nextStep(host, ports, session, refs, next).catch((): StepCheck => ({ refusal: 'screen-changed' }))
      if (between.screen !== undefined) newest = between.screen
      if (between.refusal !== undefined) return failed('stopped', newest)
    }
    if (isCancelled()) return failed('cancelled', newest)
    const exitCode = await host.run(step).then(
      (result) => result.exitCode,
      () => undefined,
    )
    if (exitCode !== 0) return failed('step-failed', newest)
  }
  const sentAt = ports.clock()
  const check: DeliverCheck = { sessionId: session.sessionId, expect: expectOf(intent, fresh.transcript, ports.clean, sentAt), sentAt, misses: 0 }
  return { outcome: { status: 'sent', intent, at: await at() }, check }
}

/** A peer message intent. */
export type PeerIntent = Extract<DeliverIntent, { kind: 'peer' }>

/**
 * Sends 1 peer message through the engine, with no screen check: delivered when the engine queued it at the session,
 * else not delivered. An empty message is refused and sends nothing.
 */
export async function deliverPeer(peer: Effects['peer'], intent: PeerIntent, now: () => Promise<number>): Promise<DeliverOutcome> {
  if (textRefusal(intent.text) === 'empty') return { status: 'refused', intent, at: await now(), refusal: 'empty' }
  const sent = await peer(intent.target.sessionId, intent.text).catch(() => undefined)
  return { status: sent?.isDelivered === true ? 'delivered' : 'not-delivered', intent, at: await now() }
}
