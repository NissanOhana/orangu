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

The verdict of a record is the verdict at the latest checkpoint that it reached. The graded order is the start time. So
a later session that started before the third graded one, and that still settles, takes a place among the first 3 when
it settles. Until then the `first` checkpoint waits: `checkpoint` is `null`, the verdict is not final, and only the
sessions that started before it are graded. A start time that the loader cannot read counts as the earliest. The one
exception is a frozen baseline below 3 sessions: it cannot change, so its verdict is final at any later count, and
`--record` closes the record as `unproven` also while the `first` checkpoint waits.

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

### Stored text in the queue reads

The store accepts any text as a `ruleId` or an `insightId`. So the queue, todo, lesson and history reads give a `ruleId` only when it is 1 of the analyzer rule ids (`src/analyze/rule-ids.ts`) or `harness:` and a change class, and `null` for any other value. They give an `insightId` only when it is that rule id, a `-` and a number, and leave it out for any other value. A `changeClass` and a `reasonCode` show only when each is a known value.

Each queue item lists its earlier records in `earlier`: the closed and `regressed` records of the same workspace and rule, newest first, 10 at most. `earlierCount` counts all of them, so a cut list hides no record.

An older `applied` record (one with no `frozenBaseline`) gets `cannotVerify: "baseline-gone"` when fewer than 3 of its baseline sessions are on disk. It gets the same value when its queue check reaches the `complete` checkpoint with fewer than 3 baseline sessions after the take rules, for example when the files on disk are its own evidence sessions. No step can then record a verdict, so the item goes to `review`, and its `next` is the verify handoff, which offers a rejection.

## The store reads

`orangu suggest` has 4 reads of the store: `--queue`, `--todo`, `--lessons` and `--history`. No read writes a record or a proposal file. Only the queue check of `--queue` and `--todo` can write cohort facts cache entries. Each `--json` output goes through the default redaction, as every `orangu suggest` output does. A later orangu can add a key within v1, as AppData v1 allows, and it removes none.

Each call runs 1 step. 2 step flags together exit 1 before any read or write when 1 of them is a step that 0.11.0 did not have: `--record`, `--queue`, `--todo`, `--lessons` or `--history`. 2 or more of the 0.11.0 steps (`--list`, `--show`, `--effect`, `--set`) run the first of them in that order, as 0.11.0 did. A read also exits 1 on an option that it does not take.

The workspace of a read is `--cwd <dir>`, and the default is the current folder. A record is in the workspace when its proposal workspace or its bound `workspaceCwd` is the canonical path of `<dir>`, or when 1 of its `sessionIds` is a session that discovery lists for that path. A workspace read leaves out the global records. `--all` reads every workspace and the global records. `--cwd` with `--all` exits 1.

The queue check keeps a cohort facts cache in `<orangu home>/cache/<generation>/cohort-facts-v1/`, with 1 file of at most 16,384 B for each session. An entry has 1 of 2 shapes. A facts entry is `{ v: 1, key, sessionId, cwd, startedAt, endedAt, ranOrangu, bytesRead, metrics }`, the facts of a settled session. A skip entry is `{ v: 1, key, sessionId, skip: "over-budget", maxBytes, bytesRead }`: the trusted loader refused the session as over the cap of its load. In 1 read, the queue also keeps each skip of a miss in memory. So it loads a skipped session 1 time, and not 1 time for each record.

The key holds the path, the inode, the size, the mtime and the ctime of the transcript. It also holds the session folder tree down to 4 folders, as `sidecarTree` walks it. The tree has each folder and each sidecar transcript with its `.meta.json`. A changed file moves the key, so the old entry is a miss. A stale or planted entry can change only what the queue shows. It never changes a stored verdict, because `--set`, `--record` and `--effect` measure with the trusted loaders and read no cache.

### SuggestionQueue v1 (`--queue [--cwd <dir> | --all] --json`)

