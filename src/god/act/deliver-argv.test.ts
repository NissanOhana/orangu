/**
 * The host of the executor takes only the argv forms that the key path runs: cmux send of 1 text (a line of a prompt
 * or the digit of an option) and send-key of enter or shift+enter, both with the refs and `--`; cmux read-screen of 1
 * tab; ps of 1 PID in UTC; and the 3 reads of the transcript (stat of the inode, tail from a byte, head of at most
 * 64 KiB) of a .jsonl file under the projects folder of the home. Each pin has a test with the argv that only that
 * pin refuses.
 */
import { describe, expect, it } from 'vitest'
import { HOME, SF, TRANSCRIPT, WS, asks, machine, sendKey, sendText } from '../../../test/fixtures/god/deliver-machine.js'
import { REFUSED_DELIVER_ARGV, deliverHost, isDeliverArgv } from './deliver.js'

const takes = (argv: readonly string[]): boolean => isDeliverArgv(argv, HOME)
const PROJECTS = `${HOME}/.claude/projects`

describe('isDeliverArgv: the only commands of the executor', () => {
  it('takes cmux send and send-key with both refs and -- right before 1 value, the screen read, ps and the transcript reads', () => {
    for (const argv of [
      sendText('1'),
      sendKey('enter'),
      sendText('--surface x'),
      ['cmux', 'read-screen', '--workspace', WS, '--surface', SF, '--lines', '40'],
      ['stat', '-f', '%i %N', TRANSCRIPT],
      ['tail', '-c', '+1', TRANSCRIPT],
      ['tail', '-c', '+2097153', TRANSCRIPT],
      ['head', '-c', '100', TRANSCRIPT],
      ['head', '-c', '65536', TRANSCRIPT],
      ['stat', '-f', '%i %N', `${PROJECTS}/-other-folder/session-color.jsonl`],
      ['ps', '-o', 'pid=,tty=,lstart=', '-p', '4242'],
    ]) {
      expect(takes(argv), argv.join(' ')).toBe(true)
    }
  })

  it('refuses every other cmux subcommand, a key with no --, a bad ref, more values, and every other command', () => {
    for (const argv of [
      ['cmux', 'notify', '--title', 't', '--body', 'b'],
      ['cmux', 'select-workspace', '--workspace', WS],
      ['cmux', 'focus-panel', '--panel', SF, '--workspace', WS],
      ['cmux', 'send', '--workspace', WS, '--surface', SF, 'text'],
      ['cmux', 'send', '--workspace', '3', '--surface', SF, '--', 'text'],
      ['cmux', 'send-key', '--workspace', WS, '--surface', SF, '--', '1', 'enter'],
      ['cmux', 'send-key', '--surface', SF, '--workspace', WS, '--', '1'],
      ['cmux', 'read-screen', '--workspace', WS, '--surface', SF, '--lines', '40', '--scrollback'],
      ['claude', '-p', 'hi'],
      ['git', 'push'],
      ['ps', '-o', 'pid='],
      ['ps', '-o', 'pid=,tty=,lstart=', '-p', '4242,4243'],
      ['ps', '-o', 'pid=,tty=,lstart=', '-p', '-1'],
      ['ps', '-o', 'pid=,tty=,lstart=', '-p', '4242', '-e'],
      [],
    ]) {
      expect(takes(argv), argv.join(' ')).toBe(false)
    }
  })

  it('takes send-key only with a key that the plan sends: enter or shift+enter, and no digit, which cmux send-key rejects', () => {
    for (const key of ['enter', 'shift+enter']) expect(takes(sendKey(key)), key).toBe(true)
    for (const key of ['1', '5', '9', '0', '10', 'escape', 'esc', 'tab', 'shift+tab', 'ctrl+c', 'Enter', 'y', 'up', 'backspace', '', ' 1']) expect(takes(sendKey(key)), JSON.stringify(key)).toBe(false)
  })

  it('takes stat only as the inode read of 1 transcript', () => {
    for (const argv of [
      ['stat', '-f', '%z %N', TRANSCRIPT],
      ['stat', '-x', '%i %N', TRANSCRIPT],
      ['stat', '-L', '-f', '%i %N', TRANSCRIPT],
      ['stat', '-f', '%i %N', TRANSCRIPT, TRANSCRIPT],
      ['stat', '-f', '%i %N'],
      ['stat', TRANSCRIPT],
    ]) {
      expect(takes(argv), argv.join(' ')).toBe(false)
    }
  })

  it('takes tail only from a byte, and head only up to 64 KiB, each of 1 transcript', () => {
    for (const argv of [
      ['tail', '-c', '+0', TRANSCRIPT],
      ['tail', '-c', '100', TRANSCRIPT],
      ['tail', '-n', '+1', TRANSCRIPT],
      ['tail', '-f', TRANSCRIPT],
      ['tail', '-c', '+1', TRANSCRIPT, TRANSCRIPT],
      ['tail', '-c', '+1x', TRANSCRIPT],
      ['head', '-c', '0', TRANSCRIPT],
      ['head', '-c', '65537', TRANSCRIPT],
      ['head', '-c', '+1', TRANSCRIPT],
      ['head', '-n', '10', TRANSCRIPT],
      ['head', '-c', '100'],
      // another command in the form of a read: the host port lets claude and git run
      ['claude', '-c', '100', TRANSCRIPT],
      ['git', '-c', '100', TRANSCRIPT],
      ['cat', '-c', '100', TRANSCRIPT],
    ]) {
      expect(takes(argv), argv.join(' ')).toBe(false)
    }
  })

  it('takes a transcript read only of a .jsonl file 2 folders under the projects folder of the home', () => {
    for (const path of [
      '/etc/passwd',
      `${HOME}/.ssh/id_rsa`,
      `${PROJECTS}/session-color.jsonl`,
      `${PROJECTS}/a/b/session-color.jsonl`,
      `${PROJECTS}/../projects/x/session-color.jsonl`,
      `${PROJECTS}/./session-color.jsonl`,
      `${PROJECTS}//session-color.jsonl`,
      `${PROJECTS}/../session-color.jsonl`,
      `${PROJECTS}/x/session-color.json`,
      `${PROJECTS}/x/session\ncolor.jsonl`,
      `/other${PROJECTS}/x/session-color.jsonl`,
      // the projects folder of another home with a name of the same length
      `${PROJECTS.replace('god-home', 'god-hxme')}/x/session-color.jsonl`,
      `-${PROJECTS}/x/session-color.jsonl`,
      'relative/x/session-color.jsonl',
    ]) {
      for (const argv of [['stat', '-f', '%i %N', path], ['tail', '-c', '+1', path], ['head', '-c', '100', path]]) expect(takes(argv), argv.join(' ')).toBe(false)
    }
  })
})

