---
name: orangu-feedback
description: Send candid beta feedback about Orangu itself through a private localhost form with an exact user-reviewed GitHub preview. Use when the user wants to report a bug, confusion, missing behavior, rough experience, or praise about Orangu. Also use when the user accepts an end-of-work feedback offer. Not for anything about a session: the `orangu analyze` command.
---

# orangu-feedback

Use after work in Claude Code, Cowork, or Desktop. It never attaches that work.

Help the user send candid, actionable beta feedback without attaching their work. Write all user-facing text in STE, as [the STE rules](../shared/ste.md) direct.

## Privacy boundary

Never read, open, summarize, quote, or attach a `.jsonl` transcript, an Orangu report or a session id. The same rule applies to a repository or filesystem path, a command, an environment value, error text and a stack trace. Do not call `gh`, a GitHub API, `curl`, or another network tool. Do not put the user's rant or other feedback text in command arguments, terminal history, or skill output.

The localhost form is the only collection surface. It builds a preview from two sources: the text that the user types there, and the displayed generic allowlist. The allowlist is the Orangu version, the Node major version, the OS family, the architecture, the context and the `localhost` surface. Opening the reviewed GitHub composer sends that exact prefill to GitHub. GitHub provides the separate, final Submit action.

## Launch

Choose exactly one context: `session`, `repo`, `global`, `report` or `app`. Unless the user explicitly invoked feedback or already accepted the offer, ask before you open the localhost form. Then run only:

`orangu feedback --context <context>`

If `orangu` is not on PATH, resolve paths relative to this `SKILL.md`: try `../../bin/orangu.cli.mjs` for an installed plugin, then `../../../dist/orangu.js` for a source checkout, and run the first file that exists with Node.js 20 or newer. Never fetch a package to continue.

Pass no other content. Tell the user these three facts:

- The process stays open until Ctrl-C.
- The draft stays on localhost until the user reviews it.
- The explicit send button opens a GitHub prefill.

If the prefill is too large for a reliable URL, the form keeps the complete Markdown for copying and opens a blank issue. Nothing is silently truncated.

Do not claim that the feedback was sent because the local form or the composer opened. The feedback is sent only after the user completes the GitHub submission.
