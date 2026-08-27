/**
 * Live watch: re-analyze a session as it grows and refresh the HTML report.
 * Uses fs.watch when available and a polling fallback. Reads are incremental via serve/tail.ts
 * (byte-offset reader, policy): each change re-reads only the new bytes; a shrink forces a full re-read.
 * "serve for one session without a server". orangu serve is the multi-session path.
 */
import { watch as fsWatch } from 'node:fs'
import { stat } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { discoverSubagentFiles } from '../adapters/claude-code/parse.js'
import { newTailState, tailOnce, sessionFromTail } from '../serve/tail.js'
import { analyzeSession } from '../analyze/analyze.js'
import { renderReport } from '../report/render.js'
import { fmtMs, fmtTokens } from '../analyze/util.js'
import type { SessionRef } from '../discover/discover.js'
import { flagBool } from './args.js'

export interface WatchDeps {
  version: string
  openInBrowser: (path: string) => void
  outPath: (id: string) => string
}

export async function watchSession(ref: SessionRef, flags: Record<string, string | boolean>, deps: WatchDeps): Promise<void> {
  const path = deps.outPath(ref.sessionId)
  let building = false
  let dirty = true
  let lastSize = -1
  let renders = 0

  const st = newTailState(ref.path) // incremental: only new bytes are read per change (serve/tail.ts)
  const rebuild = async () => {
    if (building || !dirty) return
    building = true
    while (dirty) {
      dirty = false
      try {
        try {
          ref.subagentFiles = (await discoverSubagentFiles(ref.path)).map((s) => s.path)
        } catch (error) {
          ref.subagentFiles = []
          throw error
        }
        await tailOnce(st, ref)
        const session = await sessionFromTail(st)
        const analysis = analyzeSession(session, { version: deps.version, now: Date.now() })
        const { html } = renderReport(analysis, { watch: true, redact: flagBool(flags, 'no-redact') ? false : { scrub: true, stripText: !flagBool(flags, 'include-text') } })
        await writeFile(path, html)
        renders++
        const s = analysis.summary
        process.stderr.write(
          `\r\x1b[2K\x1b[38;5;209m●\x1b[0m watching ${ref.sessionId.slice(0, 8)} · ${s.turns} turns · ${s.toolCalls} tools · ${fmtTokens(s.totalTokens)} tok · ctx ${fmtTokens(s.contextPeak)} · ${fmtMs(s.wallMs)}  \x1b[2m(render #${renders})\x1b[0m`,
        )
      } catch {
        /* file may be mid-write; retry on the next change */
        dirty = true
        break
      }
    }
    building = false
  }

  await rebuild()
  process.stderr.write(`\n  report: ${path}\n`)
  if (!flagBool(flags, 'no-open')) deps.openInBrowser(path)

  const poll = setInterval(async () => {
    try {
      const st = await stat(ref.path)
      if (st.size !== lastSize) {
        lastSize = st.size
        dirty = true
        void rebuild()
      }
    } catch {
      /* file vanished */
    }
  }, 1500)

  try {
    const w = fsWatch(ref.path, { persistent: true }, () => {
      dirty = true
      void rebuild()
    })
    process.on('SIGINT', () => {
      w.close()
      clearInterval(poll)
      process.stderr.write('\n  stopped.\n')
      process.exit(0)
    })
  } catch {
    process.on('SIGINT', () => {
      clearInterval(poll)
      process.exit(0)
    })
  }
  // keep the process alive
  await new Promise<void>(() => {})
}