describe('deliverHost: the host of the executor', () => {
  it('runs an argv that isDeliverArgv takes, and refuses any other one before the host port sees it', async () => {
    const fake = machine(asks())
    const host = deliverHost(fake.ports.host, HOME)
    await host.run(sendText('1'))
    for (const argv of [['cmux', 'notify', '--title', 't', '--body', 'b'], ['cmux', 'select-workspace', '--workspace', WS], ['git', 'push'], ['claude', '-p', 'hi'], sendKey('1'), sendKey('escape'), ['tail', '-c', '+1', '/etc/passwd']]) {
      await expect(host.run(argv)).rejects.toThrow(REFUSED_DELIVER_ARGV)
    }
    // ps runs only in UTC, and no other command sets the environment
    const ps = ['ps', '-o', 'pid=,tty=,lstart=', '-p', '4242']
    await expect(host.run(ps)).rejects.toThrow(REFUSED_DELIVER_ARGV)
    await expect(host.run(ps, { env: { TZ: 'Asia/Jerusalem' } })).rejects.toThrow(REFUSED_DELIVER_ARGV)
    await expect(host.run(sendText('1'), { env: { TZ: 'UTC' } })).rejects.toThrow(REFUSED_DELIVER_ARGV)
    await host.run(ps, { env: { TZ: 'UTC' } })
    expect(fake.runs).toEqual([sendText('1'), ps])
  })
})
