# Orangu proposal and verification artifacts

Write valid JSON with the exact suggestion id. Project paths are relative and may not include `.`, `..`, or `.git`.

The human file `~/.orangu/proposals/<id>.md` includes title, suggestion/rule/scope, one change class, evidence sessions, effort, change, evidence, expected effect, risks, sources, affected files, and scope-appropriate verification limits.

The machine manifest `~/.orangu/proposals/<id>.json` has this exact shape:

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
  "verificationChecks": [{ "metric": "avgToolCalls", "comparison": "decreased" }],
  "files": ["relative/file.md"],
  "sources": [
    { "kind": "catalog", "label": "catalog: cli-ripgrep" },
    { "kind": "inference", "label": "Smallest change consistent with the evidence" }
  ],
  "rank": 1
}
```

Allowed change classes: `instruction`, `script-cli`, `hook`, `skill-create`, `skill-discover`, `subagent-agent`, `mcp`, `plugin`, `workflow-config`. Effort is `S`, `M`, or `L`. `files` contains 1-64 reviewed relative paths. `verificationChecks` contains 1-32 unique supported metric/comparison pairs. A catalog source must name a real shipped entry exactly as `catalog: <id>`; omit its URL and date because Orangu derives the catalog-owned metadata. A research source requires the direct HTTPS page actually opened and a non-null checked `YYYY-MM-DD` date. An inference source has neither URL nor date. A discovery candidate whose `verifiedAt` is `null` stays in chat and must not be copied into this manifest.

Session proposals may be applied and later verified against immutable, non-partial baseline/later manifests quiet for at least 30 minutes, with timeline ordering around application. Quiet means a settled snapshot, not provider-confirmed completion. Repo proposals may be applied but remain `applied` until a real fresh-cohort comparator exists. Global proposals are review-only and may not be applied or verified.

For a real later supported session, write `~/.orangu/proposals/<id>.verified.json` as an intent describing what Orangu should measure:

```json
{
  "v": 1,
  "id": "sg_000000000000",
  "measuredSessionIds": ["later-session-id"],
  "checks": [{ "metric": "avgToolCalls", "comparison": "decreased" }]
}
```

Supported metrics are `avgTotalTokens`, `avgToolCalls`, `avgToolErrors`, `avgActiveMs`, `avgContextPeak`, `avgTestRunsFailed`, `avgBuildRunsFailed`, and `avgInterruptions`. Comparisons are `decreased`, `not-increased`, `increased`, `not-decreased`, and `equal`.

The receipt pairs must exactly match proposal `verificationChecks`. Omit summary and check names; Orangu generates them deterministically. Never include `before`, `after`, `evidence`, or `ok`, and never reuse a baseline selector. Verification is session-only. Orangu resolves the real sessions from configured roots, revalidates the proposal's canonical workspace identity, requires immutable non-partial baseline/later manifests quiet for at least 30 minutes, enforces baseline-end/application/later-start ordering, computes averages, and accepts only passing comparisons. Quiet means a settled snapshot, not provider-confirmed completion.
