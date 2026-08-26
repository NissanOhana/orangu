import { describe, expect, it } from 'vitest'
import { feedbackBootstrap, feedbackDiagnostics } from './diagnostics.js'

describe('feedback diagnostics allowlist', () => {
  it('contains only generic runtime facts and the selected context', () => {
    const diagnostics = feedbackDiagnostics('0.5.0', 'repo')
    expect(Object.keys(diagnostics).sort()).toEqual(['arch', 'context', 'nodeMajor', 'osFamily', 'surface', 'version'])
    expect(diagnostics).toMatchObject({ version: '0.5.0', context: 'repo', surface: 'localhost' })
    expect(diagnostics.nodeMajor).toMatch(/^\d+$|^unknown$/)
    expect(['macOS', 'Windows', 'Linux', 'other']).toContain(diagnostics.osFamily)
    expect(['arm64', 'x64', 'other']).toContain(diagnostics.arch)
  })

  it('removes context from the shell bootstrap so the local hash remains authoritative', () => {
    expect(Object.keys(feedbackBootstrap('test')).sort()).toEqual(['arch', 'nodeMajor', 'osFamily', 'surface', 'version'])
  })
})
