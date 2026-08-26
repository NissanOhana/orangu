import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('GitHub beta feedback intake', () => {
  const form = readFileSync('.github/ISSUE_TEMPLATE/beta-feedback.yml', 'utf8')

  it('has actionable matching fields, a privacy gate, and no assumed repository label', () => {
    for (const id of ['summary', 'category', 'experience', 'expected', 'reproduction', 'context', 'diagnostics', 'privacy']) {
      expect(form).toContain(`id: ${id}`)
    }
    expect(form).toContain('title: "[beta feedback] "')
    expect(form).toContain('required: true')
    expect(form).not.toMatch(/^labels:/m)
  })
})
