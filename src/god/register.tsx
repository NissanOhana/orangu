// The hooks module of orangu god: wiring only, with no rule. scripts/build.mjs bundles it to god/hooks/god.mjs.
// register is a function declaration, because the engine validator refuses an exported arrow.
import type { On, PluginOptions } from 'claude-code'

import { GOD_COMMAND_DESCRIPTION, GOD_NOT_READY } from './copy.js'

export function register(on: On, options: PluginOptions): void {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'god', description: GOD_COMMAND_DESCRIPTION })
    return next(e)
  })

  on('command.run', { command: 'god' }, async () => ({ text: GOD_NOT_READY }))
}
