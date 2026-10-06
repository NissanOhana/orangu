# Usage

Orangu reads supported local session files. It turns them into a self-contained report, a loopback app, or redacted JSON.

## Install

Orangu requires Node.js 20 or newer.

```bash
npx orangu          # dashboard: repo, global, or a session
npx orangu report   # latest session
npm install --global orangu
```

In a pipe or in CI, bare `npx orangu` prints a short summary of the latest session.

To run from a source checkout:

```bash
npm ci
npm run build
node dist/orangu.js report
```

## Commands

| Command | Purpose |
|---|---|
| `orangu` (no verb) | Open the terminal dashboard for repo, global, and session reports |
| `orangu report [selector]` | Write and open one self-contained session report |
| `orangu analyze [selector]` | Print a summary or redacted JSON |
| `orangu list` | List discoverable supported sessions |
| `orangu pick` | Choose a session from a list, running ones first, and open its report |
| `orangu watch [selector]` | Refresh one report while its session grows |
| `orangu serve` | Run the capability-protected local app on `127.0.0.1` |
| `orangu feedback` | Open the isolated, capability-protected localhost beta-feedback form |
| `orangu repo` | Aggregate supported sessions for the current repository (`--html`/`--open` for the report) |
| `orangu global` | Aggregate supported sessions across configured roots (`--html`/`--open` for the report) |
| `orangu evidence <input>` | Emit the bounded, always-redacted evidence a skill reads |
| `orangu estimate [selector\|repo\|global\|harness]` | Size the bounded read before handing evidence to a skill |
| `orangu harness` | Compare declared harness configuration with observed use |
| `orangu suggest` | Inspect and transition validated suggestion records |

A session selector is `latest`, a session id or unique prefix, a supported `.jsonl` path, or `current`. `current` is the session that Claude Code runs orangu from, resolved from the Claude Code environment and never guessed silently. A guess from the cwd says so, and outside Claude Code `current` is an error. `report`, `analyze`, `watch`, and `estimate` also take the selector as `--session <selector>` (`-s`). If the positional selector and the flag differ, that is an error.

On an interactive terminal, bare `orangu` draws the orange ASCII mascot and a keyboard dashboard. The first choices open the current-repository aggregate, the global aggregate, or the full session picker. Below them, each open Claude Code session is a direct report shortcut. Move with the arrow keys or `j`/`k`, choose with Enter, and cancel with `q`, Esc, or Ctrl-C. A pipe, CI, `--plain`, `--quiet`, or an explicit scope or session flag keeps the compact latest-session behavior and never waits for input.

`orangu repo` and `orangu global` print their answer to stdout. `--html <file>` also writes that scope as one self-contained HTML report. `--open` writes it into the temp directory as `orangu-<scope>-<hash>.html` and hands it to your browser. So a re-run never overwrites a file that a browser still has open.

The dashboard's repository and global choices ask for that report, and `--no-open` suppresses it. Orangu refuses `--html` and `--open` with `--json`, which is a machine read with no side effect. `--out <file>` still writes the aggregate JSON. The written file is private (mode `0600`), redacted by default, and passes the same zero-network gate as the session report.

`orangu pick` lists sessions, running ones first (title, project, age, size). Move with the arrow keys, `j`/`k`, or a digit. Enter opens the chosen report, and `q`, Esc, or Ctrl-C cancels and restores the terminal. Without a terminal, in CI, or with `--plain`, it prints a numbered list and the `orangu report <id>` hint. `--json` prints the array. On an empty home it prints `[]` and still exits 1, because the chooser had nothing to choose.

Use `orangu --help` for flags and output controls.

### Terminal output

`orangu report` writes only the report path to stdout, so `orangu report | xargs open` works. Its summary goes to stderr: the check line, the path, the top finding, and the next command. `orangu analyze` prints the measurement block on stdout and the same footer on stderr. The bare interactive dashboard and the non-interactive latest-session brief both use stdout.

The next command is the short `claude "/orangu:improve sg_…"`. For it to work, `report`, `analyze`, and the non-interactive bare-session brief record the top finding's suggestion under `~/.orangu`. Only when orangu cannot write that store does the long `--finding` form appear, with a line that says so. `--quiet` silences the trailing hint but still records the suggestion, and a re-run adds nothing. `--json` records nothing.

