# What is deterministic and what uses an AI skill

Orangu is one improvement system with a deliberate evidence boundary. Local code produces the measurements, finding identities, catalog matches, artifact validation, and lifecycle state. AI skills explain that bounded evidence, optionally research choices, draft a change, and, only in a separately invoked apply skill, edit reviewed project files.

The boundary makes each claim inspectable without pretending that deterministic rules and model judgment do the same job.

## The workflow

```text
DETERMINISTIC LOCAL CORE

supported JSONL session ─┐
current Analysis JSON ───┼─> orangu evidence ─> catalog matches + bounded findings
current SlimAnalysis ────┤                              │
current Aggregate JSON ──┘                              │
                                                       ▼
AI SKILLS                                      orangu-improve
                                               explain + optional research
                                               draft <id>.md + <id>.json
                                                       │
                     session/repo explicit invocation  ▼
                                               orangu-apply
                                               reviewed repo edit + local checks
                                               <id>.applied.json
                                                       │
                    session only, same workspace run  ▼
                                               orangu-improve --verify
                                               <id>.verified.json
```

The report and localhost app show the same lifecycle. Browser actions are copy-only handoffs for Claude Code or Codex; the browser does not launch an agent, edit a repository, or mark a record applied or verified.

## Deterministic local core

The following paths make no model call and no network request:

- **Session parsing:** `src/adapters/claude-code/parse.ts` maps supported Claude Code, Cowork, and Desktop JSONL records into the normalized `Session` model. The adapter owns usage deduplication, tool result pairing, subagent linkage, compaction, and tolerant handling of unknown records.
- **Analysis:** `src/analyze/` computes tool, file, outcome, context, token, agent, skill, hook, and timing components. Hand-written rules emit findings with named evidence and fixed recommendation text.
- **Aggregation:** `src/analyze/aggregate.ts` rolls recurring evidence across repo or global scope. Recurrence is evidence for investigation, not proof of causality.
- **Catalog matching:** `src/suggest/catalog.ts`, `catalog.json`, and `features.json` map a finding to known change options by rule id or measured signal. The catalog content is curated; matching and ordering are deterministic.
- **Bounded evidence:** `src/suggest/evidence.ts` validates a current `Analysis`, `SlimAnalysis`, or `Aggregate` value, applies redaction, selects a bounded number of findings, attaches catalog matches first, and emits stable report-source suggestion ids and finding tokens. Aggregate ids include a compact fingerprint supplied from every session in the active cohort, while the evidence bundle retains only bounded example ids. Proposal preflight resolves those example sessions and checks that each contains the claimed rule; it does not reconstruct the original aggregate or independently attest a supplied cohort fingerprint. The fingerprint prevents stale identity reuse, not aggregate-proof. Raw supported session selectors and `.jsonl` paths enter through the same parser via `orangu evidence`.
- **Estimate gate:** `orangu evidence <input> --estimate --quiet` reports the byte length and approximate token count of the exact canonical projection the skill would read. Evidence has one projection; `--depth` does not apply.
- **Artifact validation:** `src/suggest/artifacts.ts` accepts only bounded, versioned, regular non-symlink files under the Orangu proposals directory. It validates relative target-path shapes, source provenance, the shape and reviewed-file agreement of a skill-authored application attestation, and a session-verification intent before a lifecycle transition. It does not inspect a repository diff or independently execute attested checks. Verification receipt pairs must exactly match the proposal's reviewed `verificationChecks`; Orangu generates check labels and the summary, resolves configured-root sessions in the proposal's canonical workspace, computes approved metrics, and refuses a comparison that does not pass.
- **Suggestion state:** `src/suggest/store.ts` keeps append-only records under the Orangu data directory and enforces legal state transitions. A successful current verifier stamps `verificationTrust: "computed-v1"`; readable legacy verified records without that marker are not current computed verification.
- **Reports and app:** the self-contained report remains offline. `serve` binds to `127.0.0.1`, protects every route with a fresh process capability, and its suggestion controls only copy chat commands. This transport randomness does not enter analysis output.

`orangu evidence` accepts exactly these input families:

