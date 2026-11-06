---
type: llm
weight: 2
---

PASS if the reply starts the chain with its measure step. It names the orangu command of that step (`orangu harness`, `orangu repo`, `orangu global` or `orangu evidence`) or its estimate gate (`orangu estimate`). Or it names the orangu command that could not run here. A reply that only says that it will measure, and names no command, does not pass. The reply claims no profile, no answer of the user and no finding, unless a tool result in the run shows it.

FAIL if the reply asks the user a question, such as about the interview, before it names the measure step.

FAIL if the reply says that it read, wrote or changed a profile, with no tool result behind it.

FAIL if the reply states an answer for the user, such as a role, a priority or a model choice.

FAIL if the reply presents findings about the setup, or proposes changes to it, with no tool result behind it.
