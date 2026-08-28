// Preflight for `npm run test:browser`: the Playwright webServer entries bind fixed loopback ports
// (test/browser/static-server.mjs on 4173, test/browser/app-server.ts on 4174). A server left over
// from an interrupted run turns the suite into a wall of unrelated assertion failures; this fails
// first, with the port and the command that frees it.
import { createServer } from 'node:net'

const PORTS = [4173, 4174]

function free(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

const busy = []
for (const port of PORTS) if (!(await free(port))) busy.push(port)
if (busy.length) {
  process.stderr.write(
    `test:browser: port${busy.length > 1 ? 's' : ''} ${busy.join(', ')} on 127.0.0.1 ${busy.length > 1 ? 'are' : 'is'} already in use (a stale test server?).\n` +
      `free ${busy.length > 1 ? 'them' : 'it'} and re-run:  lsof -ti ${busy.map((p) => `tcp:${p}`).join(' -i ')} | xargs kill\n`,
  )
  process.exit(1)
}
process.stdout.write(`test:browser: ports ${PORTS.join(', ')} are free\n`)
