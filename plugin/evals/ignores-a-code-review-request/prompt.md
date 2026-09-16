---
name: ignores-a-code-review-request
description: An ordinary code review request fires no orangu skill; the reply simply finds the bug.
expected_outcome: No orangu skill is invoked and the reply points at the wrong operator.
tags: [negative]
max_turns: 6
allowed_tools: [Read, Glob, Grep, Skill]
---

Review this function for bugs:

function add(a, b) {
  return a - b
}
