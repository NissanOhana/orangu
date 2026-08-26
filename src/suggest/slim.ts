/**
 * SlimAnalysis: the projection of Analysis that LLM consumers read.
 * Drops the multi-MB fields (`turns`, `tools.calls`, `context.series`, `events`, `parse`) and keeps the
 * exact evidence a suggest pass needs. Target: ≤ 40 KB on the largest session, < 20 KB on fixtures.
 */
import type {
  Analysis,
  AgentsAnalysis,
  ContextAnalysis,
  TokensAnalysis,
  FilesAnalysis,
  QualityAnalysis,
  Reconciliation,
  ToolsAnalysis,
} from '../model/analysis.js'

export type SlimAnalysis = Pick<Analysis, 'schemaVersion' | 'generator' | 'session' | 'summary' | 'insights'> & {
  slim: true
  tools: Pick<ToolsAnalysis, 'byName' | 'errorGroups'>
  files: Pick<FilesAnalysis, 'mostReRead'>
  tokens: Pick<TokensAnalysis, 'total' | 'totalTokens' | 'byModel' | 'byKind'>
  agents: Pick<AgentsAnalysis, 'totals' | 'byType'>
  context: Pick<ContextAnalysis, 'peak' | 'baseline' | 'final' | 'contextWindow' | 'cacheHitRatio' | 'reReadMultiplier' | 'compactions'>
  quality: Pick<QualityAnalysis, 'signals'>
  parse: { reconciliation: Reconciliation }
}

export function slimAnalysis(a: Analysis): SlimAnalysis {
  return {
    schemaVersion: a.schemaVersion,
    generator: a.generator,
    slim: true,
    session: a.session,
    summary: a.summary,
    insights: a.insights,
    tools: { byName: a.tools.byName, errorGroups: a.tools.errorGroups },
    files: { mostReRead: a.files.mostReRead },
    tokens: { total: a.tokens.total, totalTokens: a.tokens.totalTokens, byModel: a.tokens.byModel, byKind: a.tokens.byKind },
    agents: { totals: a.agents.totals, byType: a.agents.byType },
    context: {
      peak: a.context.peak,
      baseline: a.context.baseline,
      final: a.context.final,
      contextWindow: a.context.contextWindow,
      cacheHitRatio: a.context.cacheHitRatio,
      reReadMultiplier: a.context.reReadMultiplier,
      compactions: a.context.compactions,
    },
    quality: { signals: a.quality.signals },
    parse: { reconciliation: a.parse.reconciliation },
  }
}
