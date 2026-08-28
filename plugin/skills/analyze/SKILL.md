---
name: analyze
description: Explain what happened in one session, finished or still running, from local deterministic evidence. Use when the user asks to review a run, trace what the agent did and why it ended where it did, diagnose an error or retry, see where time or tokens went, open a visual report, open the report for the session running right now, or keep a report refreshed while a session runs. Not for a change proposal: /orangu:improve. Not for a repo or global harness review: /orangu:harness.
allowed-tools: Bash(orangu:*), Bash(node *orangu.cli.mjs*), Read
---

# /orangu:analyze

Input: one supported Claude Code, Cowork, or Desktop session on this machine (or a repo or global aggregate of them).

Use the bundled CLI to observe a supported session and explain its outcome. The CLI owns parsing, redaction, counts, evidence, matching, and ranking. You translate that deterministic output for the user. Do not turn the analysis itself into a claim that a change worked.

## Hard boundary

**Never Read, cat, grep, or otherwise open a `.jsonl` transcript yourself.** Use `orangu`; it streams the source and returns bounded, redacted evidence. If `orangu` is not on PATH, run `node "${CLAUDE_PLUGIN_ROOT}/bin/orangu.cli.mjs" ...`. If neither command works, report that and stop.

## Choose the scope

- **One session, observe and diagnose:** `orangu analyze <session> --json --slim`
  `<session>` may be a supported session id, unique prefix, transcript path, `latest`, or `current`. Prefer `--slim`; it omits the large event and turn arrays. Size that read first with `orangu estimate <session> --slim`; it sizes exactly this read and nothing else.
- **One session, bounded findings for a hand-off:** `orangu evidence '<session>' --quiet`. Its gate is `orangu evidence '<session>' --estimate --quiet`; use the gate that matches the read you are about to make.
- **Repository, find recurring patterns:** `orangu repo [<path>] --json`
- **Supported sessions on this machine, find recurring patterns:** `orangu global --json`
- **Find the right session:** `orangu list`; add `--global` to include supported Cowork and Desktop sources.
- **Open a self-contained report:** `orangu report <session>`; add `--out <file>` when the destination matters.
- **This session, open its report:** `orangu report current --open` resolves the session Claude Code is running in; the transcript is written asynchronously, so the report can lag the last turn. If `current` cannot resolve, run `orangu report ${CLAUDE_SESSION_ID} --open`.
- **Live session, keep one report current:** `orangu watch [<session>]` is a foreground command that refreshes one self-contained report as the transcript grows until Ctrl-C; tell the user how to interrupt it. For several sessions at once, run `orangu serve` and open its loopback URL. Watching observes; it never turns a partial run into a claim that a change worked.

JSON is redacted by default. Use `--no-redact` only after the user explicitly requests unredacted output on their machine. See `references/json-shape.md` for the contract and `references/reading-the-report.md` only when a field needs interpretation.

## Answer from evidence

1. State the outcome first: what completed, what remained unfinished, and the evidence that supports that reading.
2. Trace the important steps, tool results, errors, retries, and context signals without inventing an event the CLI did not report.
3. Keep scope honest. One session supports diagnosis. Repository and global aggregates support a recurring-pattern claim only when they include example sessions.
4. Name the top deterministic finding and its exact evidence. A `savings` value is an estimate owned by the rule; a finding without one has no measured saving.
5. Use plain language when requested: keep the words tool calls and subagents, and say reused context and working memory for the cache and the context window. Keep the numbers and evidence identical across detail levels.

## Handoff

Analysis observes and diagnoses. It does not edit a harness or write a proposal.

- For one bounded finding, create or reuse its suggestion record with `orangu suggest --rule <ruleId> --scope <session|repo|global> --session <id[,id...]>`, then offer the printed `/orangu:improve <id>` command.
- Quote `orangu estimate --suggestion <id>` before the deeper read.
- Use `/orangu:harness --scope repo|global` only for a separately requested whole-harness review of recurring patterns.

Session proposals may be applied explicitly and become verified only after Orangu passes their reviewed checks against a later supported session. Repo proposals may be applied but remain `applied` until Orangu can compare later repository sessions; global proposals are review-only. Never describe a proposal as applied, verified, or improved beyond the evidence its scope supports.

After the requested analysis is complete, briefly offer `/orangu:feedback` with the matching context once. Never launch it unless the user accepts.
