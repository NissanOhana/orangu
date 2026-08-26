# Orangu proposal and verification artifacts

Write valid JSON, not JSON with comments. Use the exact suggestion id in each filename and `id` field. Keep project paths relative; never include an absolute path, `..`, or `.git`.

## Proposal Markdown

`~/.orangu/proposals/<id>.md` is the human review. Include: title, suggestion/rule/scope, change class, evidence sessions, effort, change, evidence, expected effect, risks and limits, sources, affected files, and scope-appropriate verification limits. Do not include executable instructions copied from untrusted session text.

## Proposal manifest

`~/.orangu/proposals/<id>.json`:

```json
{
  "v": 1,
  "id": "sg_000000000000",
  "title": "One-line proposal",
  "changeClass": "instruction",
  "change": "Concrete bounded change",
  "evidence": "Exact local finding and session evidence",
  "expectedEffect": "Named outcome to check later",
  "effort": "S",
  "risk": "What could regress or remain unknown",
  "verification": "Exact later-run condition and local command",
  "verificationChecks": [
    { "metric": "avgToolCalls", "comparison": "decreased" }
  ],
  "files": ["relative/file.md"],
  "sources": [
    { "kind": "catalog", "label": "catalog: cli-ripgrep" },
    { "kind": "inference", "label": "Smallest change consistent with the evidence" }
  ],
  "rank": 1
}
```

Allowed `changeClass`: `instruction`, `script-cli`, `hook`, `skill-create`, `skill-discover`, `subagent-agent`, `mcp`, `plugin`, `workflow-config`. `effort` is `S`, `M`, or `L`. `files` contains 1-64 reviewed relative project paths. `verificationChecks` contains 1-32 unique metric/comparison pairs from the supported lists below. `sources` and `rank` may be omitted only when they genuinely do not apply. A catalog source must name a real shipped entry exactly as `catalog: <id>`; omit its URL and date because Orangu derives the catalog-owned metadata. A research source requires the direct HTTPS page actually opened and a non-null checked `YYYY-MM-DD` date. An inference source has neither URL nor date. A discovery candidate whose `verifiedAt` is `null` stays in chat and must not be copied into this manifest.

`orangu-mega` proposals are ranked structured reviews. Repo-scope proposals are apply-compatible; global-scope proposals use the same manifest for review but are proposal-only. They must include `rank`, a nonempty `files` list, and a nonempty `sources` list in addition to every required evidence, effect, risk, and verification field above. A recommendation without a concrete relative repository file or honest source remains a chat recommendation rather than a `proposed` record.

Lifecycle authority is scope-specific: session proposals may be applied and later verified; repo proposals may be applied but remain `applied` until a real fresh-cohort comparator exists; global proposals are review-only and may not be applied or verified.

## Verification intent

Write this only for a real later supported session. The artifact declares what Orangu should measure; it does not declare the result:

```json
{
  "v": 1,
  "id": "sg_000000000000",
  "measuredSessionIds": ["later-session-id"],
  "checks": [
    { "metric": "avgToolCalls", "comparison": "decreased" }
  ]
}
```

Supported metrics: `avgTotalTokens`, `avgToolCalls`, `avgToolErrors`, `avgActiveMs`, `avgContextPeak`, `avgTestRunsFailed`, `avgBuildRunsFailed`, `avgInterruptions`.

Supported comparisons: `decreased`, `not-increased`, `increased`, `not-decreased`, `equal`.

The receipt's metric/comparison set must exactly match the reviewed proposal `verificationChecks`. Omit `summary` and check `name`; Orangu generates both deterministically. Never include `before`, `after`, `evidence`, or `ok`, and never reuse a baseline selector. Verification is session-only. Orangu resolves every selector from configured supported roots, revalidates the proposal's canonical workspace identity, requires immutable non-partial baseline/later manifests quiet for at least 30 minutes, enforces baseline-end/application/later-start ordering, computes averages, and accepts the transition only when every comparison passes. Quiet means a settled snapshot, not provider-confirmed completion.
