# orangu `--json` shape (schemaVersion 2)

The stable machine contract emitted by `orangu analyze --json`. The HTML report renders the same evidence and the skills read its bounded projection. Breaking changes bump `schemaVersion`. Fields use explicit tokens, milliseconds, bytes, timestamps, ratios, and plain counts from the supported source.

## Top level
```
{
  schemaVersion: "2",
  generator: { name, version, generatedAt, modelCatalogUpdatedAt },
  session:  { id, title?, source, path, subagentPaths[], cwd?, projectSlug?, gitBranches[], clientVersions[], models:[{id,displayName,family,estimatedMatch,contextWindow?}], effortLevels[], startedAt?, endedAt?, live },
  summary:  { turns, humanTurns, messages, assistantMessages, toolCalls, toolErrors, agents, skills, compactions,
              wallMs?, activeMs, humanWaitMs, tokens:Usage, totalTokens, contextPeak, cacheHitRatio,
              outcomes:{ prLinks[], gitCommits, testRuns, testRunsFailed, buildRuns, buildRunsFailed, filesRead, filesEdited, filesWritten, webLookups },
              topInsightIds[], narrative },
  turns:    [ TurnAnalysis ],
  tools:    { byName:[ToolStat], byCategory[], errorGroups[], slowest[], largestResults[], parallelism{}, calls:[ToolCallView] },
  agents:   { runs:[AgentStat], totals{}, byType[], byModel[], maxDepth, concurrentMs, maxConcurrency, mainThreadShare{} },
  skills:   { invocations[], byName[] },
  hooks:    { runs, errors, totalMs, byCommand[], events[] },
  context:  { series:[ContextPoint], compactions[], peak, baseline, final, contextWindow?, cacheHitRatio, cacheWrite1hShare, reReadMultiplier, totalCacheRead, totalCacheWrite, totalFreshInput, totalOutput, requestsPerCompaction[] },
  tokens:   { total:Usage, totalTokens, byModel[], byKind{input,output,cacheRead,cacheWrite5m,cacheWrite1h}, mainThread, agents, byTurn[], byToolCategory[], serverToolRequests{webSearch,webFetch}, hiddenIterations{count,tokens} },
  time:     { wallMs?, activeMs, humanWaitMs, toolMs, agentMs, modelMs, longestTurns[], longestGaps[], firstResponse{p50,p95,max}, hooksMs },
  files:    { files:[FileStat], mostReRead[], totalDistinct, editedThenReverted },
  quality:  { signals:[{id,label,value,tone,detail?,evidenceTurnIndexes?}], testRuns[], buildRuns[], gitCommits[], userCorrections[], interruptions, apiErrors, toolErrorRate, reworkFiles },
  insights: [ Insight ],
  events:   [ {kind, ts?, turnIndex, agentId?, label, detail?} ],
  parse:    { totalLines, badLines, recordCounts{}, unknownRecordTypes{}, unknownBlockTypes{}, attachmentTypes{}, systemSubtypes{}, warnings[], reconciliation:{usageEventsTotal,turnsPlusAgentsTotal,matchesWithinPct,ok} }
}
```

## Key sub-shapes
- **Usage** = `{ input, output, cacheRead, cacheWrite, cacheWrite5m, cacheWrite1h, webSearchRequests, webFetchRequests, serviceTier? }`
- **TurnAnalysis** = `{ index, kind, isCommand, commandName?, promptPreview, promptChars, startTs?, endTs?, durationMs?, reportedDurationMs?, firstResponseMs?, humanGapMs?, autoContinuations, interrupted, toolCalls, toolErrors, toolMs, agents[], models[], tokens:Usage, contextEnd?, totalTokens, insightIds[], activity }`
  - `totalTokens` = this turn's tokens **plus** the tokens of every agent it spawned.
  - `kind` ∈ `human | command | peer | scheduled | notification | local_output | interrupt | meta`: only human/command/peer/scheduled start a turn.
- **ToolStat** = `{ name, category, count, errors, unresolved, totalMs, avgMs, p95Ms, maxMs, resultBytesTotal, resultBytesMax, inputBytesTotal, parallelShare, mainCount, agentCount }`
- **AgentStat** = `{ agentId, name?, agentType?, description?, model?, spawnDepth, parentAgentId?, spawnedByToolUseId?, turnIndex?, startTs?, endTs?, durationMs?, messageCount, toolCallCount, toolErrors, tokens:Usage, totalTokens, reportedTotalTokens?, reportedDurationMs?, status?, hasTranscript }`
- **ContextPoint** = `{ messageUuid, turnIndex, agentId?, ts?, model, contextSize, input, cacheRead, cacheWrite, cacheWrite1h, output }`
- **Insight** = `{ id, ruleId, severity(info|low|medium|high), axis(quality|time|tokens|context), title, detail, recommendation, evidence{}, turnIndexes[], savings?{tokens?,ms?,estimated}, personas[] }`
  - `savings.tokens` is a **token count**, present only when following the recommendation would have caused fewer tokens to be sent or generated. A rule whose change would merely move the same tokens (a cache tier, a different model) omits `savings` entirely; do not invent one for it.

## Aggregate (`orangu repo/global --json`)
```
{ schemaVersion, generatedAt, scope, sessionCount,
  totals{tokens,toolCalls,toolErrors,agents,turns,humanTurns,wallMs,activeMs,compactions,prs,commits},
  averages{tokensPerSession,tokensPerHumanTurn,toolErrorRate,cacheHitRatio,agentsPerSession,contextPeak},
  byModel[], byProject[], byTool[], byAgentType[], bySkill[],
  topReReadFiles:[{path,sessions,totalReads}],
  recurringErrors:[{signature,tool,sessions,total}],
  crossFindings:[{ruleId,title,sessions,totalSavingsTokens,totalSavingsMs,axis,severity,exampleSessionIds[]}],
  sessions:[SessionRow], topSessions:[SessionRow], byWeek:[{weekStartUtc,tokens,sessions}] }
```

## `--slim` (the projection built for LLM reads)

`orangu analyze <id> --json --slim` emits `SlimAnalysis`: the same contract minus the multi-MB fields.
Kept: `schemaVersion, generator, session, summary, insights`, `tools.{byName,errorGroups}`,
`files.mostReRead`, `tokens.{total,totalTokens,byModel,byKind}`, `agents.{totals,byType}`,
`context.{peak,baseline,final,contextWindow,cacheHitRatio,reReadMultiplier,compactions}`,
`quality.signals`, `parse.reconciliation`, plus a `slim: true` marker.
Dropped: `turns`, `tools.calls`, `context.series`, `events`, `time`, the rest of `parse`.
Typically ~20 KB where the full object is megabytes. Size any read first: `orangu estimate <id>`.

## Redaction (default-on)

`--json` output is redacted by default: API keys, tokens, emails and other obvious secrets in previews,
titles and summaries are masked (e.g. `‹anthropic-key›`, `‹email›`). `--no-redact` restores the raw
strings, only when the user explicitly asks. Structural numbers are never altered by redaction.
