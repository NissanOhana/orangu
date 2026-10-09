/**
 * Synthetic fixtures for the detail, the confirm bar and the tool texts of the god pane, and for the rendered#god
 * STE row: the board sessions of test/fixtures/god/snapshots.ts with more facts on some of them, 3 more waiting
 * sessions (a permission, a dialog with 2 questions, a dialog with more than 1 choice), a screen read, the 3 Recap
 * states, 1 intent of each kind and 1 outcome of each status. Every name, path and text is made up. The session
 * texts are short and STE-clean, so the STE row scores the words of the pane, not fixture words.
 */
import type { BoardSnapshot, DeliverIntent, DeliverOutcome, GodSession, RecapState, ScreenRead, SessionFacts, TabRef } from '../../../src/god/types.js'
import { HOUR, MINUTE, SECOND, transcript, waiting } from './sessions.js'
import { NOW, QUESTION, boardSessions, snapshotOf } from './snapshots.js'

export { NOW, QUESTION }

/** the cmux tab of a session */
const tabOf = (pid: number, workspaceTitle: string, surfaceTitle?: string): TabRef => ({
  pid,
  tty: 'ttys009',
  workspaceRef: 'workspace:7',
  surfaceRef: 'surface:12',
  workspaceTitle,
  ...(surfaceTitle === undefined ? {} : { surfaceTitle }),
})

/** the input of the open Bash call of the permission session */
export const PERMISSION_INPUT = '{"command":"npm test","description":"Run the tests"}'

/** more facts on the board sessions that the detail tests read */
function enrich(session: SessionFacts): SessionFacts {
  const base = session.transcript ?? transcript()
  if (session.sessionId === 's-wait') {
    return {
      ...session,
      tab: tabOf(session.pid, 'Eval set', 'tab 2'),
      transcript: {
        ...base,
        title: 'Pick the eval set',
        permissionMode: 'default',
        lastPrompt: 'Run the eval tests.',
        lastReply: 'The eval tests pass. I need 1 choice from you.\n\nThe notes have the details.',
        context: { tokens: 122_000, window: 200_000, model: 'claude-opus-5-5', isEstimated: false },
        prLinks: [{ url: 'https://example.com/acme/api/pull/9', number: 9 }, { url: 'https://example.com/acme/api/pull/12', number: 12 }],
        openQuestion: {
          toolUseId: 'tu-ask',
          askedAt: NOW - 6 * HOUR - 41 * MINUTE,
          questions: [
            {
              text: QUESTION,
              header: 'Eval set',
              multiSelect: false,
              options: [{ label: 'Small', description: 'Only the fast tests.' }, { label: 'All' }, { label: 'None', description: 'Skip the eval.' }],
            },
          ],
        },
        history: [
          { prompt: 'Read the parser.', promptAt: NOW - 7 * HOUR, reply: 'I read the parser. It has 3 parts.', replyAt: NOW - 7 * HOUR + 2 * MINUTE },
          { prompt: 'Run the eval tests.', promptAt: NOW - 6 * HOUR - 50 * MINUTE, reply: 'The eval tests pass. I need 1 choice from you.', replyAt: NOW - 6 * HOUR - 41 * MINUTE },
        ],
      },
    }
  }
  if (session.sessionId === 's-work') {
    return {
      ...session,
      tab: tabOf(session.pid, 'Parser'),
      subagents: [{ agentId: 'a1f0', size: 2048, mtimeMs: NOW - 3 * HOUR, agentType: 'Plan', description: 'Plan the parser work.' }],
      transcript: {
        ...base,
        permissionMode: 'acceptEdits',
        lastReply: 'I edit the parser now.',
        context: { tokens: 30_000, window: 200_000, model: 'claude-opus-5-5', isEstimated: true },
        agents: [
          { toolUseId: 'tu-agent-1', kind: 'subagent', text: 'Find the parser tests', agentType: 'Explore', isRunning: true, startedAt: NOW - 3 * MINUTE },
          { toolUseId: 'tu-bg-1', kind: 'background', text: 'Bash npm run build', isRunning: false, startedAt: NOW - 30 * MINUTE, endedAt: NOW - 25 * MINUTE },
          { toolUseId: 'tu-agent-2', kind: 'subagent', text: 'Read the notes', agentType: 'Explore', isRunning: true, startedAt: NOW - 2 * MINUTE },
        ],
      },
    }
  }
  return session
}

