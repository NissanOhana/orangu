import { arch, platform } from 'node:os'
import type { FeedbackContext, FeedbackDiagnostics } from './model.js'

export type FeedbackBootstrap = Omit<FeedbackDiagnostics, 'context'>

function osFamily(value: NodeJS.Platform): FeedbackDiagnostics['osFamily'] {
  if (value === 'darwin') return 'macOS'
  if (value === 'win32') return 'Windows'
  if (value === 'linux') return 'Linux'
  return 'other'
}

function safeArch(value: string): FeedbackDiagnostics['arch'] {
  return value === 'arm64' || value === 'x64' ? value : 'other'
}

/** Construct the complete diagnostic allowlist without accepting arbitrary data. */
export function feedbackDiagnostics(version: string, context: FeedbackContext): FeedbackDiagnostics {
  return {
    version,
    nodeMajor: process.versions.node.split('.')[0] ?? 'unknown',
    osFamily: osFamily(platform()),
    arch: safeArch(arch()),
    context,
    surface: 'localhost',
  }
}

export function feedbackBootstrap(version: string): FeedbackBootstrap {
  const { context: _context, ...bootstrap } = feedbackDiagnostics(version, 'app')
  return bootstrap
}
