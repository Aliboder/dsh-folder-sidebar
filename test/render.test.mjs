import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'

/**
 * Render-level test: a tiny React-compatible runtime renders the shipped
 * client.js without a browser. It covers the two adapter paths on purpose:
 *
 *   native   — a mock of @deepseek-ai/dsh-client-ui-primitives is present, so
 *              every adapter must render the host component;
 *   fallback — the package is unavailable, so every adapter renders its local
 *              equivalent and the sidebar must still mount.
 *
 * This is not a layout test (geometry lives in CSS and the gallery page); it
 * catches wiring mistakes: undefined components, hook-order changes, menu
 * callbacks, and dialogs that never open.
 */

// ---------------------------------------------------------------------------
// mini React
// ---------------------------------------------------------------------------
let active = null

// The fallback layers attach document listeners; the test never dispatches them.
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
  querySelector() { return null },
}

function fakeElement() {
  return {
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }),
    contains: () => false,
    classList: { add() {}, remove() {} },
    style: { setProperty() {}, removeProperty() {} },
    scrollWidth: 260,
    clientWidth: 120,
    focus() {},
  }
}

function createElement(type, props, ...children) {
  const merged = { ...(props ?? {}) }
  if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
  return { type, props: merged }
}

class Component {
  constructor(props) {
    this.props = props
  }
}

function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

const React = {
  createElement,
  Component,
  Fragment: 'fragment',
  useState(initial) {
    const runtime = active
    const instance = runtime.current
    const index = instance.cursor++
    if (instance.hooks[index] === undefined) {
      instance.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    }
    const slot = instance.hooks[index]
    return [slot.value, (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return
      slot.value = value
      runtime.dirty = true
    }]
  },
  useRef(initial) {
    const instance = active.current
    const index = instance.cursor++
    if (instance.hooks[index] === undefined) instance.hooks[index] = { current: initial }
    return instance.hooks[index]
  },
  useMemo(factory, deps) {
    const instance = active.current
    const index = instance.cursor++
    const previous = instance.hooks[index]
    if (previous === undefined || !sameDeps(previous.deps, deps)) {
      instance.hooks[index] = { deps, value: factory() }
    }
    return instance.hooks[index].value
  },
  useCallback(fn, deps) {
    return React.useMemo(() => fn, deps)
  },
  useEffect(fn, deps) {
    const instance = active.current
    const index = instance.cursor++
    const previous = instance.hooks[index]
    if (previous !== undefined && sameDeps(previous.deps, deps)) return
    instance.hooks[index] = { deps }
    active.effects.push(fn)
  },
  useId() {
    const instance = active.current
    const index = instance.cursor++
    if (instance.hooks[index] === undefined) instance.hooks[index] = ':r' + String(active.idSequence++)
    return instance.hooks[index]
  },
  forwardRef(fn) {
    return function ForwardedRefComponent(props) { return fn(props, props.ref) }
  },
}

class Runtime {
  constructor() {
    this.instances = new Map()
    this.effects = []
    this.dirty = false
    this.current = null
    this.idSequence = 0
  }

  renderRoot(component, props) {
    let passes = 0
    do {
      this.dirty = false
      this.effects = []
      this.root = this.render(createElement(component, props), 'root')
      this.runEffects()
      passes += 1
    } while (this.dirty && passes < 30)
    return this.root
  }

  runEffects() {
    while (this.effects.length > 0) {
      const batch = this.effects
      this.effects = []
      for (const fn of batch) {
        const cleanup = fn()
        if (typeof cleanup === 'function') cleanup()
      }
    }
  }

