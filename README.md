<div align="center">

<img src="https://raw.githubusercontent.com/NissanOhana/orangu/main/design/brand/mascot-main-transparent.png" width="140" alt="orangu" />

# orangu

**Observe the run. Improve the next outcome.**

Local observability for supported Claude Code, Cowork, and Desktop sessions, with optional Claude Code and Codex skills that turn bounded evidence into reviewable changes.

[See the sample](https://nissanohana.github.io/orangu/sample.html) · [Read the docs](docs/README.md) · [Contribute](CONTRIBUTING.md)

</div>

## What Orangu does

- **Observe one session.** Inspect turns, tool calls, subagents, errors, context, time, tokens, and available outcome evidence in one local report.
- **Improve repeated work.** Find recurring repo or global patterns, then review suggestions for instructions, scripts, hooks, skills, agents, MCP servers, plugins, or workflow configuration.

Session scope is diagnostic. Repo and global scopes reveal recurring patterns that may justify a larger change.

## Quick start

```bash
# inspect the latest supported session and open its report
npx orangu report

# follow local sessions in the browser
npx orangu serve

# inspect recurring patterns
npx orangu repo
npx orangu global
```

Orangu reads supported session files already on your machine. It does not require an SDK, proxy, account, instrumentation, upload, or telemetry.

More commands and input formats are in the [usage guide](docs/USAGE.md).

## From evidence to a change

1. Orangu parses, redacts, counts, reconciles, matches, and ranks locally.
2. `orangu-improve` explains the bounded evidence and drafts a structured proposal. It does not edit the target project.
3. `orangu-apply` applies one explicitly reviewed session or repo proposal and records what changed and which checks ran.
4. Session-scope changes can later be compared with a settled supported session from the same workspace. Repo changes remain applied until a fresh-cohort comparator exists; global proposals are review-only.

A proposal is not an application, and a later comparison is not causal proof. See [determinism and skill authority](docs/DETERMINISM.md) for the complete boundary.

## Improvement skills

### Claude Code

```text
/plugin marketplace add NissanOhana/orangu
/plugin install orangu

/orangu:improve latest
/orangu:apply sg_0123456789ab
/orangu:improve --verify sg_0123456789ab later-session-id
```

### Codex

Copy `.agents/skills/orangu-improve` and `.agents/skills/orangu-apply` into the target repository's `.agents/skills/` directory, put `orangu` on `PATH`, then run:

```text
$orangu-improve latest
$orangu-apply sg_0123456789ab
$orangu-improve --verify sg_0123456789ab later-session-id
```

Both hosts use the same evidence and artifact contracts. Codex is an improvement-skill host; Orangu does not currently ingest Codex transcripts.

## Privacy and support

- Generated reports are self-contained and use a zero-network Content Security Policy.
- Redaction is on by default. Prompt and result text are omitted unless explicitly requested.
- `orangu serve` binds to `127.0.0.1`; browser actions copy commands and never launch an agent.
- Optional skill research uses generic feature terms only and never sends local evidence, paths, project names, prompts, or proposal text in queries.
- Unknown transcript records are counted and shown in Coverage instead of crashing the analysis.

Read the [privacy model](docs/PRIVACY.md), [supported limits](docs/USAGE.md#supported-inputs-and-limits), and [security policy](SECURITY.md) before sharing a report or JSON export.

## Documentation

| Guide | Purpose |
|---|---|
| [Documentation index](docs/README.md) | All user, integration, design, and contributor references |
| [Usage](docs/USAGE.md) | CLI commands, app surfaces, inputs, and limits |
| [Determinism](docs/DETERMINISM.md) | Local evidence, AI-skill authority, and lifecycle rules |
| [Architecture](docs/ARCHITECTURE.md) | Pipeline, modules, build, and correctness gates |
| [Data contracts](docs/DATA-CONTRACTS.md) | Analysis, evidence, app, proposal, and receipt shapes |
| [Design system](docs/DESIGN.md) | Visual tokens, interaction rules, and accessibility |
| [Contributing](CONTRIBUTING.md) | Development workflow and project layout |

## Develop

```bash
git clone https://github.com/NissanOhana/orangu
cd orangu
npm ci
npm run verify:release
```

Orangu requires Node.js 20 or newer. The shipped CLI has no runtime dependencies.

## License

MIT © Nissan Ohana. The mascot is CC0.

<div align="center"><sub>orangu is not affiliated with Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic. Codex is a product of OpenAI.</sub></div>
