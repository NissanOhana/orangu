---
name: interview-asks-about-my-work
description: A request to tell orangu the role and the work of the user, so that its proposals fit, routes to the interview. The reply claims no saved profile without a tool result.
expected_outcome: The interview skill fires and opens no transcript. The reply asks about the role or the work of the user, or says that orangu could not run here. It claims no saved profile.
tags: [routing, interview, holdout]
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

Before you suggest changes to my agent setup, ask me about my role and how I work, so that the suggestions fit me.
