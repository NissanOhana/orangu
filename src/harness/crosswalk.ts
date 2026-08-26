/**
 * The crosswalk: what the config DECLARES joined against what the sessions DID.
 *
 * A pure function over already-computed `Analysis` / `Aggregate` values. No filesystem, no clock, no network,
 * no model: joins and arithmetic are deterministic and reproducible.
 *
 * Two rules shape every axis:
 *  - the classification is `status` and nothing else. `used` = declared and observed, `idle` = declared with
 *    zero observations in the window, `undeclared` = observed but absent from every config the collector could
 *    read. `undeclared` means "not found in the config I read" (a source outside scope, or drift). It is never
 *    "you have a rogue tool", and this layer never recommends anything about it.
 *  - every array is sorted by an explicit comparator and then capped at `HARNESS_ROW_CAP`, so the payload is
 *    bounded by construction and two runs over the same inputs serialize the same bytes.
 *
 * The window comes from session `startedAt` values, never from the clock.
 */
import { basename } from 'node:path'
import type { Analysis } from '../model/analysis.js'
import type { Aggregate } from '../analyze/aggregate.js'
import { HARNESS_ROW_CAP } from './types.js'
import type {
  HarnessAgentRow,
  HarnessCrosswalk,
  HarnessHookRow,
  HarnessInventory,
  HarnessListingRow,
  HarnessMcpRow,
  HarnessMemoryRow,
  HarnessSkillRow,
  HarnessStatus,
  HarnessConfigScope,
} from './types.js'

/** most specific config wins when two files declare the same thing */
const SCOPE_PRECEDENCE: HarnessConfigScope[] = ['repo-local', 'repo', 'global-local', 'global']

const approxTokens = (bytes: number): number => Math.ceil(bytes / 4)

function statusOf(declared: boolean, observations: number): HarnessStatus {
  if (!declared) return 'undeclared'
  return observations > 0 ? 'used' : 'idle'
}

/** desc by `n`, then asc by `k`: the comparator every capped array uses */
function ranked<T>(rows: T[], n: (x: T) => number, k: (x: T) => string): T[] {
  return rows
    .slice()
    .sort((a, b) => n(b) - n(a) || (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0))
    .slice(0, HARNESS_ROW_CAP)
}


/** `mcp__<server>__<tool>` → `{ server, tool }`; anything else → null */
function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  const parts = name.split('__')
  if (parts.length < 3) return null
  const server = parts[1] ?? ''
  const tool = parts.slice(2).join('__')
  return server && tool ? { server, tool } : null
}

const norm = (p: string): string => p.replace(/\\/g, '/')
const isAbs = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:\//.test(p)

/** expand a leading `~` with the injected home; anything else is returned normalized and unchanged */
function expandHome(p: string, home?: string): string {
  const s = norm(p)
  if (!home) return s
  const h = norm(home).replace(/\/+$/, '')
  if (s === '~') return h
  if (s.startsWith('~/')) return h + s.slice(1)
  return s
}

/**
 * The absolute path a session-side file row refers to, or `null` when it cannot be resolved.
 *
 * `FileStat.path` is `shortPath(p, cwd)` (`src/analyze/util.ts:36`), which STRIPS the session cwd prefix,
 * so a read of the repo's own `CLAUDE.md` is stored as the bare string `"CLAUDE.md"`. Matching that by
 * suffix would make it a match for every memory file in the inventory, which is exactly the phantom-read
 * defect this function exists to prevent. A relative row is therefore resolved against the session's own
 * cwd, and anything that cannot be resolved credits nothing rather than guessing.
 */
function resolveSessionPath(p: string, sessionCwd: string | undefined, home?: string): string | null {
  const s = expandHome(p, home)
  if (isAbs(s)) return s
  if (s.startsWith('~')) return null // `~`-prefixed with no home to expand it
  if (!sessionCwd) return null
  return norm(sessionCwd).replace(/\/+$/, '') + '/' + s
}

/** first value declared by the most specific settings file that declares one */
function declared<T>(inv: HarnessInventory, pick: (s: HarnessInventory['settings'][number]) => T | undefined): T | undefined {
  for (const scope of SCOPE_PRECEDENCE) {
    for (const s of inv.settings) {
      if (s.scope !== scope) continue
      const v = pick(s)
      if (v !== undefined && v !== '') return v
    }
  }
  return undefined
}

