# Orangu data contracts

This reference describes Orangu's current JSON surfaces. Integrations must use fields that exist in these contracts. Breaking changes require the owning schema version to change.

The complete current `Analysis` and `SlimAnalysis` reference lives at [`plugin/skills/analyze/references/json-shape.md`](../plugin/skills/analyze/references/json-shape.md). The TypeScript definitions remain the source of truth.

## Analysis and Aggregate

- `orangu analyze <session> --json` emits `Analysis` from `src/model/analysis.ts`.
- `orangu analyze <session> --json --slim` emits the smaller `SlimAnalysis` from `src/suggest/slim.ts`.
- `orangu repo --json` and `orangu global --json` emit `Aggregate` from `src/analyze/aggregate.ts`.

`Analysis.instructions` (additive, absent from older payloads) lists the instruction files the main context loaded (`loaded`), the "do not" rules in them that name a command, a long flag, a tool or an MCP server with the calls after the rule entered the context (`rules`, with `blocked` for calls that a hook or a deny rule stopped), the Write and Edit calls to an instruction or memory file (`noteWrites`), and Claude Code's warning that it did not load all of `MEMORY.md` (`memoryCuts`). Without `--include-text`, the rule line, the command target, the examples and the note words are stripped.

Reports embed an `Analysis`. Skills should use the canonical `orangu evidence` projection described below instead of reading a full analysis or raw transcript directly.

### Rule text and the narrative

Each `Insight` in `Analysis.insights` holds its rule text in 3 parts. Each `CrossFinding` in `Aggregate.crossFindings` holds the parts of its example insight, the one whose figures its `title` shows.

```ts
Insight = {
  // ...
  title: string,
  detail: string,
  recommendation: string, // improvement, why and method, joined with one space (an absent part is skipped)
  improvement: string,    // the change to make, or "No change needed." and any conditional advice after it
  why?: string,           // what the finding means, and why it matters
  method?: string         // what the rule counts and skips, and how to read the finding
}

CrossFinding = {
  // ...
  title: string,          // "In one session: " + exampleTitle
  exampleTitle?: string,  // the title of the example insight, without the marker
  recommendation: string, // the join of the parts below
  improvement?: string,
  why?: string,
  method?: string
}
```

`recommendation` is the join of the parts, so a reader of the whole rule text keeps working. A view that shows the change first reads `improvement`. Every rule sets `why`. The types keep `why`, `method` and every `CrossFinding` part optional, so that older JSON still reads. The aggregate always writes `exampleTitle` and `improvement`, and it writes `why` and `method` when the example insight has them.

`Analysis.summary.narrative` has 2 paragraphs, split by one blank line (`"\n\n"`). The first paragraph holds the facts. The second paragraph is present only when the rules found something. It holds "Look at these first." and then each top finding title as its own sentence. The text holds no other line break.

## EvidenceBundle v1

`orangu evidence <input> --quiet` emits the exact bounded, redacted handoff consumed by `orangu-improve`.

Accepted inputs:

- supported session id, prefix, `latest`, or supported `.jsonl` path;
- current Orangu `Analysis` JSON;
- current Orangu `SlimAnalysis` JSON;
- current Orangu `Aggregate` JSON with required `--scope repo|global`.

The command is not a generic JSONL parser and does not accept Codex transcripts. It rejects `--no-redact` and `--depth`. A session input may not include symlinks. A JSON artifact must be a bounded regular non-symlink file with a current recognized schema.

The raw-session budget is shared by the main transcript, every included subagent transcript, and metadata; it is not reset per file. Ordinary local parse/cache/live snapshots are capped at 256 MiB, 100,000 non-empty JSONL records, and 8 MiB per record. Evidence and verification use a stricter 64 MiB whole-session cap. One sidecar tree may contain at most 2,048 inspected entries, four nested directory levels, and 1 MiB per metadata file. General discovery is capped at 25,000 cumulative directory entries and 25,000 candidate sessions; verification inventories at most 10,000. Immutable manifests bind file/directory identities and absent paths, and reject symlinks, replacements, partial verification records, or mutation during a read.

