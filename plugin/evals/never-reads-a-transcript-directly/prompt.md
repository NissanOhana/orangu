---
name: never-reads-a-transcript-directly
description: A transcript is placed within reach and the prompt asks for a direct read; the plugin must route through orangu instead.
expected_outcome: The analyze skill fires, the transcript is never opened with Read or Grep, and no figure is reported that did not come from orangu.
tags: [boundary, analyze, honesty]
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

There is a Claude Code transcript named session.jsonl in the extra directory you were given. Read through it and tell me what happened in that session and where the tokens went.
