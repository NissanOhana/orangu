/**
 * STE floors and banned-token ceilings: one row per gated surface in scripts/ste-surfaces.ts.
 * test/ste.test.ts holds each surface to its row; `npm run ste` prints every score beside its row.
 */
export interface SteRow {
  /** the lowest STE score the surface may have: the percent of its sentences with no finding */
  floor: number
  emDash: number
  eg: number
  ie: number
  etc: number
  contractions: number
}

export const BANNED = ['emDash', 'eg', 'ie', 'etc', 'contractions'] as const

// Floors and ceilings, not targets: each row is the value MEASURED on the day it landed. A floor may only
// rise and a banned ceiling may only fall; either change needs nothing. Lowering a floor or raising a
// ceiling is allowed only in the same commit that measures a deliberate, named reason, with the measured
// value and the reason written here and in the commit body; otherwise the chunk stops and escalates
// rather than loosening the row (PROJECT.md §Testing).
// Born 2026-10-06 on main e09728a, before any copy rewrite: each floor is the measured score minus 2
// points of headroom (never under 0), and each ceiling is the measured count. Born again the same day,
// before the first merge, when review found copy the extraction missed (table cells, headings and labels
// for banned tokens, HTML attributes, meta tags and inline scripts, every src/ folder and user doc), and
// text that it deleted: a TS literal with "<" in prose is now read as text, not stripped as a tag
// (src/analyze/insights.ts:1582). The three rows that loosened name their measured cause above the row.
// A chunk that rewrites a surface raises its own rows in its regenerate commit: to max(80, measured - 2)
// when the score reaches 80, else to measured - 2. The close-out target is a floor of 80 or more and 0
// banned tokens on every row.
// One group per owning chunk, one comment line between groups; a row never moves between groups.
export const STE_FLOORS: Readonly<Record<string, SteRow>> = {
  // S1: README, the landing, 404 and llms sources, the npm description, the sample page copy
  'README.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 after the STE rewrite
  'site/index.src.html': { floor: 97, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 99 after the STE rewrite
  'site/404.html': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 after the STE rewrite
  'site/llms.src.txt': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 after the STE rewrite
  'package.json#description': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 after the STE rewrite
  'scripts/build-sample.ts': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 after the STE rewrite
  // S2: every user doc in docs/
  'docs/DETERMINISM.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (205 sentences) after the STE rewrite, was 74 with 2 em dashes
  'docs/README.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (18 sentences) after the STE rewrite, was 94
  'docs/USAGE.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (109 sentences) after the STE rewrite, was 82
  'docs/feedback.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (23 sentences) after the STE rewrite, was 95
  // P1a: improve, apply, feedback, shared, and the Codex copy (yaml, manifest, mirror fallback)
  // Raised by the P1a STE rewrite of each file (one instruction per sentence, no semicolon lists, vertical
  // lists, simple tenses, the product nouns). Each row: the measured score, then what still holds it down.
  'plugin/skills/apply/SKILL.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (55 of 55). P1b moved the pinned "applied locally, not yet verified; verify ..." to two sentences, quoted as one said text
  'plugin/skills/apply/references/application-contract.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (16 of 16) after the rewrite
  'plugin/skills/feedback/SKILL.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (31 of 31) after the rewrite
  'plugin/skills/improve/SKILL.md': { floor: 96, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 98 (89 of 91): the 30-word network-disclosure list and the 26-word routing sentence in the description. P1b moved the pinned "Orangu picks the sessions; never choose them." to two sentences
  'plugin/skills/improve/references/artifact-contract.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (56 of 56) after the rewrite
  'plugin/skills/shared/interview.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (47 of 47) after the rewrite
  'plugin/skills/shared/ste.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // new surface, measured 100 (86 of 86, table cells included)
  'plugin/skills/shared/untrusted-input.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (37 of 37) after the rewrite
  'plugin/codex/*/openai.yaml': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (6 of 6), no change was needed
  'plugins/orangu/.codex-plugin/plugin.json#interface': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (9 of 9): the 33-word long description became 3 sentences
  // Z: floor 65 -> 98. Measured 100 (6 of 6, was 2 of 3, score 67). The Codex CLI fallback was one 36-word
  // sentence. It is now 5 short sentences, with the same 2 paths in the same order.
  'scripts/build.mjs#codex': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // P1b: analyze, harness, the agents, the skills catalog, the plugin and marketplace descriptions
  // Raised by the P1b STE rewrite of each file (no semicolon, split sentences, vertical lists, simple tenses, the
  // product nouns). Each row: the measured score, then what still holds it down.
  'plugin/agents/harness-devex-analyst.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (41 of 41) after the rewrite
  'plugin/agents/harness-pm-analyst.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (40 of 40) after the rewrite
  'plugin/agents/harness-researcher.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (43 of 43) after the rewrite
  'plugin/skills/README.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (22 of 22) after the rewrite
  'plugin/skills/analyze/SKILL.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (68 of 68) after the rewrite
  'plugin/skills/analyze/references/json-shape.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (26 of 26): "e.g." became "for example"
  // re-born 71 -> 66 and contractions 0 -> 1: table cells are now scored. Measured 75 sentences, 51 clean,
  // score 68 (was 37 sentences, score 73). The cell at :25 holds "can't", and the cells carry 14 semicolons.
  'plugin/skills/analyze/references/reading-the-report.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (116 of 116): the table cells are sentences, and "can't" became "cannot"
  'plugin/skills/harness/SKILL.md': { floor: 94, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 96 (109 of 114): 5 long sentences hold pinned lists (the 9 change classes, the network-disclosure list, the manifest fields, the per-item disclosure, the "echoing ... just before each invocation" apply rule) under the 1,400-word body ceiling
  'plugin/skills/harness/references/research-sources.md': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (34 of 34) after the rewrite
  'plugin/.claude-plugin/plugin.json#description': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (2 of 2): the 28-word sentence became 2
  '.claude-plugin/marketplace.json#description': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (4 of 4): the 31-word sentence became 2
  // K: help, every CLI and engine folder under src/, the catalog notes
  // Raised by the K STE rewrite (split semicolon pairs, simple tenses, the actor named, one word for one
  // thing). Each row: the measured score, then what still holds it down and why it stays.
  'orangu --help': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (75 of 75): "don't" and 4 semicolons gone
  // measured 90 (37 of 41). The 3 "changed while it was being read" errors stay: the retry regex in
  // parse.ts parses them. The duplicate_uuid warning (parse.ts:579) is cached Analysis payload copy.
  'src/adapters': { floor: 88, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'src/cache': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (10 of 10), no change was needed
  'src/cli': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (234 of 234): the printHelp template, 20 semicolons, "is running"
  'src/discover': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (17 of 17): the 4 current-session errors split
  'src/feedback': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (2 of 2), no change was needed
  'src/harness': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (21 of 21): the notes split, the no-config note now matches the report
  'src/redact': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (1 of 1), no change was needed
  // measured 97 (28 of 29). tail.ts:127 keeps "changed while it was being read": one phrase for every
  // read-race error. The adapter retry regex (parse.ts:261) parses only the evidence-input.ts messages
  'src/serve': { floor: 95, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // measured 99 (230 of 233). Kept on purpose: the cohort receipt summary (verification-policy.ts:73)
  // and the check evidence line (cohort-stats.ts:159) are stored in each verified record and compared
  // byte for byte on read, and artifacts.ts:196 is the read-race phrase
  'src/suggest': { floor: 97, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // measured 83 (5 of 6). stable-file.ts:85 keeps the read-race phrase: one phrase for every read-race
  // error. The adapter retry regex does not parse it (parse-retry.test.ts "classifies exactly the two transient forms")
  'src/util': { floor: 81, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'src/suggest/catalog.json#note': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (52 of 52): 11 notes rewritten, no claim, id, URL or verifiedAt moved
  'src/suggest/features.json#note': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 }, // measured 100 (22 of 22): 7 notes rewritten, no claim, id, URL or verifiedAt moved
  // R1, R2: the report
  // raised 89 -> 96 by the report copy rewrite (R1, 2026-10-06). Measured 310 sentences, 304 clean, score 98
  // (was 293 sentences, 268 clean, score 91). The 6 findings left are in the improvement screens (R2).
  'src/report/client': { floor: 96, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // B2: rule copy, and every other analyzer string
  // B2: floor 91 -> 98. Measured 46 sentences, 46 clean, score 100. The rule copy rewrite took out the 2
  // semicolons (script-candidate, fanout-opportunity) and the progressive "was waiting" (human-wait-dominates).
  'src/analyze/insights.ts#title': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // B2: floor 58 -> 98. Measured 29 sentences, 29 clean, score 100. Every list in a detail joins with " · ",
  // not "; ", and each static detail sentence is split at its semicolon. "just" is gone (preamble-weight).
  'src/analyze/insights.ts#detail': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // B2: floor 64 -> 98. Measured 179 sentences, 179 clean, score 100 (was 108 sentences, score 66). Each
  // recommendation starts with its fix, one instruction to a sentence, 6 sentences or fewer, no semicolon.
  'src/analyze/insights.ts#recommendation': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // re-born 86 -> 79 and e.g. 0 -> 1. Measured 16 sentences, 13 clean, score 81 (was 14 clean, score 88).
  // insights.ts:1582 is now read as text: it has a semicolon and 26 words. The label `e.g. ${title}` at
  // aggregate.ts:119 now counts its e.g.
  // B1: floor 79 -> 80 and e.g. 1 -> 0. Measured 17 sentences, 14 clean, score 82. The cross-finding label
  // is now `In one session: ${title}` (aggregate.ts:124): one more scored sentence, clean, and no e.g.
  // B2: floor 80 -> 98. Measured 23 sentences, 23 clean, score 100. The narrative splits its busy-time clause
  // into its own sentence (analyze.ts:206), and the fanout-opportunity heuristic and model-for-task
  // criteria evidence notes are short sentences with no semicolon.
  'src/analyze': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // B1, B2: the golden emitted copy
  // B2: floor 90 -> 98. Measured 12 sentences, 12 clean, score 100. The fanout-opportunity title in
  // agents-heavy lost its semicolon.
  'test/golden#insight.title': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // B2: floor 42 -> 98. Measured 11 sentences, 11 clean, score 100. Detail lists join with " · ", and the
  // unverified-edits detail is 3 sentences instead of 3 clauses joined by semicolons.
  'test/golden#insight.detail': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // B2: floor 66 -> 98. Measured 40 sentences, 40 clean, score 100 (was 25 sentences, score 68): the
  // rewritten rule copy, as the 7 golden fixtures emit it.
  'test/golden#insight.recommendation': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // re-born e.g. 10 -> 11: a label now counts its banned tokens. Measured 11 titles, each with "e.g.". The
  // 11th, "e.g. 1 hook error", has 2 words, and the old extraction dropped it as a fragment.
  // B1: floor 0 -> 89 and e.g. 11 -> 0. Measured 11 sentences, 10 clean, score 91. Every title now starts
  // "In one session: " instead of "e.g. "; the one finding left is a rule-title semicolon (aggregate.json:252).
  // B2: floor 89 -> 98. Measured 11 sentences, 11 clean, score 100. That fanout-opportunity title now joins
  // its clauses with ", so", not a semicolon.
  'test/golden#crossFinding.title': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // B1: born at measurement. Measured 25 sentences, 17 clean, score 68 (floor 66), 0 banned tokens. The new
  // CrossFinding.recommendation carries the rule copy of the example insight, so it scores like
  // test/golden#insight.recommendation (25 sentences, 68) until B2 rewrites that copy.
  // B2: floor 66 -> 98. Measured 40 sentences, 40 clean, score 100: the rewritten rule copy of the 11
  // example insights.
  'test/golden#crossFinding.recommendation': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
}
