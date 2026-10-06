# Show-me slot rules

The two templates, `slides.html` (the slide deck) and `report.html` (the written report), use the same slots and these rules. Each template renders a complete sample. Every sample value starts with the word `EXAMPLE`, and every sample chart has a `data-sample` attribute. Fill a copy of each template, and change only what these rules name.

## The attributes

| Attribute | What you do |
|---|---|
| `data-slot="<name>"` | Replace the text of the element. Keep the element and its attributes. |
| `data-f="<format>"` | The element shows a number. Put the raw CLI value in `data-v`, and its formatted value in the text. |
| `data-repeat="<name>"` | Copy the element once for each item, up to `data-max`. With 0 items, delete it. |
| `data-empty="<name>"` | Keep it only when the list `<name>` has 0 items. Else, delete it. |
| `data-if="<condition>"` | Keep it only when its condition holds. Else, delete it. |
| `data-chart="<name>"` | Set the chart values that the chart table names. Then delete its `data-sample` attribute. |

On `<html>`, set `data-scope` to `session`, `repo` or `global`. Set `data-live`, `data-caution` and `data-redacted` to `true` or `false`.

Escape each text that you insert: `&` as `&amp;`, `<` as `&lt;`, `>` as `&gt;`, `"` as `&quot;` and `'` as `&#39;`. Use no other numeric character reference. Do not change the `<style>` and `<script>` blocks or the image data. The page runs its script only when the script is unchanged, because the page pins it by its hash. Do not add an attribute that loads anything. Keep every sentence that has no slot word for word.

## Conditions

| Condition | It holds when |
|---|---|
| `session`, `repo`, `global` | the scope has this name |
| `aggregate` | the scope is `repo` or `global` |
| `live` | `session.live` is true |
| `caution` | `parse.reconciliation.ok` is false |
| `reconciled` | `parse.reconciliation.ok` is true, and always in repo and global scope |
| `redacted` | a finding on the page has an empty detail |
| `findings` | the list `finding` has 1 item or more |
| `improvements` | the list `improvement` has 1 item or more |
| `turns` | the finding has 1 turn index or more (per finding) |
| `savings` | the item has a token saving over 0 (per item) |
| `savings-ms` | the item has a time saving over 0 (per item) |

## Number formats

| `data-f` | Text | Examples |
|---|---|---|
| `tok` | tokens | 950 → 950, 12,345 → 12.3k, 1,234,567 → 1.23M |
| `ms` | milliseconds | 870 → 870ms, 4,200 → 4.2s, 750,000 → 12m 30s, 7,500,000 → 2h 5m |
| `pct` | a ratio | 0.834 → 83% |
| `num` | a count | 1234 → 1,234 |
| `date` | epoch milliseconds | the UTC date, YYYY-MM-DD |
| `time` | epoch milliseconds | the UTC date and time, YYYY-MM-DD HH:MM |

The page formats each `data-v` again when it opens, so the text and the value always agree. Put `≈` before a saving, because the rule that claims it estimates it. Never show a saving of 0.

## Session scope: `orangu analyze '<session>' --json --slim`

| Slot | Value |
|---|---|
| `title` | `session.title`. If it is missing or empty, "Session " and the first 8 characters of `session.id`. Default redaction empties it. |
| `project` | `session.projectSlug`. If it is missing, delete the element. |
| `date` | `session.startedAt` (`date`). If it is missing, delete the element. |
| `models` | each `session.models[].displayName`, joined with ", " |
| `live-at` | `generator.generatedAt` (`time`) |
| `version` | `generator.version` |
| `generated` | `generator.generatedAt` (`date`), in the footer of the written report |
| `quality` | the outcome phrase, built as "The quality value" says |
| `quality-note` | from `summary.ending`: `clean` → "The last check it ran passed." `interrupted` → "You stopped it." `failing` → "The last test run failed." `unknown` → "No test or build run to judge." Also set `data-end` on the same card to that value. |
| `active` | `summary.activeMs` (`ms`) |
| `wall` | `summary.wallMs` (`ms`). If it is missing, delete it and the words " in total · ". |
| `waiting` | `summary.humanWaitMs` (`ms`) |
| `tokens` | `summary.totalTokens` (`tok`) |
| `cache` | `summary.cacheHitRatio` (`pct`) |
| `output` | `tokens.byKind.output` (`tok`) |
| `caution-pct` | `parse.reconciliation.matchesWithinPct`, as the CLI prints it |
| `cwd` | `session.cwd`. If it is missing, write "the project directory". |
| `session-id` | `session.id`, the full id |

**The quality value.** Join these parts with " · ", in this order. Write a part only when its count is over 0. Use the singular for 1. Each count is one CLI value: never add two values.

