---
name: harness-global-declared-vs-used
description: A machine-wide declared-versus-used question routes to the harness review at global scope.
expected_outcome: The harness skill fires, the reply names the global scope, and no finding is stated without tool output.
tags: [routing, harness, honesty]
max_turns: 14
allowed_tools: [Read, Glob, Grep, Skill]
---

Look across all my Claude Code projects on this machine: which of my CLAUDE.md rules, hooks, skills, agents, and MCP servers are declared but never actually used, and what should I drop or fix?
