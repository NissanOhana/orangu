/**
 * Offline gate as a unit test: the same regex list as scripts/assert-offline.mjs over the
 * rendered fixture body MINUS the embedded #orangu-data block (data may legitimately carry https:// PR links),
 * plus a scan of the raw client JS: the file-mode bundle must contain no network API text at all.
 */
import { describe, it, expect } from 'vitest'
import { parseClaudeCodeSession } from '../adapters/claude-code/parse.js'
import { analyzeSession } from '../analyze/analyze.js'
import { renderReport } from './render.js'
import { CLIENT_JS, CLIENT_JS_AGG, CLIENT_JS_SERVE } from './generated/client-bundle.js'
import { MASCOT_STACKED } from '../cli/mascot-ascii.js'
import { buildCanonicalSession } from '../../test/fixtures/session-builder.js'

const CHECKS: Array<[RegExp, string]> = [
  [/https?:\/\/(?!localhost|127\.0\.0\.1)/, 'external http(s) URL'],
  [/<link\b/i, '<link> tag'],
  [/<img[^>]+src\s*=\s*["']https?:/i, 'remote image'],
  [/@import\s+url/i, '@import url'],
  [/\bfetch\s*\(/, 'fetch()'],
  [/XMLHttpRequest/, 'XMLHttpRequest'],
  [/new\s+WebSocket/, 'WebSocket'],
  [/<iframe/i, 'iframe'],
]

async function renderedHtml(): Promise<string> {
  const b = buildCanonicalSession()
  b.userPrompt('see the PR at https://github.com/example/repo/pull/1')
  b.assistant([{ type: 'text', text: 'done' }])
  const s = await parseClaudeCodeSession({ records: b.toRecords(), noSidecar: true })
  const a = analyzeSession(s, { version: 'test', now: 0 })
  return renderReport(a).html
}

function stripDataBlock(html: string): string {
  const start = html.indexOf('<script type="application/json" id="orangu-data">')
  const end = html.indexOf('</script>', start)
  return html.slice(0, start) + html.slice(end)
}

describe('offline report', () => {
  it('body (minus the data block) matches none of the assert-offline regexes', async () => {
    const html = await renderedHtml()
    const body = stripDataBlock(html).slice(html.indexOf('</head>'))
    for (const [re, label] of CHECKS) {
      const m = body.match(re)
      expect(m, `${label}: ${m?.[0]?.slice(0, 60)}`).toBeNull()
    }
    expect(html).toContain("default-src 'none'")
  })

  it('raw client JS contains no network API text (two-bundle rule, the design)', () => {
    expect(CLIENT_JS.length).toBeGreaterThan(0)
    expect(/\bfetch\s*\(/.test(CLIENT_JS), 'fetch(').toBe(false)
    expect(/EventSource/.test(CLIENT_JS), 'EventSource').toBe(false)
    expect(/XMLHttpRequest/.test(CLIENT_JS), 'XMLHttpRequest').toBe(false)
    expect(/new\s+WebSocket/.test(CLIENT_JS), 'WebSocket').toBe(false)
    expect(CLIENT_JS).not.toContain('github.com/NissanOhana/orangu/issues/new')
    expect(CLIENT_JS_SERVE).toContain('github.com/NissanOhana/orangu/issues/new')
  })

  it('the aggregate bundle carries no network API text either: it is written to a file too', () => {
    // CLIENT_JS_AGG is the third entry. It renders repo/global from data embedded in the file, so it
    // must pass the same offline gate as CLIENT_JS; it may not reach the serve bundle, whose
    // fetch/EventSource text and issue URL exist by design.
    expect(CLIENT_JS_AGG.length).toBeGreaterThan(0)
    expect(/\bfetch\s*\(/.test(CLIENT_JS_AGG), 'fetch(').toBe(false)
    expect(/EventSource/.test(CLIENT_JS_AGG), 'EventSource').toBe(false)
    expect(/XMLHttpRequest/.test(CLIENT_JS_AGG), 'XMLHttpRequest').toBe(false)
    expect(/new\s+WebSocket/.test(CLIENT_JS_AGG), 'WebSocket').toBe(false)
    expect(CLIENT_JS_AGG).not.toContain('github.com/NissanOhana/orangu/issues/new')
  })

  it('the stored proposal and the Saved proposals inbox ship only in the serve bundle', () => {
    // A file report always embeds `suggestions: []` (render.ts), so neither block can render from a
    // file. serve-ui.ts injects proposals-ui.ts through the optional ServeUi.proposals seam, the way the
    // whole-harness block reaches the screen through Ctx.megaReview. Each marker is that module's markup.
    const markers = ['sg-inbox', 'saved-proposal', 'sg-proposal', 'sg-pfield', 'Copy only. Nothing runs here.', 'Computed comparisons', 'Localhost only']
    for (const marker of markers) {
      expect(CLIENT_JS, `CLIENT_JS carries ${marker}`).not.toContain(marker)
      expect(CLIENT_JS_AGG, `CLIENT_JS_AGG carries ${marker}`).not.toContain(marker)
      expect(CLIENT_JS_SERVE, `CLIENT_JS_SERVE lost ${marker}`).toContain(marker)
    }
  })

  it('the aggregate bundle stays inside its own size ratchet', () => {
    // Ratchet born 2026-08-28 with the cta chunk at its MEASURED landing value, not a round number
    // and not a target: same rule as CLIENT_JS above, it may only go DOWN. A chunk that needs more
    // stops and escalates rather than raising this line. It is larger than CLIENT_JS because it
    // carries the repo and global screens (rollups, the weekly trend, the evidence blocks) that the
    // session bundle tree-shakes away, plus the whole-harness block the session report cannot render.
    // 2026-08-28 shell: +304 B, re-measured. The number landed at exactly the measured 82,200 with zero
    // headroom, and the shell chunk that follows is the one that makes this bundle correct (its whole
    // job is the sessionless state, which lives in the shared nav.ts/app.ts/suggest.ts), so the value
    // could not survive its own successor. Treated like the CLIENT_JS pin below: re-measured in the
    // same commit, with the delta named. Flagged for the reviewer to rule on rather than raised quietly.
    // 2026-08-28 shell fix 1: +14 B, re-measured. The sessionless subtraction is gated on fileScope()
    // rather than on a missing session, so serve (which can bootstrap with none) keeps its session nav
    // and its Session eyebrow. Same escalation rule: it may only go down from here.
    // 2026-08-28 fix 1: +208 B, re-measured. Two truthfulness fixes in the shared client: the hero CTA
    // builds its href through the hash writer so the theme survives the click, and the across-session
    // empty state asks fileScope() before claiming the file carries a session. Both land in modules
    // this bundle owns outright (screens/repo.ts, screens/global.ts), which is why the aggregate
    // bundle pays more for them than the session bundle does.
    // POLICY for this ratchet, restated so the next chunk does not have to reconstruct it: the number
    // is BORN at the value measured on the day it is written, never a round number and never a target,
    // and from there it may only go DOWN. Raising it is allowed only in the same commit that measures
    // a deliberate, named growth, with the delta and its reason written above the line, exactly as the
    // CLIENT_JS pin below is kept. A chunk that merely bumps into it stops and escalates.
    // 2026-08-28 click loader: +313 B, re-measured. Not a bump: the click feedback fix lands entirely
    // in the shared app.ts shell (renderWait, the navigation branch of scheduleRender, and the busy
    // mark, frame yield and showLoader prediction in render), so this bundle pays the identical
    // 313 B the session bundle pays and neither one carries a byte the other does not. The
    // alternative was to ship a navigation that freezes for a third of a second with no feedback,
    // which the aggregate screens suffer worst of all. Flagged for the reviewer to rule on rather
    // than raised quietly; from here it may only go DOWN.
    // 2026-08-29 embedded aggregates: +97 B, re-measured. The published sample carries its session AND
    // the repo/global aggregates, so it ships this bundle; agg-ui's sidebar card now draws the session
    // card when the file has a session (the same markup the session bundle draws inline) instead of a
    // dash, and nav.ts counts an embedded global aggregate in any file (+2 B, shared with CLIENT_JS).
    // Named here rather than raised quietly; from here it may only go DOWN.
    // 2026-10-06 improvement on every card + Show me: the cap goes DOWN from 83,136 to 81,468, the
    // measured 81,455 below plus the 13 B of headroom this cap had at the start of the run (83,123 then).
    // The run spent 1,633 of the 3,301 B the proposals seam freed; the rest leaves the budget for good.
    // 2026-10-07 close-out (sample note in STE, copy confirmation in body ink): the cap goes DOWN 81,468 ->
    // 81,457, the measured 81,444 below plus the same 13 B of headroom.
    // 2026-10-07 Why disclosure: the cap goes UP 81,457 -> 82,056, the measured 82,043 below plus the same
    // 13 B of headroom. A named, measured growth: the pin below gives the bytes of each part and the reason.
    // 2026-10-07 narrative paragraphs: the cap goes UP 82,056 -> 82,100, the measured 82,087 below plus the same
    // 13 B of headroom. A named, measured growth: the narrative shows its 2 paragraphs, each 6 sentences or fewer.
    // 2026-10-08 ellipsis titles: the cap goes UP 82,100 -> 82,248, the measured 82,235 below plus the same 13 B of
    // headroom. A named, measured growth: each label cell that an ellipsis can cut carries its whole text in a title.
    expect(CLIENT_JS_AGG.length).toBeLessThanOrEqual(82_248)
    // 2026-10-06 proposals seam: -3,301 B (83,123 -> 79,822), and this bundle gets the exact pin the
    // session bundle has always had, so a change that moves it has to name the bytes. The stored
    // proposal block and the Saved proposals inbox (proposals-ui.ts) reach the Suggest screen only
    // through the optional ServeUi.proposals seam, which only serve-ui.ts provides: a file report
    // embeds `suggestions: []`, so this bundle never rendered them. The cap above is left as it was;
    // the run that spends this room lowers it once its own growth is measured.
    // 2026-10-06 report copy in STE: +194 B (79,822 -> 80,016), cap unchanged. Costed: the rewrite of
    // the copy outside the improvement screens is +39 B (a named actor where the old copy had a
    // fragment, a period where it had a semicolon, paid down by the Repo/Global hero, which lost its
    // 7-item inline list); the Plain audience on the Repo/Global KPI strip and the Live screen is
    // +155 B (plainLabel() and its call sites). 3,120 B of the cap stay free.
    // 2026-10-06 improvement on every card + Show me: +1,439 B (80,016 -> 81,455), re-measured after
    // `npm run build`. Costed by builds without each part: the Show me control (the show-me command for
    // the scope or the session, its popover, the paste line and the 2 install bars) is +628 B; the
    // improvement line in every card summary, the one explainer that replaces the 3 steps in every card,
    // the terminal paste line, the 2 install bars, the "N of M sessions" count and the copy of the
    // Improvements screen and the whole-harness block are +341 B; the review fixes (the session folder
    // in the Overview caption, a name for each copy button and for the steps list, the parts of a
    // proposal as a list, the copy) are +272 B; a new screen opening at its top, or at the element a
    // link names (data-to), is +198 B. Run history for this bundle: 83,123 before the run, 79,822 after
    // the seam, 80,016 after the report copy, 81,455 now.
    // 2026-10-07 close-out: -11 B (81,455 -> 81,444), re-measured after `npm run build`. The note on the
    // published samples says "This sample is synthetic." instead of the fragment "Illustrative synthetic
    // sample." (app.ts, -5 B), and the copy confirmation drops its muted class, which failed AA in light
    // (screens/suggest.ts, -6 B). Run history: 83,123 before the run, 81,444 at its close.
    // 2026-10-07 Why disclosure: +599 B (81,444 -> 82,043), re-measured after `npm run build`. The rule
    // text has 3 parts now, and the user asked for structure, not a word cap: each card leads with the
    // improvement only, and the reason and the method open under one closed Why, first in the card body,
    // keyed by the sg_ id so that a re-render keeps it open. Repo and global cards and the Recurring
    // findings rows show the example title, and one caption per list says that its figures come from one
    // example session. Costed from the minified segments: the Why builder, its 2 call sites and the reason
    // and the method on each row are +343 B; the example title and the caption are +196 B (the Recurring
    // findings rows ship only in this bundle); the pure Overview and Improvements builders are +72 B; the
    // improvement with its recommendation fallback is +38 B net of the old row copy; keying the Overview
    // Why by the sg_ id is -50 B, because the commandForInsight wrapper and its 2 call sites left.
    // 2026-10-07 narrative paragraphs: +44 B (82,043 -> 82,087), re-measured after `npm run build`. The narrative
    // shows its 2 paragraphs, each 6 sentences or fewer: the analyzer puts the top finding titles in a second
    // paragraph after one blank line, and the Overview hero (screens/overview.ts, shared with the session
    // bundle) splits the narrative there and shows each paragraph in its own .sg-sub block.
    // 2026-10-08 ellipsis titles: +148 B (82,087 -> 82,235), re-measured after `npm run build`. The user rejects
    // hidden text with no way to read it: a label cell that a CSS ellipsis cuts had no title, and nothing else showed
    // the rest. Each rule that cuts a label now writes the whole text into a title, through esc. Costed from
    // the minified segments: the agent lane label (Agents and Live) is +42 B (one label variable, which the text and
    // the title share), the label of a proportion row (Agents and Context) is +46 B, the tool name of a raw call
    // (Coverage) is +21 B, the re-read path (Repo and Global) is +21 B, and the session title (Repo and Global) is
    // +18 B (its `?? ""` left, because esc reads undefined as ''). The closed-card line clamp left the CSS (-221 B
    // of CLIENT_CSS), which no JS bundle carries.
    expect(CLIENT_JS_AGG.length).toBe(82235)
  })

  it('carries no terminal art: the ASCII mascot is a CLI-only module now', () => {
    // String.raw survives tree-shaking, so the old 4-line art shipped in every saved report for
    // nothing. Neither the old face nor the new wordmark may come back into the file bundle.
    expect(CLIENT_JS).not.toContain('.-"""-.')
    expect(CLIENT_JS).not.toContain(MASCOT_STACKED[0]!)
  })

  it('client JS never says "finished" (possibly-live honesty) and stays inside its size ratchet', () => {
    expect(CLIENT_JS.includes('finished'), 'the string "finished"').toBe(false)
    // Budget history: design B2 budgeted 60 KB for 7 screens; the shipped client renders 10 and landed at 68 KB
    // after a shrink pass; 2026-08-27 Track 0 raised the cap to 72 KB to pay for four honesty fixes (B-tier token
    // formatting, the redaction placeholder note, the watch-gated Live banner, the outcome headline). Track A (A1)
    // removes the 6-tile KPI grid, the 10 signal chips and 5 of the "Follow the evidence" cards and MUST bring this
    // back under 70 KB; the cap may only go DOWN from there.
    // Status 2026-08-27 (Track A, review round 3): the 70 KB target is NOT met and is recorded as such, not
    // left open. Measured: the client lands at 72,920 B; the plan's cut list was measured, not projected, and
    // cannot close the gap (the Overview sparkline is 143 B, the Suggest taxonomy chips 295 B, and the taxonomy
    // is pinned into the app by test/plugin.test.ts). Reaching 71,680 B needs a screen-level cut, which is a
    // product decision, not a polish trim. The cap stays at 72 KB and may only go DOWN; the pin is exact.
    // 2026-08-27 final fix pass: +287 B inside the cap for two honesty fixes (the Plain "What happened"
    // sentence no longer cuts at "incl." with an open parenthesis: leadSentence; the redacted Suggest row
    // says its details are hidden and names --include-text instead of asserting evidence it cannot show).
    // 2026-08-27 final client pass: -474 B, the Plain "What happened here" card no longer repeats the hero
    // (its "What happened" and "What it produced" rows duplicated the headline and the narrative sentence).
    // Suggest footer rewritten in the six user-facing nouns (session, finding, evidence, proposal, apply,
    // verify): +1 B.
    // Tools table: the Avg cell says "outlier" (with a title that explains it) when the mean sits above p95,
    // so one 30-minute timeout among quick calls no longer reads as a broken statistic: +252 B.
    // 2026-10-06 improvement on every card + Show me: the cap goes DOWN from 73,728 (72 KB) to 72,211,
    // the measured 72,185 below plus the 26 B of headroom this cap had at the start of the run (73,702
    // then). The run spent 1,785 of the 3,302 B the proposals seam freed; the rest leaves the budget.
    // 2026-10-07 close-out (sample note in STE, copy confirmation in body ink): the cap goes DOWN 72,211 ->
    // 72,200, the measured 72,174 below plus the same 26 B of headroom.
    // 2026-10-07 Why disclosure: the cap goes UP 72,200 -> 72,753, the measured 72,727 below plus the same
    // 26 B of headroom. A named, measured growth: the pin below gives the bytes of each part and the reason.
    // 2026-10-07 narrative paragraphs: the cap goes UP 72,753 -> 72,797, the measured 72,771 below plus the same
    // 26 B of headroom. A named, measured growth: the narrative shows its 2 paragraphs, each 6 sentences or fewer.
    // 2026-10-08 ellipsis titles: the cap goes UP 72,797 -> 72,906, the measured 72,880 below plus the same 26 B of
    // headroom. A named, measured growth: each label cell that an ellipsis can cut carries its whole text in a title.
    expect(CLIENT_JS.length).toBeLessThanOrEqual(72_906)
    // 2026-08-27 rebase onto main's redaction fix (+50 B fallback label): exact pin re-measured after `npm run build`.
    // 2026-08-27 final client pass 2 (fix/final-client2): −56 B net, cap unchanged. Eight UX fixes cost +1,233 B
    // (the Timeline row's own-facts fallback, folded hidden-error rows on Tools/Repo/Global, the Quality verdict
    // scope, the Global evidence blocks, the install line inside step 2, plural(), the ms() day tier) and were paid
    // for by two trims: template-literal indentation no longer ships (−1,090 B; continuation lines inside a
    // template start at column 0, every byte of one is in every report) and the six identical "No session
    // selected" guards share noSession() (−199 B).
    // 2026-08-28 mascot: -94 B. MASCOT_ASCII (a String.raw literal esbuild could not shake out) left
    // the client tree for src/cli/mascot-ascii.ts, so terminal art no longer ships in saved reports.
    // 2026-08-28 theme: -41 B. Light is the only default, so applyTheme lost its middle branch and the
    // sidebar control lost its three-state order array; themeName/cycleTheme pay a little of it back.
    // 2026-08-28 cta: +5 B. The per-finding copy control wears the primary CTA class; the whole-harness
    // block and the aggregate screens cost this bundle nothing (the Ctx.megaReview seam and tree-shaking).
    // 2026-08-28 shell: +386 B, inside the cap with 492 B to spare. The app shell learned the state it
    // never had before, a report with no session in it: fileScope() (the scope a saved file is about),
    // the landing screen and the omitted session group in nav.ts, the Scope eyebrow and the scope-label
    // document title in app.ts, and in the Suggest screen the scope default plus the disabled
    // "This session" chip. The session report pays for it because nav.ts, app.ts and suggest.ts are
    // shared with the aggregate bundle; the six conditionals are the whole cost.
    // 2026-08-28 shell fix 1: +17 B, inside the cap with 475 B to spare. Two of those conditionals were
    // gated on "this data has no session", which is also true of a serve page whose first frame arrived
    // before any analysis did; both now ask fileScope() instead, the one answer the router already uses,
    // so the nav group and the landing screen cannot disagree in any mode.
    // 2026-08-28 fix 1: +146 B, inside the cap with 329 B to spare. The empty state that says a report
    // needs the local viewer now asks fileScope() before telling the reader the file carries a session
    // (a saved scope report carries none), the Overview guard stops pointing at a session picker that
    // is not in a scope report's sidebar, and the Global nav count is gated on the same predicate so
    // serve keeps "Global · all time" instead of rewriting it mid-session.
    // 2026-08-28 click loader: +314 B, inside the cap with 15 B to spare, which is the whole of the
    // product's remaining room and is flagged as such rather than spent quietly. What it buys, on a
    // 50-turn Timeline measured at 304 ms of blocked thread with no feedback at all: renderWait()
    // splits navigation from the live-tick throttle and a click now cancels a queued tick, so the
    // shell is not rebuilt a second time behind the click; render() marks .main busy and yields the
    // one frame a blocked build ever gets; and showLoader() spends that frame only on a screen that
    // measured slow, so a quick screen never flashes. Costed: the mark and the frame yield 107 B,
    // the prediction 94 B, the scheduling seam 78 B, plumbing 35 B. If a later chunk needs the room,
    // the cheapest cut is the prediction (-94 B), which costs a two-frame hairline on quick screens.
    // The cap is untouched and still may only go DOWN.
    // 2026-08-29 embedded aggregates: +2 B, re-measured. nav.ts counts an embedded global aggregate in
    // any saved file (`data.mode === 'file'` instead of the fileScope predicate), so the published
    // sample's "Global · 11 sessions" label is true; serve still never counts. The cap is untouched.
    // 2026-09-29 cohort verification: -13 B, re-measured. The Suggest screen renders a trusted receipt of
    // either version (a noise-checked cohort receipt is v2) instead of only v1, and both footers say
    // "later sessions" now that one session cannot verify anything. A distinct chip label for the older
    // comparison was costed at about +200 B, over the cap, and left out: the receipt summary names the method.
    // 2026-10-06 proposals seam: -3,302 B (73,702 -> 70,400), re-measured after `npm run build`. The
    // stored proposal block and the Saved proposals inbox left this bundle for proposals-ui.ts, which
    // reaches the Suggest screen only through the optional Ctx.proposals seam (the Ctx.megaReview
    // pattern); only serve-ui.ts provides it, because a file report embeds `suggestions: []` and never
    // rendered either block. The cap is unchanged; the run that spends this room lowers it.
    // 2026-10-06 report copy in STE: +243 B (70,400 -> 70,643), re-measured after `npm run build`, cap
    // unchanged. Costed: the copy rewrite is +103 B (the old copy was short because it dropped its
    // subjects); the Plain audience on the Live screen (plainLabel() maps "Cache hits" and "Context
    // window", plainSentence the compaction caption) is +140 B. 3,085 B of the cap stay free for the
    // improvement screens.
    // 2026-10-06 improvement on every card + Show me: +1,542 B (70,643 -> 72,185), re-measured after
    // `npm run build`. Costed by builds without each part: the Show me control is +626 B; the
    // improvement line in every card summary, the one explainer above the cards (it replaces the 3
    // steps, the "handled by" row and the install bar that each card repeated), the terminal paste line,
    // the 2 install bars, the "N of M sessions" count and the Improvements and Overview copy are +432 B;
    // the review fixes (the session folder in the Overview caption, a name for each copy button and for
    // the steps list, the parts of a proposal as a list, the copy) are +286 B; a new screen opening at
    // its top, or at the element a link names (data-to), is +198 B. Run history: 73,702 before the run,
    // 70,400 after the seam, 70,643 after the report copy, 72,185 now.
    // 2026-10-07 close-out: -11 B (72,185 -> 72,174), re-measured after `npm run build`. The note on the
    // published samples says "This sample is synthetic." instead of the fragment "Illustrative synthetic
    // sample." (app.ts, -5 B), and the copy confirmation drops its muted class, which failed AA in light
    // (screens/suggest.ts, -6 B). Run history: 73,702 before the run, 72,174 at its close.
    // 2026-10-07 Why disclosure: +553 B (72,174 -> 72,727), re-measured after `npm run build`. The rule
    // text has 3 parts now, and the user asked for structure, not a word cap: each card leads with the
    // improvement only, and the reason and the method open under one closed Why, first in the card body,
    // keyed by the sg_ id so that a re-render keeps it open. Repo and global cards show the example title,
    // and one caption above them says that its figures come from one example session. Costed from the
    // minified segments: the Why builder, its 2 call sites and the reason and the method on each row are
    // +343 B; the example title and the caption are +150 B; the pure Overview and Improvements builders are
    // +72 B; the improvement with its recommendation fallback is +38 B net of the old row copy; keying the
    // Overview Why by the sg_ id is -50 B, because the commandForInsight wrapper and its 2 call sites left.
    // 2026-10-07 narrative paragraphs: +44 B (72,727 -> 72,771), re-measured after `npm run build`. The narrative
    // shows its 2 paragraphs, each 6 sentences or fewer: the analyzer puts the top finding titles in a second
    // paragraph after one blank line, and the Overview hero splits the narrative there and shows each paragraph
    // in its own .sg-sub block (the split, the map and the join are the whole cost).
    // 2026-10-08 ellipsis titles: +109 B (72,771 -> 72,880), re-measured after `npm run build`. The user rejects
    // hidden text with no way to read it: a label cell that a CSS ellipsis cuts had no title, and nothing else showed
    // the rest. Each rule that cuts a label now writes the whole text into a title, through esc. Costed from
    // the minified segments: the agent lane label (Agents and Live) is +42 B (one label variable, which the text and the title
    // share), the label of a proportion row (Agents and Context) is +46 B, and the tool name of a raw call (Coverage)
    // is +21 B. The Repo titles ship only in the aggregate bundle. The closed-card line clamp left the CSS (-221 B of
    // CLIENT_CSS), which no JS bundle carries.
    expect(CLIENT_JS.length).toBe(72880)
  })
})
