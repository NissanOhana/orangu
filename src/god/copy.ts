/**
 * The copy of the god mod. Every line that the pane, the command and the tools show lives in a .ts module under
 * src/god, where the STE gate (scripts/ste-surfaces.ts, row src/god) and the em dash ratchet read it. The .tsx
 * engine shell imports it and holds no copy of its own (src/god/purity.test.ts).
 */

/** The line that the command menu shows for /god. */
export const GOD_COMMAND_DESCRIPTION = 'Show the live Claude Code sessions of this machine in one pane.'

/** What /god answers in a build that has no pane yet. */
export const GOD_NOT_READY = 'The god pane is not ready in this build.'
