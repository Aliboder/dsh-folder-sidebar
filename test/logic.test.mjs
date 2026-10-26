import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

// Load the shipped client source in a sandbox with no `window`: the browser
// bootstrap is skipped and `module.exports` exposes the pure logic.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const module = { exports: {} }
// eslint-disable-next-line no-new-func
new Function('module', 'exports', source)(module, module.exports)
const L = module.exports

assert.equal(typeof L.sortWorkspaces, 'function', 'client.js must export the pure API')

// --- direction / normalization ---
assert.equal(L.directionSign('asc'), 1)
assert.equal(L.directionSign('desc'), -1)
assert.deepEqual(L.normalizeSort(undefined, { mode: 'recent', dir: 'desc' }), { mode: 'recent', dir: 'desc' })
assert.deepEqual(L.normalizeSort({ mode: 'name', dir: 'up' }, { mode: 'manual', dir: 'asc' }), { mode: 'name', dir: 'asc' })
assert.deepEqual(L.normalizeSort({ mode: 'nope', dir: 'desc' }, { mode: 'manual', dir: 'asc' }), { mode: 'manual', dir: 'desc' })

// --- persistence (a Map-backed fake storage) ---
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    dump: () => Object.fromEntries(map),
  }
}

assert.deepEqual(L.readSortState(fakeStorage()), {
  folders: { mode: 'manual', dir: 'asc' },
  sessions: { mode: 'recent', dir: 'desc' },
}, 'defaults')
assert.deepEqual(L.readSortState(fakeStorage({ 'dsh.folder-sidebar.sort': 'not json' })).folders.mode, 'manual')
const store = fakeStorage()
L.writeSortState({ folders: { mode: 'name', dir: 'desc' }, sessions: { mode: 'name', dir: 'asc' } }, store)
assert.deepEqual(JSON.parse(store.dump()['dsh.folder-sidebar.sort']).folders, { mode: 'name', dir: 'desc' })
assert.equal(L.readArchivedFilter(fakeStorage()), 'hide')
assert.equal(L.readArchivedFilter(fakeStorage({ 'dsh.folder-sidebar.archived': 'only' })), 'only')
assert.equal(L.readArchivedFilter(fakeStorage({ 'dsh.folder-sidebar.archived': 'bogus' })), 'hide')
const archiveStore = fakeStorage()
L.writeArchivedFilter('all', archiveStore)
assert.equal(archiveStore.dump()['dsh.folder-sidebar.archived'], 'all')

// --- workspace ordering ---
const workspaces = [
  { id: 'a', name: 'alpha', activity: 10 },
  { id: 'b', name: 'Beta', activity: 30 },
  { id: 'c', name: 'gamma', activity: 20 },
]
const accessors = { nameOf: (w) => w.name, activityOf: (w) => w.activity }

assert.deepEqual(L.sortWorkspaces(workspaces, { mode: 'manual', dir: 'asc' }, accessors).map((w) => w.id), ['a', 'b', 'c'])
assert.deepEqual(L.sortWorkspaces(workspaces, { mode: 'manual', dir: 'desc' }, accessors).map((w) => w.id), ['c', 'b', 'a'])
assert.deepEqual(L.sortWorkspaces(workspaces, { mode: 'name', dir: 'asc' }, accessors).map((w) => w.id), ['a', 'b', 'c'])
assert.deepEqual(L.sortWorkspaces(workspaces, { mode: 'name', dir: 'desc' }, accessors).map((w) => w.id), ['c', 'b', 'a'])
assert.deepEqual(L.sortWorkspaces(workspaces, { mode: 'recent', dir: 'desc' }, accessors).map((w) => w.id), ['b', 'c', 'a'])
assert.deepEqual(L.sortWorkspaces(workspaces, { mode: 'recent', dir: 'asc' }, accessors).map((w) => w.id), ['a', 'c', 'b'])
// The input array must never be mutated in place.
assert.deepEqual(workspaces.map((w) => w.id), ['a', 'b', 'c'])

