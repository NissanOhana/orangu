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
  it('skips the NAME=value assignments in front of argv0, as the shell does: the program names the hook, never a value', () => {
    expect(argv0Basename('NTFY_TOPIC=FAKEhooktopic91 ~/.claude/hooks/ntfy.sh')).toBe('ntfy.sh')
    expect(argv0Basename('DB_PASS=FAKEpass1 SIGNING_KEY=FAKEkey2 node hooks/sign.js --now')).toBe('sign.js')
    expect(argv0Basename('"API_HOST=FAKEhost3" /usr/local/bin/afplay x.mp3')).toBe('afplay')
    // only assignments: no program, so no name
    expect(argv0Basename('FOO=FAKEbar4')).toBe('')
  })
  it('reads each leading assignment as 1 shell word: a quoted value or an escaped space never becomes the program', () => {
    expect(argv0Basename('AUTH="Bearer FAKEtoken6" ~/.claude/hooks/post.sh')).toBe('post.sh')
    expect(argv0Basename('CURL_OPTS="-u admin:FAKEpw7" ~/.claude/hooks/curl-hook.sh --quiet')).toBe('curl-hook.sh')
    expect(argv0Basename('TOPIC=a\\ FAKEt8 ~/.claude/hooks/ntfy.sh')).toBe('ntfy.sh')
    expect(argv0Basename("NOTE='a FAKEt9 b' /opt/hooks/note.sh")).toBe('note.sh')
    expect(argv0Basename('MSG="say \\"hi FAKEt10\\" now" X=1 /opt/hooks/say.sh')).toBe('say.sh')
    // the shapes of the security re-check: a double quote, a single quote, an escaped space, an escaped double quote
    expect(argv0Basename('TOKEN="abc FAKEv20" ~/.claude/hooks/h.sh')).toBe('h.sh')
    expect(argv0Basename("TOKEN='abc FAKEv21' ~/.claude/hooks/h.sh")).toBe('h.sh')
    expect(argv0Basename('TOKEN=abc\\ FAKEv22 ~/.claude/hooks/h.sh')).toBe('h.sh')
    expect(argv0Basename('TOKEN="a\\" FAKEv24" ~/.claude/hooks/h.sh')).toBe('h.sh')
  })
  it('names nothing when a quote does not close, in any word', () => {
    expect(argv0Basename('AUTH="Bearer FAKEt11 ~/.claude/hooks/post.sh')).toBe('')
    expect(argv0Basename("NOTE='FAKEt12 /opt/hooks/note.sh")).toBe('')
    expect(argv0Basename('"/opt/hooks/hook.sh --x')).toBe('')
    expect(argv0Basename('node --key "FAKEv29 hook.js')).toBe('')
  })
  it('names nothing when a word holds a substitution: $(, a backtick or $\'', () => {
    expect(argv0Basename("TOKEN=$'a FAKEv23' ~/.claude/hooks/h.sh")).toBe('')
    expect(argv0Basename('TOKEN=$(cat FAKEv27) ~/.claude/hooks/h.sh')).toBe('')
    expect(argv0Basename('TOKEN=`cat FAKEv28` ~/.claude/hooks/h.sh')).toBe('')
  })
  it('keeps a first word with = that is no assignment: a path names its script, never the argument after it', () => {
    expect(argv0Basename('/opt/run=1/hook.sh FAKEarg13')).toBe('hook.sh')
    expect(argv0Basename('/opt/run=1/hook.sh x')).toBe('hook.sh')
  })
  it('reads the words after an interpreter as shell words too, and takes the word after a flag with no = as the script only with a script extension', () => {
    expect(argv0Basename('env A="x y" d.sh')).toBe('d.sh')
    expect(argv0Basename('env AUTH="Bearer Zm9v/FAKEv26" ~/h.sh')).toBe('h.sh')
    expect(argv0Basename('node --key Zm9v/FAKEv25 x.js')).toBe('x.js')
    expect(argv0Basename('node --key=Zm9v/FAKEv30 /opt/hooks/x.js')).toBe('x.js')
  })
  it('keeps the names of the env forms', () => {
    expect(argv0Basename('env FOO=1 cmd')).toBe('env')
    expect(argv0Basename('FOO=1 BAR=2 cmd')).toBe('cmd')
    expect(argv0Basename('cmd=1')).toBe('')
  })
})
