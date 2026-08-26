import { allEntries } from './catalog.js'
import type { SuggestionProposalSource } from './types.js'

const MAX_SOURCES = 24
const MAX_LABEL = 300
const MAX_URL = 2_000
const CATALOG_BY_LABEL = new Map<string, ReturnType<typeof allEntries>[number]>(
  allEntries().map((entry) => [`catalog: ${entry.id}`, entry]),
)

export interface ProposalSourcesResult {
  sources?: SuggestionProposalSource[]
  error?: string
}

interface ProposalSourceResult {
  source?: SuggestionProposalSource
  error?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text && text.length <= max && !/[\x00-\x1f\x7f]/.test(text) ? text : undefined
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL) return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

function inferenceSource(source: Record<string, unknown>, label: string, index: number): ProposalSourceResult {
  if (source['url'] !== undefined || source['verifiedAt'] !== undefined) {
    return { error: `sources[${index}] inference must not include url or verifiedAt` }
  }
  return { source: { kind: 'inference', label } }
}

function researchSource(source: Record<string, unknown>, label: string, index: number): ProposalSourceResult {
  const url = httpsUrl(source['url'])
  if (!url) return { error: `sources[${index}].url must be a valid HTTPS URL` }
  if (!validDate(source['verifiedAt'])) {
    return { error: `sources[${index}].verifiedAt must be a non-null valid YYYY-MM-DD date` }
  }
  return { source: { kind: 'research', label, url, verifiedAt: source['verifiedAt'] } }
}

function catalogSource(source: Record<string, unknown>, label: string, index: number): ProposalSourceResult {
  if (source['label'] !== label) {
    return { error: `sources[${index}].label must be exactly "catalog: <catalog id>" for a shipped catalog entry` }
  }
  const entry = CATALOG_BY_LABEL.get(label)
  if (!entry) return { error: `sources[${index}].label must be exactly "catalog: <catalog id>" for a shipped catalog entry` }
  if (source['url'] !== undefined) {
    const suppliedUrl = httpsUrl(source['url'])
    const catalogUrl = entry.url === null ? undefined : httpsUrl(entry.url)
    if (!suppliedUrl || suppliedUrl !== catalogUrl) return { error: `sources[${index}].url does not match catalog entry ${entry.id}` }
  }
  if (source['verifiedAt'] !== undefined && source['verifiedAt'] !== entry.verifiedAt) {
    return { error: `sources[${index}].verifiedAt does not match catalog entry ${entry.id}` }
  }
  return {
    source: {
      kind: 'catalog',
      label,
      ...(entry.url !== null ? { url: entry.url } : {}),
      verifiedAt: entry.verifiedAt,
    },
  }
}

function normalizeProposalSource(value: unknown, index: number): ProposalSourceResult {
  const source = record(value)
  if (!source) return { error: `sources[${index}] must be an object` }
  const label = boundedText(source['label'], MAX_LABEL)
  if (!label) return { error: `sources[${index}].label must contain 1-${MAX_LABEL} safe characters` }
  if (source['kind'] === 'inference') return inferenceSource(source, label, index)
  if (source['kind'] === 'research') return researchSource(source, label, index)
  if (source['kind'] === 'catalog') return catalogSource(source, label, index)
  return { error: `sources[${index}].kind is not supported` }
}

/**
 * Project untrusted proposal provenance into the deterministic stored contract.
 * Catalog metadata comes from the shipped catalog; research carries a checked
 * HTTPS URL/date; inference can never masquerade as an externally verified source.
 */
export function normalizeProposalSources(value: unknown): ProposalSourcesResult {
  if (value === undefined) return {}
  if (!Array.isArray(value) || value.length > MAX_SOURCES) {
    return { error: `sources must contain 0-${MAX_SOURCES} entries` }
  }

  const sources: SuggestionProposalSource[] = []
  for (let index = 0; index < value.length; index++) {
    const normalized = normalizeProposalSource(value[index], index)
    if (normalized.error) return { error: normalized.error }
    if (!normalized.source) return { error: `sources[${index}] could not be normalized` }
    sources.push(normalized.source)
  }
  return { sources }
}

/** Direct store callers must already hold the canonical projection. */
export function proposalSourcesAreCanonical(value: unknown): boolean {
  if (value === undefined) return true
  const normalized = normalizeProposalSources(value)
  if (normalized.error !== undefined || !Array.isArray(value) || !normalized.sources || value.length !== normalized.sources.length) return false
  return value.every((raw, index) => {
    const source = record(raw)
    const canonical = record(normalized.sources?.[index])
    if (!source || !canonical) return false
    const sourceKeys = Object.keys(source).sort()
    const canonicalKeys = Object.keys(canonical).sort()
    return JSON.stringify(sourceKeys) === JSON.stringify(canonicalKeys) && sourceKeys.every((key) => source[key] === canonical[key])
  })
}
