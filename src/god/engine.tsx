// The engine adapter of orangu god: the Host port and the Effects from the engine `$`, and the clock. It is the
// only place where the pure units reach the machine, and it adds no rule of its own:
// - every host command goes through planRun (src/god/host-guard.ts): argv[0] on the allowlist, the 5 s timeout on
//   every command, and only TZ in its environment. A command that the plan refuses never reaches the engine;
// - each call is spelled `$.noun.method(...)` with literal names, so the engine validator lists every call;
// - the values pass through as the engine gives them, cut down to the fields of the port.
// This file is the only one under src/god that reads Date.now: the collector, the snapshot and the drawing take
// the time from engineClock, which reads with no wait.
import type { EngineInterface } from 'claude-code'

import type { Effects, Host, ModelReply } from './host.js'
import { planRun } from './host-guard.js'

/** The time now, with no wait. */
export const engineClock = (): number => Date.now()

/** The Host port over `$`. */
export function engineHost($: EngineInterface): Host {
  return {
    run: async (argv, options) => {
      const plan = planRun(argv, options)
      if (!plan.ok) throw new Error(plan.reason)
      const { exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated } = await $.process.run(argv, plan.init)
      return { exitCode, stdout, stderr, isStdoutTruncated, isStderrTruncated }
    },
    list: async (path) => (await $.fs.list(path)).map(({ name, kind, size, mtimeMs, isLink }) => ({ name, kind, size, mtimeMs, isLink })),
    read: (path) => $.fs.read(path),
    stat: async (path) => {
      const { kind, size, mtimeMs, isLink } = await $.fs.stat(path)
      return { kind, size, mtimeMs, isLink }
    },
    now: () => $.clock.now(),
  }
}

/** The Effects over `$`. The keys of the pane start them: the alerts, the peer message and the Recap. */
export function engineEffects($: EngineInterface): Effects {
  return {
    notify: async (text, title) => {
      const sent = await $.ui.notify(text, { title })
      return sent.isSent ? { isSent: true } : { isSent: false, reason: sent.reason }
    },
    play: (clip) => $.audio.play({ base64: clip.base64, mime: clip.mime }),
    peer: async (sessionId, text) => {
      const sent = await $.session.send({ to: { sessionId }, text })
      return sent.isDelivered ? { isDelivered: true } : { isDelivered: false, reason: sent.reason }
    },
    complete: async (request): Promise<ModelReply> => {
      const reply = await $.model.complete(request)
      const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = reply.usage
      const usage = { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
      return reply.isAnswered ? { isAnswered: true, text: reply.text, usage } : { isAnswered: false, reason: reply.reason, usage }
    },
  }
}
