/**
 * The copy of the god mod. Every line that the pane, the command and the tools show lives in a .ts module under
 * src/god, where the STE gate (scripts/ste-surfaces.ts, row src/god) and the em dash ratchet read it. The .tsx
 * engine shell imports it and holds no copy of its own (src/god/purity.test.ts).
 */

/** The line that the command menu shows for /god. */
export const GOD_COMMAND_DESCRIPTION = 'Show the live Claude Code sessions of this machine in one pane.'

/** The hint after /god in the command menu: the forms that it takes. */
export const GOD_ARGUMENT_HINT = '[all | repos <name>... | stats]'

/** The title of the pane: its tab while more than 1 pane is open. */
export const PANE_TITLE = 'orangu god'

/** The header item that says who holds the keys, and the key that gives them to the other: `keys: pane · Esc: prompt`. */
export const KEYS_LABEL = 'keys:'
export const KEYS_HOLDER = {
  pane: { holder: 'pane', handover: 'Esc: prompt' },
  prompt: { holder: 'prompt', handover: 'ctrl+x tab: pane' },
} as const

/** The first line of the help view (h): what it is, and the 2 keys that close it. */
export const HELP_TITLE = 'What the pane shows. Press h or Esc to close this help.'

/** What each heading of the board means, in the order of the board, by the level of the heading. */
export const HELP_LEVELS = {
  'needs-you': 'The session waits for your answer to a question or a permission prompt.',
  'your-turn': 'The session finished its turn and waits for your next prompt.',
  stuck: 'The session is busy, but it wrote nothing for a long time, or it got an API error.',
  working: 'The session works on its task now.',
  idle: 'The session waits for a prompt, and you saw its last turn.',
  stale: 'The session is idle for a long time. Press Enter on the heading to show its group.',
} as const

/** What the same file chip of a board row means. */
export const HELP_SAME_FILE = 'This session and another session wrote the same file in the last 2 h.'

/** What each key does: the keys of the key row, the 2 keys of the confirm bar, and the 2 keys that move the keys. */
export const HELP_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['↑↓', 'Select a session.'],
  ['Enter', 'Open the selected session.'],
  ['b', 'Go back to the board from the detail of a narrow pane.'],
  ['j', 'Jump to the cmux tab of the session.'],
  ['n', 'Select the next session that needs you.'],
  ['1-9', 'Pick an option of the open question. Then press y to send it.'],
  ['y  c', 'Send, or cancel, what the confirm bar shows.'],
  ['r', 'Write a prompt. The session reads it as your prompt.'],
  ['m', 'Write a peer note. The session reads it as a note from a peer, not as your prompt.'],
  ['t', 'Show the next tab of the detail.'],
  ['s', 'Turn all tones off, or on again.'],
  ['u', 'Mute the selected session, or unmute it.'],
  ['f', 'Show every session, or only the sessions of the selected repos.'],
  ['g', 'Group the rows by level or by repo.'],
  ['h', 'Show this help, or close it.'],
  ['Esc', 'Give the keys to the prompt.'],
  ['ctrl+x tab', 'Give the keys to the pane.'],
]

/** The line of the detail while 2 or more sessions of its folder work now: the count, the names, and the count of the names left out. */
export function sharesFolderText(count: number, names: readonly string[], left: number): string {
  return `Shares its folder with ${count} working ${count === 1 ? 'session' : 'sessions'}: ${names.join(', ')}${left > 0 ? ` and ${left} more` : ''}`
}

/** What /god answers when it opened the pane. */
export const GOD_OPENED = 'The god pane is open.'

/** What /god answers when the engine keeps the pane off the screen for now. */
export const GOD_NOT_PLACED = 'The god pane waits for more room. Make the terminal wider.'

/** What /god all answers. */
export const GOD_SHOWS_ALL = 'The god pane shows every live session.'

/** What /god repos <name>... answers: the repo names that the repos mode keeps now. */
export const godShowsRepos = (names: readonly string[]): string => `The god pane shows the sessions of these repos: ${names.join(', ')}.`

/** What /god repos answers with no name: the repo set that the repos mode keeps. */
export const reposSetText = (names: readonly string[]): string =>
  names.length === 0 ? 'No repo is selected. Run /god repos <name> to select one.' : `The repos mode shows these repos: ${names.join(', ')}.`

/** What the pane shows in the repos mode when no repo is selected. */
export const NO_REPO_SET = 'No repo is selected. Type /god repos and a repo name.'

/** What /god answers to a form that it does not know. */
export const GOD_USAGE =
  'Run /god to open the pane. Run /god all to show every session. Run /god repos <name> to show the sessions of a repo. Run /god stats to show the time of the last refresh.'

/** What /god answers when it failed. */
export const GOD_FAILED = 'The god command failed. Run /god again.'

/** The status line while the pane is not on the screen and 1 or more sessions need you. */
export const needYouStatus = (count: number): string => `god: ${count} ${count === 1 ? 'needs' : 'need'} you`

/** What /god stats answers before /god starts the board. */
export const GOD_STATS_OFF = 'The god pane does not run now. Run /god to start it.'

/** What /god stats answers before the first refresh ends. */
export const GOD_STATS_READING = 'The god pane reads the sessions now. Run /god stats again in 2 s.'

