import { readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { describe, expect, it } from 'vitest'

// Each specifier of a module: imports, type imports, re-exports, side-effect and dynamic imports.
const SPECIFIER_RE = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g

describe('suggestion contract', () => {
  it('stays browser-safe: no node module in its import closure, type imports included', async () => {
    // The god type-check reaches types.ts with no node types, so 1 node module anywhere in the closure fails it.
    const root = new URL('../', import.meta.url)
    const queue = [new URL('./types.ts', import.meta.url)]
    const seen = new Set<string>()
    const nodeImports: string[] = []
    // for...of reads the array length on each step, so it also visits each module that the loop appends
    for (const url of queue) {
      if (seen.has(url.href)) continue
      seen.add(url.href)
      const source = await readFile(url, 'utf8')
      for (const match of source.matchAll(SPECIFIER_RE)) {
        const specifier = match[1] ?? match[2] ?? ''
        if (specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0] ?? '')) {
          nodeImports.push(`${url.href.slice(root.href.length)} -> ${specifier}`)
        } else if (specifier.startsWith('.')) {
          queue.push(new URL(specifier.replace(/\.js$/, '.ts'), url))
        }
      }
    }
    // types.ts has only type imports, so a closure of more than 1 module proves that the walk follows them
    expect(seen.size).toBeGreaterThan(1)
    expect(nodeImports).toEqual([])
  })
})
