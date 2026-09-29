---
name: ignores-a-jsonl-coding-question
description: The word JSONL alone must not pull in the session skills; a coding question about the format stays a coding question.
expected_outcome: No orangu skill is invoked and the reply describes streaming the file line by line.
tags: [negative, holdout]
max_turns: 6
allowed_tools: [Read, Glob, Grep, Skill]
---

How do I read a large JSONL file line by line in Node without loading the whole thing into memory?
