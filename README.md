<div align="center">

<img src="https://raw.githubusercontent.com/NissanOhana/orangu/main/design/brand/mascot-main-transparent.png" width="140" alt="orangu" />

# orangu

**Observe the session. Improve the next outcome.**

Local, offline, deterministic observability for Claude Code, Cowork, and Desktop sessions. Optional Claude Code skills turn the evidence into reviewable changes.

[sample report](https://nissanohana.github.io/orangu/sample.html) · [repo sample](https://nissanohana.github.io/orangu/sample-repo.html) · [docs](docs/README.md) · [npm](https://www.npmjs.com/package/orangu) · `npx orangu`

</div>

You run coding agents for hours. The transcript on disk is the only record of what they did, and nobody reads it. orangu does, and shows you:

| What the session does not tell you | What orangu shows |
|---|---|
| "compacted" | which turns filled the context window, and with what |
| a subagent's final answer | its full tree: tools, tokens, time, errors |
| that a skill or MCP server is installed | whether it ever fired, and what it weighs in context |
| nothing about repetition | the same file read again and again, and the same context re-read in every request |

One real number from one local session: 34.9M of the 37.0M tokens the model processed were cache reads. The model re-read one 223k-token context 156 times. Tokens are the only usage metric orangu has, because they are the only one the transcript records.

ccusage counts your token usage. orangu tells you what to change.

## Quick start

**Read-only.** orangu reads the session files already on your disk and writes one HTML file. It needs no SDK, proxy, account, instrumentation, upload, or telemetry. It can analyze your whole history from the minute you install it, not only new sessions.

```bash
npx orangu                 # report dashboard -> repo, global, or one session
npx orangu report          # latest session -> self-contained HTML report, opened in your browser
npx orangu pick            # choose a session (running ones first), Enter opens its report
npx orangu report current  # the session Claude Code is running you in; or -s <id> for any
npx orangu serve           # live loopback viewer over every local session
npx orangu repo            # recurring patterns across this repository's sessions
npx orangu global          # ... across every session on the machine
npx orangu harness         # what your config declares vs what your sessions used, in tokens
```

Use the arrow keys or `j`/`k` and Enter in the dashboard. In a pipe or CI, bare
`orangu` keeps the compact latest-session summary instead of waiting for input.

The repo and global choices open the same self-contained HTML report for a whole scope. From the
command line, `orangu repo --html <file>` writes it where you say. `--open` writes it to the temp
directory and hands it to your browser. `--json` stays a side-effect-free machine read.

orangu needs Node.js 20 or newer and no runtime dependency. The [usage guide](docs/USAGE.md) has more commands, inputs, and limits.

## The improve loop

1. **Observe.** orangu parses, redacts, counts, reconciles, matches, and ranks locally against 44 deterministic rules. It uses no model.
2. **See.** The report shows what happened: quality, time, and tokens as separate axes, with the evidence behind each finding.
3. **Propose.** `/orangu:improve` explains one finding's bounded evidence and drafts a structured proposal. It never edits your project.
4. **Apply, with a receipt.** `/orangu:apply` applies one explicitly reviewed proposal and records what changed and which checks ran.

Each proposal has one of nine change classes ([data contracts](docs/DATA-CONTRACTS.md)). They are instruction files, scripts and CLIs, hooks, skills to create, skills to discover, subagents and agents, MCP servers, plugins, and workflow and configuration.

When you ask, `/orangu:apply` applies a session or repo-wide change. orangu then checks it on later sessions from the same workspace. The change counts as verified only when those sessions beat the sessions before it beyond chance. `orangu suggest --effect <id>` shows the comparison.

Whole-harness (global) changes stay review-only. A proposal is not an application, and a later comparison is not causal proof. The full boundary is in [determinism and skill authority](docs/DETERMINISM.md).

## Skills

```text
/plugin marketplace add NissanOhana/orangu
/plugin install orangu
```

| Skill | What it does |
|---|---|
| `/orangu:analyze` | Explain what happened in one session, finished or still running, from local evidence. Open the report of the current session |
| `/orangu:improve` | Draft one reviewable proposal from a finding (`/orangu:improve latest`) |
| `/orangu:apply` | Apply one reviewed session or repo proposal and save the receipt |
| `/orangu:harness` | Review the whole harness: CLAUDE.md, skills, agents, hooks, MCP, in tokens |
| `/orangu:feedback` | Send reviewed beta feedback from a localhost form |

Skills read `orangu ... --json` and `orangu evidence`, never the raw `.jsonl`. Each skill shows a token estimate before a large read. The shipped instructions live in [`plugin/skills/`](plugin/skills/). Codex can also host the improvement skills: `codex plugin marketplace add NissanOhana/orangu` then `codex plugin add orangu@orangu` installs `$orangu-improve`, `$orangu-apply`, and `$orangu-feedback`. orangu does not ingest Codex transcripts.

## Not a wrapper

orangu is not a proxy, an SDK, a hook you install before the session, or a model that summarizes your transcript. It is a parser plus a rule set over the `.jsonl` files Claude Code already writes. Nothing runs during your session, nothing is sent anywhere, and the measurement never asks a model what it thinks.

## Design principles

- **No model in the measurement path.** Counting, reconciling, and ranking are plain code. Skills only interpret the result.
- **Zero network from reports.** Every report ships `default-src 'none'` and makes no request. `serve` binds to `127.0.0.1` and places every route behind a fresh process capability in its launched URL.
- **Redacted by default.** orangu scrubs secrets. It omits prompt text unless you ask with `--include-text`.
- **Same transcript in, byte-identical analysis out.** The analyzer uses no clock, no randomness, and no network.
- **Components, never a composite score.** Quality, time, and tokens stay separate. orangu never ranks people.
- **Tokens only.** orangu counts input, cache-read, cache-write, and output tokens. It never converts them into another unit.

## Where it sits

| | |
|---|---|
| Raw transcripts | Contain the record, but leave the reading and synthesis to you. |
| Usage counters (ccusage and friends) | Sum tokens across time and sources. |
| Instrumented trace platforms | Capture traces and evaluations from applications that you instrument. |
| orangu | Reads the transcript you already have, explains it, and turns findings into reviewed changes with receipts. |

## Privacy and support

- Redaction is on by default. Add `--strip-paths` before you share a report. Review every export first.
- orangu counts unknown transcript records and shows them in Coverage. They never crash the analysis.
- Feedback stays on localhost until you review the exact title and body and open GitHub's issue composer yourself.

Read the [privacy model](docs/PRIVACY.md), [supported limits](docs/USAGE.md#supported-inputs-and-limits), and [security policy](SECURITY.md) before sharing a report or JSON export. Are you an LLM? Read [llms.txt](https://nissanohana.github.io/orangu/llms.txt).

## Documentation

| Guide | Purpose |
|---|---|
| [Documentation index](docs/README.md) | All user, integration, design, and contributor references |
| [Usage](docs/USAGE.md) | CLI commands, app surfaces, inputs, and limits |
| [Determinism](docs/DETERMINISM.md) | Local evidence, AI-skill authority, and lifecycle rules |
| [Architecture](docs/ARCHITECTURE.md) | Pipeline, modules, build, and correctness gates |
| [Data contracts](docs/DATA-CONTRACTS.md) | Analysis, evidence, app, proposal, and receipt shapes |
| [Beta feedback](docs/feedback.md) | Localhost intake, exact-review consent, and GitHub handoff |
| [Contributing](CONTRIBUTING.md) | Development workflow and project layout |

## Develop

```bash
git clone https://github.com/NissanOhana/orangu && cd orangu
npm ci && npm run verify:release
```

## License

MIT © Nissan Ohana. The mascot is CC0.

<div align="center"><sub>orangu is not affiliated with Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic. Codex is a product of OpenAI.</sub></div>