/**
 * effort is a CLOSED enum (`low|medium|high|xhigh|max`), so it is compared by EQUALITY, never containment:
 * `"xhigh".includes("high")` is true, which would report a harness configured `high` and running at `xhigh`
 * as matching, the precise drift this axis was commissioned to surface.
 */
function sameEffort(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** `claude-fable-5[1m]` → `claude-fable-5`: a trailing `[…]` tag is a variant selector, not part of the id */
function stripModelTag(m: string): string {
  return m.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').trim()
}

/** the only short aliases a `model` setting may use for a family: a closed, tested set, not a substring rule */
const MODEL_FAMILY_ALIASES: ReadonlySet<string> = new Set(['opus', 'sonnet', 'haiku'])

/**
 * A configured model matches a seen model id by exact equality, or (for the aliases above only) when the
 * alias is a WHOLE hyphen-delimited segment of the id (`opus` matches `claude-opus-5`). Nothing else matches:
 * `claude-opus-4-5` against `claude-opus-5` is real drift and is reported as such.
 */
function sameModel(configured: string, seen: string): boolean {
  // a `model` setting may carry a context-window tag the sessions never report (`claude-fable-5[1m]`);
  // the tag selects a variant, not a different model, so it is stripped before the identity compare
  const c = stripModelTag(configured)
  const s = stripModelTag(seen)
  if (c === s) return true
  return MODEL_FAMILY_ALIASES.has(c) && s.split('-').includes(c)
}

export interface CrosswalkOptions {
  /** the home dir whose `~` prefix the inventory paths were written with; needed to join them against
   * session file paths, which are absolute. Omitted → `~`-prefixed inventory rows credit no reads. */
  home?: string
}

export function crosswalk(inv: HarnessInventory, analyses: Analysis[], agg: Aggregate, opts: CrosswalkOptions = {}): HarnessCrosswalk {
  // ---------- skills ----------
  const installedSkills = new Map(inv.skills.map((s) => [s.name, s]))
  /**
   * Claude Code reports an invocation under the plugin-qualified name (`superpowers:brainstorming`) while the
   * inventory holds the bare one, so the raw string would split ONE skill into two contradictory rows, an
   * `idle` install and an `undeclared` observation. Resolve an observed name onto the installed skill it names:
   * exact first, then the `<plugin>:<skill>` suffix. A qualified name nothing installs stays as observed.
   */
  const canonicalSkill = (observed: string): string => {
    if (installedSkills.has(observed)) return observed
    const colon = observed.lastIndexOf(':')
    if (colon > 0) {
      const bare = observed.slice(colon + 1)
      const entry = installedSkills.get(bare)
      // the inventory records the marketplace-qualified key (`superpowers@superpowers-marketplace`) while the
      // invocation carries the bare plugin name (`superpowers:brainstorming`), so compare the name part
      if (entry && (entry.plugin === undefined || pluginName(entry.plugin) === observed.slice(0, colon))) return bare
    }
    return observed
  }
  const pluginName = (key: string): string => key.split('@')[0] ?? key
  const skillObs = new Map<string, { invocations: number; sessions: number; viaTool: number; viaCommand: number }>()
  const skillObsAt = (rawName: string) => {
    const name = canonicalSkill(rawName)
    let e = skillObs.get(name)
    if (!e) skillObs.set(name, (e = { invocations: 0, sessions: 0, viaTool: 0, viaCommand: 0 }))
    return e
  }
  for (const a of analyses) {
    const here = new Set<string>()
    for (const s of a.skills.byName) {
      const e = skillObsAt(s.name)
      e.invocations += s.count
      here.add(canonicalSkill(s.name))
    }
    for (const i of a.skills.invocations) {
      const e = skillObsAt(i.name)
      if (i.via === 'tool') e.viaTool++
      else e.viaCommand++
      here.add(canonicalSkill(i.name))
    }
    for (const n of here) skillObsAt(n).sessions++
  }
  // the cross-session rollup is the same signal; anything it knows that no single analysis carried still counts
  for (const r of agg.bySkill) {
    const uses = r.extra?.['uses'] ?? 0
    if (uses > 0 && !skillObs.has(canonicalSkill(r.key))) skillObsAt(r.key).invocations += uses
  }

  const skillRows: HarnessSkillRow[] = []
  for (const name of new Set([...installedSkills.keys(), ...skillObs.keys()])) {
    const o = skillObs.get(name)
    const entry = installedSkills.get(name)
    skillRows.push({
      name,
      ...(entry ? { origin: entry.plugin ? `plugin:${entry.plugin}` : entry.origin } : {}),
      installed: !!entry,
      invocations: o?.invocations ?? 0,
      sessions: o?.sessions ?? 0,
      viaTool: o?.viaTool ?? 0,
      viaCommand: o?.viaCommand ?? 0,
      status: statusOf(!!entry, o?.invocations ?? 0),
    })
  }

  // ---------- mcp servers ----------
  const mcpObs = new Map<string, { toolCalls: number; tools: Set<string>; sessions: number }>()
  const mcpObsAt = (name: string) => {
    let e = mcpObs.get(name)
    if (!e) mcpObs.set(name, (e = { toolCalls: 0, tools: new Set(), sessions: 0 }))
    return e
  }
  for (const a of analyses) {
    const here = new Set<string>()
    for (const t of a.tools.byName) {
      const parsed = parseMcpToolName(t.name)
      if (!parsed) continue
      const e = mcpObsAt(parsed.server)
      e.toolCalls += t.count
      e.tools.add(parsed.tool)
      here.add(parsed.server)
    }
    for (const n of here) mcpObsAt(n).sessions++
  }
  for (const r of agg.byTool) {
    // only a row that actually carries calls may register a server; a 0-call row would be classified
    // `idle`/`undeclared` despite having been observed.
    const calls = r.extra?.['calls'] ?? 0
    const parsed = parseMcpToolName(r.key)
    if (calls > 0 && parsed && !mcpObs.has(parsed.server)) {
      const e = mcpObsAt(parsed.server)
      e.toolCalls += calls
      e.tools.add(parsed.tool)
    }
  }

  const configuredMcp = new Map(inv.mcpServers.map((m) => [m.name, m]))
  const mcpRows: HarnessMcpRow[] = []
  for (const name of new Set([...configuredMcp.keys(), ...mcpObs.keys()])) {
    const o = mcpObs.get(name)
    mcpRows.push({
      name,
      configured: configuredMcp.has(name),
      toolCalls: o?.toolCalls ?? 0,
      distinctTools: o?.tools.size ?? 0,
      sessions: o?.sessions ?? 0,
      status: statusOf(configuredMcp.has(name), o?.toolCalls ?? 0),
    })
  }

  // ---------- agents ----------
  const agentObs = new Map<string, { dispatches: number; sessions: number; models: Set<string> }>()
  const agentObsAt = (name: string) => {
    let e = agentObs.get(name)
    if (!e) agentObs.set(name, (e = { dispatches: 0, sessions: 0, models: new Set() }))
    return e
  }
  for (const a of analyses) {
    const here = new Set<string>()
    for (const t of a.agents.byType) {
      const e = agentObsAt(t.agentType)
      e.dispatches += t.count
      here.add(t.agentType)
    }
    for (const r of a.agents.runs) {
      if (!r.agentType) continue
      const e = agentObsAt(r.agentType)
      if (r.model) e.models.add(r.model)
      here.add(r.agentType)
    }
    for (const n of here) agentObsAt(n).sessions++
  }
  for (const r of agg.byAgentType) {
    const runs = r.extra?.['runs'] ?? 0
    if (runs > 0 && !agentObs.has(r.key)) agentObsAt(r.key).dispatches += runs
  }

  const definedAgents = new Map(inv.agents.map((a) => [a.name, a]))
  const agentRows: HarnessAgentRow[] = []
  for (const name of new Set([...definedAgents.keys(), ...agentObs.keys()])) {
    const o = agentObs.get(name)
    const entry = definedAgents.get(name)
    agentRows.push({
      name,
      ...(entry ? { origin: entry.plugin ? `plugin:${entry.plugin}` : entry.origin } : {}),
      defined: !!entry,
      dispatches: o?.dispatches ?? 0,
      sessions: o?.sessions ?? 0,
      models: [...(o?.models ?? [])].sort(),
      status: statusOf(!!entry, o?.dispatches ?? 0),
    })
  }

  // ---------- hooks ----------
  const hookObs = new Map<string, { runs: number; errors: number; totalMs: number; events: Set<string> }>()
  const hookObsAt = (name: string) => {
    let e = hookObs.get(name)
    if (!e) hookObs.set(name, (e = { runs: 0, errors: 0, totalMs: 0, events: new Set() }))
    return e
  }
  for (const a of analyses) {
    for (const h of a.hooks.byCommand) {
      const name = basename((h.command ?? '').trim().split(/\s+/)[0] ?? '')
      if (!name) continue
      const e = hookObsAt(name)
      e.runs += h.count
      e.errors += h.errors
      e.totalMs += h.totalMs
      if (h.hookEvent) e.events.add(h.hookEvent)
    }
  }
  const configuredHooks = new Map<string, string | undefined>()
  for (const s of inv.settings) for (const h of s.hooks) for (const b of h.commandBasenames) if (!configuredHooks.has(b)) configuredHooks.set(b, h.event)

  const hookRows: HarnessHookRow[] = []
  for (const name of new Set([...configuredHooks.keys(), ...hookObs.keys()])) {
    const o = hookObs.get(name)
    const event = configuredHooks.get(name) ?? [...(o?.events ?? [])].sort()[0]
    hookRows.push({
      ...(event ? { event } : {}),
      commandBasename: name,
      configured: configuredHooks.has(name),
      runs: o?.runs ?? 0,
      errors: o?.errors ?? 0,
      totalMs: Math.round(o?.totalMs ?? 0),
      // exact from exposed data: Σ totalMs ÷ Σ runs. No percentile is claimed; see HarnessHookRow.meanMs
      meanMs: o && o.runs > 0 ? Math.round(o.totalMs / o.runs) : 0,
      status: statusOf(configuredHooks.has(name), o?.runs ?? 0),
    })
  }

  // ---------- models ----------
  const modelObs = new Map<string, { requests: number; sessions: number }>()
  for (const a of analyses) {
    const here = new Set<string>()
    for (const m of a.tokens.byModel) {
      const e = modelObs.get(m.model) ?? { requests: 0, sessions: 0 }
      e.requests += m.requests
      modelObs.set(m.model, e)
      here.add(m.model)
    }
    for (const n of here) modelObs.get(n)!.sessions++
  }
  const configuredModel = declared(inv, (s) => s.model)
  const modelsSeen = ranked(
    [...modelObs].map(([model, v]) => ({ model, requests: v.requests, sessions: v.sessions })),
    (x) => x.requests,
    (x) => x.model,
  )

  // ---------- effort ----------
  const effortObs = new Map<string, number>()
  for (const a of analyses) for (const e of new Set(a.session.effortLevels)) effortObs.set(e, (effortObs.get(e) ?? 0) + 1)
  let slashEffortCommands = 0
  for (const a of analyses) {
    for (const t of a.turns) {
      const c = t.commandName
      if (c && c.replace(/^\//, '').toLowerCase() === 'effort') slashEffortCommands++
    }
  }
  const configuredEffort = declared(inv, (s) => s.effortLevel)
  const effortSeen = ranked(
    [...effortObs].map(([effort, sessions]) => ({ effort, sessions })),
    (x) => x.sessions,
    (x) => x.effort,
  )

  // ---------- permissions ----------
  let promptEvents = 0
  let promptSessions = 0
  for (const a of analyses) {
    const n = a.events.filter((e) => e.kind === 'permission_prompt').length
    promptEvents += n
    if (n > 0) promptSessions++
  }

  // ---------- memory files ----------
  // Index the inventory by resolved absolute path ONCE, then join by exact equality. Two inventory rows that
  // resolve to the same path are ambiguous and credit neither: the guard the old suffix match only promised.
  const memoryIndex = new Map<string, number>()
  const ambiguous = new Set<string>()
  inv.claudeMd.forEach((f, i) => {
    const abs = expandHome(f.file, opts.home)
    if (!isAbs(abs)) return // still `~`-prefixed: no home was injected, so it cannot be joined safely
    if (memoryIndex.has(abs)) ambiguous.add(abs)
    else memoryIndex.set(abs, i)
  })
  for (const a of ambiguous) memoryIndex.delete(a)

  const memoryHits = inv.claudeMd.map(() => ({ reads: 0, sessions: 0 }))
  for (const a of analyses) {
    const here = new Set<number>()
    // `files.files` is the complete set; `files.mostReRead` is a filtered top-10 of it and would undercount
    for (const s of a.files.files) {
      const abs = resolveSessionPath(s.path, a.session.cwd, opts.home)
      if (abs === null) continue
      const i = memoryIndex.get(abs)
      if (i === undefined) continue
      memoryHits[i]!.reads += s.reads
      if (s.reads > 0) here.add(i)
    }
    for (const i of here) memoryHits[i]!.sessions++
  }
  const memoryRows: HarnessMemoryRow[] = inv.claudeMd.map((f, i) => ({
    file: f.file,
    bytes: f.bytes,
    approxTokens: f.approxTokens,
    reads: memoryHits[i]!.reads,
    sessions: memoryHits[i]!.sessions,
    approxTokensCarried: f.approxTokens * memoryHits[i]!.reads,
  }))

  // ---------- injected listings ----------
  const listingObs = new Map<string, { bytes: number; sessions: number }>()
  for (const a of analyses) {
    for (const [type, bytes] of Object.entries(a.parse.attachmentBytes ?? {})) {
      const e = listingObs.get(type) ?? { bytes: 0, sessions: 0 }
      e.bytes += bytes
      e.sessions++
      listingObs.set(type, e)
    }
  }
  const listingRows: HarnessListingRow[] = [...listingObs].map(([type, v]) => {
    const tokens = approxTokens(v.bytes)
    return { type, sessions: v.sessions, bytes: v.bytes, approxTokens: tokens, approxTokensPerSession: v.sessions > 0 ? Math.ceil(tokens / v.sessions) : 0 }
  })

  // ---------- window: from session data, never the clock ----------
  const starts = analyses.map((a) => a.session.startedAt).filter((t): t is number => typeof t === 'number')

  return {
    window: {
      ...(starts.length ? { firstStartedAt: Math.min(...starts) } : {}),
      ...(starts.length ? { lastStartedAt: Math.max(...starts) } : {}),
    },
    skills: ranked(skillRows, (x) => x.invocations, (x) => x.name),
    mcpServers: ranked(mcpRows, (x) => x.toolCalls, (x) => x.name),
    agents: ranked(agentRows, (x) => x.dispatches, (x) => x.name),
    hooks: ranked(hookRows, (x) => x.runs, (x) => x.commandBasename),
    models: {
      ...(configuredModel ? { configured: configuredModel } : {}),
      seen: modelsSeen,
      matchesConfigured: configuredModel === undefined ? true : modelsSeen.some((m) => sameModel(configuredModel, m.model)),
    },
    effort: {
      ...(configuredEffort ? { configured: configuredEffort } : {}),
      seen: effortSeen,
      slashEffortCommands,
      matchesConfigured: configuredEffort === undefined ? true : effortSeen.some((e) => sameEffort(e.effort, configuredEffort)),
    },
    permissions: {
      allowRules: inv.settings.reduce((n, s) => n + s.permissions.allow, 0),
      denyRules: inv.settings.reduce((n, s) => n + s.permissions.deny, 0),
      askRules: inv.settings.reduce((n, s) => n + s.permissions.ask, 0),
      ...(declared(inv, (s) => s.permissions.defaultMode) ? { defaultMode: declared(inv, (s) => s.permissions.defaultMode)! } : {}),
      promptEvents,
      promptSessions,
    },
    claudeMd: ranked(memoryRows, (x) => x.approxTokensCarried, (x) => x.file),
    injectedListings: ranked(listingRows, (x) => x.approxTokens, (x) => x.type),
  }
}
