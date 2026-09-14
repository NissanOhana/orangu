import { describe, it, expect } from 'vitest'
import { argv0Basename, canonicalName, pluginName } from './names.js'

describe('names: pluginName', () => {
  it('strips the marketplace suffix and leaves a bare key alone', () => {
    expect(pluginName('superpowers@superpowers-marketplace')).toBe('superpowers')
    expect(pluginName('orangu')).toBe('orangu')
  })
})

describe('names: canonicalName', () => {
  const declared = new Map<string, { plugin?: string }>([
    ['brainstorming', { plugin: 'superpowers@superpowers-marketplace' }],
    ['backend', { plugin: 'nisso-dev@nisso-skills' }],
    ['local-only', {}],
  ])
  it('returns an exact match unchanged', () => {
    expect(canonicalName('backend', declared)).toBe('backend')
  })
  it("resolves <plugin>:<bare> when the prefix is that entry's plugin name", () => {
    expect(canonicalName('superpowers:brainstorming', declared)).toBe('brainstorming')
    expect(canonicalName('nisso-dev:backend', declared)).toBe('backend')
  })
  it("does not strip a prefix that is not the entry's plugin: two plugins may ship the same bare name", () => {
    expect(canonicalName('other:backend', declared)).toBe('other:backend')
  })
  it('lets an entry without a plugin claim any prefix, as a local override of a plugin name does', () => {
    expect(canonicalName('anything:local-only', declared)).toBe('local-only')
  })
  it('leaves a qualified name nothing declares as observed', () => {
    expect(canonicalName('ghost:nothing', declared)).toBe('ghost:nothing')
  })
})

describe('names: argv0Basename', () => {
  it('keeps only the basename of argv0 and drops quotes and arguments', () => {
    expect(argv0Basename('/opt/tools/notify.sh --token sk-ant-secret')).toBe('notify.sh')
    expect(argv0Basename("'/usr/bin/afplay' ~/x.mp3 &")).toBe('afplay')
    expect(argv0Basename('   ')).toBe('')
  })
  it('names the script, not the interpreter, when argv0 is an interpreter', () => {
    // a dozen plugin hooks would otherwise collapse onto the one key `bash` and inherit each other's event
    expect(argv0Basename('bash "${CLAUDE_PLUGIN_ROOT}/hooks/security.sh" --strict')).toBe('security.sh')
    expect(argv0Basename('python3 /opt/tools/guard.py --json')).toBe('guard.py')
    expect(argv0Basename('node --experimental-strip-types scripts/run-hook.ts')).toBe('run-hook.ts')
    expect(argv0Basename('npx tsx hooks/check.ts')).toBe('check.ts')
  })
  it('falls back to the interpreter when nothing after it looks like a script path', () => {
    expect(argv0Basename('bash -c "echo hi"')).toBe('bash')
    expect(argv0Basename('sh')).toBe('sh')
    // a bare token is a script only with a known script extension: a module name or an inline expression is not
    expect(argv0Basename('python3 -m mymodule.sub')).toBe('python3')
    expect(argv0Basename('node -e console.log(1)')).toBe('node')
  })
  it('never lets an environment assignment stand in for the script: the value is an argument, and arguments carry secrets', () => {
    expect(argv0Basename('env SLACK_WEBHOOK=T01.B02.xoxbSECRET /usr/local/bin/notify.sh')).toBe('notify.sh')
    expect(argv0Basename('env DB_PASSWORD=hunter2.prod /opt/hooks/guard.sh')).toBe('guard.sh')
    expect(argv0Basename('bash FOO=bar.baz')).toBe('bash')
  })
})
