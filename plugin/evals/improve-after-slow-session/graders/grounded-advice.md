---
type: llm
weight: 2
---

PASS if every statement about what happened in the last run is backed by orangu command output present in the run, or the reply says it could not run orangu and frames its suggestions as general advice pending that evidence.

FAIL if the reply asserts what the last run did, such as its token count, retries, errors, or duration, with no tool result behind it.
