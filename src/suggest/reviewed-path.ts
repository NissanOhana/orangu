import { isAbsolute } from 'node:path'

const WINDOWS_RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/

interface ReviewedPathResult {
  path?: string
  violation?: string
}

function inspectReviewedPath(file: string): ReviewedPathResult {
  if (CONTROL_CHARACTER.test(file)) return { violation: 'must not contain control characters or newlines' }
  if (isAbsolute(file) || /^[\\/]/.test(file)) return { violation: 'must be relative to the target repository' }
  if (file.includes(':')) return { violation: 'must not contain a colon or Windows alternate data stream' }

  // Use one platform-independent lexical representation before validating and
  // de-duplicating. This prevents slash aliases from naming the same Windows file.
  const canonical = file.replace(/\\/g, '/')
  const parts = canonical.split('/')
  if (parts.some((part) => part === '')) return { violation: 'must not contain empty path components or a trailing separator' }
  if (parts.some((part) => part === '.')) return { violation: 'must not contain dot path components' }
  if (parts.some((part) => part === '..')) return { violation: 'must not escape the target repository' }
  for (const part of parts) {
    const windowsName = part.replace(/[. ]+$/g, '')
    if (windowsName.toLowerCase() === '.git') return { violation: 'must not modify .git, including Windows aliases' }
    if (windowsName !== part) return { violation: 'must not contain a component ending in a dot or space' }
    const basename = windowsName.split('.')[0]!.replace(/[. ]+$/g, '')
    if (WINDOWS_RESERVED_DEVICE.test(basename)) return { violation: 'must not use a reserved Windows device name' }
  }
  return { path: canonical }
}

/** Return a normalized slash-separated path, or undefined when it is unsafe. */
export function canonicalReviewedPath(file: string): string | undefined {
  return inspectReviewedPath(file).path
}

/** Case-folded key used only for cross-platform alias-safe duplicate detection. */
export function reviewedPathKey(file: string): string | undefined {
  return canonicalReviewedPath(file)?.toLowerCase()
}

/** Return the cross-platform reason a reviewed repository path is unsafe. */
export function reviewedPathViolation(file: string): string | undefined {
  return inspectReviewedPath(file).violation
}
