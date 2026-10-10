/**
 * The executor of the key path: what y does with the intent of the confirm bar, as pure code over the host port. It
 * is the only code that types keys into another session, so every step fails closed:
 *
 * 1. With no cmux on the machine it refuses (no-cmux). With no cmux read that worked, or no mapped tab in the forms
 *    that the key guard takes, it refuses (no-tab). A prompt text that cmux would type as keys is refused, and so is
 *    a session that left the board. None of these runs a host call.
 * 2. It reads the registry file and the transcript tail of the target again, at once, and only then the screen of its
 *    tab. The facts take the time of the host clock just before those reads, so a slow read makes them older, never
 *    younger. No fact of a board tick reaches the plan: the request carries only the row of the target (its PID, cwd
 *    and tab), and the open question comes only from this fresh transcript read. The screen is read again for each
 *    delivery, never taken from the Screen tab or an earlier y.
 * 3. planDelivery (src/god/act/deliver-plan.ts) makes the plan of the intent from that screen and those facts, with
 *    the host clock right after the screen read. A refusal keeps the fresh screen for the Screen tab.
 * 4. It runs the plan steps in order and stops at the first one that fails: an exit code that is not 0, or a reject.
 *    Its host runs only cmux send and send-key in the exact form of the plan, cmux read-screen, and the reads of the
 *    transcript (stat, tail, head). Any other command, another cmux subcommand among them, is refused before the
 *    engine sees it: the host port checks only the command name.
 * 5. After the last step it gives the check of the next refreshes (src/god/act/deliver-check.ts), timed on the clock
 *    of the collector, which the refresh stats use.
 * A peer message has no keys: deliverPeer sends it through the engine with no screen check, and the confirm bar is its
 * only guard. A failure reason holds no session text.
 */
import type { Effects, Host } from '../host.js'
import { readRegistryFile } from '../source/agents.js'
import { reduceRecords } from '../source/records.js'
import { readScreenOf } from '../source/screen.js'
import { readTranscripts } from '../source/transcript.js'
import type { DeliverIntent, DeliverOutcome, DeliverRefusal, ScreenRead, SessionFacts, SourceState, TranscriptFacts } from '../types.js'
import { expectOf, type DeliverCheck } from './deliver-check.js'
import { SURFACE_REF, WORKSPACE_REF, planDelivery, textRefusal, type KeyIntent, type TargetFacts } from './deliver-plan.js'
import { tabRefs } from './jump.js'

/** The commands of the transcript read: the inode, the tail and the head of the file. */
const READ_COMMANDS: readonly string[] = ['stat', 'tail', 'head']

/** The reason when the host of the executor refuses a command. */
export const REFUSED_DELIVER_ARGV = 'The key path runs only cmux send, send-key and read-screen, and the reads of the transcript.'
/** The failure reasons of a delivery. */
export const FACTS_UNREAD = 'The pane could not read the transcript of the session again.'
export const SCREEN_UNREAD = 'cmux did not read the screen of the tab.'
export const STEP_FAILED = 'A cmux command of the plan failed.'

/** True when the 2 refs are in the forms that the key guard takes. */
const isRefs = (workspaceRef: string | undefined, surfaceRef: string | undefined): boolean => WORKSPACE_REF.test(workspaceRef ?? '') && SURFACE_REF.test(surfaceRef ?? '')

/**
 * True when the executor may run the argv: `cmux send` or `cmux send-key` with both refs and `--` right before 1
 * value, `cmux read-screen` of 1 tab, or a read of the transcript.
 */
export function isDeliverArgv(argv: readonly string[]): boolean {
  const [command, verb, workspaceFlag, workspaceRef, surfaceFlag, surfaceRef, ...rest] = argv
  if (command !== 'cmux') return command !== undefined && READ_COMMANDS.includes(command)
  if (workspaceFlag !== '--workspace' || surfaceFlag !== '--surface' || !isRefs(workspaceRef, surfaceRef)) return false
  if (verb === 'read-screen') return rest.length === 2 && rest[0] === '--lines' && /^[1-9][0-9]{0,3}$/.test(rest[1] ?? '')
  return (verb === 'send' || verb === 'send-key') && rest.length === 2 && rest[0] === '--'
}

