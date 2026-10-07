import { describe, expect, it } from 'vitest'
import { checkText } from '../ste/index.js'
import { rawOutputRefusal } from './raw-output.js'

const CLAUDE = { CLAUDECODE: '1' }

describe('rawOutputRefusal', () => {
  // A line planted in a transcript, a file or a page can make Claude run a pre-approved
  // `orangu report latest --no-redact --include-text -o <repo>/notes.md`. Inside Claude Code, unredacted session text
  // goes to a path that the command names only with ORANGU_ALLOW_RAW=1, and Claude Code asks before an env prefix.
  it('inside Claude Code, refuses --no-redact or --include-text with a path that the command names', () => {
    const lines: Array<Record<string, string | boolean>> = [
      { o: 'notes.md', 'no-redact': true },
      { out: 'notes.md', 'include-text': true },
      { out: 'aggregate.json', 'no-redact': true, 'include-text': true },
      { html: 'repo.html', 'include-text': true },
    ]
    for (const flags of lines) {
      const message = rawOutputRefusal(flags, CLAUDE)
      expect(message, JSON.stringify(flags)).toContain('ORANGU_ALLOW_RAW=1')
      expect(message).toContain('Text in a session can steer Claude to run such a command with no prompt.')
    }
    expect(rawOutputRefusal({ o: 'x.html', 'no-redact': true }, CLAUDE)).toMatch(/^--no-redact with -o: /)
    expect(rawOutputRefusal({ html: 'x.html', 'no-redact': true, 'include-text': true }, CLAUDE)).toMatch(/^--no-redact and --include-text with --html: /)
  })

  it('allows the same command with ORANGU_ALLOW_RAW=1, outside Claude Code, with redaction, or with the default path', () => {
    expect(rawOutputRefusal({ o: 'notes.md', 'no-redact': true }, { ...CLAUDE, ORANGU_ALLOW_RAW: '1' })).toBeUndefined()
    expect(rawOutputRefusal({ o: 'notes.md', 'no-redact': true }, {})).toBeUndefined()
    expect(rawOutputRefusal({ o: 'notes.md', 'no-redact': true }, { CLAUDECODE: '' })).toBeUndefined()
    expect(rawOutputRefusal({ o: 'notes.md' }, CLAUDE)).toBeUndefined()
    expect(rawOutputRefusal({ o: 'notes.md', 'strip-paths': true }, CLAUDE)).toBeUndefined()
    // no path: orangu chooses a private temporary file
    expect(rawOutputRefusal({ 'no-redact': true, 'include-text': true }, CLAUDE)).toBeUndefined()
    // --html with no file name writes to the temporary directory too
    expect(rawOutputRefusal({ html: true, 'include-text': true }, CLAUDE)).toBeUndefined()
    // any other value than 1 does not allow it
    expect(rawOutputRefusal({ o: 'notes.md', 'no-redact': true }, { ...CLAUDE, ORANGU_ALLOW_RAW: 'yes' })).toContain('ORANGU_ALLOW_RAW=1')
  })

  it('the refusal is STE', () => {
    const message = rawOutputRefusal({ o: 'notes.md', 'no-redact': true }, CLAUDE)!
    expect(checkText(message).findings).toEqual([])
  })
})
