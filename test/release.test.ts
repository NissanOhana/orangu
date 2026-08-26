import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; devDependencies: Record<string, string> }

describe('release automation', () => {
  it('pins every tool used by release scripts', () => {
    for (const dep of ['@playwright/test', 'esbuild', 'tsx', 'typescript', 'vitest'])
      expect(pkg.devDependencies[dep], `missing development dependency ${dep}`).toBeTypeOf('string')
    expect(pkg.scripts['build:sample']).toBe('node --import tsx scripts/build-sample.ts')
    expect(Object.values(pkg.scripts).join('\n')).not.toMatch(/\bnpx\s+tsx\b/)
  })

  it('makes freshness and browser QA part of named release commands', () => {
    expect(pkg.scripts['verify']).toContain('npm run verify:generated')
    expect(pkg.scripts['verify:generated']).toBe('node scripts/assert-generated.mjs')
    expect(pkg.scripts['test:browser']).toContain('playwright test')
    expect(pkg.scripts['verify:release']).toContain('npm run test:browser')
    expect(pkg.scripts['prepublishOnly']).toBe('npm run verify:release')
    const generated = read('scripts/assert-generated.mjs')
    for (const path of ['plugin/bin/orangu.cli.mjs', 'src/report/generated/client-bundle.ts', 'site/index.html', 'site/sample.html'])
      expect(generated).toContain(`'${path}'`)
    const verify = pkg.scripts['verify']!
    expect(verify.indexOf('verify:generated')).toBeLessThan(verify.indexOf('npm run build'))
    expect(pkg.scripts['verify:release']).toContain('assert-offline.mjs --file site/sample.html')
  })

  it('verifies pull requests and retains browser diagnostics on failure', () => {
    const workflow = read('.github/workflows/verify.yml')
    expect(workflow).toMatch(/\n\s*pull_request:/)
    expect(workflow).toContain("node: ['20.19.0', '22']")
    expect(workflow).toContain('npm run verify')
    expect(workflow).toContain('npm run test:browser')
    expect(workflow).toContain('assert-offline.mjs --file site/sample.html')
    expect(workflow).toContain('npx --no-install playwright install --with-deps chromium')
    expect(workflow).toContain('if: failure()')
    expect(workflow).toContain('playwright-report/')
    expect(workflow).toContain('test-results/')
    expect(workflow).toContain('Install and run the packed CLI')
    expect(workflow).toContain('npm pack --pack-destination')
    expect(workflow).toContain('node_modules/.bin/orangu --version')
  })

  it('keeps Pages deployment manual and main-only', () => {
    const pages = read('.github/workflows/pages.yml')
    expect(pages).toMatch(/\non:\n\s+workflow_dispatch:/)
    expect(pages).not.toMatch(/\n\s+push:/)
    expect(pages).toContain("if: github.ref == 'refs/heads/main'")
    expect(pages).toContain('npm run verify:generated')
    expect(pages).toContain('node scripts/assert-offline.mjs --site')
  })
})