```ts
SuggestionQueue = {
  v: 1,
  scope: string,                // the canonical workspace path, or "all"
  now: number,                  // the clock of the read: the settle rule and the age of a running item
  counts: QueueCounts,
  groups: {                     // the 6 groups, in the order that a person works them
    verdict: QueueItem[], regressed: QueueItem[], apply: QueueItem[],
    review: QueueItem[], running: QueueItem[], wait: QueueItem[]
  },
  globalOpen: number            // the open global records that a workspace read leaves out. 0 with --all
}

QueueCounts = { verdict, regressed, apply, review, running, wait, due, open: number }  // due = verdict, open = every item

QueueItem = {
  group: "verdict" | "regressed" | "apply" | "review" | "running" | "wait",
  id: string,                   // the newest record of the item
  ids: string[],                // every folded record, newest move first. More than 1 only in review
  status: SuggestionStatus,
  scope: "session" | "repo" | "global",
  ruleId: string | null,        // see "Stored text in the queue reads"
  changeClass?: ChangeClass,
  title: string,                // the stored title. It can be model text, so each surface escapes it
  workspace: string | null,
  lastMoveAt: number,           // the statusAt of the newest move of the item
  appliedAt?: number,           // applied items only, with the next 7 keys
  candidates?: { baseline: number, later: number },  // discovery counts for the row text, at most 10 each
  check?: "ran" | "deferred",   // whether the queue check measured the item in this read
  checkpoint?: "first" | "complete" | null,
  verdict?: CohortVerdict,
  final?: boolean,
  leaning?: "worse",
  cannotVerify?: "few-baseline-sessions" | "no-directional-check" | "baseline-gone" | "legacy-record",
  earlier: Array<{ id: string, status: SuggestionStatus, verdict: CohortVerdict | null, reasonCode?: RejectReasonCode }>,
  earlierCount: number,
  next: string | null           // a whole claude "/orangu:..." command, or null when no step can run now
}
```

1 group for each open record:

| Record | Group | `next` |
|---|---|---|
| `applied`, due | `verdict` | `claude "/orangu:improve --verify <id>"` |
| `regressed` | `regressed` | `claude "/orangu:improve --verify <id>"` |
| `proposed`, session or repo scope | `apply` | `claude "/orangu:apply <id>"` |
| `new` or `failed` | `review` | `claude "/orangu:improve <id>"` |
| `proposed`, global scope (only with `--all`) | `review` | `null` |
| `applied`, `cannotVerify` `baseline-gone` or `legacy-record` | `review` | `claude "/orangu:improve --verify <id>"` |
| `kicked-off` | `running` | `claude "/orangu:improve <id>"` |
| `applied`, not due | `wait` | `null` |

An `applied` item is due when 1 step can close it now: its queue check gives `final: true`, or its frozen baseline has fewer than 3 sessions. The counts in `candidates` never decide it. 1 read parses at most 256 MiB of transcripts that miss the cohort facts cache, and it checks the items oldest application first. An item past that budget gets `check: "deferred"`, is not due and has `next: null`. A second read with no new session parses no transcript.

The text output of `--queue` is for a person, so it names no `orangu suggest` command. Each item prints its `next` whole on a row of its own, or no command row when `next` is `null`.

### TodoRead v1 (`--todo [--cwd <dir>] --json`)

The open items of 1 workspace that need a step, for a skill. It has no title and no `now` at any depth.

```ts
TodoRead = {
  v: 1,
  workspace: string,            // the canonical workspace path
  counts: QueueCounts,          // the counts of --queue --json --cwd <dir> for the same store, sessions and now
  maxBytes: 8192,
  omitted: number,              // the items that do not fit
  items: TodoItem[]             // the groups verdict, regressed, apply, review and running, in that order
}

TodoItem = { group, id, status, scope, ruleId: string | null, changeClass?, cannotVerify? }
```

`--todo` takes no `--all`, and `--todo --all` exits 1. The CLI keeps the first items that fit in 8,192 B (`TODO_MAX_BYTES`) of the exact output with its trailing newline, in the form that it prints: `--json`, `--json --quiet` or the text. So each form keeps as many items as fit in its own bytes. The text form prints 1 row for each item: the group, the id, the status and the rule.

### LessonRead v1 (`--lessons [--cwd <dir> | --all | --scope global] [--rule <id>[,<id>]] --json`)

What each decided record taught, as ids, codes, enum values, counts and times. It is the only read that a skill uses as memory.

