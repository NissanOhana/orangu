import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; devDependencies: Record<string, string> }
const actionPins = {
  'actions/checkout': { sha: '3d3c42e5aac5ba805825da76410c181273ba90b1', version: 'v7' },
  'actions/setup-node': { sha: '820762786026740c76f36085b0efc47a31fe5020', version: 'v7' },
  'actions/upload-artifact': { sha: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', version: 'v7' },
  'actions/upload-pages-artifact': { sha: 'fc324d3547104276b827a68afc52ff2a11cc49c9', version: 'v5' },
  'actions/deploy-pages': { sha: 'cd2ce8fcbc39b97be8ca5fce6e763baed58fa128', version: 'v5' },
} as const

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
    expect(workflow).toContain('permissions:\n  contents: read')
  })

  it('allowlists exact third-party action identities and official SHAs in every workflow', () => {
    const workflows = readdirSync(join(root, '.github/workflows'))
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
    expect(workflows).not.toHaveLength(0)

    const seen = new Set<string>()
    for (const name of workflows) {
      const workflow = read(`.github/workflows/${name}`)
      const actions = workflow
        .split(/\r?\n/)
        .filter((line) => !/^\s*#/.test(line) && /\buses\s*:/.test(line))
        .map((line) => {
          const match = /^\s*(?:-\s+)?uses\s*:\s*([^#\s]+)(?:\s+#\s*(\S+))?\s*$/.exec(line)
          expect(match, `${name}: action use must be a single reviewable scalar: ${line.trim()}`).not.toBeNull()
          return { ref: match![1]!, version: match![2] }
        })
        .filter(({ ref }) => !ref.startsWith('./'))
      for (const action of actions) {
        const separator = action.ref.lastIndexOf('@')
        const identity = action.ref.slice(0, separator)
        const ref = action.ref.slice(separator + 1)
        expect(Object.hasOwn(actionPins, identity), `${name}: unallowlisted action ${identity}`).toBe(true)
        const expected = actionPins[identity as keyof typeof actionPins]
        expect(ref, `${name}: ${identity} must use its reviewed SHA`).toBe(expected.sha)
        expect(action.version, `${name}: ${identity} must retain a readable version comment`).toBe(expected.version)
        seen.add(identity)
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(actionPins).sort())
  })

  it('deploys Pages manually, for main site changes, or as the last leg of a release', () => {
    const pages = read('.github/workflows/pages.yml')
    // workflow_call is how release.yml reuses this instead of duplicating the deploy.
    expect(pages).toMatch(/\non:\n(?:  #.*\n)*  workflow_call:\n  workflow_dispatch:\n  push:\n/)
    const push = /\n  push:\n([\s\S]*?)\n\n# Least privilege/.exec(pages)?.[1]
    expect(push).toBe("    branches: [main]\n    paths:\n      - 'site/**'\n      - '.github/workflows/pages.yml'")
    // A bare refs/heads/main check silently skips the whole deploy when release.yml
    // calls this from a tag push, so the tag ref has to be allowed explicitly.
    expect(pages).toContain("if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')")
    expect(pages).toContain('npm run verify:generated')
    expect(pages).toContain('node scripts/assert-offline.mjs --site')
  })

  it('ships npm, the plugin tag and the landing page from one v* tag', () => {
    const release = read('.github/workflows/release.yml')
    expect(release).toMatch(/\non:\n  push:\n    tags: \['v\*'\]\n/)
    expect(release).toContain('permissions:\n  contents: read')

    // Nothing ships unless the tag and every version-bearing manifest agree, so a
    // half-finished bump cannot publish npm against one version and tag another.
    for (const manifest of [
      'package.json',
      'plugin/.claude-plugin/plugin.json',
      'plugins/orangu/.codex-plugin/plugin.json',
    ])
      expect(release, `the guard must compare ${manifest}`).toContain(`compare ${manifest} \\`)

    // The release gate is the same suite the branch already runs, browser tests included.
    expect(release).toContain('npm run verify:release')
    expect(release).toContain('npx --no-install playwright install --with-deps chromium')

    // npm auth is OIDC trusted publishing: no token secret may enter this workflow.
    expect(release).toContain('id-token: write')
    expect(release, 'npm publish must not read a stored secret').not.toMatch(/secrets\./)
    expect(release, 'trusted publishing needs npm >= 11.5.1').toContain('npm install -g npm@latest')

    // A Claude Code plugin is released by the {name}--v{version} git tag the marketplace resolves.
    expect(release).toContain('claude plugin validate ./plugin --strict')
    expect(release).toContain('claude plugin tag ./plugin --push')

    // Strict order: the landing page announces only artifacts that already exist.
    expect(release).toContain('needs: [guard, verify]')
    expect(release).toContain('needs: [guard, verify, npm]')
    expect(release).toContain('needs: [guard, verify, npm, plugin]')
    expect(release).toContain('uses: ./.github/workflows/pages.yml')

    // Re-pushing a tag must skip what already shipped rather than failing the run.
    expect(release).toContain('is already published; skipping.')
    expect(release).toContain('is already on origin; nothing to publish.')
  })
})