Colour appears only on an interactive terminal. It is off under `--json`, `--quiet`, `--no-color`, `NO_COLOR`, `FORCE_COLOR=0`, `TERM=dumb`, or a pipe (`FORCE_COLOR=1|2|3` paints a pipe). The spinner needs the same terminal. It is also off under `CI`, `NO_COLOR`, `FORCE_COLOR=0`, and `ORANGU_NO_ANIMATION=1` (the last one stops the spinner, not the colour).

`file://` hyperlinks (OSC 8) appear on terminals known to render them. `FORCE_HYPERLINK=0|1` overrides that, and `NO_COLOR` leaves them alone. `--json` and `--quiet` output never carries an escape sequence. `--verbose` adds the cache diagnostic on stderr.

## Report and app

The file report and localhost app render the same session evidence:

- Overview: outcome narrative, named signals, and relevant findings.
- Timeline: turns, parent and subagent tool calls, actors, durations, and errors.
- Tools: calls, latency, failure states, and recurring error shapes.
- Agents: parent and subagent structure and activity.
- Context and tokens: context changes, compaction, cache behavior, and token composition.
- Coverage: parsed and unknown records plus usage reconciliation.
- Repo and Global: recurring patterns across supported sessions.
- Improvements: matching known changes, proposals, receipts, host commands, and scope-aware verification state.

The browser never starts an agent or marks a proposal applied. It only copies a command for explicit use in Claude Code or Codex.

## Beta feedback

Run `orangu feedback --context session|repo|global|report|app` or use the **Beta feedback** launcher in the localhost app. The standalone command does not discover a session or attach report data. Feedback stays in the browser until you review the exact title, body, and generic diagnostics and explicitly open GitHub's issue composer.

See [beta feedback](feedback.md) for the privacy boundary, consent flow, and oversized-report fallback.

## Shareable output

Reports and JSON scrub recognized secrets by default. Report, `analyze --json`, `evidence`, `repo`, and `global` output also omit arbitrary prompt and result text unless you ask for `--include-text`. That text is session titles, previews, tool-error text, and finding details built from commands.

Orangu shortens home paths to `~`, but other absolute paths may remain as useful evidence. Add `--strip-paths` to reduce them to basenames before sharing. `--no-redact` is only for a local inspection that you explicitly ask for.

`orangu evidence` is always redacted and does not accept `--no-redact`.

## Supported inputs and limits

Orangu currently parses supported Claude Code, Cowork, and Desktop session formats. It is not a generic JSONL reader and does not ingest Codex transcripts. Claude Code and Codex are both supported as hosts for the optional improvement skills.

Disk-backed parsing is fail-closed:

- Normal parse, cache, and live snapshots share a 256 MiB and 100,000-record session budget.
- Evidence and later verification use a stricter 64 MiB whole-session budget.
- One JSONL record may be at most 8 MiB.
- Sidecar discovery has limits on entry count, nesting depth, and metadata file size.
- Orangu rejects symlinks, replacement races, partial verification inputs, and over-limit inputs.

Current Analysis, SlimAnalysis, and Aggregate JSON inputs to `orangu evidence` are capped at 8 MiB. The projection validates at most 500 findings and 1,000 aggregate sessions, selects at most 50 findings, and emits at most 256 KiB.

Unknown records appear in Coverage. Orangu never treats them silently as supported.

## Improvement lifecycle

The optional skills use `orangu evidence` as their only transcript boundary:

```text
observe -> propose -> explicit apply -> later sessions vs baseline, beyond chance
```

- Session and repo scope support proposal, explicit application, and later same-workspace verification.
- `orangu suggest --effect <id>` shows the comparison read-only. Orangu picks up to 10 settled sessions before the change, without the ones that surfaced the finding, and up to 10 after it. Orangu grades each reviewed check with an exact rank test.
- A record becomes `verified` only when every directional check beats chance at p ≤ 0.05 and no guard moves the wrong way beyond chance. It also needs at least 3 sessions on each side. Otherwise it stays `applied` with a verdict such as `within-noise` or `not-enough-sessions`.
- Orangu names changes applied in the same workspace at overlapping times as confounders. To measure each effect, apply one change at a time.
- Global scope is proposal-only.

See [determinism and AI skills](DETERMINISM.md) and [data contracts](DATA-CONTRACTS.md) for the complete rules.
