import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkText } from '../ste/index.js'
import { outputPathRefusal, type OutputPlaces } from './output-path.js'

const CLAUDE = { CLAUDECODE: '1' }
const ALLOW = { ...CLAUDE, ORANGU_ALLOW_OUT: '1' }
/** A file system link needs a privilege on Windows, so the link cases run on macOS and Linux. */
const links = process.platform !== 'win32'
/** parts of the 2 refusals: a place, and a name that an agent loads */
const PLACE = 'only in a folder inside the temp folder or in the orangu home'
const WORK = 'It does not write in the current folder or in its git repository.'
const ASKS = 'start the command with ORANGU_ALLOW_OUT=1, so that Claude Code asks you first'
const LOADED = 'orangu does not write CLAUDE.md, CLAUDE.local.md, AGENTS.md, .mcp.json or a file in a .claude folder'

/**
 * Real folders: a temp folder with a run folder in it (as `mktemp -d` makes), an orangu home, a repository, and the
 * folder of the command. Only the run folder and the home are places where a named file may go.
 */
function folders(): { root: string; temp: string; run: string; home: string; repo: string; work: string; places: OutputPlaces } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orangu-output-path-')))
  const temp = join(root, 'temp')
  const run = join(temp, 'tmp.Xy12')
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  const work = join(root, 'work')
  for (const dir of [temp, run, home, repo, work]) mkdirSync(dir)
  return { root, temp, run, home, repo, work, places: { temp, home, cwd: work } }
}

