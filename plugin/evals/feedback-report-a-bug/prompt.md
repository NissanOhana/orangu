---
name: feedback-report-a-bug
description: Wanting to report a bug in orangu itself routes to feedback, which hands off to the private localhost form and attaches nothing.
expected_outcome: The feedback skill fires, the reply names the orangu feedback command, and it neither files an issue itself nor asks for session details.
tags: [routing, feedback, privacy]
max_turns: 8
allowed_tools: [Read, Glob, Grep, Skill]
---

The orangu report showed a cache token number that cannot be right. I want to report this bug to the orangu maintainers.