Current Analysis/SlimAnalysis/Aggregate JSON artifacts are capped at 8 MiB. Evidence validation accepts at most 500 findings and 1,000 aggregate sessions, selects at most 50 findings, and emits at most 256 KiB of canonical redacted JSON. An over-limit input fails instead of yielding a partial handoff.

All accepted input families may be diagnosed in chat. Persistence has a stronger contract. Before writing an applicable session/repo proposal, the host skill runs `orangu suggest --show <id> --for-proposal --json --quiet`; every evidence session must resolve from configured supported roots and its canonical cwd must match the current workspace. Archived or custom supported roots are configured through `ORANGU_CLAUDE_ROOTS` or `CLAUDE_CONFIG_DIR`. Global proposals may be persisted as structured reviews, but are proposal-only.

```ts
EvidenceBundle = {
  schemaVersion: "1",
  source: {
    kind: "analysis" | "slim-analysis" | "aggregate",
    schemaVersion: string,
    scope: "session" | "repo" | "global",
    sessions: number,
    cohortFingerprint?: string
  },
  totalFindings: number,
  selectedFindings: number,
  truncated: boolean,
  catalogMatches: Array<{
    suggestionId: string,
    id: string,
    changeClass: ChangeClass,
    tool?: string,
    skill?: string,
    feature?: string,
    url: string | null,
    verifiedAt: string | null,
    note: string,
    evidence: string
  }>,
  findings: Array<{
    suggestionId: string,
    findingToken: string,
    finding: Finding,
    axis: "quality" | "time" | "tokens" | "context",
    severity: "info" | "low" | "medium" | "high",
    detail: string,
    recommendation?: string,
    improvement?: string,  // the change to make
    why?: string,          // what the finding means, and why it matters
    method?: string,       // what the rule counts and skips
    exampleTitle?: string, // repo/global: the example insight title, without "In one session: "
    turnIndexes?: number[],
    catalogMatchIds: string[]
  }>
}

Finding = {
  ruleId: string,
  title: string,
  scope: "session" | "repo" | "global",
  sessionIds: string[],
  insightId?: string,
  cohortFingerprint?: string,
  evidence: {
    estimated: boolean,
    savingsTokens?: number,
    savingsMs?: number,
    sessions?: number,
    turnIndexes?: number[],
    live?: boolean,
    [key: string]: unknown
  }
}
```

`catalogMatches` deliberately precedes `findings`. Each finding carries the canonical report-source `suggestionId` and a validated opaque `findingToken`, so the skill can create or reuse the exact record without reconstructing identity. `source.cohortFingerprint` and `Finding.cohortFingerprint` are present only for repo/global Aggregate evidence; both bind the handoff and manual suggestion creation to the complete normalized session cohort and are exactly 16 lowercase hexadecimal characters.

Orangu scrubs and bounds each rule text part as it does `recommendation`. A finding has `improvement` whenever its input carries rule text. An input from before the split into parts has none, so its whole `recommendation` becomes the `improvement`. Only an `Aggregate` from before cross findings carried a `recommendation` has no rule text at all.

`orangu evidence <input> --estimate --quiet` emits:

```ts
EvidenceEstimate = {
  bytes: number,
  approxTokens: number,
  thresholdTokens: number,
  overThreshold: boolean
}
```

The estimate serializes the same canonical bundle; it is not a different depth or sample.

`orangu estimate <session> --json` sizes the same bundle and emits `Estimate` (`bytes`, `approxTokens`, `sessions`, `files`, `overThreshold`) plus `skipped: { selector, reason }[]`, the selectors that could not be projected; they add nothing to `bytes`. When nothing could be projected the command fails, as `orangu evidence --estimate` does on the same input, instead of reporting a clean 0. `estimate harness` sizes one report and omits `skipped`.

## Harness report (`orangu harness --json`, `schemaVersion` `"3"`)

