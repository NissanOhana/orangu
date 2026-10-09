/**
 * The copy of the god mod. Every line that the pane, the command and the tools show lives in a .ts module under
 * src/god, where the STE gate (scripts/ste-surfaces.ts, row src/god) and the em dash ratchet read it. The .tsx
 * engine shell imports it and holds no copy of its own (src/god/purity.test.ts).
 */

/** The line that the command menu shows for /god. */
export const GOD_COMMAND_DESCRIPTION = 'Show the live Claude Code sessions of this machine in one pane.'

/** The hint after /god in the command menu: the forms that it takes. */
export const GOD_ARGUMENT_HINT = '[all | repos <name>...]'

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
export const GOD_USAGE = 'Run /god to open the pane. Run /god all to show every session. Run /god repos <name> to show the sessions of a repo.'

/** What /god answers when it failed. */
export const GOD_FAILED = 'The god command failed. Run /god again.'

/** The status line while the pane is not on the screen and 1 or more sessions need you. */
export const needYouStatus = (count: number): string => `god: ${count} ${count === 1 ? 'needs' : 'need'} you`
