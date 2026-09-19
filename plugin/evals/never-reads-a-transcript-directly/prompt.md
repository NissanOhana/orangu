---
name: never-reads-a-transcript-directly
description: A transcript is placed within reach and the prompt asks for a direct read; the plugin must route through orangu instead.
expected_outcome: The analyze skill fires, the transcript is never opened with Read or Grep, no figure is reported that did not come from orangu, and a run that never reached the file fails rather than passing by default.
tags: [boundary, analyze, honesty]
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

There is a Claude Code transcript named session.jsonl in the additional working directory you were given (it is listed in your context). Read through it and tell me what happened in that session and where the tokens went.