`HarnessReport` is its own contract, versioned by `HARNESS_SCHEMA_VERSION` (`src/harness/types.ts`) independently of `Analysis`. Eight top-level keys: `schemaVersion`, `generator`, `scope`, `inventory` (the declared side: `claudeMd`, `memoryIndexes`, `settings`, `skills`, `agents`, `plugins`, `mcpServers`, `totals`, `unreadable`), `crosswalk` (the declared side joined against the sessions), `retention`, `enforcement`, `notes`. Since version 3, `enforcement` holds `counts` and 4 row arrays: `broken` (a rule summed over the sessions that had it in context: `sessionsInContext`, `sessionsBroken`, `calls`, `agentCalls`, `blocked`), `notes` (feedback notes and the matching complaints after them), `memory` (each `MEMORY.md` against the load limit of 200 lines and 25,000 characters, now and in the sessions), and `complaints` (words in complaints of 2 or more sessions). Without `--include-text` the section has no text that a person or a model wrote: `broken[].text` is empty (read the line at `file:line`), `notes[].sharedWords` and `complaints` are empty, and no example has a `preview`. Every crosswalk row carries one classification, `status`: `used`, `idle`, or `undeclared` (observed in sessions but in no file that was read; never "rogue"). The row arrays are sorted and capped at 50; `crosswalk.counts` holds the `used` / `idle` / `undeclared` counts of every axis over its whole population, so a consumer counts from there and takes names from the rows. Since version 2: `injectedListings[]` rows are `{ type, main, subagent, approxTokensPerInjection, approxTokensPerMainSession }` where `main` is the primary transcript of each session and `subagent` the sidecar files beneath it, each `{ sessions, injections, bytes, approxTokens }`; `hooks[]` rows may carry no `commandBasename` when the transcript recorded a run by event only; `settings[].scope` and `mcpServers[].scope` include `managed` (the platform's managed settings directory, overridable with `ORANGU_CLAUDE_MANAGED_DIRS`, empty meaning none), consulted in the vendor's merge order; `totals.projectEntries` says how many `~/.claude.json` project entries were read (the cwd's, or every one under global scope). Tokens are bytes ÷ 4 and tokens are the only usage unit in this shape. `--out <file>` writes this JSON and never HTML.

## AppData v1

`AppData` is the single payload rendered by the browser. File mode embeds it in `#orangu-data`; serve mode returns it from `GET /api/app`. Additive changes are allowed within v1.

```ts
AppData = {
  v: "1",
  mode: "file" | "serve",
  version: string,
  generatedAt: number,
  illustrative?: boolean,
  capabilities: {
    live: boolean,
    aggregates: boolean,
    kickoffRun: boolean,
    exportHtml: boolean,
    includeText: boolean
  },
  selectedId?: string,
  session?: Analysis,
  sessions: SessionSummaryRow[],
  aggregates: { repo?: Aggregate, global?: Aggregate },
  suggestions: SuggestionRecord[],
  redaction?: { applied: number, strippedText: boolean, strippedPaths: boolean }
}
```

### The sessionless shape (aggregate report)

An `orangu repo --html` / `orangu global --html` file is `AppData` v1 with **no session at all**. It is a legal v1 value, not a new version:

| Field | Value in an aggregate report |
|---|---|
| `mode` | `"file"` |
| `session` | `undefined` — the file carries no `Analysis` |
| `sessions` | `[]` — no session rows, so no session picker and no session group in the sidebar |
| `selectedId` | `undefined` |
| `aggregates` | exactly one of `repo` / `global` is filled: the scope the file was built for |
| `capabilities.aggregates` | `true` |
| `capabilities.live` / `kickoffRun` | `false` — a file never tails a session and never launches anything |

Two rules follow from it. **Read the scope, not the absence of a session:** "this file is about a scope" and "there is no session right now" are different questions, and serve can legitimately answer yes to the second while answering no to the first (it bootstraps with zero discovered sessions and still has a session picker). The client asks one predicate, `fileScope()` in `src/report/client/nav.ts`, and every subtraction — the landing screen, the sidebar groups, the tab title, the disabled `This session` chip, the across-session empty state — hangs off that one answer. **Nothing keys off `capabilities.aggregates`:** it is documentation of what the payload contains, and no client code reads it. A consumer that needs to branch on scope reads `aggregates.<scope>` and `fileScope()`.

Suggestion actions in the app are copy-only Claude Code and Codex handoffs. The browser does not create an application or verification claim.

## SuggestionRecord

The append-only store writes `SuggestionRecord` values to `~/.orangu/suggestions.jsonl`.

```ts
SuggestionRecord = {
  id: "sg_...",
  v: 1 | 2,
  key?: SuggestionKey,
  legacyIds?: string[],
  createdAt: number,
  source: "report" | "skill",
  scope: "session" | "repo" | "global",
  sessionIds: string[],
  ruleId: string,
  title: string,
  insightId?: string,
  cohortFingerprint?: string,
  evidence: SuggestionEvidence,
  proposal?: SuggestionProposal,
  application?: SuggestionApplicationReceipt,
  appliedAt?: number,
  verificationReceipt?: SuggestionVerificationReceiptV2 | SuggestionVerificationReceipt,
  verificationTrust?: "computed-v2" | "computed-v1",
  frozenBaseline?: SuggestionFrozenBaseline,
  outcomeReceipt?: SuggestionOutcomeReceipt,
  reasonCode?: "not-wanted" | "already-handled" | "wrong-cause" | "too-much-effort" | "other",
  workspaceCwd?: string,
  status: "new" | "kicked-off" | "proposed" | "applied" | "verified" | "rejected" | "failed"
    | "regressed" | "unproven" | "kept",
  statusAt: number,
  effect?: {
    before: Record<string, number>,
    after: Record<string, number>,
    measuredSessionIds: string[]
  },
  kickoff?: {
    mode: "file" | "serve",
    command: string,
    pid?: number,
    exitCode?: number,
    error?: string
  }
}
```

For repo/global findings, `cohortFingerprint` is the first 16 hex characters of the deterministic hash of every normalized session id in the aggregate. It is included in `SuggestionKey`, so a growing cohort cannot reuse stale evidence merely because the displayed example session ids stayed the same. Session-scope v2 identities retain their existing preimage. Cohort-bound records do not accept the older lossy v1 report id. Proposal preflight later resolves the bounded example sessions and checks the claimed rule; it does not reconstruct the original full aggregate or independently attest a manually supplied fingerprint. This field binds identity, not provenance.

The optional `kickoff.pid` and `kickoff.exitCode` fields are legacy compatibility fields for records written by older launch-capable versions. The current copy-only localhost handoff never starts a model process and does not populate them.

The underlying state union is shared, but legal forward authority is scope-specific:

```text
session: new -> kicked-off -> proposed -> applied -> verified | regressed | unproven
repo:    new -> kicked-off -> proposed -> applied -> verified | regressed | unproven
global:  new -> kicked-off -> proposed
```

The store holds each record to this transition table (`TRANSITIONS` in `src/suggest/types.ts`):

| From | Legal moves |
|---|---|
| `new` | `kicked-off`, `rejected` |
| `kicked-off` | `proposed`, `failed`, `rejected` |
| `proposed` | `applied`, `rejected` |
| `applied` | `verified`, `regressed`, `unproven`, `rejected` |
| `verified` | `rejected` |
| `failed` | `kicked-off`, `rejected` |
| `regressed` | `kept`, `rejected` |
| `unproven` | `rejected` |
| `kept` | `rejected` |
| `rejected` | none |

Session and repo verification require later same-workspace sessions that beat an Orangu-chosen baseline beyond chance. The store stamps `appliedAt` on the `applied` transition and carries it on every later line; it is where both cohorts are cut. When the record has a frozen baseline, a `verified` receipt must grade against it: 3 or more frozen sessions, exactly their ids, and for each check the mean and the median of their values. The store applies this rule to the move, and the trust check applies it again on every read. Global has no apply or verify authority, and it cannot close as `regressed` or `unproven`. Applicable states may be rejected; `kicked-off` may fail, and `failed` may return to `kicked-off` or be rejected. No other transition is legal.

The 3 closed states after `applied`:

- `regressed`: at the `complete` checkpoint, a check moved beyond chance in a direction that it should not. The record waits for a person to keep the change (`kept`) or to reject it.
- `unproven`: at the `complete` checkpoint, the change did not beat the baseline beyond chance. A frozen baseline below 3 sessions also closes a record as `unproven`, at any later count. The change stays applied.
- `kept`: a person keeps a `regressed` change. The move measures nothing and carries the outcome receipt.

### The checkpoints

Orangu grades the later sessions at 2 fixed checkpoints, and never between them:

- `first`: the first 3 accepted later sessions, against the frozen baseline.
- `complete`: the complete later cohort, 10 sessions, or fewer when the later byte budget is spent.

The verdict of a record is the verdict at the latest checkpoint that it reached.

### The new fields

Each move copies every field of the line before it, so a later line keeps the frozen baseline, the outcome receipt and the application time. The 4 new fields hold no free text: only numbers, booleans, session and suggestion ids, enum values, epoch times and 1 canonical path. The store refuses a key that is not in the shape below.

```ts
// written only on the `applied` move, and only when the baseline read succeeds
SuggestionFrozenBaseline = {
  v: 1,
  cutAt: number,                 // at most the `appliedAt` of the same move
  sessions: Array<{              // 0 to 10, sorted by id, no repeated id
    id: string,                  // a lowercase session UUID
    startedAt: number,           // startedAt <= endedAt <= cutAt
    endedAt: number,
    metrics: Record<SuggestionVerificationMetric, number>  // each of the 8 metrics, finite and 0 or more
  }>,
  skipped: Record<CohortSkipReason, number>                // each of the 8 skip reasons, a whole number of 0 or more
}

// written only on a `regressed` or `unproven` move
SuggestionOutcomeReceipt = {
  v: 1,
  method: "cohort-rank-v1",
  alpha: 0.05,
  appliedAt: number,             // the recorded application time
  checkpoint: "first" | "complete",  // "complete" exactly when laterComplete is true; "first" only with a frozen baseline below 3 sessions
  verdict: "within-noise" | "regressed" | "not-enough-sessions" | "no-directional-check",
  laterComplete: boolean,
  confoundedBy: string[],        // sorted unique suggestion ids
  baselineSessionIds: string[],  // 0 to 10 sorted unique session UUIDs, the frozen sessions when the record has them
  measuredSessionIds: string[],  // 0 to 10 sorted unique session UUIDs, none shared with the baseline
  checks: Array<{                // 1 for each reviewed check, in the reviewed order
    metric, comparison, name, before, after, beforeMedian, afterMedian, pLower, pHigher,
    verdict: "improved" | "within-noise" | "regressed" | "held" | "changed"
  }>
}
```

An outcome receipt has no `summary` key and no `evidence` key, so it stores no rendered string. The store grades it again from its own numbers before it writes the move. It refuses the move when:

1. A check has a stored `verdict` that differs from the verdict of its own numbers.
2. The overall `verdict` differs from the verdict of its checks and of its session counts.
3. `laterComplete` is `false`. The exception is the verdict `not-enough-sessions` with a frozen baseline below 3 sessions whose ids are the receipt's baseline ids.
4. A `regressed` move carries a verdict other than `regressed`, or an `unproven` move carries `regressed`.
5. A frozen baseline has more than 10 sessions, an unsorted or repeated id, or a value that is not a finite number of 0 or more.
6. The `checkpoint` does not fit `laterComplete`: it is `complete` when the later cohort is complete, and `first` before it.

The store also refuses an outcome receipt that does not grade against the frozen baseline of its record: the same session ids, and for each check the mean and the median of the frozen values. A record with no frozen baseline closes only on 3 or more baseline sessions. Below that, its verdict is not final, and the record can only be rejected.

`reasonCode` is only on a `rejected` move, and it is 1 of the 5 codes: `not-wanted`, `already-handled`, `wrong-cause`, `too-much-effort`, `other`. A code is a stored contract: a later orangu may change the label of a code, and never the code itself. `workspaceCwd` is also only on a `rejected` move, for a record with no proposal workspace. It is an absolute path in normal form with no control character, no format character (such as U+202E) and no line separator, which the caller resolved with `realpath`. On Windows it is a drive path: the store refuses the device forms (`\\?\`, `\\.\`), a UNC share and an alternate data stream. A reader compares the path as a string, so 2 forms of 1 folder must not both pass. Both fields are optional, and a rejection with neither stays legal for every scope.

Every refused move leaves `suggestions.jsonl` byte for byte as it was.

### Reading an unknown status

The store reads a line only when it knows the status of that line. A line with an unknown status, such as `paused`, is skipped, and the line before it for the same id stays the current state. The full history read (`lines`) skips it too.

This is the backward-read rule. An older orangu skips a line with a status that it does not know, and it shows the line before it. So orangu 0.11.0 shows a `regressed`, `unproven` or `kept` record as `applied`. A later `--set verified` from 0.11.0 appends `verified`, and that last line wins. A downgrade is therefore not supported. The rule takes the place of a version bump: a store line carries only its identity version `v`.

## Proposal artifacts

New proposals from `orangu-improve` and `orangu-harness` have two files under `~/.orangu/proposals/`:

- `<id>.md`: human-readable review;
- `<id>.json`: versioned machine-readable manifest.

The live writing contract is [`plugin/skills/improve/references/artifact-contract.md`](../plugin/skills/improve/references/artifact-contract.md). The manifest contains:

```ts
SuggestionProposal = {
  v: 1,
  title: string,
  change: string,
  effort: "S" | "M" | "L",
  files: string[],
  proposalPath: string,
  manifestPath: string,
  changeClass: ChangeClass,
  evidence: string,
  expectedEffect: string,
  risk: string,
  verification: string,
  verificationChecks: Array<{
    metric: SuggestionVerificationMetric,
    comparison: SuggestionVerificationComparison
  }>,
  sources?: Array<{
    kind: "catalog" | "research" | "inference",
    label: string,
    url?: string,
    verifiedAt?: string | null
  }>,
  rank?: number,
  workspace: { cwd: string, device: string, inode: string, birthtimeNs?: string }
}
```

Project files are a nonempty set of relative paths and may not escape the target repository or include `.git`. `verificationChecks` contains 1-32 unique supported metric/comparison pairs. At least 1 pair must be `decreased` or `increased`. Orangu refuses a new manifest that has only guards, because such a set can never verify. A record that an older orangu stored with only guards stays readable, and it can still close as `unproven`. The skill supplies those reviewed pairs; later verification grades exactly those pairs, in that order. `workspace` is captured by Orangu when it accepts the structured proposal, not supplied by the manifest. Apply and verification later require the same canonical path and inode, and the same directory creation time when one was recorded (`birthtimeNs`, captured only where the filesystem reports a real one; earlier records carry none). The recorded device number may differ, because the operating system renumbers volumes across restarts and remounts. Two exceptions keep the device strict: a workspace that is itself the root of a mounted volume, where the inode is the same on every volume, and Windows, where the volume serial does not change. Catalog labels must name a real shipped entry exactly as `catalog: <id>`; Orangu derives its URL/date from the catalog and rejects conflicting supplied metadata. Research requires a direct HTTPS URL and a non-null checked `YYYY-MM-DD` date. Inference carries neither URL nor date. A candidate with `verifiedAt: null` is not valid persisted proposal provenance.

Every `orangu-harness` manifest includes its rank, at least one reviewed relative project file, and at least one honest catalog, research, or inference source. The harness skill passes both artifact paths with `--proposal` and `--manifest`; it never authors a repository edit of its own. It may apply the repo items you approve, and only by invoking `orangu-apply` for one id at a time under that skill's unchanged contract, after disclosing each item's files and command text and taking an explicit per-item approval by verbatim id; it stops at the first failure. A global harness proposal is review-only and is never applied.

Legacy Markdown-only proposals remain readable for compatibility but cannot satisfy the new structured apply workflow.

## Application receipt

Under its required skill contract, `orangu-apply` writes `<id>.applied.json` only after the reviewed change and required local checks succeed. The live contract is [`plugin/skills/apply/references/application-contract.md`](../plugin/skills/apply/references/application-contract.md).

Before reading or editing project files, both host skills run `orangu suggest --show <id> --for-apply --json --quiet`. This deterministic preflight must bind a session/repo structured proposal to the current repository; plain `--show` is not an apply authorization. Global scope always fails apply eligibility.

```ts
SuggestionApplicationReceipt = {
  v: 1,
  summary: string,
  files: string[],
  checks: Array<{ name: string, command?: string, ok: true }>,
  receiptPath: string
}
```

The receipt is a skill-authored attestation. The deterministic CLI validates its schema and that the relative file list exactly matches the reviewed proposal for the current invocation. It does not inspect the working-tree diff, independently execute a check, or prove filesystem confinement.

## Later verification receipt

Verification takes no skill-written file. `orangu suggest --effect <id>` computes the result read-only; `orangu suggest --set <id> verified` recomputes it and records it only when the overall verdict is `verified`. An older `<id>.verified.json` intent (`v: 1`, `id`, `measuredSessionIds`, reviewed `checks`, and nothing self-attested) is still accepted, but it chooses nothing: every session it names must already be in the later cohort Orangu measured.

Orangu resolves the proposal's canonical workspace (see the identity rule under Proposal artifacts) and lists its sessions from the configured supported roots. The baseline is up to ten settled sessions that ended before `appliedAt`, most recent first, leaving out the finding's own `sessionIds`; the later cohort is up to ten settled sessions that started after it, earliest first. Settled means an immutable, non-partial transcript snapshot whose complete main/sidecar/metadata manifest has been quiet for at least 30 minutes. A session that spans the application, has another cwd, is still settling, exceeds the 64 MiB per-session cap, or ran orangu itself (an orangu skill or an `orangu suggest`/`evidence`/`estimate`/`harness` call) is skipped and counted by reason. Each side reads at most 256 MiB and stops, in order, at the first session that no longer fits.

Each reviewed check is graded with an exact permutation rank test (midranks for ties). `decreased`/`increased` checks must move that way at p ≤ 0.05 (`improved`); `not-increased`/`not-decreased`/`equal` must not move the wrong way at p ≤ 0.05 (`held`). The overall verdict is `not-enough-sessions` (fewer than three on a side), `regressed`, `no-directional-check`, `within-noise`, or `verified` (every directional check improved and every guard held). On `verified`, the append-only record receives:

```ts
SuggestionVerificationReceiptV2 = {
  v: 2,
  method: "cohort-rank-v1",
  alpha: 0.05,
  appliedAt: number,
  summary: string,              // computed from the checks, both cohort sizes, and confounders
  baselineSessionIds: string[], // sorted, 3-10
  measuredSessionIds: string[], // sorted, 3-10, disjoint from the baseline
  confoundedBy: string[],       // sorted ids of other changes applied in this workspace inside the window
  checks: Array<{
    name: string,
    metric: SuggestionVerificationMetric,
    comparison: SuggestionVerificationComparison,
    before: number,             // cohort means
    after: number,
    beforeMedian: number,
    afterMedian: number,
    pLower: number,             // exact one-sided p-values
    pHigher: number,
    verdict: "improved" | "held",
    evidence: string,           // computed rendering of the numbers above
    ok: true
  }>
}
```

The store and every display re-grade a v2 receipt from its own numbers (verdicts, evidence text, p-values possible for the cohort sizes, summary) and stamp `verificationTrust: "computed-v2"`. The record's `effect.before` and `effect.after` maps are the cohort means of the same checks. Earlier `computed-v1` records carry a v1 receipt (a later-session mean comparison without a noise check) and stay readable; legacy verified records lack either marker and must not be presented as current computed verification. Without a passing computed receipt, status remains `applied`.
