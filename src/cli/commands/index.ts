/**
 * Command registry. `src/cli/main.ts` dispatches unknown verbs through
 * EXTRA_COMMANDS and prints EXTRA_HELP under 'usage', so new verbs register here without touching main.
 */
import { cmdEstimate } from './estimate.js'
import { cmdEvidence } from './evidence.js'
import { cmdHarness } from './harness.js'
import { cmdSuggest } from './suggest.js'

export type CommandFn = (positionals: string[], flags: Record<string, string | boolean>) => Promise<void>

export const EXTRA_COMMANDS: Record<string, CommandFn> = {
  evidence: cmdEvidence,
  estimate: cmdEstimate,
  harness: cmdHarness,
  suggest: cmdSuggest,
}

export const EXTRA_HELP: string[] = [
  '  orangu evidence <input>       bounded redacted findings + catalog matches for a session/.jsonl or current Orangu JSON  ([--scope repo|global] [--limit <n>] [--estimate] [--json])',
  '  orangu estimate [<session>|repo|global]  size what an LLM would read: bytes and ≈tokens             (--suggestion <id> [--receipt <token>] | --rule <r> --session <a,b>, --depth quick|standard|deep)',
  '  orangu harness               what your config declares vs what your sessions did: skills/MCP/agents/hooks used|idle|undeclared, in tokens  ([--json] [--cwd <dir>] [--root <dir>] [--global] [--limit <n>] [-o|--out <file>] [--no-redact] [--strip-paths] [--jobs <n>] [--no-cache] [--quiet])',
  '  orangu suggest               suggestion records in ~/.orangu  ([<sg_id>] --finding <token> | [<sg_id>] --rule <r> --scope <s> --session <a,b> [--cohort <16hex override; derived when omitted>] | --show <id> [--for-proposal|--for-apply] | --set <id> <status> [--proposal <path>] [--manifest <path>] [--application <path>] [--verification <path>] | --list)',
]
