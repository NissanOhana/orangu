# Orangu proposal and verification artifacts

Write valid JSON, not JSON with comments. Use the exact suggestion id in each filename and `id` field. Keep project paths relative. Never include an absolute path, `..`, or `.git`.

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

Field rules:

- `changeClass` is one of `instruction`, `script-cli`, `hook`, `skill-create`, `skill-discover`, `subagent-agent`, `mcp`, `plugin`, `workflow-config`.
- `effort` is `S`, `M`, or `L`.
- `files` contains 1-64 reviewed relative project paths.
- `verificationChecks` contains 1-32 unique metric/comparison pairs from the supported lists below.
- Omit `sources` and `rank` only when they do not apply.

Source rules:

- A catalog source must name a real shipped entry exactly as `catalog: <id>`. Omit its URL and date, because Orangu derives the metadata that the catalog owns.
- A research source requires the direct HTTPS page opened while the skill ran, and a non-null checked `YYYY-MM-DD` date.
- An inference source has no URL and no date.
- A discovery candidate whose `verifiedAt` is `null` stays in chat. Do not copy it into this manifest.

`/orangu:harness` proposals are ranked structured reviews. Repo-scope proposals are apply-compatible. Global-scope proposals use the same manifest for review, but they are proposal-only. A harness proposal must include `rank`, a nonempty `files` list and a nonempty `sources` list. It must also include every required evidence, effect, risk and verification field above. A recommendation without a concrete relative repository file or an honest source stays a chat recommendation, not a `proposed` record.

Lifecycle authority depends on the scope. Session and repo proposals may be applied and later verified. Global proposals are review-only, and they may not be applied or verified.

## Verification

Verification needs no skill-written file, because Orangu computes it. `orangu suggest --effect <id>` is read-only. `orangu suggest --set <id> verified` records the result only when the verdict is `verified`. Orangu still accepts an older `<id>.verified.json` intent, but that file chooses nothing. Do not write one.

Orangu picks both sides from the canonical workspace of the proposal, and it cuts them at the recorded application time:

- The baseline is up to 10 settled sessions that ended before that time, leaving out the finding's own sessions. Orangu leaves them out because they were chosen for going badly.
- The later side is up to 10 settled sessions that started after that time.
- A session that spans the application time counts on neither side. A session that ran orangu itself (such as a verify check-in) also counts on neither side.
- A settled session is quiet for at least 30 minutes and has no partial line.

An exact rank test grades each reviewed check. A `decreased` or `increased` check must beat chance at p ≤ 0.05. A guard (`not-increased`, `not-decreased`, `equal`) must not move the wrong way beyond chance. Both kinds need at least three sessions on each side. The verdict is `verified`, `within-noise`, `regressed`, `not-enough-sessions` or `no-directional-check`. Only `verified` changes state.

Orangu names in `confoundedBy` the other changes applied in the same workspace inside the measured window. A `verified` result says that later sessions beat the baseline beyond chance. It does not prove the change caused it.

Supported metrics: `avgTotalTokens`, `avgToolCalls`, `avgToolErrors`, `avgActiveMs`, `avgContextPeak`, `avgTestRunsFailed`, `avgBuildRunsFailed`, `avgInterruptions`.

Supported comparisons: `decreased`, `not-increased`, `increased`, `not-decreased`, `equal`.

Choose checks that the change directly moves, plus one guard for what must not get worse. Every directional check must clear the noise. A check that the change cannot move only makes verification harder.
