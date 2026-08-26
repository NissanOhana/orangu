/**
 * Model catalog + id resolution.
 *
 * The catalog lives in catalog.json: display names, families, context windows, aliases and the
 * fallback rules that turn any string seen in a `model` position into something we can name.
 *
 * It holds **no rates of any kind**. orangu measures tokens (input, cache read, cache write,
 * output) and nothing else; a token count is exact, so nothing derived from this file is ever an
 * approximation of a number we do not have. `estimatedMatch` says only that the *id* was matched by
 * alias or family fallback rather than an exact catalog row, which makes the display name and the
 * context window approximate. Token counts are unaffected.
 */
import table from './catalog.json' with { type: 'json' }

interface ModelEntry {
  displayName: string
  family: string
  status?: string
  contextWindow?: number
  maxOutputTokens?: number
  verified?: boolean
}
interface Catalog {
  updatedAt: string
  models: Record<string, ModelEntry>
  aliases: Record<string, string>
  unstableAliases: Record<string, string>
  nonModelSentinels: Record<string, unknown>
  fallbackByFamily: { order: string[] } & Record<string, unknown>
}

const T = table as unknown as Catalog

export interface ResolvedModel {
  /** id as it appeared in the transcript */
  rawId: string
  /** normalized id used for lookup */
  normalizedId: string
  /** key into the catalog, or undefined when the id is unknown */
  catalogId?: string
  displayName: string
  family: string
  contextWindow?: number
  /** true when the id was matched by alias/family fallback rather than an exact catalog row */
  estimatedMatch: boolean
  /** true for <synthetic> and other placeholders that are not real models */
  synthetic: boolean
  /** annotations picked up during normalization */
  tags: string[]
}

export function normalizeModelId(raw: string): { id: string; tags: string[] } {
  const tags: string[] = []
  let id = raw.trim().toLowerCase()
  id = id.replace(/^(us|eu|apac|global|us-gov)\./, '')
  id = id.replace(/^anthropic\./, '')
  id = id.replace(/-v\d+:\d+$/, '')
  id = id.replace(/:\d+$/, '')
  id = id.replace(/@(\d{8})$/, '-$1')
  const ctx = /\[(1m|200k|\d+k)\]$/.exec(id)
  if (ctx) {
    tags.push(`context:${ctx[1]}`)
    id = id.slice(0, ctx.index)
  }
  if (id.endsWith('-fast')) {
    tags.push('speed:fast')
    id = id.slice(0, -5)
  }
  return { id, tags }
}

const cache = new Map<string, ResolvedModel>()

export function resolveModel(rawId: string | undefined): ResolvedModel {
  const raw = rawId ?? 'unknown'
  const hit = cache.get(raw)
  if (hit) return hit
  const { id, tags } = normalizeModelId(raw)
  let out: ResolvedModel
  if (raw in T.nonModelSentinels || id in T.nonModelSentinels) {
    out = { rawId: raw, normalizedId: id, displayName: raw, family: 'none', estimatedMatch: false, synthetic: true, tags }
  } else {
    let catalogId: string | undefined
    let estimatedMatch = false
    if (T.models[id]) catalogId = id
    else if (T.aliases[id]) catalogId = T.aliases[id]
    else if (T.unstableAliases[id] && typeof T.unstableAliases[id] === 'string' && T.models[T.unstableAliases[id] as string]) {
      catalogId = T.unstableAliases[id]
      estimatedMatch = true
    } else {
      // dated-to-dateless prefix match: claude-opus-4-1-20250805 -> catalog key that is a prefix, or catalog dated key that starts with id
      const dateless = id.replace(/-\d{8}$/, '')
      const candidates = Object.keys(T.models).filter((k) => k === dateless || k.startsWith(dateless + '-') || dateless.startsWith(k + '-'))
      if (candidates.length) {
        catalogId = candidates.sort((a, b) => b.length - a.length)[0]
        estimatedMatch = true
      } else {
        for (const fam of T.fallbackByFamily.order) {
          const rule = T.fallbackByFamily[fam] as { match?: string; useModel?: string } | undefined
          if (rule?.match && id.includes(rule.match) && rule.useModel && T.models[rule.useModel]) {
            catalogId = rule.useModel
            estimatedMatch = true
            break
          }
        }
      }
    }
    const entry = catalogId ? T.models[catalogId] : undefined
    // an entry the catalog research could not verify (retired snapshots) is named but flagged
    const unverified = entry ? entry.verified === false : false
    out = {
      rawId: raw,
      normalizedId: id,
      catalogId,
      displayName: entry?.displayName ?? raw,
      family: entry?.family ?? guessFamily(id),
      contextWindow: entry?.contextWindow,
      estimatedMatch: estimatedMatch || !entry || unverified,
      synthetic: false,
      tags,
    }
  }
  cache.set(raw, out)
  return out
}

function guessFamily(id: string): string {
  for (const f of ['mythos', 'fable', 'opus', 'sonnet', 'haiku']) if (id.includes(f)) return f
  return 'unknown'
}

export function catalogInfo(): { updatedAt: string; modelCount: number } {
  return { updatedAt: T.updatedAt, modelCount: Object.keys(T.models).length }
}

export function listKnownModels(): Array<{ id: string; displayName: string; family: string; contextWindow?: number }> {
  return Object.entries(T.models).map(([id, e]) => ({ id, displayName: e.displayName, family: e.family, contextWindow: e.contextWindow }))
}
