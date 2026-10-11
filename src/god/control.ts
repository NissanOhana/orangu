/**
 * The pure rules of the pane controls, so the engine shell (src/god/register.tsx) holds none:
 * - the forms of /god: `/god` opens the pane, `/god all` shows every session and clears the repo set,
 *   `/god repos <name>...` sets the repo set, `/god repos` with no name prints the set, `/god stats` prints the times
 *   of the last refresh from the last facts (not from the snapshot, which ignores a change of the stats alone) and
 *   opens nothing. Any other form is unknown;
 * - the settings from the userConfig values, and the stored choices from the store, each value checked, else its
 *   default. A seenAt entry needs a finite number under a key of its own;
 * - the answer of /god: what the form did, or that the engine keeps the pane off the screen for now;
 * - the keys: f switches between all and the repos and keeps the set, g switches between level and repo, s turns every
 *   tone off and on again, and u mutes the selected session and unmutes it again (a heading, or a session that left
 *   the board, changes nothing). A press on the heading of a group that starts closed opens it, and a second press
 *   closes it;
 * - the selection: a move of the focus ring onto a session row or onto a heading that opens and closes selects
 *   that row. A move onto a key Button keeps the selection. n selects the next session that needs you after the
 *   selected row, in the order of the groups that the mode keeps, and goes round to the first;
 * - the status line: `god: N need you` while the pane is not on the screen and N sessions of the board need you;
 * - /god stats adds the tones that played and the notifications that the notification channel wrote, once a refresh
 *   ended;
 * - the session that a press opens: a press on a session row (Enter, or a click) opens that session, in both
 *   layouts, so it marks the session seen. A move of the ring only selects a row: the person walks the board with it.
 */
import { GOD_NOT_PLACED, GOD_OPENED, GOD_SHOWS_ALL, GOD_STATS_OFF, GOD_STATS_READING, GOD_USAGE, alertCountsText, godShowsRepos, godStats, needYouStatus, reposSetText } from './copy.js'
import type { AlertCounts, BoardMode, BoardSnapshot, GroupBy, RefreshStats, Settings, StoreState } from './types.js'
import { groupKey } from './view/board.js'

/** What /god does with its arguments. */
export type GodCommand =
  | { kind: 'open' }
  | { kind: 'all' }
  | { kind: 'repos'; names: readonly string[] }
  | { kind: 'show-repos' }
  | { kind: 'stats' }
  | { kind: 'unknown' }

/** The settings when the userConfig values are not set. */
export const DEFAULT_SETTINGS: Settings = { stuckAfterMin: 10, staleAfterH: 24, motion: 'on' }

/** The stored choices of a first start: every session, grouped by level, nothing seen, nothing muted, sound on. */
export const DEFAULT_STORE: StoreState = { mode: 'all', repos: [], groupBy: 'level', seenAt: {}, muted: [], sound: true }

/** The store keys, 1 per field of StoreState. */
export const STORE_KEYS = ['mode', 'repos', 'groupBy', 'seenAt', 'muted', 'sound'] as const
export type StoreKey = (typeof STORE_KEYS)[number]

const MODES: readonly BoardMode[] = ['all', 'repos']
const GROUPS: readonly GroupBy[] = ['level', 'repo']

/** The form of /god from the text after its name. */
export function parseGodArgs(args: string): GodCommand {
  const [verb, ...rest] = args.trim().split(/\s+/).filter((word) => word !== '')
  if (verb === undefined) return { kind: 'open' }
  if (verb === 'all' && rest.length === 0) return { kind: 'all' }
  if (verb === 'stats' && rest.length === 0) return { kind: 'stats' }
  if (verb === 'repos') return rest.length === 0 ? { kind: 'show-repos' } : { kind: 'repos', names: [...new Set(rest)] }
  return { kind: 'unknown' }
}

const positive = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback)

/** The settings from the userConfig values of the plugin. */
export function settingsOf(options: Readonly<Record<string, unknown>>): Settings {
  return {
    stuckAfterMin: positive(options['stuckAfterMin'], DEFAULT_SETTINGS.stuckAfterMin),
    staleAfterH: positive(options['staleAfterH'], DEFAULT_SETTINGS.staleAfterH),
    motion: options['motion'] === 'off' ? 'off' : DEFAULT_SETTINGS.motion,
  }
}

const textList = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined)

function seenAtOf(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries = Object.keys(value).flatMap((key) => {
    const time: unknown = (value as Record<string, unknown>)[key]
    return key !== '__proto__' && typeof time === 'number' && Number.isFinite(time) ? [[key, time] as const] : []
  })
  return Object.fromEntries(entries)
}

/** The stored choices from the store values, each one checked, else its default. */
export function storeOf(values: Readonly<Partial<Record<StoreKey, unknown>>>): StoreState {
  const { mode, repos, groupBy, seenAt, muted, sound } = values
  return {
    mode: MODES.includes(mode as BoardMode) ? (mode as BoardMode) : DEFAULT_STORE.mode,
    repos: textList(repos) ?? DEFAULT_STORE.repos,
    groupBy: GROUPS.includes(groupBy as GroupBy) ? (groupBy as GroupBy) : DEFAULT_STORE.groupBy,
    seenAt: seenAtOf(seenAt) ?? DEFAULT_STORE.seenAt,
    muted: textList(muted) ?? DEFAULT_STORE.muted,
    sound: typeof sound === 'boolean' ? sound : DEFAULT_STORE.sound,
  }
}

