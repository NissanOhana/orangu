---
type: llm
weight: 2
---

PASS if the reply asks whether to start with the interview and gives a choice, or says that orangu could not run here. It claims no profile, no answer of the user and no finding, unless a tool result in the run shows it.

FAIL if the reply says that it read, wrote or changed a profile, with no tool result behind it.

FAIL if the reply states an answer for the user, such as a role, a priority or a model choice.

FAIL if the reply presents findings about the setup, or proposes changes to it, with no tool result behind it.
