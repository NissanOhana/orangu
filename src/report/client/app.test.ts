import { describe, expect, it, vi } from 'vitest'
import type { AppData } from '../../model/app-data.js'
import type { SuggestionRecord } from '../../suggest/types.js'
import { cycleTheme, refreshSuggestions, refreshSuggestionsOnConnection, themeName } from './app.js'

const record = (id: string): SuggestionRecord => ({ id, v: 2, status: 'new' }) as SuggestionRecord

describe('suggestion-updated refresh', () => {
  it('replaces visible records with persisted state and rerenders the suggestion screen', async () => {
    const data = { suggestions: [record('old')] } as AppData
    const rerender = vi.fn()
    await refreshSuggestions(data, { suggestions: vi.fn().mockResolvedValue([record('fresh')]) }, true, rerender)
    expect(data.suggestions.map((item) => item.id)).toEqual(['fresh'])
    expect(rerender).toHaveBeenCalledOnce()
  })

  it('keeps the last good state when a refresh fails', async () => {
    const data = { suggestions: [record('old')] } as AppData
    const rerender = vi.fn()
    await refreshSuggestions(data, { suggestions: vi.fn().mockRejectedValue(new Error('loopback unavailable')) }, true, rerender)
    expect(data.suggestions.map((item) => item.id)).toEqual(['old'])
    expect(rerender).not.toHaveBeenCalled()
  })

  it('replaces a stale bootstrap snapshot on first connect and every reconnect', async () => {
    const data = { suggestions: [record('bootstrap')] } as AppData
    const rerender = vi.fn()
    const suggestions = vi.fn()
      .mockResolvedValueOnce([record('between-bootstrap-and-stream')])
      .mockResolvedValueOnce([record('during-reconnect')])
    const ds = { suggestions }

    await refreshSuggestionsOnConnection({ type: 'connection', state: 'connected' }, data, ds, true, rerender)
    expect(data.suggestions.map((item) => item.id)).toEqual(['between-bootstrap-and-stream'])
    await refreshSuggestionsOnConnection({ type: 'connection', state: 'reconnecting' }, data, ds, true, rerender)
    expect(suggestions).toHaveBeenCalledOnce()
    await refreshSuggestionsOnConnection({ type: 'connection', state: 'connected' }, data, ds, true, rerender)
    expect(data.suggestions.map((item) => item.id)).toEqual(['during-reconnect'])
    expect(suggestions).toHaveBeenCalledTimes(2)
    expect(rerender).toHaveBeenCalledTimes(2)
  })
})

describe('light is the only default theme', () => {
  it('reads every value but dark as light, so a legacy hash cannot resurrect a third state', () => {
    expect(themeName('dark')).toBe('dark')
    expect(themeName('light')).toBe('light')
    expect(themeName(undefined)).toBe('light')
    expect(themeName('auto')).toBe('light')
  })

  it('cycles exactly two states and clears the key on the default so the light hash stays clean', () => {
    expect(cycleTheme(undefined)).toBe('dark')
    expect(cycleTheme('dark')).toBeUndefined()
    expect(cycleTheme(cycleTheme(undefined))).toBeUndefined()
    expect(cycleTheme('auto')).toBe('dark')
  })
})
