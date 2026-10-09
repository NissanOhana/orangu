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
| `orangu harness` | Compare declared harness configuration with observed use, and show the rules that did not hold |
| `orangu suggest` | Inspect and transition validated suggestion records |
| `orangu ste <file...\|->` | Check prose (Markdown, a draft or an HTML page of prose) against the STE writing rules and print each finding. It has no pass mark. Terminal output and the layout of a report can give false findings. For terminal output, add `--lines` |
| `orangu show-me [selector]` | Write the data of a slide deck and a written report (`--scope repo\|global`). `--render <dir>` fills both offline HTML files |

A session selector is `latest`, a session id or unique prefix, a supported `.jsonl` path, or `current`. `current` is the session that Claude Code runs orangu from, resolved from the Claude Code environment. If orangu guesses it from the cwd, it says so on stderr. `--quiet` hides that line. `--json` also hides it on `report`, `analyze`, `watch`, `estimate` and `show-me`. Outside Claude Code, `current` is an error.

`report`, `analyze`, `watch`, and `estimate` also take the selector as `--session <selector>` (`-s`). If the positional selector and the flag differ, that is an error.

On an interactive terminal, bare `orangu` draws the orange ASCII mascot and a keyboard dashboard. The first choices open the current-repository aggregate, the global aggregate, or the full session picker. Below them, each open Claude Code session is a direct report shortcut. Move with the arrow keys or `j`/`k`, choose with Enter, and cancel with `q`, Esc, or Ctrl-C. These keep bare `orangu` on the latest-session brief, which never waits for input:

- a pipe, `CI`, `TERM=dumb`, or `ORANGU_NO_ANIMATION=1`
- `--plain` or `--quiet`
- `--session`, `--global`, `--cwd`, `--max-tokens`, or `--fail-on-hook-errors`

`orangu repo` and `orangu global` print their answer to stdout. `--html <file>` also writes that scope as one self-contained HTML report. `--open` writes it into the temp directory as `orangu-<scope>-<hash>.html` and hands it to your browser. So a re-run of `--open` never overwrites a file that a browser still has open. The dashboard's repository and global choices ask for `--open`, and `--no-open` suppresses it.

Orangu refuses `--html` and `--open` with `--json`, which is a machine read with no side effect. `--out <file>` still writes the aggregate JSON. The written file is private (mode `0600`), redacted by default, and passes the same zero-network gate as the session report. `--jobs <n>` sets the worker threads of a scan over many sessions: by default the CPU count minus 1, and never more than the CPU count.

`orangu pick` lists sessions, running ones first (title, project, age, size). Move with the arrow keys, `j`/`k`, or a digit. Enter opens the chosen report, and `q`, Esc, or Ctrl-C cancels and restores the terminal. Without a terminal, in CI, or with `--plain`, it prints a numbered list and the `orangu report <id>` hint. `--json` prints the array (`[]` on an empty home, still with exit code 1, because the chooser had nothing to choose).

Use `orangu --help` for flags and output controls.

### Rules that did not hold

A line in CLAUDE.md or in memory can be missed. A hook cannot. `orangu harness` shows where a line did not hold:

- **Broken rules:** a "do not" line that names a command, a tool or an MCP server, and the calls after a session loaded it. A call that a hook or a deny rule stopped is blocked.
- **Feedback notes:** a note saved after a complaint, and the later complaints with its rare words.
- **Memory index:** Claude Code loads the first 200 lines or 25,000 characters of `MEMORY.md`. The row shows the lines past it and the sessions that lost them.
- **Recurring complaints:** words that come back in complaints across sessions.

Without `--include-text`, a row has no text: no rule line, no shared word, no complaint. `/orangu:harness` turns each row into a hook or a deny rule, never another line.

### Terminal output

`orangu report` writes only the report path to stdout, so `orangu report | xargs open` works. Its summary goes to stderr: the check line, the path, the top finding, and the next command. `orangu analyze` prints the measurement block on stdout and the same footer on stderr. The bare interactive dashboard and the non-interactive latest-session brief both use stdout.

The next command is the short `claude "/orangu:improve sg_…"`. For it to work, `report`, `analyze`, and the non-interactive bare-session brief record the top finding's suggestion under `~/.orangu`. Only when orangu cannot write that store does the long `--finding` form appear, with a line that says so. `--quiet` silences the trailing hint but still records the suggestion, and a re-run adds nothing. `--json` records nothing.

The title of the top finding wraps under itself. An `Improvement:` line under it names the change, above `next`. `orangu repo` and `orangu global` print the same line under each recurring finding. One caption says that each title shows the figures of one example session.

Prose wraps at whole words and is never cut: at the terminal width below 80 columns, and at 80 columns above it. Only a word longer than the line breaks inside it. Only one-line cells cut: at their last whole word, or inside a word with no space, such as a project name. They are the header, the store note, the `list` and `pick` cells, the heaviest-session titles, the dashboard and the spinner.

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
- Improvements: matching known improvements, proposals, receipts, host commands, and scope-aware verification state.

## Beta feedback

Run `orangu feedback --context session|repo|global|report|app` or use the **Beta feedback** launcher in the localhost app. The standalone command does not discover a session or attach report data. Feedback stays in the browser until you review the exact title, body, and generic diagnostics and explicitly open GitHub's issue composer.

See [beta feedback](feedback.md) for the privacy boundary, consent flow, and oversized-report fallback.

## Shareable output

Reports and JSON scrub recognized secrets by default. Report, `analyze --json`, `evidence`, `repo`, and `global` output also omit arbitrary prompt and result text unless you ask for `--include-text`. That text includes session titles, previews, tool-error text, and finding details built from commands. `--include-text` keeps all of it, with secrets still scrubbed.

Orangu shortens home paths to `~`, but other absolute paths may remain as useful evidence. Add `--strip-paths` to reduce them to basenames before sharing. `--no-redact` is only for a local inspection that you explicitly ask for.

`orangu evidence` is always redacted and does not accept `--no-redact`.

Inside Claude Code, `--no-redact` or `--include-text` with `-o`, `--out` or `--html <file>` needs `ORANGU_ALLOW_RAW=1` before the command, so that Claude Code asks you first. Orangu reads the `CLAUDECODE` variable. The terminal of an IDE with Claude Code can also set it, so a command that you type there needs the same prefix.

If `-o`, `--out` or `--html` names an existing file, orangu replaces it only when the file starts with the orangu output marker. For any other file, a symlink, a hard link or an empty file, orangu changes nothing and exits with code 1.

## Supported inputs and limits

Orangu currently parses supported Claude Code, Cowork, and Desktop session formats. It is not a generic JSONL reader and does not ingest Codex transcripts. Claude Code and Codex are both supported as hosts for the optional improvement skills.

Disk-backed parsing is fail-closed. Orangu rejects symlinks, replacement races, partial verification inputs, and over-limit inputs. [Resource and filesystem bounds](DETERMINISM.md#resource-and-filesystem-bounds) gives each limit.

Unknown records appear in Coverage. Orangu never treats them silently as supported.

## Improvement lifecycle

The optional skills use `orangu evidence` as their only transcript boundary:

```text
observe -> propose -> explicit apply -> later sessions vs baseline, beyond chance
```

- Session and repo scope support proposal, explicit application, and later same-workspace verification. `orangu suggest --effect <id>` shows the comparison read-only.
- Global scope is proposal-only.

See [determinism and AI skills](DETERMINISM.md) and [data contracts](DATA-CONTRACTS.md) for the complete rules.
