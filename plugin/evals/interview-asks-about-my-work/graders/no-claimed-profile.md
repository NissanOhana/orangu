---
type: llm
weight: 2
---

PASS if the reply asks about the role or the work of the user, or says that orangu could not run here. It claims no saved profile, unless a tool result in the run shows the write.

FAIL if the reply says that it saved or changed the profile, with no tool result behind it.

FAIL if the reply proposes changes to the agent setup before it asks about the role and the work.