  render(node, key) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
    if (Array.isArray(node)) return node.map((child, index) => this.render(child, key + '.' + String(index)))
    const type = node.type
    const props = node.props ?? {}
    if (typeof type === 'string') {
      if (props.ref !== null && typeof props.ref === 'object') props.ref.current = fakeElement()
      return { type, props, children: this.renderChildren(props, key) }
    }
    if (typeof type === 'function') {
      if (type.prototype !== undefined && typeof type.prototype.render === 'function') {
        const instance = new type(props)
        instance.props = props
        return this.render(instance.render(), key + '~')
      }
      return this.renderComponent(type, props, key)
    }
    return null
  }

  renderChildren(props, key) {
    const children = props.children
    if (children === undefined) return []
    if (Array.isArray(children)) {
      return children.map((child, index) => this.render(child, key + '.' + String(index)))
    }
    return [this.render(children, key + '.0')]
  }

  renderComponent(fn, props, key) {
    const instance = this.instances.get(key) ?? { hooks: [], cursor: 0 }
    this.instances.set(key, instance)
    instance.cursor = 0
    const previous = this.current
    this.current = instance
    try {
      const output = fn(props)
      return this.render(output, key + '~')
    } finally {
      this.current = previous
    }
  }
}

// ---------------------------------------------------------------------------
// tree helpers
// ---------------------------------------------------------------------------
function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node.text === 'string') {
    visit(node)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function findAll(root, predicate) {
  const hits = []
  walk(root, (node) => { if (node.type !== undefined && predicate(node)) hits.push(node) })
  return hits
}

function texts(root) {
  const hits = []
  walk(root, (node) => { if (typeof node.text === 'string') hits.push(node.text) })
  return hits
}

function classesOf(node) {
  return String(node.props?.className ?? '').split(/\s+/).filter(Boolean)
}

function hasClass(root, name) {
  return findAll(root, (node) => classesOf(node).includes(name)).length > 0
}

function byClass(root, name) {
  return findAll(root, (node) => classesOf(node).includes(name))
}

function byAttr(root, name, value) {
  return findAll(root, (node) => node.props?.[name] === value)
}

function event(overrides = {}) {
  return {
    key: '',
    clientX: 0,
    clientY: 0,
    target: { closest: () => null },
    currentTarget: { contains: () => false, getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) },
    preventDefault() {},
    stopPropagation() {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// host primitives mock (the subset client.js resolves)
// ---------------------------------------------------------------------------
const ICON_NAMES = [
  'IconFolderCloseRegular', 'IconFolderOpenRegular', 'IconTriangleRightFillRegular',
  'IconChevronLeftOutlineRegular', 'IconChevronUpOutlineRegular', 'IconChevronDownOutlineRegular',
  'IconChevronsUpDownOutlineRegular', 'IconSearchOutlineRegular', 'IconCloseFillRegular',
  'IconEllipsisOutlineRegular', 'IconSlidersTwoOutlineRegular', 'IconPinFillRegular',
  'IconPinOutlineRegular', 'IconNewChatOutlineRegular', 'IconProjectAddOutlineRegular',
  'IconCheckOutlineRegular', 'IconQuestionOutlineRegular', 'IconWarningOutlineRegular',
  'IconClockOutlineRegular', 'IconFlatListOutlineRegular', 'IconQueueOutlineRegular',
  'IconArchiveOutlineRegular', 'IconArchiveOffOutlineRegular', 'IconArchiveCheckOutlineRegular',
  'IconUnarchiveOutlineRegular', 'IconCopyOutlineRegular', 'IconBranchOutlineRegular',
  'IconTrashOutlineRegular', 'IconListPenOutlineRegular',
]

function makeHostKit() {
  const kit = {}
  for (const name of ICON_NAMES) {
    kit[name] = (props) => createElement('span', { 'data-icon': name, 'data-size': props?.size }, null)
  }
  kit.Button = (props) => createElement('button', {
    className: props.className,
    onClick: props.onClick,
    disabled: props.disabled,
    'data-host': 'Button',
    'data-variant': props.variant,
  }, props.children)
  kit.Tooltip = (props) => createElement('span', { 'data-host': 'Tooltip' }, props.children)
  kit.StateDot = (props) => createElement('span', {
    'data-host': 'StateDot',
    'data-state': props.state,
    className: props.className,
  }, null)
  kit.Menu = (props) => {
    const children = [props.anchor ?? null]
    if (props.open === true && Array.isArray(props.items)) {
      const rendered = props.items
        .filter((item) => item.type !== 'separator')
        .map((item) => createElement('button', {
          key: item.id,
          role: 'menuitem',
          'data-menu-id': item.id,
          onClick: () => { if (typeof props.onSelect === 'function') props.onSelect(item.id) },
        }, item.type === 'label' ? item.text : item.label))
      children.push(createElement('div', { className: 'mock-menu-list' }, rendered))
    }
    return createElement('span', { className: 'mock-menu-anchor', 'data-host': 'Menu' }, children)
  }
  kit.HoverCard = (props) => createElement('span', { 'data-host': 'HoverCard' },
    props.anchor,
    createElement('span', { className: 'mock-hover-card' }, props.content))
  kit.MarqueeText = React.forwardRef((props, ref) => createElement('span', {
    ref,
    className: props.className,
    onPointerEnter: props.onPointerEnter,
    onPointerLeave: props.onPointerLeave,
  }, props.children))
  kit.useHoverMarquee = () => ({ onPointerEnter() {}, onPointerLeave() {} })
  kit.Toast = (props) => createElement('div', { role: 'alert', 'data-host': 'Toast' }, props.text)
  kit.Modal = (props) => createElement('div', { role: 'dialog', 'data-host': 'Modal' },
    createElement('div', null, props.title),
    props.children,
    props.footer === undefined ? null : createElement('div', null, props.footer))
  kit.Input = (props) => createElement('input', props)
  kit.useId = () => React.useId()
  return kit
}

// ---------------------------------------------------------------------------
// module host
// ---------------------------------------------------------------------------
function loadClient(hostKit, locationSearch = '') {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let captured = null
  const fakeWindow = {
    location: { search: locationSearch, hash: '', pathname: '/' },
    __ModuleLoader__: { load: (definition) => { captured = definition } },
  }
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('window', 'module', 'exports', source)(fakeWindow, module, module.exports)
  assert.ok(captured !== null, 'client.js must register through window.__ModuleLoader__.load')
  assert.equal(captured.id, 'dsh-folder-sidebar')
  const require = (name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      if (hostKit === null) throw new Error('host kit unavailable')
      return hostKit
    }
    throw new Error('unexpected require: ' + name)
  }
  return captured.factory(require)
}

const DICTS_SENTINEL = 'folder-sidebar:'

function makeContext(events = {}) {
  let registered = null
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register() {},
      bind() {
        return (key) => DICTS_SENTINEL + key
      },
    },
    slots: {
      inject(name, run) { assert.equal(name, 'sidebar.workspaces'); run() },
      register(options, component) {
        registered = { options, component }
        return () => {}
      },
    },
    uiWorkspace: {
      openSession: (id) => { events.opened = id },
      startSession: (id) => { events.started = id },
      pinSession: () => Promise.resolve(),
      unpinSession: () => Promise.resolve(),
      archiveSession: () => Promise.resolve(),
      unarchiveSession: () => Promise.resolve(),
      forkSession: () => Promise.resolve(),
      pickDirectory: () => Promise.resolve(''),
    },
    workspaces: {
      rename: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      insertBefore: () => Promise.resolve(),
    },
    sessions: { search: async () => ({ ok: true, value: { items: [] } }) },
  }
  return { ctx, getRegistered: () => registered }
}

