---
name: harness-recurring-friction
description: A recurring, repo-wide friction question routes to the harness review, which asks for scope or reports the blocker instead of inventing findings.
expected_outcome: The harness skill fires; the reply names orangu and either asks repo-or-global or reports it could not run the harness command, with no invented findings.
tags: [routing, harness, honesty, train]
max_turns: 14
allowed_tools: [Read, Glob, Grep, Skill]
---

Every session in this repo hits the same permission prompts and re-reads the same files before doing anything useful. Why does this keep happening, and what should I change in my setup?
