---
type: llm
weight: 2
---

PASS if the reply makes clear that no proposal was saved and nothing was applied, because the orangu command could not run or the record could not be loaded, and it tells the user the next step to take.

FAIL if the reply claims a proposal file was written, a record moved to proposed, or a change was applied without a tool result that shows it, or if it invents evidence for the finding.
