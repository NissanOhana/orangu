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
| `orangu` (no verb) | Analyze the latest session and print the one next step |
| `orangu report [selector]` | Write and open one self-contained session report |
| `orangu analyze [selector]` | Print a summary or redacted JSON |
| `orangu list` | List discoverable supported sessions |
| `orangu pick` | Choose a session from a list, running ones first, and open its report |
| `orangu watch [selector]` | Refresh one report while its session grows |
| `orangu serve` | Run the capability-protected local app on `127.0.0.1` |
| `orangu feedback` | Open the isolated, capability-protected localhost beta-feedback form |
| `orangu repo` | Aggregate supported sessions for the current repository |
| `orangu global` | Aggregate supported sessions across configured roots |
| `orangu evidence <input>` | Emit the bounded, always-redacted evidence a skill reads |
| `orangu estimate [selector\|repo\|global\|harness]` | Size the bounded read before handing evidence to a skill |
| `orangu harness` | Compare declared harness configuration with observed use |
| `orangu suggest` | Inspect and transition validated suggestion records |

A session selector can be `latest`, a session id or unique prefix, a supported `.jsonl` path, or `current`: the session Claude Code is running orangu from, resolved from the Claude Code environment and never guessed silently (a cwd-based guess says so; outside Claude Code it is an error). `report`, `analyze`, `watch`, and `estimate` also take the selector as `--session <selector>` (`-s`); giving both the positional and the flag with different values is an error.

`orangu pick` lists sessions running first (title, project, age, size), moves with the arrow keys, `j`/`k`, or a digit, opens the chosen report on Enter, and cancels on `q`, Esc, or Ctrl-C with the terminal restored. Without a terminal, in CI, or with `--plain` it prints a numbered list and the `orangu report <id>` hint; `--json` prints the array (`[]` on an empty home, still exiting 1 because the chooser had nothing to choose).

Use `orangu --help` for flags and output controls.

### Terminal output

`orangu report` writes only the report path to stdout, so `orangu report | xargs open` works; its summary (the check line, the path, the top finding, and the next command) goes to stderr. `orangu analyze` prints the measurement block on stdout and the same footer on stderr; bare `orangu` prints everything on stdout. The next command is the short `claude "/orangu:improve sg_..."`: the suggestion record is stored under `~/.orangu` at report time, and only when that store cannot be written does the long `--finding` form appear, with a line saying so.

Colour, the spinner, and `file://` hyperlinks appear only on an interactive terminal and are off under `--json`, `--quiet`, `--no-color`, `NO_COLOR`, `FORCE_COLOR=0`, `TERM=dumb`, `CI`, or a pipe; `ORANGU_NO_ANIMATION=1` stops the spinner alone. `--json` and `--quiet` output never carries an escape sequence. `--verbose` adds the cache diagnostic on stderr.

## Report and app

The file report and localhost app render the same session evidence:

- Overview: outcome narrative, named signals, and relevant findings.
- Timeline: turns, parent and subagent tool calls, actors, durations, and errors.
- Tools: calls, latency, failure states, and recurring error shapes.
- Agents: parent and subagent structure and activity.
- Context and tokens: context changes, compaction, cache behavior, and token composition.
- Coverage: parsed and unknown records plus usage reconciliation.
- Repo and Global: recurring patterns across supported sessions.
- Suggestions: matching known fixes, proposals, receipts, host hand-offs, and scope-aware verification state.

The browser never starts an agent or marks a proposal applied. It only copies a command for explicit use in Claude Code or Codex.

## Beta feedback

Run `orangu feedback --context session|repo|global|report|app` or use the **Beta feedback** launcher in the localhost app. The standalone command does not discover a session or attach report data. Feedback stays in the browser until you review the exact title, body, and generic diagnostics and explicitly open GitHub's issue composer.

See [beta feedback](feedback.md) for the privacy boundary, consent flow, and oversized-report fallback.

## Shareable output

Reports and JSON scrub recognized secrets by default. Report, `analyze --json`, `evidence`, `repo`, and `global` output also omit arbitrary prompt and result text (session titles, previews, tool-error text, finding details built from commands) unless `--include-text` is requested.

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
- Repo scope supports proposal and explicit application; later verification for repo scope is not implemented yet.
- Global scope is proposal-only.

See [determinism and AI skills](DETERMINISM.md) and [data contracts](DATA-CONTRACTS.md) for the complete rules.