/** The host of the executor: the host port, with every command that isDeliverArgv refuses rejected before it runs. */
export function deliverHost(host: Host): Host {
  return { ...host, run: (argv, options) => (isDeliverArgv(argv) ? host.run(argv, options) : Promise.reject(new Error(REFUSED_DELIVER_ARGV))) }
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
}

/** The row of the target on the board at y: the PID of its registry file, its cwd and its mapped tab. */
export type DeliverRow = Pick<SessionFacts, 'pid' | 'sessionId' | 'cwd' | 'tab'>

/** 1 delivery: the intent of the bar, the row of its target (absent when it left the board), and the state of cmux. */
export type DeliverRequest = { intent: KeyIntent; session?: DeliverRow; cmux: SourceState['status'] }

/** What 1 y gave: the outcome, and for keys that went out, the check of the next refreshes. */
export type DeliverResult = { outcome: DeliverOutcome; check?: DeliverCheck }

/** The facts of the target read again, with the transcript facts for the check, or why they are not there. */
type FreshFacts = { kind: 'read'; facts: TargetFacts; transcript?: TranscriptFacts } | { kind: 'gone' } | { kind: 'unread' }

/** The registry file and the transcript tail of the target, read again at once, timed just before the reads. */
async function readFresh(host: Host, ports: DeliverPorts, row: DeliverRow): Promise<FreshFacts> {
  const factsAt = await host.now()
  const [registry, reads] = await Promise.all([readRegistryFile(host, ports.home, row.pid, ports.clean), readTranscripts(host, ports.home, [{ sessionId: row.sessionId, cwd: row.cwd }])])
  if (registry === undefined || registry.sessionId !== row.sessionId) return { kind: 'gone' }
  const read = reads[0]
  if (read === undefined || (read.status !== 'read' && read.status !== 'missing')) return { kind: 'unread' }
  const transcript = read.status === 'read' ? reduceRecords(read.records, { home: ports.home, headRecords: read.headRecords, parseErrors: read.parseErrors }) : undefined
  const state = { sessionId: registry.sessionId, status: registry.status, ...(registry.waitingFor === undefined ? {} : { waitingFor: registry.waitingFor }) }
  return { kind: 'read', facts: { ...state, ...(transcript === undefined ? {} : { transcript }), factsAt }, ...(transcript === undefined ? {} : { transcript }) }
}

/** Delivers 1 confirmed intent that goes out as keys. It never rejects: a host call that fails gives an outcome. */
export async function deliver(ports: DeliverPorts, request: DeliverRequest): Promise<DeliverResult> {
  const { intent, session } = request
  const host = deliverHost(ports.host)
  const at = (): Promise<number> => host.now().catch(() => ports.clock())
  const refused = async (refusal: DeliverRefusal, screen?: ScreenRead): Promise<DeliverResult> => ({ outcome: { status: 'refused', intent, at: await at(), refusal, ...(screen === undefined ? {} : { screen }) } })
  const failed = async (reason: string, screen?: ScreenRead): Promise<DeliverResult> => ({ outcome: { status: 'failed', intent, at: await at(), reason, ...(screen === undefined ? {} : { screen }) } })

  if (request.cmux === 'missing') return refused('no-cmux')
  const textRefused = intent.kind === 'prompt' ? textRefusal(intent.text) : undefined
  if (textRefused !== undefined) return refused(textRefused)
  if (session === undefined || session.sessionId !== intent.target.sessionId) return refused('screen-changed')
  const refs = request.cmux === 'ok' ? tabRefs(session.tab) : undefined
  if (refs === undefined) return refused('no-tab')

  const fresh = await readFresh(host, ports, session).catch((): FreshFacts => ({ kind: 'unread' }))
  if (fresh.kind === 'gone') return refused('screen-changed')
  if (fresh.kind === 'unread') return failed(FACTS_UNREAD)
  const screen = await readScreenOf(host, { sessionId: session.sessionId, ...refs }, ports.clean, () => host.now())
  if (screen === undefined) return failed(SCREEN_UNREAD)
  const now = await host.now().catch(() => Number.NaN)
  const plan = planDelivery(intent, screen, fresh.facts, now)
  if (plan.kind === 'refuse') return refused(plan.refusal, screen)

  for (const step of plan.steps) {
    const exitCode = await host.run(step).then(
      (result) => result.exitCode,
      () => undefined,
    )
    if (exitCode !== 0) return failed(STEP_FAILED, screen)
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
