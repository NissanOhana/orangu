import { describe, expect, it } from 'vitest'
import { megaReview } from './serve-ui.js'

describe('whole-harness review CTA', () => {
  it.each(['repo', 'global'] as const)('is an exact copy-only %s command with no row lifecycle', (scope) => {
    const html = megaReview(scope)
    expect(html).toContain(`claude &quot;/orangu:mega --scope ${scope}&quot;`)
    expect(html).toContain('data-copy=')
    expect(html).not.toContain('data-kick')
    expect(html).not.toContain('status-chip')
  })
})
