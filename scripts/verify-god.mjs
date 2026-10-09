#!/usr/bin/env node
// verify:god, the last step of `npm run verify`: the gates of the orangu god mod that need the claude binary.
// 1. With no claude on PATH (CI), it prints that it skipped and exits 0. The vitest gates still run there.
// 2. `claude plugin validate --strict --json god` must pass, every gating hook must have a .catch, every `$` call
//    must be in ALLOWED_CALLS, the module may read only HOME and ORANGU_GOD, and it may write no variable.
// 3. `claude plugin test god` must pass.
// 4. When god/.claude-plugin/types holds the engine types of the claude on PATH, `tsc -p tsconfig.god.json` must
//    pass. Types of another version, or none, skip this step with the reason: Claude Code updates often, and a
//    gate that turns red on each update gets turned off. An interactive `claude --plugin-dir god` lays the types.
// `--check-report <file>` prints the findings of a saved validate report as JSON, for test/verify-god.test.ts.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TYPES = 'god/.claude-plugin/types/claude-code/index.d.ts'

/**
 * The `$` calls that the god mod may make: every one that the plan of the mod needs, and no other. It never
 * holds $.fs.write, $.env.set, $.http.*, $.prompt.*, $.process.spawn or $.agent.spawn. The list may shrink. A new
 * call needs a change of the plan first.
 */
const ALLOWED_CALLS = [
  '$.command.register',
  '$.env.get',
  '$.process.run',
  '$.fs.list',
  '$.fs.read',
  '$.fs.stat',
  '$.clock.now',
  '$.clock.every',
  '$.clock.after',
  '$.state.get',
  '$.state.set',
  '$.store.get',
  '$.store.set',
  '$.ui.open',
  '$.ui.resolve',
  '$.ui.status',
  '$.ui.notify',
  '$.ui.invalidate',
  '$.ui.focus',
  '$.session.id',
  '$.session.send',
  '$.tool.register',
  '$.audio.play',
  '$.model.complete',
  '$.config.list',
]
const ENV_READS = ['HOME', 'ORANGU_GOD']

/** Every finding of 1 validate report. A note that the validator does not write counts as none. */
export function reportFindings(report) {
  const findings = []
  if (report?.success !== true) findings.push('the validator failed the plugin')
  const sections = [report?.manifest, ...(Array.isArray(report?.contents) ? report.contents : [])].filter(Boolean)
  let hooksNote = false
  let callsNote = false
  for (const section of sections) {
    for (const error of section.errors ?? []) findings.push(`validator error: ${error.message}`)
    for (const hook of section.gatingHooks ?? []) if (hook.hasCatch !== true) findings.push(`gating hook without .catch: ${hook.hook}`)
    for (const note of section.notes ?? []) {
      const match = /^\S+ (hooks|calls|env reads|env writes): (.*)$/.exec(note)
      if (!match) continue
      const values = match[2].split(',').map((value) => value.trim()).filter((value) => value && value !== 'nothing')
      if (match[1] === 'hooks') hooksNote = true
      if (match[1] === 'calls') {
        callsNote = true
        for (const call of values) if (!ALLOWED_CALLS.includes(call)) findings.push(`call outside the allowlist: ${call}`)
      }
      if (match[1] === 'env reads') for (const name of values) if (!ENV_READS.includes(name)) findings.push(`environment read outside HOME and ORANGU_GOD: ${name}`)
      if (match[1] === 'env writes') for (const name of values) findings.push(`environment write: ${name}`)
    }
  }
  // the god module always hooks and calls: no such note means the validator changed how it writes them
  if (report?.success === true && !(hooksNote && callsNote)) findings.push('the report has no hooks note and calls note: read the validator output and update this script')
  return findings
}

const versionOf = (text) => /\d+\.\d+\.\d+/.exec(text ?? '')?.[0]

function run(command, args) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function fail(lines) {
  for (const line of lines) process.stderr.write(`${line}\n`)
  process.exit(1)
}

function main() {
  const at = process.argv.indexOf('--check-report')
  if (at >= 0) {
    const file = process.argv[at + 1]
    if (!file) fail(['verify:god: --check-report needs a file'])
    process.stdout.write(`${JSON.stringify(reportFindings(JSON.parse(readFileSync(file, 'utf8'))))}\n`)
    return
  }

  const version = run('claude', ['--version'])
  if (version.error) {
    if (version.error.code === 'ENOENT') {
      process.stdout.write('verify:god skipped: no claude binary on PATH\n')
      return
    }
    fail([`verify:god: claude --version did not run: ${version.error.message}`])
  }
  const claudeVersion = versionOf(version.stdout)

  const validate = run('claude', ['plugin', 'validate', '--strict', '--json', 'god'])
  let report
  try {
    report = JSON.parse(validate.stdout)
  } catch {
    fail(['verify:god validate failed: the report is not JSON', validate.stdout, validate.stderr])
  }
  const findings = reportFindings(report)
  if (validate.status !== 0 && !findings.includes('the validator failed the plugin')) findings.unshift(`claude plugin validate exited ${validate.status}`)
  if (findings.length > 0) fail(['verify:god validate failed:', ...findings.map((finding) => `  ${finding}`)])
  const notes = (report.contents ?? []).flatMap((section) => section.notes ?? [])
  const note = (name) => notes.find((line) => line.includes(` ${name}: `))?.split(`${name}: `)[1] ?? 'none'
  const gating = (report.contents ?? []).flatMap((section) => section.gatingHooks ?? []).length
  process.stdout.write(`verify:god validate ok (claude ${claudeVersion}): ${gating} gating hooks, each with .catch; calls ${note('calls')}; env reads ${note('env reads')}; env writes ${note('env writes')}\n`)

  const test = run('claude', ['plugin', 'test', 'god'])
  const summary = `${test.stdout}${test.stderr}`.split('\n').filter((line) => /^\s*\d+ (pass|fail)\s*$/.test(line)).map((line) => line.trim()).join(', ')
  if (test.status !== 0) fail([`verify:god test failed (${summary || `exit ${test.status}`}):`, test.stdout, test.stderr])
  process.stdout.write(`verify:god test ok: ${summary}\n`)

  if (!existsSync(join(root, TYPES))) {
    process.stdout.write(`verify:god type-check skipped: no ${TYPES}; an interactive claude --plugin-dir god lays it\n`)
    return
  }
  const typesVersion = versionOf(readFileSync(join(root, TYPES), 'utf8').split('\n', 1)[0])
  if (!typesVersion || typesVersion !== claudeVersion) {
    process.stdout.write(`verify:god type-check skipped: the types are from Claude Code ${typesVersion ?? 'unknown'} and claude is ${claudeVersion}; an interactive claude --plugin-dir god lays new ones\n`)
    return
  }
  const tsc = run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.god.json'])
  if (tsc.status !== 0) fail(['verify:god type-check failed (tsc -p tsconfig.god.json):', tsc.stdout, tsc.stderr])
  process.stdout.write(`verify:god type-check ok: tsc -p tsconfig.god.json against the Claude Code ${typesVersion} types\n`)
}

main()
