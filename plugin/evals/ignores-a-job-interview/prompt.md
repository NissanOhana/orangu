---
name: ignores-a-job-interview
description: The word interview alone does not pull in an orangu skill. A request for help with a job interview gets a direct answer.
expected_outcome: No orangu skill fires, and the reply helps the user prepare for an interview at a database company.
tags: [negative, train]
max_turns: 6
allowed_tools: [Read, Glob, Grep, Skill]
---

Can you help me prepare for a job interview at a database company next week?
