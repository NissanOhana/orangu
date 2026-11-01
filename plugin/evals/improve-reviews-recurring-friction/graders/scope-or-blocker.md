---
type: llm
weight: 2
---

PASS if the reply reports that it could not run an orangu command, or asks a question that the review needs, such as which scope to review, and it presents no finding about this setup that a tool result does not back.

FAIL if the reply lists concrete declared-versus-used findings, names hooks, skills, agents, or files as idle or missing, or proposes changes to this setup with no tool output, or if it claims to have written or applied anything.
