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

/** Why the pane types no shell command (`!`), help key (`?`) or exit word: the target opens a mode or ends. */
export const NOT_A_PROMPT = 'The pane does not type a shell command, the help or an exit. Press j and type it in its tab.'
