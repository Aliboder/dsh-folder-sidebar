/**
 * Host half of dsh-folder-sidebar.
 *
 * The sidebar replacement is Client-only except for one fact the Client cannot
 * derive: whether a Session's most recent turn failed or was interrupted. A
 * Session summary carries no failure field, so this projection folds
 * `turn/start` and `turn/end` into a small client-visible state per Session.
 *
 * The Client reads it from the sessions list snapshot
 * (`projectionsBySession[id].values['folder-sidebar/turn']`) — the value is
 * computed here and streamed, never folded in the browser.
 */

import { z } from 'zod'

export const name = 'folder-sidebar'
export const inject = ['sessionProjections']

/** Must match the key the Client reads. */
const KEY = 'folder-sidebar/turn'

/** Bump when the folded state or its meaning changes; stale checkpoints drop. */
const STATE_VERSION = 3

const STATES = ['idle', 'running', 'completed', 'failed', 'interrupted', 'stopped']

const StateSchema = z.object({
  state: z.enum(STATES),
  turn: z.number(),
  /** When the current state began (epoch ms); the folder status picks the oldest. */
  since: z.number(),
  reason: z.string().optional(),
})

const ViewSchema = StateSchema

const IDLE = { state: 'idle', turn: 0, since: 0 }

/** Map one turn end onto the colour-relevant state. */
function endedState(reason, turn, since) {
  if (reason === null || typeof reason !== 'object') return { state: 'idle', turn, since }
  switch (reason.kind) {
    case 'completed':
      return { state: 'completed', turn, since }
    case 'forked':
      return { state: 'idle', turn, since }
    case 'error':
      return { state: 'failed', turn, since, reason: reason.error?.code ?? 'error' }
    case 'blocked':
      return { state: 'failed', turn, since, reason: 'blocked' }
    case 'max-tokens':
      return { state: 'failed', turn, since, reason: 'max-tokens' }
    case 'interrupted':
      return { state: 'interrupted', turn, since }
    case 'aborted': {
      // A user stop is not a failure: the sidebar shows it in the neutral tone.
      const kind = reason.reason?.kind
      if (kind === 'user') return { state: 'stopped', turn, since }
      return { state: 'interrupted', turn, since, reason: kind ?? 'aborted' }
    }
    default:
      return { state: 'idle', turn, since }
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.sessionProjections.register({
    key: KEY,
    stateSchema: StateSchema,
    stateVersion: STATE_VERSION,
    init: () => IDLE,
    apply(state, event) {
      const time = typeof event.time === 'number' ? event.time : Date.now()
      if (event.type === 'turn/start') {
        const turn = event.data?.turn ?? state.turn
        return { state: 'running', turn, since: time }
      }
      if (event.type !== 'turn/end') return state
      return endedState(event.data?.reason, event.data?.turn ?? state.turn, time)
    },
    wire: {
      viewSchema: ViewSchema,
      view(state) {
        return {
          state: state.state,
          turn: state.turn,
          since: state.since,
          ...(typeof state.reason === 'string' && state.reason !== '' ? { reason: state.reason } : {}),
        }
      },
    },
  }))
}
