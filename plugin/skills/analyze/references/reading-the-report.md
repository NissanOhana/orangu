# Reading an orangu analysis

This is the reference for interpreting `orangu analyze --json` and the HTML report. Read it when you hit a metric you are unsure about. Every number is deterministic: computed from the transcript, never estimated by a model. Token counts are exact; the only thing orangu ever approximates is the *identity* of an unrecognised model id, flagged `estimatedMatch`.

## The three axes

orangu frames everything as **Quality x Time x Tokens**. You maximize the first and minimize the other two.

- **Quality** is never a single score (a contestable score destroys trust). It is a set of deterministic signals: tests run and their last result, build/typecheck/lint runs, git commits, PRs opened, tool-error rate, user-correction turns ("no / wrong / again / revert"), interruptions, API errors, files edited 4+ times, edit-then-revert pairs.
- **Time** = wall clock (first to last record), split into *active* (assistant working, summed turn durations), *tool* time, *agent* time, *model* time (latency + streaming), and *human wait* (idle gaps between turns).
- **Tokens** = every token the session moved, split by kind (fresh input, cache read, cache write 5m, cache write 1h, output), by model, by turn, by tool category, main-thread vs agents. Tokens are the only usage metric orangu has and the only one it reports. **Every figure you quote must be in tokens or milliseconds**; do not convert them into a unit the transcript did not record. Server-tool calls (web search/fetch) are counted as requests, not tokens.

## Token accounting (the correctness gate)

Claude Code may write one JSONL line per content block, with several lines repeating the same response usage. Summing per line would count one response more than once. Orangu deduplicates by `message.id`, keeps the completed usage record, drops zero-usage synthetic error placeholders, and counts hidden usage iterations on their reported model. The `parse.reconciliation` block shows whether totals agree with per-turn and per-agent sums.

**Context size** at any request = `input + cache_read + cache_creation` (this mirrors Claude Code's own status-line formula; output is not included). The **re-read multiplier** = total cache-read tokens ÷ peak context, or how many times the working context was carried through the model. High is normal; very high with a low cache-hit ratio is waste.

## The findings (insight rules)

orangu ships deterministic rules; each finding carries an `axis`, `severity`, `recommendation`, `evidence`, `turnIndexes`, and sometimes a `savings` estimate (`tokens`/`ms`, `estimated: true` when derived from bytes at ~4 bytes/token). A rule attaches `savings.tokens` **only** when following its recommendation would have caused fewer tokens to be sent or generated; rules whose change would merely move the same tokens between cache tiers or between models omit `savings` on purpose. Relay them as observations, not as savings. The main rules:

| ruleId | what it flags | the fix it recommends |
|---|---|---|
| `reread-files` | same file read 3+ times | read once; use Grep/offset; agents can't see parent context so their reads are expected |
| `repeated-commands` | identical shell command 4+ times | verify loops are fine; polling should wait; fix a repeatedly-failing command once |
| `tool-errors` | high error rate or a recurring error signature | a recurring signature is an environment/instruction problem; fix the root cause, add to CLAUDE.md |
| `oversized-tool-results` | tool results > 40 KB carried in context | trim at source (head/tail/grep, `--limit`), or run the noisy step in a subagent |
| `sequential-reads` | 4+ read/search calls issued one-by-one | batch them in one message or use an Explore subagent |
| `compactions` / `context-near-limit` | context reset, or > 70% of window | split into sessions with a handover; keep tool outputs small; push exploration into subagents |
| `preamble-weight` | large per-request baseline (CLAUDE.md, tools, skills) | trim CLAUDE.md; prune unused MCP servers/skills; check SessionStart hook output |
| `low-cache-hit` | cache hit ratio < 60% over many requests | avoid editing the system prompt/CLAUDE.md mid-session; work steadily within the cache TTL |
| `agent-fanout` / `idle-agents` | subagents' share of the session's tokens; agents that did nothing | agents worth it when the returned summary << what they read; watch for agents re-reading what the parent already knew |
| `hook-errors` / `hook-latency` | failing or slow hooks | fix/remove in settings.json; make Stop/PostToolUse hooks async |
| `large-writes` | big Write/Edit inputs emitted as output tokens | prefer targeted Edits; generate boilerplate with a script, not the model |
| `cache-dominates-tokens` | cache read+write is >80% of the session's tokens | context size, not output, is where the tokens go: batch tool calls, scan in subagents, /compact deliberately |
| `cache-invalidation` / `cache-ttl-churn` | the prompt cache was busted, or the long TTL tier carried the writes | load MCP tools at the start, avoid mid-session /model switches. **No saving is claimed**; the same tokens are written instead of read |
| `skill-token-weight` | a skill moves >2x the median turn's tokens per invocation | trim the skill body; defer its reference docs to on-demand reads |
| `model-for-task` | an agent type is mostly mechanical on a frontier model | set `model: haiku` for it. **No saving is claimed**; it sends the same tokens, while the larger model remains available for other work |
| `interruptions` / `user-corrections` | the human stopped or corrected the agent | under-specified brief; ask for a plan first; add the missed rule to CLAUDE.md |
| `model-fallback` | the chosen model was unavailable and fell back | re-run quality-critical steps on the intended model |

## Cross-session (repo / global)

`orangu repo` and `orangu global` aggregate the same components across many sessions:
- **tokens by model / project**, **tokens per session**, **tokens per human turn**
- **crossFindings**: which insight rules recur, with total token savings and example session ids
- **recurringErrors**: tool-error signatures that appear in **many** sessions. These are environment problems (worktree isolation, write-before-read, missing deps), not one-off bad luck, and they are the highest-leverage harness fixes
- **topReReadFiles**: files read across many sessions. These are candidates to summarize, cache, or restructure (a CLAUDE.md read hundreds of times is a signal to trim it)
- **topSessions**: the heaviest runs, by tokens

The aggregate JSON also has `schemaVersion` and is the input the **`/orangu:mega`** skill reasons over.

## Plain-language vocabulary

When the user asks for plain language, translate:
- tool call → step; sidechain/subagent → helper task; cache read → reused context; cache creation → fresh context loaded; compaction → memory refresh; context window → working memory; effort → how hard it thought; model → which assistant version.
Lead with the **Outcome** (what it produced), the **tokens and the time**, and the **one thing to fix**. Never surface `tool_use`, `message.id`, `cache_creation_input_tokens`, or raw model ids.
