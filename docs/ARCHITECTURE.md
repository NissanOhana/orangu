# orangu architecture

Orangu has a deterministic, adapter-shaped evidence core and an explicit skill boundary. The core never calls a model. Optional skills consume a bounded core projection to explain evidence and draft a proposal. Session and repo proposals may be applied only when separately invoked; global proposals are review-only. Deterministic later verification currently belongs only to session scope.

```
 .jsonl transcript ──▶ [reader] ──▶ raw records
                                      │
                                      ▼
                         [claude-code adapter] ──▶ Session (normalized model)
                                      │
                                      ▼
                              [analyzer + rules] ──▶ Analysis (public JSON, schemaVersion)
                                      │                       │
                            [cache ~/.orangu/cache/]          └──▶ orangu analyze --json (redacted, --slim)
                                      │
                          ┌───────────┼──────────────┬─────────────────────┐
                          ▼           ▼              ▼                     ▼
                     [catalog]   [redactor]      [renderer]        [serve 127.0.0.1 + SSE]
                          │                          │                     │
                          │                AppData embedded ──▶ one   ◀── AppData fetched live
                          │                self-contained     client      │
                          │                HTML report        bundle      └──▶ copy-only skill handoff
                          │
 current Analysis / SlimAnalysis / Aggregate JSON ─┐
 supported session selector or .jsonl path ────────┴──▶ [evidence projection]
                                                            │
                                                            ▼
                                                  bounded findings + catalog matches
                                                            │
                                    ┌───────────────────────┴──────────────────────┐
                                    ▼                                              ▼
                           [orangu-improve skill]                         [suggestion store]
                           proposal Markdown + manifest                  validated states
                                    │
                     session/repo explicit apply invocation
                                    ▼
                            [orangu-apply skill] ──▶ application attestation ──▶ applied state
                                                                                     │
                                                  session only: explicit later       │
                                                  [orangu-improve --verify] invocation
                                                                                     ▼
                                                     verification intent ──▶ [suggest verifier]
                                                                                     │
                                                  resolve same-workspace later evidence,
                                                  compute + persist verification receipt
```

The evidence projection accepts supported direct JSONL plus current Analysis, SlimAnalysis, and Aggregate artifacts for diagnosis. Persisting an applicable session/repo proposal adds a discovery/workspace gate: every evidence session must resolve from configured roots and share the current canonical cwd. Custom roots use `ORANGU_CLAUDE_ROOTS` or `CLAUDE_CONFIG_DIR`. Global scope may persist a structured review without gaining apply or verification authority.

## Modules