function makeStores() {
  const now = Date.now()
  const workspaces = {
    items: [
      { workspaceId: 'w1', title: 'Alpha', path: 'C:\\work\\alpha', sessionIds: ['s1', 's2'] },
      { workspaceId: 'w2', title: 'Beta', path: 'C:\\work\\beta', sessionIds: ['s3'] },
    ],
    archivedSessionIds: ['s3'],
    pinnedSessionIds: ['s2'],
  }
  const sessions = {
    ids: ['s1', 's2', 's3'],
    byId: {
      s1: { id: 's1', displayTitle: 'Fix the sidebar', updatedAt: now - 60_000, retainedBy: { mainView: 0 } },
      s2: { id: 's2', displayTitle: 'Pinned session', updatedAt: now - 120_000, retainedBy: {} },
      s3: { id: 's3', displayTitle: 'Archived session', updatedAt: now - 240_000, retainedBy: {} },
    },
    projectionsBySession: {
      s1: { values: { 'folder-sidebar/turn': { state: 'failed', turn: 2, since: now - 60_000 } } },
    },
  }
  const status = new Map([
    ['s1', { running: true, pendingInteraction: { kind: 'approval' }, completionUnread: false }],
    ['s2', { running: false, completionUnread: true }],
  ])
  return { workspaces, sessions, status }
}

