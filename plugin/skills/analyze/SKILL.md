---
name: analyze
description: Explain what happened in one session, finished or still running, from local deterministic evidence. Use when the user asks to review a run or trace what the agent did and why it ended there. Use it to diagnose an error or retry, see where time or tokens went, or open a visual report. Use it to open the report for the session running right now. Use it to keep a report refreshed while a session runs. Not for a change proposal (/orangu:improve) or a repo or global harness review (/orangu:harness).
allowed-tools: Bash(orangu:*), Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/orangu.cli.mjs" *), Read
---

# /orangu:analyze

Input: one supported Claude Code, Cowork, or Desktop session on this machine (or a repo or global aggregate of them).

Use the bundled CLI to observe a supported session and explain its outcome. The CLI owns parsing, redaction, counts, evidence, matching, and ranking. You translate that deterministic output for the user. Do not turn the analysis itself into a claim that a change worked. Write all user-facing text in STE, as [the STE rules](../shared/ste.md) direct.

## Hard boundary

**Never Read, cat, grep, or otherwise open a `.jsonl` transcript yourself.** Use `orangu`. It streams the source and returns bounded, redacted evidence. If `orangu` is not on PATH, run `node "${CLAUDE_PLUGIN_ROOT}/bin/orangu.cli.mjs" ...`. If neither command works, report that and stop.

## Choose the scope

- **One session, observe and diagnose:** `orangu analyze <session> --json --slim`
  `<session>` may be a supported session id, unique prefix, transcript path, `latest`, or `current`. Prefer `--slim`. It omits the large event and turn arrays. Size that read first with `orangu estimate <session> --slim`. That command sizes exactly this read and nothing else.
- **One session, bounded findings for a hand-off:** `orangu evidence '<session>' --quiet`. Its gate is `orangu evidence '<session>' --estimate --quiet`. Use the gate that matches the read you are about to make.
- **Repository, find recurring patterns:** `orangu repo [<path>] --json`
- **Supported sessions on this machine, find recurring patterns:** `orangu global --json`
- **Find the right session:** `orangu list`. Add `--global` to include supported Cowork and Desktop sources.
- **Open a self-contained report:** `orangu report <session>`. Add `--out <file>` when the destination matters.
- **This session, open its report:** `orangu report current --open` resolves the session that Claude Code runs in. Claude Code writes the transcript asynchronously, so the report can lag the last turn. If `current` cannot resolve, run `orangu report -s "${CLAUDE_SESSION_ID}" --open`.
- **Live session, keep one report current:** `orangu watch [<session>]` is a foreground command. It refreshes one self-contained report as the transcript grows, until Ctrl-C. Tell the user how to interrupt it. For several sessions at once, run `orangu serve` and open its loopback URL. Watching observes. It never turns a partial session into a claim that a change worked.

JSON is redacted by default. Use `--no-redact` only after the user explicitly requests unredacted output on their machine. See `references/json-shape.md` for the contract. Read `references/reading-the-report.md` only when a field needs interpretation.

## Answer from evidence

1. State the outcome first: what completed, what remained unfinished, and the evidence that supports that reading.
2. Trace the important steps, tool results, errors, retries, and context signals. Do not invent an event that the CLI did not report.
3. Keep scope honest. One session supports diagnosis. Repository and global aggregates support a recurring-pattern claim only when they include example sessions.
4. Name the top deterministic finding and its exact evidence. A `savings` value is an estimate that the rule owns. A finding without one has no measured saving.
5. When the user asks for plain language, keep the words tool calls and subagents. In plain language, say reused context for the cache, and working memory for the context window. Keep the numbers and evidence identical across detail levels.
6. Before you send the answer, check the draft with `orangu ste - <<'END_STE'`.

## Handoff

Analysis observes and diagnoses. It does not edit a harness or write a proposal.

- For one bounded finding, create or reuse its suggestion record with `orangu suggest --rule <ruleId> --scope <session|repo|global> --session <id[,id...]>`. Then offer the printed `/orangu:improve <id>` command.
- Quote `orangu estimate --suggestion <id>` before the deeper read.
- Use `/orangu:harness --scope repo|global` only for a separately requested whole-harness review of recurring patterns.

Session and repo proposals may be applied explicitly. They become verified only when Orangu's reviewed checks pass against later sessions beyond chance. Global proposals are review-only. Never describe a proposal as applied, verified, or improved beyond the evidence its scope supports.

After the requested analysis is complete, briefly offer `/orangu:feedback` with the matching context once. Never launch it unless the user accepts.
