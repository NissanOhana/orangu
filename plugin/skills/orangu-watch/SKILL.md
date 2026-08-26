---
name: orangu-watch
description: Keep a local report refreshed while one supported Claude Code, Cowork, or Desktop session is running. Use when someone asks to watch a long or delegated run, monitor its steps and outcome as they appear, check whether work is still progressing, or keep one session report open. This observes one session; use orangu serve for several sessions and use orangu-improve or orangu-mega only when a change proposal is requested.
allowed-tools: Bash(orangu:*), Bash(node *orangu.cli.mjs*)
---

# orangu-watch

Run `orangu watch [<session>]` to keep one self-contained report current as a supported transcript grows. The deterministic CLI refreshes the evidence; this skill does not interpret a partial run as a verified improvement.

If `orangu` is not on PATH, run `node "${CLAUDE_PLUGIN_ROOT}/bin/orangu.cli.mjs" watch ...`. If neither command works, report that and stop. Never open the `.jsonl` directly.

## Operating boundary

- This is a foreground, long-running command. Tell the user how to interrupt it with Ctrl-C. Use a separate terminal or an explicitly managed background process if other work must continue.
- The report is local and redacted by default. Add `--include-text` or `--no-redact` only after the user explicitly requests that content on their machine.
- Watching follows **one** session. Use `orangu list` to choose it.
- For multiple live sessions, run `orangu serve` and open its loopback URL.
- Observation is not proposal work. A session finding goes to `orangu-improve`; recurring repo or global patterns go to the separately requested `orangu-mega --scope repo|global` flow.