/** A choice of the board: the fields of the stored choices that a command or a key changes. */
export type BoardChoice = Partial<Pick<StoreState, 'mode' | 'repos' | 'groupBy' | 'sound' | 'muted'>>

/** The choice that a /god form makes: all shows every session and clears the repo set, repos sets it. */
export function commandChoice(command: GodCommand): BoardChoice | undefined {
  if (command.kind === 'all') return { mode: 'all', repos: [] }
  if (command.kind === 'repos') return { mode: 'repos', repos: command.names }
  return undefined
}

/** What /god answers to a form, from whether the engine placed the pane and the repo set after the form. */
export function commandAnswer(command: Exclude<GodCommand, { kind: 'stats' }>, after: { isPlaced: boolean; repos: readonly string[] }): string {
  if (command.kind === 'unknown') return GOD_USAGE
  if (command.kind === 'show-repos') return reposSetText(after.repos)
  if (command.kind === 'all') return GOD_SHOWS_ALL
  if (command.kind === 'repos') return godShowsRepos(command.names)
  return after.isPlaced ? GOD_OPENED : GOD_NOT_PLACED
}

/** The choice that f makes: the other mode. The repo set stays. */
export const toggledMode = (store: Pick<StoreState, 'mode'>): Pick<StoreState, 'mode'> => ({ mode: store.mode === 'all' ? 'repos' : 'all' })

/** The choice that g makes: the other grouping. */
export const toggledGroup = (store: Pick<StoreState, 'groupBy'>): Pick<StoreState, 'groupBy'> => ({ groupBy: store.groupBy === 'level' ? 'repo' : 'level' })

/** The choice that s makes: every tone off, or on again. */
export const toggledSound = (store: Pick<StoreState, 'sound'>): Pick<StoreState, 'sound'> => ({ sound: !store.sound })

/** The choice that u makes: the selected session muted, or unmuted again. Undefined when no session of the board is selected. */
export function toggledMute(store: Pick<StoreState, 'muted'>, selectedKey: string | undefined, snapshot: BoardSnapshot | undefined): Pick<StoreState, 'muted'> | undefined {
  if (selectedKey === undefined || snapshot?.sessions.some((session) => session.sessionId === selectedKey) !== true) return undefined
  return { muted: store.muted.includes(selectedKey) ? store.muted.filter((id) => id !== selectedKey) : [...store.muted, selectedKey] }
}

/** The keys of the rows that the board shows, in the order of the groups: each closed heading, then its sessions. */
function rowKeys(snapshot: BoardSnapshot): string[] {
  return snapshot.groups.flatMap((group) => [...(group.startsClosed ? [groupKey(group.key)] : []), ...group.sessionIds])
}

/** The open groups after a press on a row: a heading of a group that starts closed opens it or closes it. */
export function openGroupsAfterPress(openGroups: readonly string[], key: string, snapshot: BoardSnapshot | undefined): readonly string[] {
  const group = snapshot?.groups.find((item) => item.startsClosed && groupKey(item.key) === key)
  if (group === undefined) return openGroups
  return openGroups.includes(group.key) ? openGroups.filter((item) => item !== group.key) : [...openGroups, group.key]
}

/** The row that the board selects when the ring moves onto `element`: a row of the board, else undefined. */
export function selectionOf(element: string | undefined, snapshot: BoardSnapshot | undefined): string | undefined {
  return element !== undefined && snapshot !== undefined && rowKeys(snapshot).includes(element) ? element : undefined
}

/** The next session that needs you after the selected row, in the order of the shown groups, going round. */
export function nextNeedsYou(snapshot: BoardSnapshot | undefined, selected: string | undefined): string | undefined {
  if (snapshot === undefined) return undefined
  const keys = rowKeys(snapshot)
  const needing = new Set(snapshot.sessions.filter((session) => session.level === 'needs-you').map((session) => session.sessionId))
  const from = selected === undefined ? -1 : keys.indexOf(selected)
  const after = [...keys.slice(from + 1), ...keys.slice(0, from + 1)]
  return after.find((key) => needing.has(key))
}

/** The status line: the count of the sessions that need you while the pane is not on the screen, else none. */
export function statusText(snapshot: BoardSnapshot | undefined, isPaneOpen: boolean): string | undefined {
  if (isPaneOpen || snapshot === undefined) return undefined
  const count = snapshot.sessions.filter((session) => session.level === 'needs-you').length
  return count > 0 ? needYouStatus(count) : undefined
}

/**
 * What /god stats answers from the stats of the last refreshes, oldest first: the 2 times of the newest one and its
 * session count, then the most engine work of all of them, then the alert counts when the pane has them. Undefined:
 * the board does not run.
 */
export function statsAnswer(recent: readonly RefreshStats[] | undefined, counts?: AlertCounts): string {
  if (recent === undefined) return GOD_STATS_OFF
  const last = recent.at(-1)
  if (last === undefined) return GOD_STATS_READING
  const most = Math.max(...recent.map((stats) => stats.computeMs))
  const times = godStats({ computeMs: Math.round(last.computeMs), waitMs: Math.round(last.waitMs), sessions: last.sessions }, Math.round(most), recent.length)
  return counts === undefined ? times : `${times} ${alertCountsText(counts)}`
}

/** The session that a press on the row `key` opens: the session of a session row, else none. */
export function openedSessionOf(key: string, snapshot: BoardSnapshot | undefined): string | undefined {
  return snapshot?.sessions.some((session) => session.sessionId === key) === true ? key : undefined
}

