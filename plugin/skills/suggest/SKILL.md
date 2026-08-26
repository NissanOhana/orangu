---
name: suggest
description: Compatibility command for older Orangu report links from supported Claude Code, Cowork, and Desktop sessions. Use when someone invokes /orangu:suggest. Forward the exact arguments to the current /orangu:improve workflow, which analyzes bounded evidence and writes a structured reviewable proposal without applying project changes.
allowed-tools: Skill
---

# /orangu:suggest compatibility alias

This command was renamed to `/orangu:improve` because the workflow now covers direct JSONL/Orangu evidence, catalog matches, optional research, structured proposals, and later verification.

Immediately invoke the `/orangu:improve` skill with the user's exact arguments, then stop. Do not interpret an encoded finding yourself, and do not create a legacy Markdown-only proposal.

If skill delegation is unavailable, tell the user to run the equivalent command explicitly:

`/orangu:improve <the exact original arguments>`

Never read a `.jsonl` transcript directly and never apply project changes from this compatibility alias.
