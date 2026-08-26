/**
 * `orangu evidence <input>`: a bounded, redacted, deterministic handoff for
 * improvement skills. It reads either one supported session selector/.jsonl or
 * one current Orangu JSON artifact. It never writes suggestion state or calls a
 * network surface.
 */
import { extname, resolve } from 'node:path'
import {
  MAX_EVIDENCE_SESSION_BYTES,
  prevalidateEvidenceSession,
  readEvidenceSessionManifest,
} from '../../adapters/claude-code/evidence-input.js'
import { parseClaudeCodeSession } from '../../adapters/claude-code/parse.js'
import { analyzeSession } from '../../analyze/analyze.js'
import {
  candidatesForPrefix,
  claudeRoots,
  findLatestSession,
  resolveSession,
  type DiscoverOptions,
  type SessionRef,
} from '../../discover/discover.js'
import {
  MAX_EVIDENCE_ARTIFACT_BYTES,
  estimateEvidence,
  evidenceLimit,
  parseEvidenceArtifact,
  projectEvidence,
  type EvidenceBundle,
  type ProjectEvidenceOptions,
} from '../../suggest/evidence.js'
import { flagBool, flagStr } from '../args.js'
import { readStableTextFile } from '../../util/stable-file.js'

export { MAX_EVIDENCE_SESSION_BYTES }

function aggregateScope(flags: Record<string, string | boolean>): ProjectEvidenceOptions['scope'] {
  const raw = flags['scope']
  if (raw === undefined) return undefined
  if (raw !== 'repo' && raw !== 'global') throw new Error('--scope must be repo|global and is required for Aggregate JSON')
  return raw
}

function requestedLimit(flags: Record<string, string | boolean>): number {
  const raw = flags['limit']
  if (raw === undefined) return evidenceLimit(undefined)
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('--limit requires an integer value')
  return evidenceLimit(Number(raw))
}

async function selectorOptions(flags: Record<string, string | boolean>): Promise<DiscoverOptions> {
  const configDir = flagStr(flags, 'root', 'config', 'r')
  const cwd = flagStr(flags, 'cwd')
  if (flagBool(flags, 'global')) return { roots: await claudeRoots(configDir), ...(cwd ? { cwd } : {}) }
  return { ...(configDir ? { configDir } : {}), ...(cwd ? { cwd } : {}) }
}

async function resolveEvidenceSession(selector: string, flags: Record<string, string | boolean>): Promise<SessionRef> {
  const options = await selectorOptions(flags)
  if (selector === 'latest') {
    const latest = await findLatestSession(options)
    if (!latest) throw new Error('No sessions found. Is Claude Code installed? Try: orangu list')
    return latest
  }
  const resolved = await resolveSession(selector, options)
  if (resolved) return resolved
  const candidates = await candidatesForPrefix(selector, options)
  if (candidates.length > 1) throw new Error(`Ambiguous session "${selector}". ${candidates.length} matches`)
  throw new Error(`No session matches "${selector}". Try: orangu list`)
}

async function bundleFromJsonFile(path: string, options: ProjectEvidenceOptions): Promise<EvidenceBundle> {
  const absolute = resolve(path)
  const text = await readStableTextFile(absolute, MAX_EVIDENCE_ARTIFACT_BYTES, 'evidence JSON')
  return parseEvidenceArtifact(text, options)
}

async function bundleFromSession(selector: string, flags: Record<string, string | boolean>, options: ProjectEvidenceOptions): Promise<EvidenceBundle> {
  const ref = await resolveEvidenceSession(selector, flags)
  const manifest = await prevalidateEvidenceSession(ref.path)
  const loaded = await readEvidenceSessionManifest(manifest)
  const session = await parseClaudeCodeSession(loaded.parseInput)
  // generatedAt/version are deliberately excluded from EvidenceBundle; fixed values
  // make this adapter clock-free without changing analysis or suggestion identity.
  const analysis = analyzeSession(session, { version: 'evidence', now: 0 })
  return projectEvidence(analysis, options)
}

export async function cmdEvidence(positionals: string[], flags: Record<string, string | boolean>): Promise<void> {
  if (positionals.length !== 1) {
    throw new Error('usage: orangu evidence <session|latest|path.jsonl|analysis.json> [--scope repo|global] [--limit <n>] [--estimate]')
  }
  if (flagBool(flags, 'no-redact')) throw new Error('evidence output is always redacted; --no-redact is not supported')
  if (flags['depth'] !== undefined) throw new Error('orangu evidence has one canonical bounded projection; --depth is only supported by orangu estimate')
  const input = positionals[0]
  if (input === undefined) throw new Error('evidence input is required')
  const options: ProjectEvidenceOptions = { limit: requestedLimit(flags), scope: aggregateScope(flags) }
  const bundle = extname(input).toLowerCase() === '.json' ? await bundleFromJsonFile(input, options) : await bundleFromSession(input, flags, options)
  const output: unknown = flagBool(flags, 'estimate') ? estimateEvidence(bundle) : bundle
  process.stdout.write(JSON.stringify(output, null, flagBool(flags, 'quiet') ? 0 : 2) + '\n')
}
