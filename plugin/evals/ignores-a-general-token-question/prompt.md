---
name: ignores-a-general-token-question
description: The word tokens alone must not pull in the session skills; a general estimate question is answered directly.
expected_outcome: No orangu skill is invoked and the reply gives a token estimate in the low thousands.
tags: [negative]
max_turns: 6
allowed_tools: [Read, Glob, Grep, Skill]
---

Roughly how many tokens is a 2,000 word English document?