1. "`n` PRs": the length of `summary.outcomes.prLinks`
2. "`n` commits": `gitCommits`
3. "`n` files edited": `filesEdited`
4. "`n` files written": `filesWritten`
5. "`f` of `n` build runs failed": `buildRunsFailed` and `buildRuns`
6. "`f` of `n` test runs failed": `testRunsFailed` and `testRuns`. With no failed test run, write "`n` test runs green".

With no part, write "No commits, PRs or test runs".

**Findings.** Use the insights that `summary.topInsightIds` names, in that order, up to 3. For each one, copy the `finding` element and set `data-sev` to `insight.severity`.

| Slot | Value |
|---|---|
| `f-i`, `f-k` | the position of the finding, and the count of findings |
| `f-sev` | `insight.severity` |
| `f-title` | `insight.title` |
| `f-evidence` | `insight.detail`. If it is empty, write "orangu hides these details because they quote commands and output." |
| `f-turns` | each of the first 5 values of `insight.turnIndexes` as "#" and the value, joined with ", ". The report writes turns the same way: "#0" is the first prompt. |
| `turn-count`, `turn-noun` | `summary.turns` (`num`), then "turn" when it is 1, else "turns" |
| `f-savings`, `f-savings-ms` | `insight.savings.tokens` (`tok`), `insight.savings.ms` (`ms`) |
| `f-rule` | `insight.ruleId` |
| `f-improvement` | `insight.recommendation` |

**Improvements.** Use the same insights in the same order, then the other insights in CLI order, up to 5. Skip an insight whose recommendation starts with "No change needed". `i-text` is the first sentence of `insight.recommendation`. `i-savings`, `i-savings-ms` and `i-rule` follow the finding rules.

## Repo and global scope: `evidence.json`

| Slot | Value |
|---|---|
| `title` | "Recurring patterns in " and the folder name of the repository, or "Recurring patterns on this machine" |
| `sessions`, `kpi-sessions` | `source.sessions` (`num`) |
| `session-noun` | "session" when `source.sessions` is 1, else "sessions" |
| `kpi-findings` | `totalFindings` (`num`) |
| `kpi-top-n`, `kpi-top-rule` | `findings[0].finding.evidence.sessions` (`num`), `findings[0].finding.ruleId` |
| `version` | the output of `orangu --version` |

This scope has no date, no `live-at` and no `generated` slot. Delete the elements that hold them.

With 0 findings, keep the Top pattern card with `data-empty="finding"` as it is, and delete the one with `data-if="findings"`. Its text is fixed, so you invent no top pattern.

**Findings.** Use the first 3 of `findings`, in order. Set `data-sev` to `severity`.

| Slot | Value |
|---|---|
| `f-title` | `finding.title` |
| `f-evidence` | `detail`, with the session fallback |
| `f-rule` | `finding.ruleId` |
| `f-shows` | `finding.evidence.sessions` (`num`) |
| `f-examples` | the first 8 characters of each of the first 5 `finding.sessionIds`, joined with ", " |
| `f-savings`, `f-savings-ms` | `finding.evidence.savingsTokens` (`tok`), `finding.evidence.savingsMs` (`ms`) |
| `f-improvement` | `recommendation`. If it is missing, write "No improvement text in this evidence." |

**Improvements** follow the session rules over the same list.

## Charts

| `data-chart` | Values |
|---|---|
| `time` | `--n` in the `style` of each `<i data-k>`: `active` is `summary.activeMs`, `waiting` is `summary.humanWaitMs`. |
| `tokens` | `--n` of each `<i data-k>` from `tokens.byKind`: `read` is `cacheRead`, `write5m` is `cacheWrite5m`, `write1h` is `cacheWrite1h`, `input` is `input`, `output` is `output`. Delete each `<i>` and legend `<span>` whose value is 0. |
| `cache` | `stroke-dasharray` of `circle.val`: the `cache` percent without the % sign, then " 100". |
| `share` | `pathLength` of both circles: `source.sessions`. `stroke-dasharray` of `circle.val`: the `n` of that slot, a space, then `source.sessions`. |
| `turns` | `viewBox` of the `<svg>`: "0 0 `summary.turns` 1". `width` of `rect.trk`: `summary.turns`. One `rect.hit` for each turn index, up to 50, with `x` set to the index. |

Use the raw CLI values. Never scale or round them. On the element with `role="img"`, set `aria-label` to the values in words, for example "Tokens by kind: cache read 56,900, output 305". Then delete `data-sample` from the chart element.

## Text that you write

Write in STE. Use no judgement word, no score and no number that the file does not show.

| Slot | Limit |
|---|---|
| `verdict` | 1 sentence, 20 words or fewer. Say how the session ended and what it produced. In repo and global scope, name the main pattern. |
| `summary` | 3 to 5 sentences, 90 words or fewer. Only in the written report. |
| `f-why` | 2 sentences or fewer, 30 words or fewer. Say why the finding matters. |
| `improvements-title` | 10 words or fewer |
