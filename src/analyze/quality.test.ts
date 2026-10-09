import { describe, expect, it } from 'vitest'
import { isCorrection } from './quality.js'

describe('isCorrection', () => {
  it('keeps every prompt start that the first detector matched', () => {
    for (const p of ['no, use the other file', 'nope', 'wrong file', 'revert that', 'undo it', 'again, the test fails', 'still broken', "didn't work", 'why did you delete it', 'stop.', 'i said the left one', 'as i said, port 3000']) {
      expect(isCorrection(p), p).toBe(true)
    }
  })

  it('finds a complaint that does not start the prompt', () => {
    for (const p of [
      'broken on desktop',
      'the slide broken, and i need more slides',
      '1 -> why it broken? fix it.',
      'EXPERT PAGE IS BROKEN!!!!! check prod',
      'this is still not working - the session does not save',
      'hamburger menu on iphone not working yet!!',
      'the login does not work on safari',
      "it doesn't work on mobile",
      'i think u check the wrong artifact',
      'you forgot the dark theme again',
      'you missed the footer',
      'I told you to check every screen size',
      'i already said use pnpm',
      'the card is still cut on the small screen',
      'you are not validating changes on all screen sizes!',
      "you're not running the tests",
    ]) {
      expect(isCorrection(p), p).toBe(true)
    }
  })

  it('does not read a status question or a plan as a complaint', () => {
    for (const p of [
      'what is still open here?',
      'are u still running?',
      'in this session, we should have blocks that we did not work on yet',
      "blocks that we didn't work on yet",
      'i\'m still afk. finish in the next 2 hours',
      'give me the login url',
      'Fix the failing test in src/foo.ts',
      'now review the diff',
      'notes on the broken-link checker design',
      'a stopwatch for the build',
      'tell me what we did and what is still missing',
      'you are not allowed to push to main',
      "don't work on the backend yet",
      'i still don\'t understand what the big tasks are',
    ]) {
      expect(isCorrection(p), p).toBe(false)
    }
  })
})
