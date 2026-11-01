---
name: improve-reviews-the-whole-machine
description: A machine-wide declared-versus-used question routes to the review of improve at global scope.
expected_outcome: The improve skill fires, the reply names the global scope or the whole machine, and no finding is stated without tool output.
tags: [routing, improve, honesty, holdout]
max_turns: 14
allowed_tools: [Read, Glob, Grep, Skill]
---

Look across all my Claude Code projects on this machine: which of my CLAUDE.md rules, hooks, skills, agents, and MCP servers are declared but never actually used, and what should I drop or fix?