```ts
LessonRead = {
  v: 1,
  scope: string,                // the canonical workspace path, "all" or "global"
  maxBytes: number | null,      // 16384 from the CLI
  omitted: number,              // the older lessons that do not fit
  lessons: Lesson[]             // newest decidedAt first, ties by id. With --all, the global lessons come last
}

Lesson = {
  id: string,
  scope: "session" | "repo" | "global",
  ruleId: string | null,
  insightId?: string,
  changeClass?: ChangeClass,
  status: "verified" | "regressed" | "unproven" | "kept" | "rejected",
  reasonCode?: RejectReasonCode,
  verdict: CohortVerdict | null,   // only from a receipt that grades again on this read
  verdictTrusted: boolean,
  laterComplete?: boolean,
  confoundedBy: string[],
  baseline: number,                // the session counts of the receipt
  later: number,
  checks: Array<{ metric, comparison, verdict }>,
  appliedAt?: number,
  decidedAt: number                // the statusAt of the newest move
}
```

A lesson has no title, no file, no proposal text, no metric value and no `leaning`. `--scope global` reads only the global records, which belong to no workspace, and it takes no `--cwd` and no `--all`. `--scope` takes no other value here. `--rule` keeps only those rule ids. The CLI keeps the newest lessons that fit in 16,384 B (`LESSONS_MAX_BYTES`) of the exact output with its trailing newline, in the form that it prints, as `--todo` does. The output has no `now`, so a second read of the same store and the same sessions gives the same bytes.

### ChangeRow (`--history [--cwd <dir> | --all | --scope global] [--rule <id>[,<id>]] --json`)

An array of `ChangeRow`: 1 row for each record with an application time, oldest application first, ties by id. It is for a person and the app, and it has no cap.

```ts
ChangeRow = {
  // every Lesson key except checks and decidedAt, then:
  checks: Array<{ metric, comparison, verdict, before: number, after: number, pLower: number | null, pHigher: number | null }>,
  decidedAt?: number,           // absent on an open row: applied or regressed
  title: string,
  files: string[]               // the files that the apply step changed, else the files of the proposal
}
```

`before` and `after` are the cohort means of each check. A check of the earlier v1 receipt has no rank test, so its `pLower` and `pHigher` are `null`. `verdict` is `null` until a receipt exists.

### The moves of a record (`--show <id> --json`)

`--show <id> --json` adds 1 key to its 0.11.0 output, `transitions`: every move of the record in file order.

```ts
transitions: Array<{ status: SuggestionStatus, statusAt: number, reasonCode?: RejectReasonCode }>
```

A move is a store line whose status differs from the line before it for the same record, and the first line of a record is its first move. Only a rejection carries a reason code.

`--list --status <s>[,<s>]` keeps only those statuses. An unknown status exits 1 and names the 10 statuses. Without `--status`, `--list --json` prints the same array as 0.11.0.

### The app reads (`orangu serve`)

`orangu serve` gives 3 store reads to the app: `GET /api/queue`, `GET /api/history` and `GET /api/lessons`. Each route runs the read of the CLI at the clock of the request, and scrubs its output as the CLI scrubs `--json`. So for the same store, sessions and clock, a route gives the JSON of `--queue --json`, `--history --json` or `--lessons --json`. The 1 difference is `GET /api/lessons`: it has no cap, so `maxBytes` is `null` and `omitted` is 0.

The query takes the options of the CLI read. Each route takes `cwd=<dir>` or `all=1`, and the history and the lessons also take `scope=global` and `rule=<id>[,<id>]`. With no scope option, a route reads the `--cwd` of serve. The app reads its own workspace that way, and every workspace with `all=1`. When serve has no `--cwd`, a route with no scope option reads every workspace, as `all=1` does, and the `scope` key of the queue and of the lesson read is `"all"`. A route gives 400 for a query name that it does not take, for 2 values of 1 option, for 2 scope options together, for another value of `all` or `scope`, for an empty `cwd=`, for a `cwd` over 4,096 B, and for a `rule` with no rule id. A route gives 503 when the store of serve has no line read, as in `orangu feedback`.

`cwd` must name a workspace of serve: the `--cwd` of serve, or the folder of a session that serve lists, as `GET /api/repo` takes it. Both forms work: the raw path, or the scrubbed path that the app shows. Any other `cwd` gives 404 with the fixed body `{"error":"unknown workspace"}`, before any read. So a request cannot make serve resolve a path that it does not know. The same 404 comes when the folder of a known workspace is gone.

