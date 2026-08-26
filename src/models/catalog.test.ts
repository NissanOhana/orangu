import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalogInfo, listKnownModels, normalizeModelId, resolveModel } from './catalog.js'

const HERE = dirname(fileURLToPath(import.meta.url))

describe('model catalog', () => {
  it('normalizes provider-prefixed, bedrock, vertex and tagged ids', () => {
    expect(normalizeModelId('us.anthropic.claude-sonnet-4-5-20250929-v1:0').id).toBe('claude-sonnet-4-5-20250929')
    expect(normalizeModelId('claude-opus-4-5@20251101').id).toBe('claude-opus-4-5-20251101')
    expect(normalizeModelId('claude-opus-5[1m]')).toEqual({ id: 'claude-opus-5', tags: ['context:1m'] })
    expect(normalizeModelId('claude-opus-4-6-fast').tags).toContain('speed:fast')
  })

  it('resolves exact ids as exact matches and family fallbacks as estimated matches', () => {
    expect(resolveModel('claude-opus-5').estimatedMatch).toBe(false)
    expect(resolveModel('claude-opus-5').family).toBe('opus')
    const unk = resolveModel('claude-sonnet-9-20990101')
    expect(unk.estimatedMatch).toBe(true)
    expect(unk.family).toBe('sonnet')
    expect(unk.catalogId).toBeTruthy()
    expect(resolveModel('opus').estimatedMatch).toBe(true)
  })

  it('marks the <synthetic> sentinel as synthetic, not as a model', () => {
    const r = resolveModel('<synthetic>')
    expect(r.synthetic).toBe(true)
    expect(r.estimatedMatch).toBe(false)
    expect(r.family).toBe('none')
  })

  it('flags unverified (retired) snapshots as estimated matches', () => {
    // claude-3-opus-20240229 is verified:false in the catalog
    const r = resolveModel('claude-3-opus-20240229')
    expect(r.catalogId).toBeTruthy()
    expect(r.estimatedMatch).toBe(true)
  })

  it('keeps the raw id and no context window for a model it cannot place at all', () => {
    const r = resolveModel('gpt-9')
    expect(r.displayName).toBe('gpt-9')
    expect(r.estimatedMatch).toBe(true)
    expect(r.contextWindow).toBeUndefined()
  })

  it('carries the context window used by the context-pressure rule', () => {
    expect(resolveModel('claude-opus-5').contextWindow).toBeGreaterThan(0)
    expect(resolveModel('claude-fable-5').contextWindow).toBe(1_000_000)
  })

  it('lists every catalogued model with a name, a family and no rate of any kind', () => {
    const models = listKnownModels()
    expect(models.length).toBe(catalogInfo().modelCount)
    expect(models.length).toBeGreaterThanOrEqual(20)
    for (const m of models) {
      expect(m.displayName, m.id).toBeTruthy()
      expect(m.family, m.id).toBeTruthy()
      expect(Object.keys(m).sort()).toEqual(['contextWindow', 'displayName', 'family', 'id'].sort())
    }
  })

  // The load-bearing promise of this module: it is a catalog, not a price list. If a rate ever
  // reappears here, orangu is talking money again.
  it('the catalog file contains no rate, price or currency field', () => {
    const raw = readFileSync(join(HERE, 'catalog.json'), 'utf8')
    for (const forbidden of ['pricePerMTok', 'price', 'pricing', 'usd', 'USD', 'currency', 'dollar', 'per_million', 'cost', 'fastMode', 'batch']) {
      expect(raw.toLowerCase().includes(forbidden.toLowerCase()), `catalog.json mentions "${forbidden}"`).toBe(false)
    }
  })
})