/** What /god stats answers: the 2 times of the last refresh and its session count, then the most engine work of the kept refreshes. */
export function godStats(last: { computeMs: number; waitMs: number; sessions: number }, mostComputeMs: number, refreshes: number): string {
  const sessions = `${last.sessions} ${last.sessions === 1 ? 'session' : 'sessions'}`
  const kept = `${refreshes} ${refreshes === 1 ? 'refresh' : 'refreshes'}`
  return `The last refresh took ${last.computeMs} ms of engine work and ${last.waitMs} ms of wait for host commands, for ${sessions}. The most engine work in the last ${kept} was ${mostComputeMs} ms.`
}

/**
 * What /god stats adds once the board runs: the tones that played and the notifications that the notification channel
 * of Claude Code wrote. The engine runs the Notification hooks first, so a notice that only a hook shows does not count.
 */
export function alertCountsText(counts: { tones: number; notifications: number }): string {
  const tones = `${counts.tones} ${counts.tones === 1 ? 'tone' : 'tones'}`
  const notifications = `${counts.notifications} ${counts.notifications === 1 ? 'notification' : 'notifications'}`
  return `The pane played ${tones} since it started, and the notification channel of Claude Code wrote ${notifications}. A Notification hook can show more.`
}

/**
 * The body of the notification and of the ring of an alert: the session name and why the session wants a look. It
 * starts with words of the pane, so the name never starts a value that cmux reads.
 */
export function alertBody(name: string, kind: 'needs-you' | 'stuck'): string {
  return kind === 'needs-you' ? `The session ${name} needs you.` : `The session ${name} is stuck.`
}

/** What the Recap model reads first: the task and the limits of the Recap. The quote rule of the tools follows it. */
export const RECAP_SYSTEM =
  'You write a recap of 1 Claude Code session for the person who runs it. Write 3 short sentences or fewer. Say what the person asked, what the session did last, and what it waits for now. Use only the facts that follow, and write no secret.'

/** The label in front of each fact of the Recap prompt. */
export const RECAP_LABEL = {
  session: 'Session',
  title: 'Title',
  level: 'Level',
  waits: 'Waits for',
  question: 'Open question',
  tool: 'Last tool',
  prompt: 'Prompt',
  reply: 'Reply',
} as const

/** What the model reads about the board tool. */
export const BOARD_TOOL_DESCRIPTION =
  'This tool shows 1 line for each live Claude Code session on this machine, in board order: the sessions that need the person come first. Each line gives the level and its time, the name, the repo, the context percent, the summary and the title. The tool only reads, and it changes nothing.'

/** What the model reads about the session tool. */
export const SESSION_TOOL_DESCRIPTION =
  'This tool shows the detail of the live session with the name that you give. The detail has the open question, the last prompt, the last reply, the activity, the agents and the overlap flags. Get the names from the board tool. The tool only reads, and it changes nothing.'

/** What the model reads about the input of the session tool. */
export const SESSION_TOOL_NAME_HINT = 'The name of the session, as the board tool shows it.'

/** What a tool answers when the board does not run in this load of the mod. */
export const TOOL_NOT_RUNNING = 'The god pane does not run in this session now. Ask the person to run /god.'

/** What a tool answers when it failed. */
export const TOOL_FAILED = 'The orangu god tool failed. Call it again.'

/** Why the pane types no prompt into an idle session that runs a background task or a subagent: either can open a dialog. */
export const TASK_RUNNING = 'The session runs a background task or a subagent that can open a dialog, so the pane sent nothing.'

/** Why the pane types no shell command (`!`), help key (`?`), exit word, /exit or /quit: the target opens a mode or ends. */
export const NOT_A_PROMPT = 'The pane does not type a shell command, the help or an exit. Press j and type it in its tab.'

/** Why the pane types no text with a control character or a character that draws nothing, as an emoji can hold. */
export const CONTROL_CHAR = 'The text has a control character or a character that does not show, so the pane sent nothing. An emoji can hold such a character.'

/** The line under the options of a question that the digits answer, with the digits of its options (`1-3`). */
export const answerAction = (digits: string): string => `Press ${digits}, then y to send.`

/**
 * The line under the options of question `at` of `count` of a dialog that the pane answers 1 question at a time. The
 * last question sends: the confirm bar then shows every pick.
 */
export const pickAction = (at: number, count: number, digits: string): string =>
  at < count ? `Question ${at} of ${count}. Press ${digits} to pick, then go on to the next question.` : `Question ${at} of ${count}. Press ${digits} to pick, then y to send.`

/** What the back key of a dialog with 2 or more questions does, as the engine paints its Button: `p: back to question 1`. */
export const pickBackLabel = (at: number): string => `back to question ${at}`

/** The line under the options when cmux is not on the machine, so no digit answers the question. */
export const ANSWER_NO_CMUX = 'cmux is not on this machine, so answer the question in its tab.'

/** Why the pane stopped after 1 or more answers of a dialog with 2 or more questions: the dialog keeps those picks. */
export const ANSWERS_PARTIAL = 'The pane stopped after 1 or more answers, so the dialog stays open with some picks in it. Press j to answer the rest in its tab.'

/** The question of the confirm bar of the answers of a dialog with 2 or more questions: the session, then each pick. */
export const answersAsk = (name: string, picks: readonly string[]): string => `Send to ${name}? ${picks.join(' · ')}`