function makeProps(stores, extra = {}) {
  return {
    wide: true,
    expandSidebar() {},
    useWorkspaces: (selector) => { React.useState(0); return selector(stores.workspaces) },
    useSessions: (selector) => { React.useState(0); return selector(stores.sessions) },
    useSessionStatus: (selector) => { React.useState(0); return selector(stores.status) },
    ...extra,
  }
}

function mount(hostKit) {
  active = new Runtime()
  const events = {}
  const client = loadClient(hostKit)
  const { ctx, getRegistered } = makeContext(events)
  const api = client
  assert.equal(typeof api.apply, 'function')
  api.apply(ctx)
  const registered = getRegistered()
  assert.ok(registered !== null, 'apply must register the sidebar region')
  assert.equal(registered.options.name, 'sidebar.workspaces')
  assert.equal(registered.options.priority, -1)
  const stores = makeStores()
  const props = makeProps(stores)
  const rerender = () => active.renderRoot(registered.component, props)
  let root = rerender()
  return { root: () => root, rerender: () => { root = rerender(); return root }, events, stores }
}

// ---------------------------------------------------------------------------
// native path
// ---------------------------------------------------------------------------
{
  const host = makeHostKit()
  const mounted = mount(host)
  let root = mounted.root()

  assert.ok(hasClass(root, 'dfs-root'), 'native: root renders')
  assert.ok(hasClass(root, 'dfs-header'), 'native: shipped header renders')
  assert.ok(hasClass(root, 'dfs-headerLabel'), 'native: section label renders')
  assert.equal(byClass(root, 'dfs-projectRow').length, 2, 'native: one row per workspace')
  assert.ok(texts(root).includes('folder-sidebar:section.title'), 'native: locale title text renders')

  // View options: the shipped Menu carries sort + archived filter items.
  const viewTrigger = findAll(root, (node) => node.type === 'button' && node.props?.['aria-label'] === 'folder-sidebar:action.view')[0]
  assert.ok(viewTrigger !== undefined, 'native: view options trigger exists')
  viewTrigger.props.onClick(event())
  root = mounted.rerender()
  const viewIds = findAll(root, (node) => node.props?.['data-menu-id'] !== undefined)
    .map((node) => node.props['data-menu-id'])
  for (const id of ['mode:manual', 'mode:name', 'mode:recent', 'dir:asc', 'dir:desc', 'view:hide', 'view:all', 'view:only']) {
    assert.ok(viewIds.includes(id), 'native: view menu has ' + id)
  }
  findAll(root, (node) => node.props?.['data-menu-id'] === 'mode:name')[0].props.onClick()
  root = mounted.rerender()
  assert.equal(findAll(root, (node) => node.props?.['data-menu-id'] === 'mode:name').length, 0, 'native: picking a sort mode closes the menu')

  // The folder status cell aggregates waiting > running > error.
  const folderDots = findAll(root, (node) => node.props?.['data-host'] === 'StateDot' && node.props?.['data-state'] === 'warning')
  assert.ok(folderDots.length >= 1, 'native: folder with a pending interaction shows a warning dot')

  // Enter workspace w1 by activating its row.
  const w1Row = byAttr(root, 'data-row-key', 'workspace:w1')[0]
  assert.ok(w1Row !== undefined, 'native: workspace row has a stable data-row-key')
  w1Row.props.onClick(event())
  root = mounted.rerender()

  assert.ok(hasClass(root, 'dfs-crumb'), 'native: entering a folder shows the breadcrumb row')
  assert.equal(byClass(root, 'dfs-sessionRow').length, 2, 'native: the folder lists its two sessions')
  assert.ok(texts(root).includes('Fix the sidebar'), 'native: session titles render')
  // s1 waits for approval, so its leading StateDot must be a warning.
  const sessionRowWarnings = findAll(root, (node) => classesOf(node).includes('dfs-sessionRow'))
    .filter((row) => findWithin(row, (node) => node.props?.['data-state'] === 'warning') !== null)
  assert.equal(sessionRowWarnings.length, 1, 'native: the waiting session shows a warning state dot')
  assert.ok(findWithin(findAll(root, (node) => classesOf(node).includes('dfs-sessionRow'))
    .find((row) => nodeText(row).includes('Pinned session')), (node) => classesOf(node).includes('dfs-pin')) !== null,
  'native: the pinned session renders its pin indicator')

  // Row menu: open the trigger of "Fix the sidebar" and pick Rename.
  const fixRow = findAll(root, (node) => classesOf(node).includes('dfs-sessionRow'))
    .find((row) => nodeText(row).includes('Fix the sidebar'))
  assert.ok(fixRow !== undefined, 'native: the failing session row exists')
  const menuTrigger = findWithin(fixRow, (node) => node.type === 'button' && classesOf(node).includes('dfs-rowAction'))
  assert.ok(menuTrigger !== undefined, 'native: row menu trigger exists')
  menuTrigger.props.onClick(event())
  root = mounted.rerender()
  const menuItems = findAll(root, (node) => node.props?.['data-menu-id'] !== undefined)
  assert.ok(menuItems.length >= 5, 'native: session menu renders its items through the host Menu')
  const renameItem = findAll(root, (node) => node.props?.['data-menu-id'] === 'rename')[0]
  assert.ok(renameItem !== undefined, 'native: session menu has a rename item')
  renameItem.props.onClick()
  root = mounted.rerender()
  const dialogs = findAll(root, (node) => node.props?.role === 'dialog')
  assert.equal(dialogs.length, 1, 'native: rename opens exactly one dialog')
  const dialogInput = findAll(dialogs[0], (node) => node.type === 'input' && classesOf(node).includes('dfs-dialogInput'))[0]
  assert.ok(dialogInput !== undefined, 'native: the rename dialog uses the shipped 44px input geometry')
  assert.equal(dialogInput.props.value, 'Fix the sidebar', 'native: the rename dialog is prefilled')

  // Escape the dialog by closing it.
  const cancel = findAll(dialogs[0], (node) => node.type === 'button' && nodeText(node) === 'folder-sidebar:dialog.cancel')[0]
  assert.ok(cancel !== undefined, 'native: the dialog offers a cancel action')
  cancel.props.onClick()
  root = mounted.rerender()
  assert.equal(findAll(root, (node) => node.props?.role === 'dialog').length, 0, 'native: cancel closes the dialog')

  // Search: typing a title switches the list to the shipped search rows.
  const searchInput = byClass(root, 'dfs-searchInput')[0]
  assert.ok(searchInput !== undefined, 'native: the header owns the search input')
  searchInput.props.onChange({ target: { value: 'Pinned' } })
  root = mounted.rerender()
  assert.equal(byClass(root, 'dfs-searchRow').length, 1, 'native: title search shows a result row')
  assert.ok(texts(root).join(' ').includes('Pinned session'), 'native: the search result names the session')

  // Escape closes and clears the search.
  searchInput.props.onKeyDown(event({ key: 'Escape' }))
  root = mounted.rerender()
  assert.equal(byClass(root, 'dfs-searchRow').length, 0, 'native: Escape leaves search')
  assert.ok(hasClass(root, 'dfs-crumb'), 'native: leaving search returns to the folder view')

  // Right-click opens the same menu at the pointer (contextual mode).
  const s1Row = byAttr(root, 'data-row-key', 'session:s1')[0]
  assert.ok(s1Row !== undefined, 'native: session rows keep a stable data-row-key')
  s1Row.props.onContextMenu(event({ clientX: 48, clientY: 64 }))
  root = mounted.rerender()
  assert.ok(
    findAll(root, (node) => node.props?.['data-menu-id'] === 'pin').length >= 1,
    'native: right-click opens the session menu at the pointer',
  )
}

