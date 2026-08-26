import { describe, it, expect } from 'vitest'
import { bashTemplate, repeatedNgrams } from './tools.js'

describe('bashTemplate (script-candidate helper)', () => {
  it('normalizes paths, numbers and hex hashes into placeholders', () => {
    expect(bashTemplate('npm test -- src/analyze/insights.test.ts')).toBe('npm test -- «path»')
    expect(bashTemplate('npm test -- src/report/render.test.ts')).toBe('npm test -- «path»')
    expect(bashTemplate('git show 82b28b2f && sleep 30')).toBe('git show «hash» && sleep «n»')
    expect(bashTemplate('curl http://127.0.0.1:4917/api')).toBe('curl «path»')
  })
  it('keeps flags and collapses whitespace so equivalent invocations share a template', () => {
    expect(bashTemplate('rg  --line-number   TODO  /Users/x/proj/src')).toBe('rg --line-number TODO «path»')
    expect(bashTemplate('rg --line-number TODO /Users/y/other/lib')).toBe('rg --line-number TODO «path»')
  })
  it('does not turn ordinary words into placeholders', () => {
    expect(bashTemplate('git status')).toBe('git status')
    expect(bashTemplate('npm run verify')).toBe('npm run verify')
  })
})

describe('repeatedNgrams (script-candidate helper)', () => {
  it('finds a repeated 3-gram with its non-overlapping count and start indexes', () => {
    const seq: string[] = []
    for (let i = 0; i < 4; i++) seq.push('Read', 'Edit', 'Bash')
    const hits = repeatedNgrams(seq, 3, 4)
    expect(hits.length).toBe(1)
    expect(hits[0]!.gram).toEqual(['Read', 'Edit', 'Bash'])
    expect(hits[0]!.count).toBe(4)
    expect(hits[0]!.starts).toEqual([0, 3, 6, 9])
  })
  it('counts self-overlapping grams non-overlapping (no sliding overcount)', () => {
    const hits = repeatedNgrams(Array(12).fill('A') as string[], 3, 4)
    expect(hits.length).toBe(1)
    expect(hits[0]!.count).toBe(4) // 12 A's = 4 non-overlapping AAA, not 10 sliding windows
  })
  it('returns nothing below the minimum count', () => {
    const seq: string[] = []
    for (let i = 0; i < 3; i++) seq.push('Read', 'Edit', 'Bash')
    expect(repeatedNgrams(seq, 3, 4)).toEqual([])
  })
})
