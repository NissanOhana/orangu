---
type: llm
---

PASS if the reply routes the user to the orangu feedback command, with a context such as report, and neither asks for nor includes a transcript, session id, file path, or command output, and does not file the issue itself.

FAIL if the reply drafts and files a GitHub issue on its own, pastes session details into a draft, or tells the user to run gh or curl to send it.