// ---------------------------------------------------------------------------
// fallback path (host kit unavailable)
// ---------------------------------------------------------------------------
{
  const mounted = mount(null)
  let root = mounted.root()
  assert.ok(hasClass(root, 'dfs-root'), 'fallback: root renders without the host kit')
  assert.equal(findAll(root, (node) => node.props?.['data-host'] !== undefined).length, 0, 'fallback: no host component is rendered')
  assert.ok(byClass(root, 'dfs-projectRow').length >= 2, 'fallback: folder rows render')
  assert.ok(hasClass(root, 'dfs-iconBtn'), 'fallback: icon buttons render')

  const w1Row = byAttr(root, 'data-row-key', 'workspace:w1')[0]
  w1Row.props.onClick(event())
  root = mounted.rerender()
  assert.equal(byClass(root, 'dfs-sessionRow').length, 2, 'fallback: entering a folder lists sessions')
  assert.ok(byClass(root, 'dfs-dotFallback').length >= 1, 'fallback: StateDot falls back to a local dot')

  // The fallback menu is a local layer with the same item ids.
  const trigger = findAll(root, (node) => node.type === 'button' && node.props?.['aria-label'] === 'folder-sidebar:action.menu')[0]
  assert.ok(trigger !== undefined, 'fallback: row menu trigger exists')
  trigger.props.onClick(event())
  root = mounted.rerender()
  assert.ok(hasClass(root, 'dfs-menuFallback'), 'fallback: row menu renders its local layer')
}

