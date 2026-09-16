---
name: analyze-current-session-report
description: Asking for the report of the session running right now routes to analyze and its report command.
expected_outcome: The analyze skill fires and the reply reaches for orangu report, resolving the current session, without opening a transcript.
tags: [routing, analyze]
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

Open the visual report for the session I'm in right now.
