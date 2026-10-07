# Reading an orangu analysis

This is the reference for `orangu analyze --json` and the HTML report. Read it when you are not sure what a metric means. Every number is deterministic: orangu computes it from the transcript, and a model never estimates it. Token counts are exact. The only thing that orangu ever approximates is the *identity* of an unrecognised model id, flagged `estimatedMatch`.

## The three axes

orangu frames everything as **Quality x Time x Tokens**. You maximize the first and minimize the other two.

- **Quality** is never a single score, because a contestable score destroys trust. It is a set of deterministic signals:
  - tests run and their last result
  - build, typecheck and lint runs
  - git commits and PRs opened
  - the tool-error rate
  - user-correction turns ("no / wrong / again / revert")
  - interruptions and API errors
  - files edited 4+ times
  - edit-then-revert pairs
- **Time** = wall clock (first to last record). It splits into *active* (assistant working, summed turn durations), *tool* time, *agent* time, *model* time (latency + streaming), and *human wait* (idle gaps between turns).
- **Tokens** = every token that the session moved. Orangu splits them by kind: fresh input, cache read, cache write 5m, cache write 1h and output. It also splits them by model, by turn, by tool category, and main thread vs agents. Orangu counts server-tool calls (web search and web fetch) as requests, not tokens.

Tokens are the only usage metric orangu has and the only one it reports. **Every figure you quote must be in tokens or milliseconds**. Do not convert them into a unit that the transcript did not record.

## Token accounting (the correctness gate)

Claude Code may write one JSONL line per content block, with several lines repeating the same response usage. Summing per line would count one response more than once. Orangu deduplicates by `message.id`, keeps the completed usage record, drops zero-usage synthetic error placeholders, and counts hidden usage iterations on their reported model. The `parse.reconciliation` block shows whether totals agree with per-turn and per-agent sums.

**Context size** at any request = `input + cache_read + cache_creation` (this mirrors Claude Code's own status-line formula and leaves out output). The **re-read multiplier** = total cache-read tokens ÷ peak context, or how many times the model carried the working context. A high value is normal. An extreme value with a low cache-hit ratio is waste.

## The findings (insight rules)

orangu ships deterministic rules. Each finding carries an `axis`, `severity`, `improvement`, `why`, `recommendation`, `evidence`, `turnIndexes`, and sometimes a `method` and a `savings` estimate. `improvement` is the change to make, `why` says why the finding matters, and `method` says what the rule counts. `recommendation` is the 3 parts joined. The estimate is in `tokens` or `ms`, with `estimated: true` when orangu derives it from bytes at ~4 bytes/token.

A rule attaches `savings.tokens` **only** when following its recommendation would cause fewer tokens to be sent or generated. A rule whose change would only move the same tokens between cache tiers or between models omits `savings` on purpose. Relay those findings as observations, not as savings. The main rules:

| ruleId | what it flags | the improvement it recommends |
|---|---|---|
| `reread-files` | the same file read 3+ times | Read it once. Use Grep or an offset. Agents cannot see the parent context, so their reads are expected. |
| `repeated-commands` | an identical shell command 4+ times | Verify loops are fine. Polling should wait. Fix a repeatedly failing command once. |
| `tool-errors` | a high error rate or a recurring error signature | A recurring signature is an environment or instruction problem. Fix the root cause, and add it to CLAUDE.md. |
| `oversized-tool-results` | tool results > 40 KB carried in context | Trim at the source (head, tail, grep, `--limit`), or run the noisy step in a subagent. |
| `sequential-reads` | 4+ read or search calls issued one by one | Batch them in one message, or use an Explore subagent. |
| `compactions` / `context-near-limit` | a context reset, or > 70% of the window | Split the work into sessions with a handover. Keep tool outputs small. Push exploration into subagents. |
| `preamble-weight` | a large per-request baseline (CLAUDE.md, tools, skills) | Trim CLAUDE.md. Prune unused MCP servers and skills. Check the SessionStart hook output. |
| `low-cache-hit` | a cache hit ratio < 60% over many requests | Avoid edits to the system prompt or CLAUDE.md mid-session. Work steadily within the cache TTL. |
| `agent-fanout` / `idle-agents` | the subagents' share of the session's tokens, and agents that did nothing | Agents are worth it when the returned summary << what they read. Watch for agents that re-read what the parent already knew. |
| `hook-errors` / `hook-latency` | failing or slow hooks | Fix or remove them in settings.json. Make Stop and PostToolUse hooks async. |
| `large-writes` | big Write or Edit inputs emitted as output tokens | Prefer targeted Edits. Generate boilerplate with a script, not the model. |
| `cache-dominates-tokens` | cache read+write is >80% of the session's tokens | Context size, not output, is where the tokens go: batch tool calls, scan in subagents, /compact deliberately. |
| `cache-invalidation` / `cache-ttl-churn` | the prompt cache was busted, or the long TTL tier carried the writes | Load MCP tools at the start. Avoid mid-session /model switches. **No saving is claimed**: the same tokens are written instead of read. |
| `skill-token-weight` | a skill moves >2x the median turn's tokens per invocation | Trim the skill body. Defer its reference docs to on-demand reads. |
| `model-for-task` | an agent type is mostly mechanical on a frontier model | Set `model: haiku` for it. **No saving is claimed**: it sends the same tokens, while the larger model remains available for other work. |
| `interruptions` / `user-corrections` | the human stopped or corrected the agent | The brief was under-specified. Ask for a plan first. Add the missed rule to CLAUDE.md. |
| `model-fallback` | the chosen model was unavailable and fell back | Run the quality-critical steps again on the intended model. |

## Cross-session (repo / global)

`orangu repo` and `orangu global` aggregate the same components across many sessions:
- **tokens by model / project**, **tokens per session**, **tokens per human turn**
- **crossFindings**: which insight rules recur, with total token savings and example session ids. Each one shows the finding title and the rule text of one example session. `exampleTitle` is that title, and `title` adds the `In one session: ` marker.
- **recurringErrors**: tool-error signatures that appear in **many** sessions. These are environment problems (worktree isolation, write-before-read, missing deps), not one-off bad luck. They point to the harness improvements with the largest effect.
- **topReReadFiles**: files read across many sessions. These are candidates to summarize, cache, or restructure (a CLAUDE.md read hundreds of times is a signal to trim it).
- **topSessions**: the heaviest sessions, by tokens

The aggregate JSON also has `schemaVersion`, and it is the input that the **`/orangu:harness`** skill reasons over.

## Plain-language vocabulary

When the user asks for plain language, translate:
- tool call and subagent keep their names (the Plain mode of the report uses them too)
- cache read → reused context
- cache creation (cache write) → saved context
- compaction → memory refresh
- context window → working memory
- effort → how hard it thought
- model → which assistant version

Lead with the **Outcome** (what it produced), the **tokens and the time**, and the **one improvement to make**. Never surface `tool_use`, `message.id`, `cache_creation_input_tokens`, or raw model ids.
