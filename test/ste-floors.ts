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
// for banned tokens, HTML attributes, meta tags and inline scripts, every src/ folder and user doc).
// A chunk that rewrites a surface raises its own rows in its regenerate commit: to max(80, measured - 2)
// when the score reaches 80, else to measured - 2. The close-out target is a floor of 80 or more and 0
// banned tokens on every row.
// One group per owning chunk, one comment line between groups; a row never moves between groups.
export const STE_FLOORS: Readonly<Record<string, SteRow>> = {
  // S1: README, the landing, 404 and llms sources, the npm description, the sample page copy
  'README.md': { floor: 85, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'site/index.src.html': { floor: 90, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 1 },
  'site/404.html': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'site/llms.src.txt': { floor: 85, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'package.json#description': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'scripts/build-sample.ts': { floor: 80, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // S2: every user doc in docs/
  'docs/DETERMINISM.md': { floor: 72, emDash: 2, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'docs/README.md': { floor: 92, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'docs/USAGE.md': { floor: 80, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'docs/feedback.md': { floor: 93, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // P1a: improve, apply, feedback, shared, and the Codex copy (yaml, manifest, mirror fallback)
  'plugin/skills/apply/SKILL.md': { floor: 77, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'plugin/skills/apply/references/application-contract.md': { floor: 67, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'plugin/skills/feedback/SKILL.md': { floor: 71, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'plugin/skills/improve/SKILL.md': { floor: 56, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'plugin/skills/improve/references/artifact-contract.md': { floor: 64, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'plugin/skills/shared/interview.md': { floor: 67, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'plugin/skills/shared/untrusted-input.md': { floor: 62, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'plugin/codex/*/openai.yaml': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'plugins/orangu/.codex-plugin/plugin.json#interface': { floor: 81, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'scripts/build.mjs#codex': { floor: 65, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // P1b: analyze, harness, the agents, the skills catalog, the plugin and marketplace descriptions
  'plugin/agents/harness-devex-analyst.md': { floor: 86, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'plugin/agents/harness-pm-analyst.md': { floor: 84, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'plugin/agents/harness-researcher.md': { floor: 87, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'plugin/skills/README.md': { floor: 63, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'plugin/skills/analyze/SKILL.md': { floor: 71, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'plugin/skills/analyze/references/json-shape.md': { floor: 84, emDash: 0, eg: 1, ie: 0, etc: 0, contractions: 0 },
  'plugin/skills/analyze/references/reading-the-report.md': { floor: 66, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 1 },
  'plugin/skills/harness/SKILL.md': { floor: 57, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'plugin/skills/harness/references/research-sources.md': { floor: 85, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'plugin/.claude-plugin/plugin.json#description': { floor: 0, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  '.claude-plugin/marketplace.json#description': { floor: 65, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // K: help, every CLI and engine folder under src/, the catalog notes
  'orangu --help': { floor: 90, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 1 },
  'src/adapters': { floor: 86, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'src/cache': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'src/cli': { floor: 88, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 1 },
  'src/discover': { floor: 65, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'src/feedback': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'src/harness': { floor: 73, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'src/redact': { floor: 98, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'src/serve': { floor: 91, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'src/suggest': { floor: 92, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'src/util': { floor: 81, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'src/suggest/catalog.json#note': { floor: 61, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'src/suggest/features.json#note': { floor: 43, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // R1, R2: the report
  'src/report/client': { floor: 89, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  // B2: rule copy, and every other analyzer string
  'src/analyze/insights.ts#title': { floor: 91, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'src/analyze/insights.ts#detail': { floor: 58, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'src/analyze/insights.ts#recommendation': { floor: 64, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'src/analyze': { floor: 79, emDash: 0, eg: 1, ie: 0, etc: 0, contractions: 0 },
  // B1, B2: the golden emitted copy
  'test/golden#insight.title': { floor: 90, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'test/golden#insight.detail': { floor: 42, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'test/golden#insight.recommendation': { floor: 66, emDash: 0, eg: 0, ie: 0, etc: 0, contractions: 0 },
  'test/golden#crossFinding.title': { floor: 0, emDash: 0, eg: 11, ie: 0, etc: 0, contractions: 0 },
}