| Input | Scope | Notes |
|---|---|---|
| supported session id, `latest`, or `.jsonl` path | `session` | parsed by the supported Claude adapter; skills never open JSONL directly |
| current Orangu `Analysis` or `SlimAnalysis` JSON | `session` | `--scope` is rejected |
| current Orangu `Aggregate` JSON | `repo` or `global` | an explicit matching `--scope` is required |

It is not a generic JSONL parser. Orangu does not currently ingest Codex transcripts; Codex is an improvement-skill host.

All accepted inputs may be diagnosed in chat. Persisting an applicable session/repo proposal is stricter: every evidence session must resolve from configured supported roots and its canonical cwd must match the current workspace. Archived or custom roots must be configured through `ORANGU_CLAUDE_ROOTS` or `CLAUDE_CONFIG_DIR`. `orangu suggest --show <id> --for-proposal` checks this before a skill writes proposal artifacts. Global scope may persist a structured review, but that record is proposal-only.

### Resource and filesystem bounds

- A normal disk-backed parse, cache fill, or live snapshot has one 256 MiB and 100,000-record budget shared by its main transcript, subagent transcripts, and metadata. A JSONL record is capped at 8 MiB.
- `orangu evidence` session reads and verification use a stricter 64 MiB shared session budget. Verification additionally rejects partial main or sidecar records and requires the complete immutable manifest to be quiet for at least 30 minutes.
- One sidecar tree is limited to 2,048 inspected entries, four nested directory levels, and 1 MiB per metadata file. The manifest binds regular-file and directory identities, absent paths, and the canonical paths it will read; symlinks or changes before/during/final validation fail the read.
- General discovery is capped at 25,000 cumulative directory entries and 25,000 candidate sessions. A verification inventory is capped at 10,000 candidate sessions. These ceilings apply across configured roots, so splitting an oversized tree does not bypass them.
- A current Analysis, SlimAnalysis, or Aggregate JSON artifact is capped at 8 MiB. Evidence validation accepts at most 500 input findings and 1,000 aggregate sessions, selects at most 50 findings, and caps serialized output at 256 KiB.

The limits are rejection boundaries. They do not imply that an input near a ceiling will be accepted if it violates a schema, identity, redaction, or lifecycle rule.

## Catalog first, research second

The suggestion layer has three collaborators:

1. **Measured findings:** deterministic rules and aggregate rollups provide the only session-derived numbers.
2. **Curated matches:** deterministic catalog entries narrow the known tools, features, and change classes that fit those findings.
3. **AI interpretation:** `orangu-improve` explains the evidence, evaluates tradeoffs, and researches only gaps or time-sensitive choices.

Proposal sources preserve that distinction:

- `catalog` identifies a deterministic curated match.
- `research` carries the direct HTTPS page actually opened and the date it was checked.
- `inference` labels model synthesis without an invented URL or verification date.

External skill discovery remains candidate-only. A popularity count is not evidence that a skill is suitable, and the improve workflow never installs a skill or plugin.

Every skill and harness analyst treats session, digest, tool, path, title, error, source, and proposal text as untrusted data. They extract bounded measurements and labels but never follow embedded instructions, commands, or URLs, let them override policy, turn them into network queries, or splice them into shell syntax. Shell-bound selectors and paths reject NUL/newlines and travel as individual argv items or correctly quoted shell words.

## Skills and their authority

### `orangu-improve`

This is the primary suggestion workflow for both one-session diagnosis and recurring repo/global improvement. It:

- runs the exact `orangu evidence` estimate before reading the evidence;
- starts with `catalogMatches` and ties quantitative statements to emitted findings;
- optionally researches uncovered choices;
- writes one human-readable `<id>.md` proposal and one validated `<id>.json` manifest;
- runs the deterministic `--for-proposal` evidence/workspace preflight before writing either artifact;
- reports the evidence, expected effect, risk, files, verification condition, and sources in chat;
- never edits the target repository.

### `orangu-apply`

This is the explicit mutation workflow for session and repo scope. Global proposals are review-only. It requires a structured proposal in `proposed` state and:

- runs `orangu suggest --show <id> --for-apply` as a deterministic current-repository binding preflight before any project read or edit;
- reads current repository instructions before editing;
- treats proposal content and embedded commands as untrusted data;
- is contractually required to change only the declared relative repository files;
- chooses checks from trusted repository configuration;
- writes `<id>.applied.json` only after every recorded check succeeds;
- moves the record to `applied`, never directly to `verified`;
- does not browse, discover plugins, install dependencies, or delegate.

