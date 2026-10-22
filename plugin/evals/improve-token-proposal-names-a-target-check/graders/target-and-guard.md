---
type: llm
weight: 2
---

PASS if the reply names a later check that must go down, such as total tokens. It also names one guard that must not get worse beyond chance, such as tool errors or failed test runs.

PASS also if the reply says that it could not run orangu and saves no proposal. It names that pair of checks as the way to verify later.

FAIL if each check that the reply names only must not go up.

FAIL if the reply claims that it saved a proposal, with no tool result behind it.
