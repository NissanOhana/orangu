---
name: improve-checks-what-was-tried-before
description: Asking to look at an earlier fix before a new proposal routes to improve, which names the bounded lesson read and invents no history.
expected_outcome: The improve skill fires, the reply names the orangu lesson read, and it states no earlier change, dismissal, outcome or date that orangu output in the run does not show.
tags: [routing, improve, honesty, train]
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

A while ago we tried a fix for the repeated test failures in this repo, and I think it made things worse. I also dismissed one finding about it. Before you suggest a change for my last session, look at what we tried before and how it went.
