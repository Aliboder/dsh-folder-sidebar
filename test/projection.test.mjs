import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

import { apply } from '../index.js'

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// Register against a stub registry and drive the unit through the events that
// decide the sidebar's state colour.
const definitions = []
const ctx = {
  effect: (fn) => fn(),
  sessionProjections: {
    register: (definition) => { definitions.push(definition); return () => {} },
  },
}

apply(ctx)
assert.equal(definitions.length, 1, 'apply must register exactly one projection')

const unit = definitions[0]
assert.equal(unit.key, 'folder-sidebar/turn')
assert.equal(typeof unit.stateVersion, 'number')
assert.equal(typeof unit.init, 'function')
assert.equal(typeof unit.apply, 'function')
assert.equal(typeof unit.wire?.view, 'function')

// The Client reads this exact key out of the sessions projection snapshot.
assert.ok(client.includes("const TURN_KEY = 'folder-sidebar/turn'"), 'client must read the same projection key')

function drive(events) {
  let state = unit.init({ id: 'x', version: 1, createdAt: 0, isSeeded: false }, 0)
  for (const event of events) state = unit.apply(state, event)
  unit.stateSchema.parse(state)
  unit.wire.viewSchema.parse(unit.wire.view(state))
  return state
}

const start = { type: 'turn/start', time: 1000, data: { turn: 3 } }
const end = (reason, time = 2000) => ({ type: 'turn/end', time, data: { turn: 3, reason } })

assert.equal(drive([]).state, 'idle')
assert.equal(drive([start]).state, 'running')
assert.equal(drive([start]).since, 1000)
assert.equal(drive([start, end({ kind: 'completed' })]).state, 'completed')
assert.equal(drive([start, end({ kind: 'completed' })]).since, 2000)
assert.equal(drive([start, end({ kind: 'forked' })]).state, 'idle')
assert.equal(drive([start, end({ kind: 'error', error: { code: 'AUTH', message: 'no' } })]).state, 'failed')
assert.equal(drive([start, end({ kind: 'error', error: { code: 'AUTH', message: 'no' } })]).reason, 'AUTH')
assert.equal(drive([start, end({ kind: 'blocked' })]).state, 'failed')
assert.equal(drive([start, end({ kind: 'max-tokens' })]).state, 'failed')
assert.equal(drive([start, end({ kind: 'interrupted' })]).state, 'interrupted')
assert.equal(drive([start, end({ kind: 'aborted', reason: { kind: 'user' } })]).state, 'stopped')
assert.equal(drive([start, end({ kind: 'aborted', reason: { kind: 'parent' } })]).state, 'interrupted')
assert.equal(drive([start, end({ kind: 'aborted', reason: { kind: 'disposed' } })]).state, 'interrupted')

// `since` is what lets a Workspace show its oldest state; it must follow the
// event that produced the current state, not the first one ever seen.
assert.equal(drive([start, end({ kind: 'completed' }, 5000)]).since, 5000)

// Unrelated events must return the same reference so the cell costs nothing.
const idle = unit.init({ id: 'x', version: 1, createdAt: 0, isSeeded: false }, 0)
assert.equal(unit.apply(idle, { type: 'tool/result', data: {} }), idle, 'unrelated events must not allocate')

// The view never carries fields the Client would have to understand.
const view = unit.wire.view({ state: 'failed', turn: 2, since: 1500, reason: 'AUTH' })
assert.deepEqual(Object.keys(view).sort(), ['reason', 'since', 'state', 'turn'])

console.log('folder-sidebar projection OK')
