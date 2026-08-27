/**
 * Command registry. `src/cli/main.ts` dispatches unknown verbs through
 * EXTRA_COMMANDS and prints EXTRA_HELP under 'usage', so new verbs register here without touching main.
 */
import { cmdEstimate } from './estimate.js'
import { cmdEvidence } from './evidence.js'
import { cmdHarness } from './harness.js'
import { cmdSuggest } from './suggest.js'
import { cmdFeedback } from './feedback.js'

export type CommandFn = (positionals: string[], flags: Record<string, string | boolean>) => Promise<void>

export const EXTRA_COMMANDS: Record<string, CommandFn> = {
  feedback: cmdFeedback,
  evidence: cmdEvidence,
  estimate: cmdEstimate,
  harness: cmdHarness,
  suggest: cmdSuggest,
}

export const EXTRA_HELP: string[] = [
  // Each entry may span lines (main.ts joins entries with '\n'); keep every line <= 80 columns.
  [
    '  orangu feedback              private localhost beta-feedback form',
    '                                 (--context session|repo|global|report|app',
    '                                  [--port <n>] [--no-open])',
  ].join('\n'),
  [
    '  orangu evidence <input>      bounded, redacted findings + matching known fixes',
    '                               for a session/.jsonl or current Orangu JSON',
    '                                 ([--scope repo|global] [--limit <n>]',
    '                                  [--estimate] [--json])',
  ].join('\n'),
  [
    '  orangu estimate [<session>|repo|global|harness]',
    '                               size what a skill would read: bytes and ~tokens',
    '                                 (--suggestion <id>',
    '                                  | --rule <r> --session <a,b>;',
    '                                  --slim sizes an analyze --json --slim read)',
  ].join('\n'),
  [
    '  orangu harness               what your config declares vs what your sessions',
    '                               used: skills/MCP/agents/hooks',
    '                               used|idle|undeclared, in tokens',
    '                                 ([--json] [--cwd <dir>] [--root <dir>]',
    '                                  [--global] [--limit <n>] [-o|--out <file>]',
    '                                  [--no-redact] [--strip-paths] [--jobs <n>]',
    '                                  [--no-cache] [--quiet])',
  ].join('\n'),
  [
    '  orangu suggest               suggestion records in ~/.orangu',
    '                                 ([<sg_id>] --finding <token>',
    '                                  | [<sg_id>] --rule <r> --scope <s>',
    '                                    --session <a,b>',
    '                                  | --show <id> [--for-proposal|--for-apply]',
    '                                  | --set <id> <status> [--proposal <path>]',
    '                                    [--manifest <path>] [--application <path>]',
    '                                    [--verification <path>]',
    '                                  | --list)',
  ].join('\n'),
]
