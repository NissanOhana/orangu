# Usage

Orangu reads supported local session files and turns them into a self-contained report, a loopback app, or redacted JSON.

## Install

Orangu requires Node.js 20 or newer.

```bash
npx orangu report
npm install --global orangu
```

To run from a source checkout:

```bash
npm ci
npm run build
node dist/orangu.js report
```

## Commands

| Command | Purpose |
|---|---|
| `orangu report [selector]` | Write and open one self-contained session report |
| `orangu analyze [selector]` | Print a summary or redacted JSON |
| `orangu list` | List discoverable supported sessions |
| `orangu watch [selector]` | Refresh one report while its session grows |
| `orangu serve` | Run the local app on `127.0.0.1` |
| `orangu repo` | Aggregate supported sessions for the current repository |
| `orangu global` | Aggregate supported sessions across configured roots |
| `orangu evidence <input>` | Emit the bounded, always-redacted skill handoff |
| `orangu harness` | Compare declared harness configuration with observed use |
| `orangu suggest` | Inspect and transition validated suggestion records |

A session selector can be `latest`, a session id or unique prefix, or a supported `.jsonl` path.

Use `orangu --help` for flags and output controls.

## Report and app

The file report and localhost app render the same session evidence:

- Overview: outcome narrative, named signals, and relevant findings.
- Timeline: turns, parent and subagent tool calls, actors, durations, and errors.
- Tools: calls, latency, failure states, and recurring error shapes.
- Agents: parent and subagent structure and activity.
- Context and tokens: context changes, compaction, cache behavior, and token composition.
- Coverage: parsed and unknown records plus usage reconciliation.
- Repo and Global: recurring patterns across supported sessions.
- Suggestions: catalog matches, proposals, application receipts, host handoffs, and scope-aware verification state.

The browser never starts an agent or marks a proposal applied. It only copies a command for explicit use in Claude Code or Codex.

## Shareable output

Reports and JSON scrub recognized secrets by default. Report commands also omit arbitrary prompt and result text unless `--include-text` is requested.

Home paths are shortened to `~`, but other absolute paths may remain useful evidence. Add `--strip-paths` to reduce them to basenames before sharing. `--no-redact` is intended only for explicitly requested local inspection.

`orangu evidence` is always redacted and does not accept `--no-redact`.

## Supported inputs and limits

Orangu currently parses supported Claude Code, Cowork, and Desktop session formats. It is not a generic JSONL reader and does not ingest Codex transcripts. Claude Code and Codex are both supported as hosts for the optional improvement skills.

Disk-backed parsing is fail-closed:

- Normal parse, cache, and live snapshots share a 256 MiB and 100,000-record session budget.
- Evidence and later verification use a stricter 64 MiB whole-session budget.
- One JSONL record may be at most 8 MiB.
- Sidecar discovery is bounded by entry count, nesting depth, and metadata file size.
- Symlinks, replacement races, partial verification inputs, and over-limit inputs are rejected.

Current Analysis, SlimAnalysis, and Aggregate JSON inputs to `orangu evidence` are capped at 8 MiB. The projection validates at most 500 findings and 1,000 aggregate sessions, selects at most 50 findings, and emits at most 256 KiB.

Unknown records appear in Coverage instead of being silently treated as supported.

## Improvement lifecycle

The optional skills use `orangu evidence` as their only transcript boundary:

```text
observe -> draft proposal -> explicit apply -> later session comparison
```

- Session scope supports proposal, explicit application, and later same-workspace comparison.
- Repo scope supports proposal and explicit application; fresh-cohort verification is not implemented.
- Global scope is proposal-only.

See [determinism and AI skills](DETERMINISM.md) and [data contracts](DATA-CONTRACTS.md) for the complete rules.
