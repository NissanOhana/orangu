import { describe, it, expect } from 'vitest'
import { parseArgs, flagStr, flagBool } from './args.js'

describe('parseArgs', () => {
  it('parses command, positionals, --key value, --key=value, --bool, -x', () => {
    const p = parseArgs(['analyze', 'abc123', '--out', 'r.html', '--json', '--max-tokens=5000', '-q'])
    expect(p.command).toBe('analyze')
    expect(p.positionals).toEqual(['abc123'])
    expect(p.flags['out']).toBe('r.html')
    expect(p.flags['json']).toBe(true)
    expect(p.flags['max-tokens']).toBe('5000')
    expect(p.flags['q']).toBe(true)
  })
  it('treats known booleans as flags even before a value', () => {
    const p = parseArgs(['report', '--open', 'session-id'])
    expect(p.flags['open']).toBe(true)
    expect(p.positionals).toEqual(['session-id'])
  })
  it('-s takes a value like --session; --plain is boolean', () => {
    const p = parseArgs(['report', '-s', 'abc123', '--plain'])
    expect(p.flags['s']).toBe('abc123')
    expect(p.positionals).toEqual([])
    expect(p.flags['plain']).toBe(true)
    expect(flagStr(parseArgs(['analyze', '--session', 'current']).flags, 'session', 's')).toBe('current')
    // a bare -s never eats a following flag
    expect(parseArgs(['report', '-s', '--json']).flags['s']).toBe(true)
  })
  it('helpers read flags', () => {
    const p = parseArgs(['x', '--out', 'y', '--global'])
    expect(flagStr(p.flags, 'o', 'out')).toBe('y')
    expect(flagBool(p.flags, 'global')).toBe(true)
    expect(flagBool(p.flags, 'nope')).toBe(false)
  })
})

describe('suggest/estimate flags ', () => {
  it('--slim and --list are boolean flags even before a value', () => {
    const p = parseArgs(['suggest', '--list', 'session', '--slim'])
    expect(p.flags['list']).toBe(true)
    expect(p.flags['slim']).toBe(true)
    expect(p.positionals).toEqual(['session'])
  })
  it('--estimate stays boolean before an evidence input', () => {
    const p = parseArgs(['evidence', '--estimate', 'latest'])
    expect(p.flags['estimate']).toBe(true)
    expect(p.positionals).toEqual(['latest'])
  })
  it('lifecycle preflight flags never consume a following suggestion id', () => {
    const p = parseArgs(['suggest', '--for-proposal', 'sg_abc', '--for-apply'])
    expect(p.flags['for-proposal']).toBe(true)
    expect(p.flags['for-apply']).toBe(true)
    expect(p.positionals).toEqual(['sg_abc'])
  })
  it('--set takes the id; the status stays positional', () => {
    const p = parseArgs(['suggest', '--set', 'sg_abc', 'proposed', '--proposal', '/tmp/p.md'])
    expect(p.flags['set']).toBe('sg_abc')
    expect(p.positionals).toEqual(['proposed'])
    expect(p.flags['proposal']).toBe('/tmp/p.md')
  })
})
