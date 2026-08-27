# Contributing to Orangu

Thanks for helping make agent sessions easier to inspect and improve.

## Principles

1. **Inspectable ownership.** Local code parses, redacts, counts, reconciles, matches, and ranks. Optional AI skills explain bounded evidence, draft proposals, and apply only after a separate explicit invocation.
2. **Offline reports.** Generated reports must make zero network requests and must retain their Content Security Policy.
3. **Private by default.** Never add a path that sends transcript content, evidence, paths, or proposal text to a remote service.
4. **Resilient parsing.** Unknown records are counted and surfaced in Coverage rather than crashing analysis.
5. **Honest evidence.** Keep measured values traceable, label estimates, and do not turn one later comparison into a causal or overall-quality claim.

## Repository layout

- `src/adapters/claude-code/`: supported transcript reader and adapter.
- `src/model/`: normalized session, public Analysis contract, and app payload types.
- `src/analyze/`: deterministic analysis rules and cross-session aggregation.
- `src/redact/`: default-on output redaction.
- `src/discover/` and `src/cache/`: bounded discovery, caching, and worker pool.
- `src/report/` and `src/serve/`: self-contained report and loopback app.
- `src/suggest/`: bounded evidence, catalog matching, lifecycle state, and artifact validation.
- `src/cli/`: command routing and output.
- `plugin/`: Claude Code plugin and bundled offline CLI.
- `.agents/skills/`: Codex improvement and application skills.
- `site/`: authored landing source (`index.src.html`, `llms.src.txt`), the generated `index.html`, `llms.txt`, `llms-full.txt`, `sample.html`, and `assets/` (the report screenshot).
- `docs/`: public user and technical documentation.

Read [the architecture](docs/ARCHITECTURE.md), [determinism boundary](docs/DETERMINISM.md), and [data contracts](docs/DATA-CONTRACTS.md) before changing a public surface.

## Development workflow

```bash
npm ci
npm run verify
npm run test:browser
```

- Add focused tests for every behavior change.
- Parser and analyzer tests use synthetic `SessionBuilder` fixtures, never real transcripts.
- `npm run verify:generated` checks the bundled client, plugin CLI, landing, and sample.
- `node scripts/assert-offline.mjs --file site/sample.html` checks the report network boundary.
- `node scripts/assert-offline.mjs --site` checks the landing's allowlisted network policy, including `llms.txt` and `llms-full.txt`.
- `node scripts/site-screenshot.mjs` regenerates `site/assets/report-overview.png` from a local session (developer-only, needs Playwright Chromium); paste the printed digest into `scripts/assert-public-tree.mjs` and read the image before committing.
- `npm run verify:public` rejects private working directories, personal paths or emails, internal process artifacts, and broken local documentation links in the tracked tree.
- Intentional analysis changes must regenerate `test/golden/` in the same commit and explain the expected diff.

Run `git diff --check` before opening a pull request.

## Adding an adapter

Map the new source into the normalized `Session` model in `src/model/session.ts`. Downstream analysis, reports, and CLI commands consume that model. Keep the adapter tolerant, bounded, and covered by synthetic fixtures for every supported record shape.

Do not advertise support until discovery, parsing, redaction, report, and malformed-input tests pass.

## Never commit

- Real session data or generated reports from real sessions.
- Credentials, local settings, `.npmrc`, or environment files.
- Personal paths, customer/project identifiers, private research, run notes, or agent-management prompts.
- Local proposal, suggestion, cache, or browser diagnostic data.

The tracked `.gitignore` blocks the common private working locations. Review `git status --ignored` before committing any new corpus or tooling output.
