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

`orangu harness` proposals are ranked structured reviews. Repo-scope proposals are apply-compatible; global-scope proposals use the same manifest for review but are proposal-only. They must include `rank`, a nonempty `files` list, and a nonempty `sources` list in addition to every required evidence, effect, risk, and verification field above. A recommendation without a concrete relative repository file or honest source remains a chat recommendation rather than a `proposed` record.

Lifecycle authority is scope-specific: session and repo proposals may be applied and later verified; global proposals are review-only and may not be applied or verified.

## Verification

Verification needs no skill-written file: Orangu computes it. `orangu suggest --effect <id>` is read-only; `orangu suggest --set <id> verified` records the result only when the verdict is `verified`. An older `<id>.verified.json` intent is still accepted but chooses nothing; do not write one.

Orangu picks both sides from the proposal's canonical workspace, cut at the recorded application time: the baseline is up to ten settled sessions that ended before it, leaving out the finding's own sessions (they were chosen for going badly), and the later side is up to ten settled sessions that started after it. A session that spans the application, or that ran orangu itself (such as a verify check-in), counts on neither side; settled means quiet for at least 30 minutes with no partial line.

Each reviewed check is graded with an exact rank test. A `decreased` or `increased` check must beat chance at p ≤ 0.05 and a guard (`not-increased`, `not-decreased`, `equal`) must not move the wrong way beyond chance, with at least three sessions on each side. The verdict is `verified`, `within-noise`, `regressed`, `not-enough-sessions`, or `no-directional-check`; only `verified` changes state. Other changes applied in the same workspace inside the measured window are named in `confoundedBy`. A `verified` result says later sessions beat the baseline beyond chance; it does not prove the change caused it.

Supported metrics: `avgTotalTokens`, `avgToolCalls`, `avgToolErrors`, `avgActiveMs`, `avgContextPeak`, `avgTestRunsFailed`, `avgBuildRunsFailed`, `avgInterruptions`.

Supported comparisons: `decreased`, `not-increased`, `increased`, `not-decreased`, `equal`.

Choose checks the change directly moves, plus one guard for what must not get worse. Every directional check must clear noise, so a check the change cannot move only makes verification harder.