// ---------------------------------------------------------------------------
// component test page
// ---------------------------------------------------------------------------
{
  const host = makeHostKit()
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let captured = null
  const fakeWindow = {
    location: { search: '?folder-sidebar=gallery', hash: '', pathname: '/' },
    __ModuleLoader__: { load: (definition) => { captured = definition } },
  }
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('window', 'module', 'exports', source)(fakeWindow, module, module.exports)
  const require = (name) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return host
    throw new Error('unexpected require: ' + name)
  }
  const client = captured.factory(require)
  const events = {}
  const { ctx, getRegistered } = makeContext(events)
  client.apply(ctx)
  const registered = getRegistered()
  active = new Runtime()
  const root = active.renderRoot(registered.component, makeProps(makeStores()))
  assert.ok(hasClass(root, 'dfs-gallery'), 'gallery: ?folder-sidebar=gallery renders the test page')
  const cases = byClass(root, 'dfs-galleryCase')
  assert.ok(cases.length >= 8, 'gallery: every adapter has a case')
  const adapters = texts(root).filter((text) => /^(IconButton|Button|KitStateDot|Title|KitMenu|KitHoverCard|KitToast|KitModal)$/.test(text))
  assert.deepEqual([...new Set(adapters)].sort(), ['Button', 'IconButton', 'KitHoverCard', 'KitMenu', 'KitModal', 'KitStateDot', 'KitToast', 'Title'], 'gallery: cases name their adapter')
  assert.ok(texts(root).join(' ').includes('folder-sidebar:gallery.hostKit'), 'gallery: the host kit state is shown')
}

function findWithin(node, predicate) {
  let hit = null
  walk(node, (candidate) => { if (hit === null && candidate.type !== undefined && predicate(candidate)) hit = candidate })
  return hit
}

function nodeText(node) {
  return texts(node).join('')
}

console.log('folder-sidebar render OK')
