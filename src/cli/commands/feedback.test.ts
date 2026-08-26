import { describe, expect, it } from 'vitest'
import { feedbackContext, feedbackOptions } from './feedback.js'

describe('feedback command options', () => {
  it('defaults to app and accepts every public context', () => {
    expect(feedbackContext({})).toBe('app')
    for (const context of ['session', 'repo', 'global', 'report', 'app']) expect(feedbackContext({ context })).toBe(context)
  })

  it('rejects a missing or invalid context value', () => {
    expect(() => feedbackContext({ context: true })).toThrow(/requires one of/)
    expect(() => feedbackContext({ context: 'private-session-id' })).toThrow(/must be one of/)
  })

  it('accepts only the documented flags and never treats arbitrary option values as feedback', () => {
    expect(feedbackOptions({ context: 'repo', port: '0', 'no-open': true })).toEqual({ context: 'repo', port: 0 })
    for (const flags of [{ json: true }, { rant: 'private text' }, { 'no-open': 'private text' }] as Array<Record<string, string | boolean>>) {
      expect(() => feedbackOptions(flags)).toThrow(/unsupported feedback option|does not accept a value/)
    }
  })

  it('accepts only decimal ports in the loopback range', () => {
    expect(feedbackOptions({ port: '65535' })).toEqual({ context: 'app', port: 65_535 })
    for (const port of ['words', '1e3', '1.5', '-1', '65536']) {
      expect(() => feedbackOptions({ port })).toThrow(/integer 0–65535/)
    }
  })
})
