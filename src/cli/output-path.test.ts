import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkText } from '../ste/index.js'
import { outputPathRefusal } from './output-path.js'

const CLAUDE = { CLAUDECODE: '1' }
/** A file system link needs a privilege on Windows, so the link cases run on macOS and Linux. */
const links = process.platform !== 'win32'

/** A temp folder, an orangu home, and a repository beside them: 3 real folders. */
function folders(): { temp: string; home: string; repo: string; places: string[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orangu-output-path-')))
  const temp = join(root, 'temp')
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  for (const dir of [temp, home, repo]) mkdirSync(dir)
  return { temp, home, repo, places: [temp, home] }
}

describe('outputPathRefusal', () => {
  // A line planted in session evidence can make Claude run a pre-approved `orangu repo <repo> --out
  // <repo>/CLAUDE.local.md` with no prompt, and later sessions load that file as instructions. Inside Claude Code, a
  // path that the command names goes only to the temp folder or the orangu home, unless ORANGU_ALLOW_OUT=1 starts the
  // command, and Claude Code asks before an env prefix.
  it('inside Claude Code, refuses -o, --out or --html outside the temp folder and the orangu home', () => {
    const { temp, repo, places } = folders()
    const lines: Array<Record<string, string | boolean>> = [
      { o: join(repo, 'CLAUDE.local.md') },
      { out: join(repo, 'CLAUDE.local.md') },
      { html: join(repo, 'repo.html') },
      // a relative path names a file in the folder of the command
      { o: 'notes.md' },
    ]
    for (const flags of lines) {
      const message = outputPathRefusal(flags, CLAUDE, places)
      expect(message, JSON.stringify(flags)).toContain('ORANGU_ALLOW_OUT=1')
      expect(message).toContain('Text in a session can steer Claude to run such a command with no prompt.')
    }
    expect(outputPathRefusal({ o: join(repo, 'x.html') }, CLAUDE, places)).toMatch(/^-o: inside Claude Code, /)
    expect(outputPathRefusal({ html: join(repo, 'x.html') }, CLAUDE, places)).toMatch(/^--html: inside Claude Code, /)
    // each named path counts: a path in the temp folder does not let another flag out
    expect(outputPathRefusal({ o: join(temp, 'a.json'), out: join(repo, 'b.json') }, CLAUDE, places)).toMatch(/^--out: /)
    // a folder whose name starts with the name of a place is not in that place
    expect(outputPathRefusal({ out: `${temp}-next${sep}a.json` }, CLAUDE, places)).toContain('ORANGU_ALLOW_OUT=1')
    expect(outputPathRefusal({ out: join(temp, '..', 'repo', 'CLAUDE.md') }, CLAUDE, places)).toContain('ORANGU_ALLOW_OUT=1')
  })

  it.runIf(links)('reads the real path: a link in the temp folder that points into the repository is refused', () => {
    const { temp, repo, places } = folders()
    symlinkSync(repo, join(temp, 'link'))
    expect(outputPathRefusal({ out: join(temp, 'link', 'CLAUDE.local.md') }, CLAUDE, places)).toContain('ORANGU_ALLOW_OUT=1')
    // a link to a file that does not exist yet: the write would follow it into the repository
    symlinkSync(join(repo, 'CLAUDE.md'), join(temp, 'dangling.md'))
    expect(outputPathRefusal({ out: join(temp, 'dangling.md') }, CLAUDE, places)).toContain('ORANGU_ALLOW_OUT=1')
    // the other way: a link in the repository that points into the orangu home, so the file lands in the home
    symlinkSync(join(repo, '..', 'home'), join(repo, 'to-home'))
    expect(outputPathRefusal({ out: join(repo, 'to-home', 'a.json') }, CLAUDE, places)).toBeUndefined()
  })

  it.runIf(links)('reads each place at its real path too', () => {
    const { temp, home, repo } = folders()
    const linkedTemp = join(repo, '..', 'temp-link')
    symlinkSync(temp, linkedTemp)
    expect(outputPathRefusal({ out: join(temp, 'a.json') }, CLAUDE, [linkedTemp, home])).toBeUndefined()
    expect(outputPathRefusal({ out: join(linkedTemp, 'a.json') }, CLAUDE, [temp, home])).toBeUndefined()
  })

  it('allows the temp folder, a folder in it, the orangu home, ORANGU_ALLOW_OUT=1, a terminal, and no path', () => {
    const { temp, home, repo, places } = folders()
    expect(outputPathRefusal({ out: join(temp, 'aggregate.json') }, CLAUDE, places)).toBeUndefined()
    // `mktemp -d` makes a folder in the temp folder, and a skill writes its evidence there
    mkdirSync(join(temp, 'tmp.Xy12'))
    expect(outputPathRefusal({ out: join(temp, 'tmp.Xy12', 'harness.json') }, CLAUDE, places)).toBeUndefined()
    expect(outputPathRefusal({ o: join(home, 'report.html'), html: join(home, 'repo.html') }, CLAUDE, places)).toBeUndefined()
    // a place that does not exist yet
    expect(outputPathRefusal({ o: join(home, 'new', 'report.html') }, CLAUDE, [temp, join(home, 'new')])).toBeUndefined()

    const named = { out: join(repo, 'CLAUDE.local.md') }
    expect(outputPathRefusal(named, { ...CLAUDE, ORANGU_ALLOW_OUT: '1' }, places)).toBeUndefined()
    expect(outputPathRefusal(named, {}, places)).toBeUndefined()
    expect(outputPathRefusal(named, { CLAUDECODE: '' }, places)).toBeUndefined()
    // no path: orangu chooses a file in the temp folder
    expect(outputPathRefusal({ html: true }, CLAUDE, places)).toBeUndefined()
    expect(outputPathRefusal({ o: '' }, CLAUDE, places)).toBeUndefined()
    expect(outputPathRefusal({ 'no-redact': true }, CLAUDE, places)).toBeUndefined()
    // any other value than 1 does not allow it
    expect(outputPathRefusal(named, { ...CLAUDE, ORANGU_ALLOW_OUT: 'yes' }, places)).toContain('ORANGU_ALLOW_OUT=1')
  })

  it('by default, the places are the temp folder of the OS and the orangu home of the environment', () => {
    // a path at the root of the file system is in no place, and the check writes nothing
    const outside = join(sep, 'orangu-output-path-none', 'a.json')
    expect(outputPathRefusal({ out: outside }, CLAUDE)).toContain('ORANGU_ALLOW_OUT=1')
    expect(outputPathRefusal({ out: join(tmpdir(), 'orangu-output-path.json') }, CLAUDE)).toBeUndefined()
    const home = join(sep, 'orangu-output-path-home')
    expect(outputPathRefusal({ out: join(home, 'a.json') }, { ...CLAUDE, ORANGU_HOME: home })).toBeUndefined()
    expect(outputPathRefusal({ out: join(home, 'orangu', 'a.json') }, { ...CLAUDE, XDG_DATA_HOME: home })).toBeUndefined()
    expect(outputPathRefusal({ out: join(home, 'a.json') }, { ...CLAUDE, XDG_DATA_HOME: home })).toContain('ORANGU_ALLOW_OUT=1')
  })

  it('the refusal is STE', () => {
    const message = outputPathRefusal({ out: join(sep, 'orangu-output-path-none', 'a.json') }, CLAUDE)!
    expect(checkText(message).findings).toEqual([])
  })
})
