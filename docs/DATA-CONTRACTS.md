# Orangu data contracts

This reference describes Orangu's current JSON surfaces. Integrations must use fields that exist in these contracts. Breaking changes require the owning schema version to change.

The complete current `Analysis` and `SlimAnalysis` reference lives at [`plugin/skills/analyze/references/json-shape.md`](../plugin/skills/analyze/references/json-shape.md). The TypeScript definitions remain the source of truth.

## Analysis and Aggregate

- `orangu analyze <session> --json` emits `Analysis` from `src/model/analysis.ts`.
- `orangu analyze <session> --json --slim` emits the smaller `SlimAnalysis` from `src/suggest/slim.ts`.
- `orangu repo --json` and `orangu global --json` emit `Aggregate` from `src/analyze/aggregate.ts`.

Reports embed an `Analysis`. Skills should use the canonical `orangu evidence` projection described below instead of reading a full analysis or raw transcript directly.

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
  verificationReceipt?: SuggestionVerificationReceipt,
  verificationTrust?: "computed-v1",
  status: "new" | "kicked-off" | "proposed" | "applied" | "verified" | "rejected" | "failed",
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
session: new -> kicked-off -> proposed -> applied -> verified
repo:    new -> kicked-off -> proposed -> applied
global:  new -> kicked-off -> proposed
```

Session verification additionally requires later same-workspace evidence. Repo has no `verified` transition until a real fresh-cohort comparator exists. Global has no apply or verify authority. Applicable states may be rejected; `kicked-off` may fail, and `failed` may return to `kicked-off` or be rejected. No other transition is legal.

## Proposal artifacts

New proposals from `orangu-improve` and `orangu-mega` have two files under `~/.orangu/proposals/`:

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
  workspace: { cwd: string, device: string, inode: string }
}
```

Project files are a nonempty set of relative paths and may not escape the target repository or include `.git`. `verificationChecks` contains 1-32 unique supported metric/comparison pairs. The skill supplies those reviewed pairs; the CLI later requires the verification intent to match them exactly. `workspace` is captured by Orangu when it accepts the structured proposal, not supplied by the manifest. Catalog labels must name a real shipped entry exactly as `catalog: <id>`; Orangu derives its URL/date from the catalog and rejects conflicting supplied metadata. Research requires a direct HTTPS URL and a non-null checked `YYYY-MM-DD` date. Inference carries neither URL nor date. A candidate with `verifiedAt: null` is not valid persisted proposal provenance.

Every `orangu-mega` manifest includes its rank, at least one reviewed relative project file, and at least one honest catalog, research, or inference source. Mega passes both artifact paths with `--proposal` and `--manifest`; it never applies the change itself. A repo mega proposal may later be applied explicitly. A global mega proposal is review-only.

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

`orangu-improve --verify` writes `<id>.verified.json` as a verification intent only for an applied session-scope record. The skill supplies selectors and the exact reviewed metric/comparison pairs only:

```ts
VerificationIntentFile = {
  v: 1,
  id: "sg_...",
  measuredSessionIds: string[],
  checks: Array<{
    metric:
      | "avgTotalTokens"
      | "avgToolCalls"
      | "avgToolErrors"
      | "avgActiveMs"
      | "avgContextPeak"
      | "avgTestRunsFailed"
      | "avgBuildRunsFailed"
      | "avgInterruptions",
    comparison: "decreased" | "not-increased" | "increased" | "not-decreased" | "equal"
  }>
}
```

The intent file omits `summary`; each check omits `name`. Orangu generates the canonical summary and check labels. The intent must also omit top-level `before` and `after`, and each check must omit `ok`, `before`, `after`, and `evidence`. Those are computed by Orangu, not asserted by the skill. The unordered metric/comparison set must exactly match the proposal's reviewed `verificationChecks`; the persisted receipt uses proposal order.

The CLI resolves every baseline and later selector through configured supported session roots. Each must be an immutable, non-partial transcript snapshot whose complete main/sidecar/metadata file manifest has been quiet for at least 30 minutes. That means settled for this comparison, not provider-confirmed completion. Resolved sessions must be distinct and use the proposal's canonical workspace; later ids may not overlap baseline ids; every baseline timeline must end before application; and every later session must start after the application transition and every baseline session. Orangu computes the average metric values and refuses the transition if any requested comparison fails. Repo verification is unavailable until a real fresh-cohort comparator exists; global apply and verification are unavailable.

On success, the append-only record receives the normalized result:

```ts
SuggestionVerificationReceipt = {
  v: 1,
  summary: string,
  measuredSessionIds: string[],
  checks: Array<{
    name: string,
    metric: SuggestionVerificationMetric,
    comparison: SuggestionVerificationComparison,
    before: number,
    after: number,
    evidence: string,
    ok: true
  }>,
  receiptPath: string
}
```

The record's `effect.before` and `effect.after` maps are derived from the same computed checks. A successful current verifier also writes `verificationTrust: "computed-v1"`; readable legacy verified records lack that marker and must not be presented as current computed verification. Without a passing computed receipt, status remains `applied`.