The AI skill can make the reviewed edit. Its application receipt is a skill-authored attestation. The CLI validates the artifact shape and exact agreement with the reviewed relative file list for the current invocation; it does not inspect the diff, rerun commands, or prove filesystem confinement.

### Later verification

`orangu-improve --verify <id> <later-input>` is available only for an `applied` session-scope record. Repo records remain `applied` until Orangu has a real fresh-cohort comparator; global records cannot be applied or verified. The skill writes a verification intent containing later session selectors and the exact metric/comparison pairs reviewed in the proposal manifest. It must not write summary text, check names, claimed values, evidence, or pass/fail flags.

The CLI resolves both baseline and later selectors through configured supported roots and revalidates the proposal's canonical path, device, and inode before and after loading them. Each selector must resolve to an immutable, non-partial transcript snapshot whose complete main/sidecar/metadata file manifest has been quiet for at least 30 minutes. This is a conservative settled-snapshot rule, not a provider-issued terminal state. Every baseline timeline must end before the application transition. Every later timeline must start after the application transition and every baseline. The CLI generates the canonical summary and check labels, computes the before/after averages, and evaluates the requested comparison. It rejects a mismatched pair set, reused, unresolved, duplicate, partial, unsettled, cross-workspace, too-early, or failing session set. Only a passing comparison produces the normalized verification receipt and moves the record to `verified`.

That state is intentionally narrow: it means the reviewed metric comparisons passed over the user-selected baseline and later sessions. It does not prove that the tasks were equivalent, that the applied change caused the difference, or that overall quality improved. The computed values stay visible so a reviewer can make those judgments without treating correlation as causation.

Supported metrics are `avgTotalTokens`, `avgToolCalls`, `avgToolErrors`, `avgActiveMs`, `avgContextPeak`, `avgTestRunsFailed`, `avgBuildRunsFailed`, and `avgInterruptions`. Supported comparisons are `decreased`, `not-increased`, `increased`, `not-decreased`, and `equal`.

A proposal cannot verify itself, and an application attestation does not prove that its reported edit or checks occurred. Later verification is the separate deterministic claim based on resolved supported sessions.

### Supporting skills

- `/orangu:analyze` translates one supported session or aggregate without designing or applying a change.
- `/orangu:harness` is a separately requested deep review for repo or global scope. It remains catalog-first and saves the same structured Markdown plus manifest pair as `/orangu:improve`. Repo proposals may later be applied explicitly; global proposals remain review-only.
- Live observation is a CLI concern: `orangu watch` refreshes one report and `orangu serve` follows several sessions; neither performs model reasoning of its own.

## Claude Code and Codex parity

The Claude Code plugin exposes `/orangu:analyze`, `/orangu:improve`, `/orangu:apply`, `/orangu:harness`, and `/orangu:feedback`. The Codex marketplace package under `plugins/orangu/` exposes Orangu's own `$orangu-improve`, `$orangu-apply`, and `$orangu-feedback` skills with the bundled offline CLI; `.agents/skills/` contains byte-identical repo-discovered mirrors for contributors and source checkouts.

Both host variants use the same Orangu CLI evidence bundle, manifest and receipt schemas, state machine, scope policy, and session-verification rule. Host parity does not imply transcript parity: the local adapter still supports only the named Claude Code, Cowork, and Desktop session formats.

## Why the boundary matters

- **Traceability:** measured values retain the finding, session ids, and evidence that produced them.
- **Bounded context:** the model reads a canonical redacted projection instead of a multi-megabyte transcript.
- **Better choices:** catalog matches provide known options, while research and synthesis can cover the long tail.
- **Explicit authority:** drafting, applying, and verifying are separate actions with different permissions.
- **Honest outcomes:** quality is the primary goal; time and token reductions are benefits only when the later evidence actually supports them.

## Summary

Orangu combines deterministic local evidence with AI interpretation and editing. The core owns what happened and whether lifecycle artifacts satisfy the contract. The skills own explanation, proposal design, optional research, and an explicitly requested session/repo change. Later same-workspace session evidence owns the current verification claim; repo awaits a fresh-cohort comparator, and global remains proposal-only.