// --- session ordering (pinned first, direction inside a group) ---
const sessions = [
  { id: 's1', title: 'Charlie', updatedAt: 30, pinned: false },
  { id: 's2', title: 'alpha', updatedAt: 10, pinned: true },
  { id: 's3', title: 'bravo', updatedAt: 20, pinned: false },
]
const sessionAccessors = {
  titleOf: (row) => row.title,
  isPinned: (row) => row.pinned,
  updatedAtOf: (row) => row.updatedAt,
}

assert.deepEqual(
  L.sortSessions(sessions, { mode: 'recent', dir: 'desc' }, sessionAccessors).map((s) => s.id),
  ['s2', 's1', 's3'],
  'pinned first, then newest',
)
assert.deepEqual(
  L.sortSessions(sessions, { mode: 'recent', dir: 'asc' }, sessionAccessors).map((s) => s.id),
  ['s2', 's3', 's1'],
  'pinned first, then oldest',
)
assert.deepEqual(
  L.sortSessions(sessions, { mode: 'name', dir: 'asc' }, sessionAccessors).map((s) => s.id),
  ['s2', 's3', 's1'],
)
assert.deepEqual(
  L.sortSessions(sessions, { mode: 'name', dir: 'desc' }, sessionAccessors).map((s) => s.id),
  ['s2', 's1', 's3'],
)
assert.deepEqual(sessions.map((s) => s.id), ['s1', 's2', 's3'], 'input order preserved')

// --- folder status: priority first, then oldest ---
assert.equal(L.pickFolderKind([]), undefined)
assert.equal(L.pickFolderKind([{ kind: 'completed', since: 1 }]), 'completed')
assert.equal(
  L.pickFolderKind([{ kind: 'completed', since: 1 }, { kind: 'running', since: 99 }]),
  'running',
  'running outranks an older completion',
)
assert.equal(
  L.pickFolderKind([{ kind: 'waiting', since: 90 }, { kind: 'running', since: 5 }]),
  'waiting',
  'a pending question outranks activity',
)
assert.equal(
  L.pickFolderKind([{ kind: 'error', since: 50 }, { kind: 'error', since: 20 }]),
  'error',
  'same kind keeps the oldest timestamp',
)
assert.equal(L.pickFolderKind([{ kind: 'nonsense', since: 1 }]), undefined, 'unknown kinds are ignored')

// --- session indicator precedence ---
const running = { running: true, completionUnread: false }
const idle = { running: false, completionUnread: false }
const waiting = { running: true, completionUnread: false, pendingInteraction: { kind: 'question' } }
const unread = { running: false, completionUnread: true }
const projection = (state, since = 0) => ({ state, since, turn: 1 })

assert.equal(L.indicatorOf(undefined, undefined), undefined)
assert.equal(L.indicatorOf(waiting, projection('running')), 'waiting')
assert.equal(L.indicatorOf(running, undefined), 'running')
assert.equal(L.indicatorOf(idle, projection('failed')), 'error')
assert.equal(L.indicatorOf(idle, projection('interrupted')), 'error')
assert.equal(L.indicatorOf(unread, projection('completed')), 'completed')
assert.equal(L.indicatorOf(idle, projection('stopped')), 'stopped')
assert.equal(L.indicatorOf(idle, projection('idle')), undefined)

// --- relative time ---
const now = Date.UTC(2026, 0, 10, 12, 0, 0)
assert.equal(L.relativeTime(undefined), '')
assert.equal(L.relativeTime(now - 30_000, now), '<1m')
assert.equal(L.relativeTime(now - 5 * 60_000, now), '5m')
assert.equal(L.relativeTime(now - 3 * 3_600_000, now), '3h')
assert.equal(L.relativeTime(now - 4 * 86_400_000, now), '4d')
assert.equal(L.relativeTime(now - 30 * 86_400_000, now), '12/11')

// --- paths ---
assert.equal(L.baseName('D:\\work\\project'), 'project')
assert.equal(L.baseName('/home/me/repo/'), 'repo')
assert.equal(L.baseName(''), '')
assert.equal(L.baseName(undefined), '')

console.log('folder-sidebar logic OK')
