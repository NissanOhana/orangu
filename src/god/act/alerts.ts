/**
 * What 1 alert sends outside its tone (src/god/act/alert-policy.ts decides the alerts, src/god/alert-loop.ts sends
 * them): the notice of the native notification, and the ring on the cmux tab of the session.
 *
 * - The notice has the pane title and a body from src/god/copy.ts with the name of the row of the session
 *   (src/god/view/names.ts: the cmux tab title, else the transcript title, else the session name), put on 1 line
 *   and then cleaned again here (no control character, the secrets masked, the home folder as `~`). The line comes
 *   first, so the redaction sees a secret that line breaks split as 1 text. The body starts with words of the pane,
 *   so it never starts with `-`.
 * - The ring is exactly `cmux notify --title <t> --body <b> --workspace <ws> --surface <s>`. It needs a cmux read
 *   that worked (a failed read can leave an old tab map) and the refs of the mapped tab in the forms that the key
 *   guard takes (src/god/act/deliver-plan.ts): `workspace:N` and `surface:N`, or UUIDs. The title and the body are
 *   flag values with no positional value after them, so no argv takes `--`. A value that is empty, that starts with
 *   `-`, or that holds a control character, a line break or a character that draws nothing is refused, so a value
 *   can never read as a flag or hide a part of itself.
 * - ringHost is the host of the ring: it runs only an argv that isRingArgv takes, with no environment variable, so
 *   no other cmux subcommand and no other command can go out through it. The host port checks only argv[0].
 */
import { PANE_TITLE, alertBody } from '../copy.js'
import type { Host } from '../host.js'
import type { AlertKind, BoardSnapshot, GodSession } from '../types.js'
import { rowName } from '../view/names.js'
import { flat } from '../view/wrap.js'
import { HIDDEN_CHAR, SURFACE_REF, WORKSPACE_REF } from './deliver-plan.js'
import { tabRefs } from './jump.js'

/** The title and the body of the notification and of the ring of 1 alert. */
export type AlertNotice = { title: string; body: string }

/** The reason when the host of the ring refuses a command. */
export const REFUSED_RING_ARGV = 'The alert ring runs only cmux notify on 1 tab, with no environment variable.'

/** C0, DEL, C1 and the line and paragraph separators: a value with one of them does not go to cmux. */
const CONTROL_OR_BREAK = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/** True when a flag value can go to cmux: not empty, not a flag itself, on 1 line, with no control character and no character that draws nothing. */
const isRingValue = (value: string | undefined): value is string =>
  value !== undefined && value !== '' && !value.startsWith('-') && !CONTROL_OR_BREAK.test(value) && !HIDDEN_CHAR.test(value)

/** The notice of an alert of the session: the pane title, and the body with the name of its row put on 1 line and then cleaned. */
export function alertNotice(session: Pick<GodSession, 'name' | 'tab' | 'transcript'>, kind: Exclude<AlertKind, 'done'>, clean: (text: string) => string): AlertNotice {
  return { title: PANE_TITLE, body: alertBody(clean(flat(rowName(session))), kind) }
}

/** True when the argv is exactly the ring of 1 tab: cmux notify, the title, the body, then the 2 refs. */
export function isRingArgv(argv: readonly string[]): boolean {
  const [command, verb, titleFlag, title, bodyFlag, body, workspaceFlag, workspaceRef, surfaceFlag, surfaceRef] = argv
  return (
    argv.length === 10 &&
    command === 'cmux' &&
    verb === 'notify' &&
    titleFlag === '--title' &&
    isRingValue(title) &&
    bodyFlag === '--body' &&
    isRingValue(body) &&
    workspaceFlag === '--workspace' &&
    WORKSPACE_REF.test(workspaceRef ?? '') &&
    surfaceFlag === '--surface' &&
    SURFACE_REF.test(surfaceRef ?? '')
  )
}

/** The argv of the ring on the tab of the session, or undefined when it has no usable tab or a value is refused. */
export function ringArgv(snapshot: BoardSnapshot, session: GodSession, notice: AlertNotice): readonly string[] | undefined {
  const refs = snapshot.sources.cmux.status === 'ok' ? tabRefs(session.tab) : undefined
  if (refs === undefined) return undefined
  const argv = ['cmux', 'notify', '--title', notice.title, '--body', notice.body, '--workspace', refs.workspaceRef, '--surface', refs.surfaceRef]
  return isRingArgv(argv) ? argv : undefined
}

/** The host port that runs only the ring, with no environment variable. Any other command rejects before it runs. */
export function ringHost(host: Host): Host {
  return {
    ...host,
    run: (argv, options) => (isRingArgv(argv) && Object.keys(options?.env ?? {}).length === 0 ? host.run(argv, options) : Promise.reject(new Error(REFUSED_RING_ARGV))),
  }
}
