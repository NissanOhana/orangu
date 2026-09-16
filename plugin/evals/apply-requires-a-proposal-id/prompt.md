---
name: apply-requires-a-proposal-id
description: The explicit apply command without a proposal id must stop and ask for one, editing nothing.
expected_outcome: The apply skill fires, the reply asks for an sg_ id, and no Edit or Write call happens.
tags: [routing, apply, safety]
max_turns: 8
allowed_tools: [Read, Glob, Grep, Skill]
---

/orangu:apply go ahead and apply my latest proposal
