---
name: analyze
description: Explain what happened in a supported Claude Code, Cowork, or Desktop session using local deterministic evidence. Use when someone asks to review a run, trace its steps and outcome, diagnose an error or retry, understand time or token use, open a visual report, or compare recurring patterns across a repository or supported sessions on the machine. For a concrete change proposal, hand one finding to /orangu:improve; for a whole repo or global improvement plan, use /orangu:mega.
allowed-tools: Bash(orangu:*), Bash(node *orangu.cli.mjs*), Read
---

# /orangu:analyze

Use the bundled CLI to observe a supported session and explain its outcome. The CLI owns parsing, redaction, counts, evidence, matching, and ranking. You translate that deterministic output for the user. Do not turn the analysis itself into a claim that a change worked.

## Hard boundary

**Never Read, cat, grep, or otherwise open a `.jsonl` transcript yourself.** Use `orangu`; it streams the source and returns bounded, redacted evidence. If `orangu` is not on PATH, run `node "${CLAUDE_PLUGIN_ROOT}/bin/orangu.cli.mjs" ...`. If neither command works, report that and stop.

## Choose the scope

- **One session, observe and diagnose:** `orangu analyze <session> --json --slim`
  `<session>` may be a supported session id, unique prefix, transcript path, or `latest`. Prefer `--slim`; it omits the large event and turn arrays. Run `orangu estimate <session>` before any full read.
- **Repository, find recurring patterns:** `orangu repo [<path>] --json`
- **Supported sessions on this machine, find recurring patterns:** `orangu global --json`
- **Find the right session:** `orangu list`; add `--global` to include supported Cowork and Desktop sources.
- **Open a self-contained report:** `orangu report <session>`; add `--out <file>` when the destination matters.
- **Live session, keep one report current:** `orangu watch [<session>]` is a foreground command that refreshes one self-contained report as the transcript grows until Ctrl-C; tell the user how to interrupt it. For several sessions at once, run `orangu serve` and open its loopback URL. Watching observes; it never turns a partial run into a claim that a change worked.

JSON is redacted by default. Use `--no-redact` only after the user explicitly requests unredacted output on their machine. See `references/json-shape.md` for the contract and `references/reading-the-report.md` only when a field needs interpretation.

## Answer from evidence

1. State the outcome first: what completed, what remained unfinished, and the evidence that supports that reading.
2. Trace the important steps, tool results, errors, retries, and context signals without inventing an event the CLI did not report.
3. Keep scope honest. One session supports diagnosis. Repository and global aggregates support a recurring-pattern claim only when they include example sessions.
4. Name the top deterministic finding and its exact evidence. A `savings` value is an estimate owned by the rule; a finding without one has no measured saving.
5. Use plain language when requested: say steps, helper tasks, reused context, and working memory. Keep the numbers and evidence identical across detail levels.

## Handoff

Analysis observes and diagnoses. It does not edit a harness or write a proposal.

- For one bounded finding, create or reuse its suggestion record with `orangu suggest --rule <ruleId> --scope <session|repo|global> --session <id[,id...]>`, then offer the printed `/orangu:improve <id>` command.
- Quote `orangu estimate --suggestion <id>` before the deeper read.
- Use `/orangu:mega --scope repo|global` only for a separately requested whole-harness review of recurring patterns.

Session proposals may be applied explicitly and become verified only after Orangu passes their reviewed checks against a later supported session. Repo proposals may be applied but remain `applied` until a real fresh-cohort comparator exists; global proposals are review-only. Never describe a proposal as applied, verified, or improved beyond the evidence its scope supports.

After the requested analysis is complete, briefly offer `/orangu:feedback` with the matching context once. Never launch it unless the user accepts.
