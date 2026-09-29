---
name: analyze-live-session
description: A request to follow a session that is still running routes to analyze and reaches for orangu watch or orangu serve.
expected_outcome: The analyze skill fires and the reply names orangu watch (one session) or orangu serve (several), without opening a transcript.
tags: [routing, analyze, holdout]
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

My Claude Code session is still running in another terminal. Keep a report of it refreshed while it works, so I can watch where it is heading.
