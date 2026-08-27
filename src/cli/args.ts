// Tiny zero-dependency arg parser. Supports: subcommand, positionals, --flag, --key value, --key=value, -x.
export interface ParsedArgs {
  command?: string
  positionals: string[]
  flags: Record<string, string | boolean>
}

const SHORT_VALUE_FLAGS = new Set(['o', 'r', 'l'])

const BOOL_FLAGS = new Set([
  'json',
  'open',
  'help',
  'version',
  'no-redact',
  'redact',
  'include-text',
  'no-include-text',
  'strip-paths',
  'quiet',
  'watch',
  'global',
  'all',
  'no-open',
  'stdout',
  'md',
  'markdown',
  'fail-on-hook-errors',
  'follow',
  'slim',
  'list',
  'allow-claude',
  'estimate',
  'for-proposal',
  'for-apply',
])

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}
  let command: string | undefined
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const body = a.slice(2)
      const eq = body.indexOf('=')
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
      } else if (BOOL_FLAGS.has(body)) {
        flags[body] = true
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          flags[body] = next
          i++
        } else {
          flags[body] = true
        }
      }
    } else if (a.startsWith('-') && a.length > 1) {
      // single short flag that takes a value: -o out.html, -r dir, -l 20
      const ch = a.slice(1)
      if (ch.length === 1 && SHORT_VALUE_FLAGS.has(ch)) {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          flags[ch] = next
          i++
        } else {
          flags[ch] = true
        }
      } else {
        for (const c of ch) flags[c] = true
      }
    } else if (!command && !a.startsWith('-')) {
      command = a
    } else {
      positionals.push(a)
    }
  }
  return { command, positionals, flags }
}

export function flagStr(flags: Record<string, string | boolean>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = flags[n]
    if (typeof v === 'string') return v
  }
  return undefined
}
export function flagBool(flags: Record<string, string | boolean>, ...names: string[]): boolean {
  return names.some((n) => flags[n] === true || flags[n] === 'true')
}
