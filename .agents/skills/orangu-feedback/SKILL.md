---
name: orangu-feedback
description: Collect candid beta feedback about Orangu after work involving Claude Code, Cowork, or Desktop by opening a private localhost form with an exact user-reviewed GitHub preview. Use when the user wants to report a bug, confusion, missing behavior, rough experience, or praise, or accepts an end-of-work feedback offer.
---

# orangu-feedback

Help the user send candid, actionable beta feedback without attaching their work.

Never read, open, summarize, quote, or attach a `.jsonl` transcript, Orangu report, session id, repository or filesystem path, command, environment value, error text, or stack trace. Never call `gh`, a GitHub API, `curl`, or another network tool. Never put the user's rant or other feedback text in command arguments or terminal history.

Choose exactly one context from `session`, `repo`, `global`, `report`, or `app`. Ask before launching localhost unless the user explicitly invoked `$orangu-feedback` or already accepted an end-of-work offer. Then run only:

`orangu feedback --context <context>`

The form constructs its preview only from text the user types there plus the displayed generic allowlist: Orangu version, Node major, OS family, architecture, context, and `localhost` surface. Explain that opening the reviewed GitHub composer sends that exact prefill to GitHub, while GitHub's final Submit action is separate. The process stays open until Ctrl-C. Oversized feedback is preserved as complete Markdown for copying; nothing is silently truncated.

Do not claim feedback was sent merely because the local form or composer opened. It is sent only after the user completes GitHub's submission.
