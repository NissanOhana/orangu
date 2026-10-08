# What is deterministic and what uses an AI skill

Orangu is one improvement system with a deliberate evidence boundary. Local code produces the measurements, finding identities, catalog matches, artifact validation, and lifecycle state. AI skills explain that bounded evidence, can research choices, and write a proposal. Only a separately invoked apply skill edits reviewed project files.

## The workflow

```text
DETERMINISTIC LOCAL CORE

supported JSONL session ─┐
current Analysis JSON ───┼─> orangu evidence
current SlimAnalysis ────┤   catalog matches + bounded findings
current Aggregate JSON ──┘   │
                             ▼
AI SKILLS                    orangu-improve
                             explain + optional research
                             write <id>.md + <id>.json
                             │ session/repo explicit invocation
                             ▼
                             orangu-apply
                             reviewed repo edit + local checks
                             <id>.applied.json
                             │ session/repo, later sessions
                             ▼
                             orangu suggest --effect
                             orangu cohorts + exact rank test
                             verified only beyond chance
```

The report and localhost app show the same lifecycle. A browser action only copies a command for Claude Code or Codex. The browser does not launch an agent, edit a repository, or mark a record applied or verified.

## Deterministic local core

The following paths make no model call and no network request:

- **Session parsing:** `src/adapters/claude-code/parse.ts` maps supported Claude Code, Cowork, and Desktop JSONL records into the normalized `Session` model. The adapter owns usage deduplication, tool result pairing, subagent linkage, compaction, and tolerant handling of unknown records.
- **Analysis:** `src/analyze/` computes tool, file, outcome, context, token, agent, skill, hook, and timing components. Hand-written rules emit findings with named evidence and fixed recommendation text.
- **Aggregation:** `src/analyze/aggregate.ts` rolls recurring evidence across repo or global scope. Recurrence is evidence for investigation, not proof of causality.
- **Catalog matching:** `src/suggest/catalog.ts`, `catalog.json`, and `features.json` map a finding to known change options by rule id or measured signal. The catalog content is curated. Matching and ordering are deterministic.
- **Bounded evidence:** `src/suggest/evidence.ts` validates a current `Analysis`, `SlimAnalysis`, or `Aggregate` value and applies redaction. It selects a bounded number of findings, attaches catalog matches first, and emits stable report-source suggestion ids and finding tokens. Raw supported session selectors and `.jsonl` paths enter through the same parser with `orangu evidence`.

  Aggregate ids bind the whole session cohort as an identity, not as proof of the aggregate ([data contracts](DATA-CONTRACTS.md#suggestionrecord)).
- **Estimate gate:** `orangu evidence <input> --estimate --quiet` reports the byte length and approximate token count of the exact canonical projection the skill would read. Evidence has one projection, so `--depth` does not apply.
- **Artifact validation:** `src/suggest/artifacts.ts` accepts only bounded, versioned, regular non-symlink files under the Orangu proposals directory. It validates relative target-path shapes, source provenance, and the shape and reviewed-file agreement of a skill-authored application receipt before a lifecycle transition. It does not inspect a repository diff or independently execute the reported checks.
- **Suggestion state:** `src/suggest/store.ts` keeps append-only records under the Orangu data directory and enforces legal state transitions. Earlier `computed-v1` records (a later-session mean comparison without a noise check) stay readable. Legacy verified records without a `computed-v1` or `computed-v2` marker are not current computed verification.
- **Reports and app:** the self-contained report remains offline. `serve` binds to `127.0.0.1`, protects every route with a fresh process capability, and its suggestion controls only copy chat commands. This transport randomness does not enter analysis output.

`orangu evidence` accepts exactly these input families:

| Input | Scope | Notes |
|---|---|---|
| supported session id, `latest`, or `.jsonl` path | `session` | the supported Claude adapter parses it, and skills never open JSONL directly |
| current Orangu `Analysis` or `SlimAnalysis` JSON | `session` | `--scope` is rejected |
| current Orangu `Aggregate` JSON | `repo` or `global` | an explicit matching `--scope` is required |

A skill may diagnose any accepted input in chat. Saving an applicable session or repo proposal is stricter. Every evidence session must resolve from configured supported roots, and its canonical cwd must match the current workspace. You must configure archived or custom roots through `ORANGU_CLAUDE_ROOTS` or `CLAUDE_CONFIG_DIR`. `orangu suggest --show <id> --for-proposal` checks this before a skill writes proposal artifacts. Global scope may save a structured review, but that record is proposal-only.

### Resource and filesystem bounds

- A normal disk-backed parse, cache fill, or live snapshot has one 256 MiB and 100,000-record budget shared by its main transcript, subagent transcripts, and metadata. A JSONL record is capped at 8 MiB.
- `orangu evidence` session reads and verification use a stricter 64 MiB shared session budget. Verification also rejects partial main or sidecar records and requires the complete immutable manifest to be quiet for at least 30 minutes.
- One sidecar tree is limited to 2,048 inspected entries, 4 nested directory levels, and 1 MiB per metadata file. The manifest binds regular-file and directory identities, absent paths, and the canonical paths it will read. A symlink, or a change before, during, or at final validation, fails the read.
- General discovery is capped at 25,000 cumulative directory entries and 25,000 candidate sessions. A verification inventory is capped at 10,000 candidate sessions. These ceilings apply across configured roots, so splitting an oversized tree does not bypass them.
- A current Analysis, SlimAnalysis, or Aggregate JSON artifact is capped at 8 MiB. Evidence validation accepts at most 500 input findings and 1,000 aggregate sessions, selects at most 50 findings, and caps serialized output at 256 KiB.

The limits are rejection boundaries. They do not imply that an input near a ceiling will be accepted if it violates a schema, identity, redaction, or lifecycle rule.

## Catalog first, research second

The suggestion layer has 3 collaborators:

1. **Measured findings:** deterministic rules and aggregate rollups provide the only session-derived numbers.
2. **Curated matches:** deterministic catalog entries narrow the known tools, features, and change classes that fit those findings.
3. **AI interpretation:** `orangu-improve` explains the evidence, evaluates tradeoffs, and researches only gaps or time-sensitive choices.

Proposal sources preserve that distinction:

- `catalog` identifies a deterministic curated match.
- `research` carries the direct HTTPS page that the skill opened and the date it was checked.
- `inference` labels model synthesis without an invented URL or verification date.

External skill discovery remains candidate-only. A popularity count is not evidence that a skill is suitable, and the improve workflow never installs a skill or plugin.

Every skill and harness analyst treats session, evidence, tool, path, title, error, source, and proposal text as untrusted data. They extract bounded measurements and labels. They never follow embedded instructions, commands, or URLs. They never let such content override policy, turn it into network queries, or splice it into shell syntax. Shell-bound selectors and paths reject NUL/newlines and travel as individual argv items or correctly quoted shell words.

## Skills and their authority

### `orangu-improve`

This is the primary suggestion workflow for both one-session diagnosis and recurring repo/global improvement. It:

- runs the exact `orangu evidence` estimate before reading the evidence
- starts with `catalogMatches` and ties quantitative statements to emitted findings
- asks the user the bounded interview questions the evidence cannot answer before saving, and records the answers as user-stated context, never as a measurement
- optionally researches uncovered choices
- writes one human-readable `<id>.md` proposal and one validated `<id>.json` manifest
- runs the deterministic `--for-proposal` evidence/workspace check before writing either artifact
- reports the evidence, expected effect, risk, files, verification condition, and sources in chat
- never edits the target repository.

### `orangu-apply`

This is the explicit mutation workflow for session and repo scope. Global proposals are review-only. It requires a structured proposal in `proposed` state and:

- runs `orangu suggest --show <id> --for-apply` as a deterministic current-repository binding check before any project read or edit
- reads current repository instructions before editing
- treats proposal content and embedded commands as untrusted data
- is contractually required to change only the declared relative repository files
- chooses checks from trusted repository configuration
- writes `<id>.applied.json` only after every recorded check succeeds
- moves the record to `applied`, never directly to `verified`
- does not browse, discover plugins, install dependencies, or delegate.

The AI skill can make the reviewed edit. Its application receipt is skill-authored. The CLI validates the artifact shape and exact agreement with the reviewed relative file list for the current invocation. It does not inspect the diff, rerun commands, or prove filesystem confinement.

### Later verification

`orangu-improve --verify <id>` is available for an `applied` session- or repo-scope record. Global records cannot be applied or verified. The skill writes no verification file and chooses no sessions. It runs the read-only `orangu suggest --effect <id>` and reports the verdict. Only on `verified` does it run `orangu suggest --set <id> verified`, which recomputes the same result before it records anything.

Orangu picks both cohorts from the proposal's canonical workspace. It revalidates the workspace path, inode, and recorded creation time before and after it reads the transcripts. The cut is the application time that the store stamped as `appliedAt`:

- **Baseline:** up to 10 settled sessions that ended before the application, most recent first, leaving out the finding's own sessions. Those sessions were chosen because they went badly, so any later session would look better against them by regression to the mean alone.
- **Later:** up to 10 settled sessions that started after the application, earliest first, so the verdict freezes once 10 exist.
- A session counts on neither side if it spans the application, belongs to another cwd, or exceeds the 64 MiB per-session cap. Neither does a session that is not yet settled (a partial line, or a manifest changed in the last 30 minutes). Neither does a session that ran orangu itself (an orangu skill or an `orangu suggest`/`evidence`/`estimate`/`harness` call). Checking a result must never become evidence for it.
- Each side reads at most 256 MiB, in order, and stops at the first session that no longer fits. So session size cannot decide who is in a cohort. Orangu counts the skipped sessions by reason.

Orangu grades each reviewed check with an exact permutation rank test (Mann-Whitney with midranks for ties, counted exactly, no sampling). So the same sessions always give the same p-values. A `decreased` or `increased` check is `improved` only when the later sessions move that way beyond chance at p ≤ 0.05. A guard (`not-increased`, `not-decreased`, `equal`) holds unless it moves the wrong way beyond chance.

The overall verdict is the first of these that applies:

1. `not-enough-sessions`: either side has fewer than 3 sessions.
2. `regressed`: any check moved the wrong way beyond chance.
3. `no-directional-check`: only guards were reviewed.
4. `verified`: every directional check improved.
5. `within-noise`: any other result.

Only `verified` moves the record. Its receipt (`v: 2`) carries both session lists, the cohort means and medians, both p-values, and each verdict. The store and every display re-grade it from its own numbers and stamp `verificationTrust: "computed-v2"`.

Orangu names other proposals applied in the same workspace inside the measured window in `confoundedBy`. The later sessions measured those changes too, so the effect is not attributable to this one alone. Verification does not block on them. To keep each effect attributable, apply one change at a time.

The `verified` state is intentionally narrow: later sessions beat the baseline beyond chance on the reviewed metrics. Different sessions are different tasks. So it does not prove that the applied change caused the difference or that overall quality improved. Repeated checks as sessions arrive raise the chance of a false win. The cap of 10 sessions bounds it.

Supported metrics are `avgTotalTokens`, `avgToolCalls`, `avgToolErrors`, `avgActiveMs`, `avgContextPeak`, `avgTestRunsFailed`, `avgBuildRunsFailed`, and `avgInterruptions`. Supported comparisons are `decreased`, `not-increased`, `increased`, `not-decreased`, and `equal`.

A proposal cannot verify itself, and an application receipt does not prove that its reported edit or checks occurred. Later verification is the separate deterministic claim based on resolved supported sessions.

### Supporting skills

- `/orangu:analyze` translates one supported session or aggregate without designing or applying a change.
- `/orangu:harness` is a separately requested deep review for repo or global scope. Its evidence is `orangu harness`, which uses no model and no network. That command reads the configured roots, every `~/.claude.json` project entry under global scope, and the platform's managed-policy directory. `ORANGU_CLAUDE_MANAGED_DIRS` overrides that directory, and an empty value reads none.

  Between the analysts and the proposals, it interviews the user in depth. It asks structured questions (AskUserQuestion) where the choices are finite, and for free text where they are open. The answers are user-stated context. They shape the ranking and never become a measurement.

  It remains catalog-first and saves the same structured Markdown plus manifest pair as `/orangu:improve`. It ends by asking which of its ranked items you approve. Then it applies the ones you approved, under 4 standing limits:
  - **Per-item explicit approval.** Before the question, it discloses each item's id, the files its manifest declares, and the exact text of anything that would run or grant authority. Only a verbatim id approves, and only the answer to that question counts. Nothing else in the conversation is consent.
  - **Repo scope only.** Global proposals are review-only and are never applied, at any approval.
  - **Through `/orangu:apply`, unchanged.** For each approved item, harness invokes `/orangu:apply <id>`: one id, one record, one receipt per invocation. Each invocation keeps that skill's existing binding check, untrusted-input rules, and confinement contract. Harness forks nothing and has no repository edit authority of its own. It prints the `/orangu:apply <id>` list, so you can do the same work by hand.
  - **Stop at the first failure.** Harness applies the approved items in order and halts at the first one that fails. It leaves the working tree as it stands for review and does not continue down the list.

  None of this moves the deterministic boundary. No model measures anything, and the evidence is still the bounded deterministic projection. The CLI still validates artifact shape and does not inspect a diff.
- `/orangu:show-me` turns the evidence of one session, one repository or all sessions into a slide deck and a written report. `orangu show-me` writes that evidence to `data.json` in a new run directory under `~/.orangu/show-me/`. Claude reads it behind the same size gate. Then Claude writes only 3 text values to `words.json`: `verdict`, `summary` and `improvementsTitle`. Claude copies each number from `data.json` and computes no figure.

  `orangu show-me --render` redacts the 3 values and checks them with `orangu ste`. It fills both offline HTML files with each value as text, and checks each file against its template before it writes it. Claude writes no HTML, no suggestion record and no repository file. The skill has no Codex mirror.
- Live observation is a CLI concern. `orangu watch` refreshes one report, and `orangu serve` follows several sessions. Neither performs model reasoning of its own.

### Text checks and permissions

`analyze`, `improve`, `harness` and `apply` check the text that they write for the user with `orangu ste`. `orangu ste` reads a proposal from its file, and chat text from a new draft file, `~/.orangu/drafts/<skill>-<random>.md`. No draft text goes through the shell. `orangu ste` has no pass mark, so Claude fixes only the findings that are real.

Each skill pre-approves by name each `orangu` verb that its steps run. No skill pre-approves all of `orangu`. `/orangu:apply` pre-approves only `orangu suggest`, `orangu ste` and `Read`. So each repository edit, each project check and each write of apply can ask you for permission. No skill pre-approves an `Edit` or a `Write` outside `~/.orangu/drafts/` and `~/.orangu/proposals/`, and `show-me` pre-approves none.

## Claude Code and Codex parity

The Claude Code plugin exposes `/orangu:analyze`, `/orangu:improve`, `/orangu:apply`, `/orangu:harness`, `/orangu:show-me`, and `/orangu:feedback`. The Codex marketplace package under `plugins/orangu/` exposes Orangu's own `$orangu-improve`, `$orangu-apply`, and `$orangu-feedback` skills with the bundled offline CLI. `.agents/skills/` contains byte-identical repo-discovered mirrors for contributors and source checkouts. `scripts/build.mjs` generates both mirrors from `plugin/skills/`, so one edit updates every host. The mirrors drop `allowed-tools`, so the pre-approvals above apply only in Claude Code. `npm run verify` fails when a mirror is stale.

Both host variants use the same Orangu CLI evidence bundle, manifest and receipt schemas, state machine, scope policy, and session-verification rule. Host parity does not imply transcript parity: the local adapter still supports only the named Claude Code, Cowork, and Desktop session formats.

## Why the boundary matters

- **Traceability:** measured values retain the finding, session ids, and evidence that produced them.
- **Bounded context:** the model reads a canonical redacted projection instead of a multi-megabyte transcript.
- **Better choices:** catalog matches provide known options, while research and synthesis can cover the long tail.
- **Explicit authority:** proposing, applying, and verifying are separate actions with different permissions.
- **Honest outcomes:** quality is the primary goal. Time and token reductions are benefits only when the later evidence supports them.
