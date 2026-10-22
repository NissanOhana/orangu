/**
 * The rule ids of the analyzer: each id that a rule of the `RULES` array (`src/analyze/insights.ts`) writes as the
 * `ruleId` of an insight. A test holds this list equal to the ids that `insights.ts` writes, so a new rule fails it
 * until its id is here.
 *
 * This module has no import, so a read that checks a stored rule id adds no module to any bundle that reads it.
 */
export const ANALYZER_RULE_IDS = [
  'agent-fanout',
  'api-errors',
  'binary-attachments',
  'blocking-questions',
  'cache-dominates-tokens',
  'cache-invalidation',
  'cache-ttl-churn',
  'compactions',
  'context-near-limit',
  'deep-fanout',
  'edit-churn',
  'failed-agents',
  'fanout-opportunity',
  'hidden-iterations',
  'hook-errors',
  'hook-latency',
  'human-wait-dominates',
  'idle-agents',
  'interruptions',
  'large-writes',
  'low-cache-hit',
  'mcp-definition-weight',
  'model-fallback',
  'model-for-task',
  'output-burst',
  'oversized-tool-results',
  'preamble-weight',
  'queued-prompts',
  'repeated-commands',
  'reread-files',
  'reverts',
  'script-candidate',
  'sequential-reads',
  'skill-token-weight',
  'slow-first-response',
  'slow-tool',
  'thinking-on-mechanical',
  'time-budget',
  'tool-errors',
  'truncated-reads',
  'unresolved-tool-calls',
  'unverified-edits',
  'user-corrections',
  'write-not-edit',
] as const

export type AnalyzerRuleId = (typeof ANALYZER_RULE_IDS)[number]
