---
name: improve-starts-the-chain-with-the-measure-step
description: A first request to make the agent setup better, with no input, routes to improve. Improve starts its chain with the measure step and asks nothing before it. It starts no interview, and the reply claims no profile and no finding without tool output.
expected_outcome: The improve skill fires and the interview skill does not fire. The reply names the orangu command of the measure step or its estimate gate, or the orangu command that could not run here. It asks no question before that step, and it claims no profile, no answer and no finding without a tool result.
tags: [routing, improve, honesty, train]
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

I just installed orangu. Help me make my agent setup better.