The browser can only dismiss a record. `POST /api/suggestions/:id/status` takes `{ "status": "rejected", "reason"?: <code> }`, and any other status gives 400. A `reason` that is not 1 of the 5 codes gives 400, and the store stays byte for byte as it was. A record with no proposal workspace gets the `workspaceCwd` that `--set <id> rejected` binds. A record whose status allows no rejection gives 400 before any discovery. A second rejection of 1 record while the first one runs gives 409, and it runs no discovery. A failed store read or write gives 500. An error body is scrubbed on each route, so it names no home path.

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

`orangu suggest --effect <id> --json` prints 1 measure step. A later orangu can add a key, and it removes none:

```ts
SuggestionEffectView = {
  id: string,
  scope: "session" | "repo",
  verdict: "verified" | "within-noise" | "regressed" | "not-enough-sessions" | "no-directional-check",
  checkpoint: "first" | "complete" | null,  // the latest checkpoint that the later side reached, null before the first
  final: boolean,                           // a step can record the verdict now
  leaning?: "worse",                        // only when the first verdict is regressed. Computed on each read, never stored
  appliedAt: number,
  baseline: { n: number, ids: string[] },   // the frozen baseline, or the live baseline of an older record
  later: {
    n: number,                              // the graded later sessions: the first 3 until the cohort is complete
    ids: string[],                          // their session ids
    complete: boolean,                      // the later cohort holds 10 sessions, or its byte budget is spent
    count: number                           // every later session so far, the graded ones included
  },
  checks: Array<CohortCheck>,               // 1 for each reviewed check, with its computed evidence line
  confoundedBy: string[],
  skipped: Record<CohortSkipReason, number>,
  next: string                              // the next step
}
```

Each new field has 1 CLI step that writes it:

- `--set <id> applied` freezes the baseline into `frozenBaseline` just before the move. When the baseline read fails, or the store refuses the frozen baseline, the move goes ahead without one, and 1 line on stderr says so. `--quiet` silences that line. That record reads its baseline sessions live, as an older record does. The `--json` output of this step is the record plus 1 key that the store does not keep:

  ```ts
  baselineFreeze: { frozen: true } | { frozen: false, reason: string }  // reason: why the baseline did not freeze
  ```
- `--record <id>` measures both cohorts again and stores `outcomeReceipt` with the status `regressed` (for a `regressed` verdict) or `unproven`. It takes no file, no status and no text. It refuses a global record before any read, a record that is not `applied`, a verdict that is not final, and a win, which `--set <id> verified` records.
- `--set <id> kept` moves only a `regressed` record. It measures nothing and keeps the outcome receipt. `--set` refuses `regressed` and `unproven`, and names `--record`.
- `--set <id> rejected [--reason <code>]` stores 1 of the 5 codes as `reasonCode`. `--reason` with any other step, or with a value that is not a code, exits 1. For a session or repo record with no proposal workspace, the step also binds `workspaceCwd`. It finds each evidence session through discovery, reads the cwd from the first 64,000 B of the transcript, and resolves it with `realpath`. A cwd binds only when it is already the canonical path of a directory. A cwd through a link binds nothing, because the link can point to another folder now than when the session ran. It binds the path only when every session that it finds gives the same path. Any other result binds nothing, and the rejection still goes ahead.

Orangu resolves the proposal's canonical workspace (see the identity rule under Proposal artifacts) and lists its sessions from the configured supported roots. The baseline is up to ten settled sessions that ended before `appliedAt`, most recent first, leaving out the finding's own `sessionIds`; the later cohort is up to ten settled sessions that started after it, earliest first. Settled means an immutable, non-partial transcript snapshot whose complete main/sidecar/metadata manifest has been quiet for at least 30 minutes. A session that spans the application, has another cwd, is still settling, exceeds the 64 MiB per-session cap, or ran orangu itself (an orangu skill or an `orangu suggest`/`evidence`/`estimate`/`harness` call) is skipped and counted by reason. Each side reads at most 256 MiB and stops, in order, at the first session that no longer fits. The bytes of a session that still settles count toward those 256 MiB, but they never complete the side: a side that stops on them waits for a later read, when that session has settled and joined it. Orangu finds a partial last line from the end of each file of a session, the transcript and each sidecar transcript (the last byte, then at most 64,000 B for each file), so it reads no more of such a session. Each byte that the probes and the head read take counts toward the 256 MiB.

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
