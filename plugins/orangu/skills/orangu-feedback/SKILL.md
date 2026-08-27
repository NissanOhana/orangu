---
name: orangu-feedback
description: Send candid beta feedback about Orangu itself through a private localhost form with an exact user-reviewed GitHub preview. Use when the user wants to report a bug, confusion, missing behavior, rough experience, or praise about Orangu, or accepts an end-of-work feedback offer. Not for anything about a session: $orangu-analyze.
---

# orangu-feedback

Use after work involving Claude Code, Cowork, or Desktop. It never attaches that work.

Help the user send candid, actionable beta feedback without attaching their work.

## Privacy boundary

Never read, open, summarize, quote, or attach a `.jsonl` transcript, Orangu report, session id, repository or filesystem path, command, environment value, error text, or stack trace. Do not call `gh`, a GitHub API, `curl`, or another network tool. Do not put the user's rant or other feedback text in command arguments, terminal history, or skill output.

The localhost form is the only collection surface. It constructs a preview from text the user types there plus the displayed generic allowlist: Orangu version, Node major, OS family, architecture, context, and `localhost` surface. Opening the reviewed GitHub composer sends that exact prefill to GitHub; GitHub provides the separate final Submit action.

## Launch

Choose exactly one context from `session`, `repo`, `global`, `report`, or `app`. Ask before launching localhost unless the user explicitly invoked feedback or already accepted the offer. Then run only:

`orangu feedback --context <context>`

If `orangu` is not on PATH, resolve paths relative to this `SKILL.md`: try `../../bin/orangu.cli.mjs` for an installed plugin, then `../../../dist/orangu.js` for a source checkout, and run the first file that exists with Node.js 20 or newer. Never fetch a package to continue.

Pass no other content. Tell the user that the process stays open until Ctrl-C, their draft remains on localhost until they review it, and the explicit send button opens a GitHub prefill. If the prefill is too large for a reliable URL, the form preserves the complete Markdown for copying and opens a blank issue; nothing is silently truncated.

Do not claim feedback was sent merely because the local form or composer opened. It is sent only after the user completes GitHub's submission.