describe('outputPathRefusal', () => {
  // A line planted in session evidence can make Claude run a pre-approved `orangu repo <repo> --out <repo>/notes.json`
  // with no prompt. Inside Claude Code, a path that the command names goes only to a folder inside the temp folder or to
  // the orangu home, unless ORANGU_ALLOW_OUT=1 starts the command, and Claude Code asks before an env prefix.
  it('inside Claude Code, refuses -o, --out or --html outside the temp folder and the orangu home', () => {
    const { temp, run, repo, places } = folders()
    const lines: Array<Record<string, string | boolean>> = [{ o: join(repo, 'report.html') }, { out: join(repo, 'aggregate.json') }, { html: join(repo, 'repo.html') }]
    for (const flags of lines) {
      const message = outputPathRefusal(flags, CLAUDE, places)
      expect(message, JSON.stringify(flags)).toContain(PLACE)
      expect(message).toContain(ASKS)
      expect(message).toContain('Text in a session can steer Claude to run such a command with no prompt.')
    }
    expect(outputPathRefusal({ o: join(repo, 'x.html') }, CLAUDE, places)).toMatch(/^-o: inside Claude Code, /)
    expect(outputPathRefusal({ html: join(repo, 'x.html') }, CLAUDE, places)).toMatch(/^--html: inside Claude Code, /)
    // a relative path names a file in the folder of the test run, which is in no place
    expect(outputPathRefusal({ o: 'notes.json' }, CLAUDE, places)).toMatch(/^-o: inside Claude Code, /)
    // each named path counts: a path in the run folder does not let another flag out
    expect(outputPathRefusal({ o: join(run, 'a.json'), out: join(repo, 'b.json') }, CLAUDE, places)).toMatch(/^--out: /)
    // a folder whose name starts with the name of a place is not in that place
    expect(outputPathRefusal({ out: join(`${temp}-next`, 'tmp.Xy12', 'a.json') }, CLAUDE, places)).toContain(PLACE)
    expect(outputPathRefusal({ out: join(run, '..', '..', 'repo', 'a.json') }, CLAUDE, places)).toContain(PLACE)
  })

  it('a named file in the temp folder goes in a folder inside it, as `mktemp -d` makes, never straight into it', () => {
    const { temp, run, home, places } = folders()
    expect(outputPathRefusal({ out: join(temp, 'aggregate.json') }, CLAUDE, places)).toContain(PLACE)
    expect(outputPathRefusal({ out: join(run, 'aggregate.json') }, CLAUDE, places)).toBeUndefined()
    // a folder that does not exist yet, deeper in the run folder
    expect(outputPathRefusal({ out: join(run, 'deeper', 'aggregate.json') }, CLAUDE, places)).toBeUndefined()
    // the orangu home takes a file straight in it
    expect(outputPathRefusal({ out: join(home, 'aggregate.json') }, CLAUDE, places)).toBeUndefined()
    // ORANGU_ALLOW_OUT=1 lifts this part of the rule
    expect(outputPathRefusal({ out: join(temp, 'aggregate.json') }, ALLOW, places)).toBeUndefined()
  })

  it('never writes in the folder of the command or in its git repository, even inside the temp folder or the home', () => {
    const { temp, run, home } = folders()
    const inRun: OutputPlaces = { temp, home, cwd: run }
    expect(outputPathRefusal({ out: join(run, 'a.json') }, CLAUDE, inRun)).toContain(WORK)
    expect(outputPathRefusal({ out: join(run, 'sub', 'a.json') }, CLAUDE, inRun)).toContain(WORK)
    expect(outputPathRefusal({ out: join(temp, 'tmp.Other', 'a.json') }, CLAUDE, inRun)).toBeUndefined()
    // a clone marks its root with a .git folder
    const clone = join(run, 'clone')
    mkdirSync(join(clone, '.git'), { recursive: true })
    mkdirSync(join(clone, 'sub'))
    const inClone: OutputPlaces = { temp, home, cwd: join(clone, 'sub') }
    expect(outputPathRefusal({ out: join(clone, 'a.json') }, CLAUDE, inClone)).toContain(WORK)
    expect(outputPathRefusal({ out: join(clone, 'sub', 'a.json') }, CLAUDE, inClone)).toContain(WORK)
    expect(outputPathRefusal({ out: join(run, 'a.json') }, CLAUDE, inClone)).toBeUndefined()
    // a worktree or a submodule marks its root with a .git file
    const worktree = join(home, 'worktree')
    mkdirSync(join(worktree, 'sub'), { recursive: true })
    writeFileSync(join(worktree, '.git'), 'gitdir: /nowhere\n')
    const inWorktree: OutputPlaces = { temp, home, cwd: join(worktree, 'sub') }
    expect(outputPathRefusal({ out: join(worktree, 'a.json') }, CLAUDE, inWorktree)).toContain(WORK)
    expect(outputPathRefusal({ out: join(home, 'a.json') }, CLAUDE, inWorktree)).toBeUndefined()
    // the orangu home as the folder of the command
    expect(outputPathRefusal({ out: join(home, 'a.json') }, CLAUDE, { temp, home, cwd: home })).toContain(WORK)
    // a folder of the command that orangu cannot read: no named file is safe
    expect(outputPathRefusal({ out: join(run, 'a.json') }, CLAUDE, { temp, home, cwd: undefined })).toContain(ASKS)
    // ORANGU_ALLOW_OUT=1 lifts this part of the rule
    expect(outputPathRefusal({ out: join(run, 'a.json') }, ALLOW, inRun)).toBeUndefined()
    expect(outputPathRefusal({ out: join(clone, 'a.json') }, ALLOW, inClone)).toBeUndefined()
  })

  // Claude Code loads CLAUDE.md and CLAUDE.local.md from each folder above its cwd, .mcp.json, and each file in a .claude
  // folder. Codex loads AGENTS.md. orangu writes only HTML and JSON reports, so no real use needs these names.
  it('refuses a name that an agent loads in every folder, and ORANGU_ALLOW_OUT=1 does not change it', () => {
    const { temp, run, home, repo, places } = folders()
    const names = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.mcp.json', 'claude.MD', 'Claude.Local.Md', 'agents.md', '.MCP.JSON', 'AGENTſ.md']
    for (const folder of [run, home, repo, temp]) {
      for (const name of names) {
        for (const env of [CLAUDE, ALLOW]) {
          expect(outputPathRefusal({ out: join(folder, name) }, env, places), `${folder} ${name} ${JSON.stringify(env)}`).toContain(LOADED)
        }
      }
    }
    // a file in a .claude folder, in any case, and a file named .claude
    for (const path of [join(run, '.claude', 'settings.json'), join(home, '.claude', 'rules', 'a.md'), join(repo, '.Claude', 'commands', 'x.md'), join(run, '.claude')]) {
      expect(outputPathRefusal({ html: path }, ALLOW, places), path).toContain(LOADED)
    }
    // the forms that Windows writes to the same file: a stream name, a dot or a space at the end
    for (const name of ['CLAUDE.md::$DATA', 'AGENTS.md:x', 'CLAUDE.md.', 'CLAUDE.md ', '.mcp.json. ']) {
      expect(outputPathRefusal({ o: join(run, name) }, ALLOW, places), JSON.stringify(name)).toContain(LOADED)
    }
    expect(outputPathRefusal({ o: join(run, 'CLAUDE.md') }, ALLOW, places)).toMatch(/^-o: /)
    // other names that only hold these names go through
    for (const name of ['CLAUDE.md.json', 'AGENTS.md.html', 'my-claude.md', 'mcp.json', join('.claude-x', 'a.json'), join('claude', 'a.json')]) {
      expect(outputPathRefusal({ out: join(run, name) }, CLAUDE, places), name).toBeUndefined()
    }
    // a terminal does not change
    expect(outputPathRefusal({ out: join(repo, 'CLAUDE.md') }, {}, places)).toBeUndefined()
  })

  it.runIf(links)('reads the real path: a link that leaves the place, or that lands on a name that an agent loads, is refused', () => {
    const { root, run, home, repo, places } = folders()
    symlinkSync(repo, join(run, 'link'))
    expect(outputPathRefusal({ out: join(run, 'link', 'a.json') }, CLAUDE, places)).toContain(PLACE)
    // a link to a file that does not exist yet: the write would follow it into the repository
    symlinkSync(join(repo, 'a.json'), join(run, 'dangling.json'))
    expect(outputPathRefusal({ out: join(run, 'dangling.json') }, CLAUDE, places)).toContain(PLACE)
    // a link to a .claude folder, and a link to a CLAUDE.md, with the prefix too
    mkdirSync(join(root, 'other', '.claude'), { recursive: true })
    symlinkSync(join(root, 'other', '.claude'), join(run, 'to-claude'))
    expect(outputPathRefusal({ out: join(run, 'to-claude', 'settings.json') }, ALLOW, places)).toContain(LOADED)
    writeFileSync(join(repo, 'CLAUDE.md'), '# rules\n')
    symlinkSync(join(repo, 'CLAUDE.md'), join(run, 'notes.json'))
    expect(outputPathRefusal({ out: join(run, 'notes.json') }, ALLOW, places)).toContain(LOADED)
    // the other way: a link in the repository that points into the orangu home, so the file lands in the home
    symlinkSync(home, join(repo, 'to-home'))
    expect(outputPathRefusal({ out: join(repo, 'to-home', 'a.json') }, CLAUDE, places)).toBeUndefined()
  })

  it.runIf(links)('reads each place and the folder of the command at its real path too', () => {
    const { root, temp, run, home, work } = folders()
    const linkedTemp = join(root, 'temp-link')
    symlinkSync(temp, linkedTemp)
    expect(outputPathRefusal({ out: join(run, 'a.json') }, CLAUDE, { temp: linkedTemp, home, cwd: work })).toBeUndefined()
    expect(outputPathRefusal({ out: join(linkedTemp, 'tmp.Xy12', 'a.json') }, CLAUDE, { temp, home, cwd: work })).toBeUndefined()
    const linkedRun = join(root, 'run-link')
    symlinkSync(run, linkedRun)
    expect(outputPathRefusal({ out: join(run, 'a.json') }, CLAUDE, { temp, home, cwd: linkedRun })).toContain(WORK)
  })

  it('allows ORANGU_ALLOW_OUT=1, a terminal, and no path', () => {
    const { repo, places } = folders()
    const named = { out: join(repo, 'aggregate.json') }
    expect(outputPathRefusal(named, ALLOW, places)).toBeUndefined()
    expect(outputPathRefusal(named, {}, places)).toBeUndefined()
    expect(outputPathRefusal(named, { CLAUDECODE: '' }, places)).toBeUndefined()
    // no path: orangu chooses a file in the temp folder
    expect(outputPathRefusal({ html: true }, CLAUDE, places)).toBeUndefined()
    expect(outputPathRefusal({ o: '' }, CLAUDE, places)).toBeUndefined()
    expect(outputPathRefusal({ 'no-redact': true }, CLAUDE, places)).toBeUndefined()
    // any other value than 1 does not allow it
    expect(outputPathRefusal(named, { ...CLAUDE, ORANGU_ALLOW_OUT: 'yes' }, places)).toContain(ASKS)
  })

  it('by default, the places are the temp folder of the OS and the orangu home of the environment', () => {
    // a path at the root of the file system is in no place, and the check writes nothing
    const outside = join(sep, 'orangu-output-path-none', 'a.json')
    expect(outputPathRefusal({ out: outside }, CLAUDE)).toContain(PLACE)
    expect(outputPathRefusal({ out: join(tmpdir(), 'orangu-output-path', 'a.json') }, CLAUDE)).toBeUndefined()
    expect(outputPathRefusal({ out: join(tmpdir(), 'orangu-output-path.json') }, CLAUDE)).toContain(PLACE)
    const home = join(sep, 'orangu-output-path-home')
    expect(outputPathRefusal({ out: join(home, 'a.json') }, { ...CLAUDE, ORANGU_HOME: home })).toBeUndefined()
    expect(outputPathRefusal({ out: join(home, 'orangu', 'a.json') }, { ...CLAUDE, XDG_DATA_HOME: home })).toBeUndefined()
    expect(outputPathRefusal({ out: join(home, 'a.json') }, { ...CLAUDE, XDG_DATA_HOME: home })).toContain(PLACE)
  })

  it('both refusals are STE', () => {
    const { repo, places } = folders()
    for (const name of ['aggregate.json', 'CLAUDE.md']) {
      const message = outputPathRefusal({ out: join(repo, name) }, CLAUDE, places)!
      expect(checkText(message).findings, message).toEqual([])
    }
  })
})