- **`src/adapters/claude-code/jsonl.ts`** — streaming, resilient JSONL reader. Never throws on a bad or partial line; supports byte-offset tailing for `watch`.
- **`src/adapters/claude-code/parse.ts`** — the adapter. Raw records → `Session`. Owns every schema quirk: usage dedupe by `message.id` (pick the `stop_reason` chunk), hidden `usage.iterations`, subagent linkage (sidecar files + inline sidechains), prompt classification, compaction metadata, attribution, attachment catalogue, `pr-link` dedupe. Tolerant by construction; counts what it can't parse.
- **`src/model/session.ts`** — the normalized `Session`. The one shape every adapter maps into and everything downstream reads. Add an adapter for another agent by mapping into this.
- **`src/model/analysis.ts`** — the `Analysis` contract = orangu's public API. `orangu analyze --json` emits exactly this. Bump `schemaVersion` on a breaking change.
- **`src/analyze/`** — the analyzer for tools, files, quality, context, tokens, agents, skills, hooks, and time; `insights.ts` owns the deterministic rule registry and `aggregate.ts` owns cross-session rollups. Components remain separate rather than becoming one score.
- **`src/models/`** — `catalog.json` stores display names, families, context windows, aliases, and sentinels; `catalog.ts` owns id normalization, alias and family fallback, and the `estimatedMatch` flag. Orangu reports the token values recorded by the source.
- **`src/redact/`** — default-on secret/PII scrubbing; optional text/path stripping.
- **`src/report/render.ts`** — assembles the HTML; embeds the analysis in a `<script type=application/json>` block with `<`/`</script>` escaped; inlines the CSS/JS bundle; sets a CSP that forbids all external origins.
- **`src/report/client/`** — the browser renderer (TypeScript → inlined IIFE by `scripts/build.mjs`). Hand-rolled SVG charts, URL-hash state, cross-filtering. No runtime dependencies. Built as **two bundles** from two esbuild entries: the file-mode bundle (`CLIENT_JS`, embedded in every report; ratcheted ≤ 70 KB by `offline.test.ts`, a ceiling that only shrinks) and the serve bundle (`CLIENT_JS_SERVE` via `serve-entry.ts`, same app + fetch/SSE data source and the `serveUi` injection seam) — so the single-file report provably contains no network-API text. Serve-only UI goes in the second bundle, never the first.
- **`src/cli/`** — `report / analyze / list / repo / global / watch / serve / evidence / estimate / suggest`; `--json` is redacted by default and `--slim` is available for legacy bounded consumers. `evidence` is the canonical skill seam. New verbs register in `src/cli/commands/` without touching `main.ts`.
- **`src/discover/`** — finds sessions across roots (incl. Cowork/Desktop); resolves a selector to a session.
- **`src/cache/`** — the analysis cache: `~/.orangu/cache/<schemaVersion>-<engineVersion>/<key>.json`, keyed by transcript path + size + mtime + sidecar stats. A miss is never an error; `--no-cache` / `ORANGU_NO_CACHE=1` bypass it. `pool.ts` is the worker pool behind repo/global scans (`--jobs`, default CPUs − 1).
- **`src/serve/`** — the loopback live server surface: `server.ts` (HTTP entry and per-process capability gate) + `api.ts` (JSON routes) · `registry.ts` (session discovery and live tail promotion) · `tail.ts` (byte-offset incremental transcript tailing) · `sse.ts` (the SSE push channel) · `kickoff.ts` (create or reuse the finding record and return a copy-only Claude Code or Codex handoff) · `export.ts` (self-contained file-mode export) · `types.ts` (serve contracts) · `badge.ts` (mtime-derived liveness) · `routes-extra.ts` (route registration). Serve binds `127.0.0.1`, requires the capability URL before every route, never launches an agent from the browser, and never exposes raw transcript text unless `--include-text`.
- **`src/suggest/`** — the deterministic improvement backend. `types.ts` owns the `SuggestionRecord` state machine and proposal/application/verification receipt shapes. `id.ts` creates stable `sg_…` identities and binds aggregate findings to a compact fingerprint of the complete repo/global session cohort. `store.ts` serializes append-only records in `~/.orangu/suggestions.jsonl`. `catalog.ts`, `catalog.json`, and `features.json` provide offline catalog-first matches. `evidence.ts` validates current Orangu artifacts, projects bounded redacted findings, orders catalog matches first, and emits canonical finding tokens. `artifacts.ts` validates versioned proposals plus the shape and reviewed-file agreement of skill-authored application attestations; it does not inspect repository diffs or execute checks. Session verification requires receipt pairs to match reviewed manifest pairs exactly, revalidates the proposal's canonical path/device/inode before and after loading, accepts only immutable non-partial baseline/later transcript snapshots whose full file manifests have been quiet for at least 30 minutes, requires the baseline timeline to end before application and the later timeline to start afterward, generates labels and summaries, computes approved averages, and accepts only passing comparisons. The quiet gate is a settled-snapshot heuristic, not provider-issued completion. Repo records have no fresh-cohort comparator yet; global records are proposal-only. `slim.ts` and `estimate.ts` remain for existing analysis and copy handoffs. `docs/DETERMINISM.md` defines the ownership boundary.
- **`plugin/skills/improve/` and `plugin/skills/apply/`** — the Claude Code `/orangu:improve` draft and explicit `/orangu:apply` application workflows. Supporting `/orangu:analyze`, `/orangu:harness`, and privacy-bounded `/orangu:feedback` skills remain separate; live observation (`orangu watch`, `orangu serve`) is CLI-only.
- **`plugins/orangu/`** — the installable Codex plugin. It bundles Orangu's own `$orangu-improve`, `$orangu-apply`, and `$orangu-feedback` skills, the offline CLI, and product branding. It uses the same evidence, artifact, scope, application, session-verification, and feedback privacy contracts as the Claude plugin and does not add a Codex transcript adapter. `.agents/plugins/marketplace.json` publishes the repository-local marketplace entry.
- **`.agents/skills/orangu-improve/`, `.agents/skills/orangu-apply/`, and `.agents/skills/orangu-feedback/`** — byte-identical repo-discovered mirrors of the Codex plugin skills for contributors and source checkouts. Both mirrors are generated by `scripts/build.mjs` from `plugin/skills/` (names become `orangu-<name>`, the Claude CLI fallback becomes the Codex one, `allowed-tools` is dropped); only `plugin/codex/<name>/openai.yaml` is hand-written.
- **`src/model/app-data.ts`** — `AppData` v1: the one payload shape the app client consumes — embedded in the report HTML in file mode, fetched (+ SSE-updated) from `serve` in live mode. Capabilities flags tell the client which features exist in each mode.
- **`src/util/home.ts`** — resolves the orangu home (`$ORANGU_HOME` → `$XDG_DATA_HOME/orangu` → `~/.orangu`); every on-disk store above goes through it.

## Build

`scripts/build.mjs` uses esbuild to (1) bundle the report client into a TS string module (client CSS = `src/report/client/tokens.css` + `styles.css`), (2) bundle the CLI to `dist/orangu.js`, (3) bundle the Claude plugin's offline CLI to `plugin/bin/`, and (4) copy that same CLI plus canonical brand assets into `plugins/orangu/`. Zero runtime dependencies ship; esbuild/vitest/typescript are dev-only.

## Correctness gates

- `npm run verify` checks generated artifacts, strict TypeScript, the synthetic test suite, the build, and the CLI version.
- `npm run test:browser` covers the landing, sample, report, and localhost app across supported viewports and themes.
- `node scripts/assert-offline.mjs --file site/sample.html` validates the generated report's zero-network policy and CSP.
- `node scripts/assert-offline.mjs --site` validates the landing's allowlisted public origins.
- `npm run verify:public` checks the tracked publication boundary, private-data markers, and local documentation links.
- Focused evidence, lifecycle, and host-parity tests pin the contracts under `src/suggest/`, `src/cli/commands/`, and `plugin/`.