/** a session that waits for a permission: its open Bash call */
const permission = (): SessionFacts =>
  waiting('s-perm', {
    name: 'ops-4',
    waitingFor: 'permission prompt',
    statusSince: NOW - 3 * MINUTE,
    transcript: transcript({ activity: { toolUseId: 'tu-bash', tool: 'Bash', text: 'Bash npm test', input: PERMISSION_INPUT, isOpen: true, at: NOW - 3 * MINUTE } }),
  })

/** a session whose dialog has 2 questions */
const twoQuestions = (): SessionFacts =>
  waiting('s-multi', {
    name: 'web-5',
    statusSince: NOW - 4 * MINUTE,
    transcript: transcript({
      openQuestion: {
        toolUseId: 'tu-multi',
        questions: [
          { text: 'Which port do you want?', header: 'Port', multiSelect: false, options: [{ label: '3000' }, { label: '8080' }] },
          { text: 'Which host do you want?', header: 'Host', multiSelect: false, options: [{ label: 'Local' }, { label: 'Shared' }] },
        ],
      },
    }),
  })

/** a session whose dialog takes more than 1 choice */
const manyChoices = (): SessionFacts =>
  waiting('s-pick', {
    name: 'web-6',
    statusSince: NOW - 2 * MINUTE,
    transcript: transcript({
      openQuestion: {
        toolUseId: 'tu-pick',
        questions: [{ text: 'Which checks do you want?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Types' }, { label: 'Tests' }] }],
      },
    }),
  })

/** the board sessions with more facts, and the 3 more waiting sessions */
export const detailSessions = (): SessionFacts[] => [...boardSessions().map(enrich), permission(), twoQuestions(), manyChoices()]

/** the snapshot of the detail fixtures, on the fixture clock */
export const detailSnapshot = (): BoardSnapshot => snapshotOf(detailSessions())

/** 1 session of the detail snapshot */
export function detailSession(sessionId: string, snapshot: BoardSnapshot = detailSnapshot()): GodSession {
  const session = snapshot.sessions.find((candidate) => candidate.sessionId === sessionId)
  if (session === undefined) throw new Error(`no fixture session ${sessionId}`)
  return session
}

/** a fresh read of the screen of the waiting session: its dialog */
export const SCREEN: ScreenRead = {
  sessionId: 's-wait',
  workspaceRef: 'workspace:7',
  surfaceRef: 'surface:12',
  readAt: NOW - SECOND,
  text: ['☐ Eval set', '', QUESTION, '', '❯ 1. Small', '     Only the fast tests.', '  2. All', '  3. None', '     Skip the eval.', '', ''].join('\n'),
}

/** the 3 states of a Recap of the waiting session */
export const RECAPS: Readonly<Record<RecapState['status'], RecapState>> = {
  running: { status: 'running', sessionId: 's-wait', startedAt: NOW - 2 * SECOND },
  answered: { status: 'answered', sessionId: 's-wait', text: 'The session waits for your choice of the eval set. The eval tests pass.', tokens: 1834, at: NOW - SECOND },
  failed: { status: 'failed', sessionId: 's-wait', reason: 'api-error', tokens: 0, at: NOW - SECOND },
}

const target = { sessionId: 's-wait', name: 'api-7' }

/** 1 intent of each kind for the waiting session */
export const INTENTS: Readonly<Record<DeliverIntent['kind'], DeliverIntent>> = {
  answer: { kind: 'answer', target, toolUseId: 'tu-ask', header: 'Eval set', question: QUESTION, option: 2, label: 'All' },
  permission: { kind: 'permission', target: { sessionId: 's-perm', name: 'ops-4' }, choice: 'yes', tool: 'Bash', input: PERMISSION_INPUT },
  prompt: { kind: 'prompt', target, text: 'Run the eval tests again.\nThen write the result in the notes.\nKeep the notes short.' },
  peer: { kind: 'peer', target, text: 'Stop the deploy now.\nI check the logs first.' },
}

/** 1 outcome of each status for the answer intent */
export const OUTCOMES: Readonly<Record<DeliverOutcome['status'], DeliverOutcome>> = {
  sent: { status: 'sent', intent: INTENTS.answer, at: NOW },
  delivered: { status: 'delivered', intent: INTENTS.answer, at: NOW },
  'not-delivered': { status: 'not-delivered', intent: INTENTS.answer, at: NOW },
  refused: { status: 'refused', intent: INTENTS.answer, at: NOW, refusal: 'screen-changed', screen: SCREEN },
  failed: { status: 'failed', intent: INTENTS.answer, at: NOW, reason: 'send-key exit 1' },
}
