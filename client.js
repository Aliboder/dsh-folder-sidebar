/**
 * Pure logic for dsh-folder-sidebar.
 *
 * This block lives at module scope, outside the Client factory, so that the
 * exact shipped source can be exercised by `node` tests: with `window` absent
 * the browser bootstrap below is skipped and `module.exports` exposes these
 * functions. Nothing here touches React, the DOM, or a specific Cordis context.
 */

const INDICATOR_PRIORITY = ['waiting', 'running', 'error', 'completed', 'stopped']

/** A Workspace cell ignores user stops: stopping is a Session-level fact. */
const FOLDER_INDICATOR_PRIORITY = INDICATOR_PRIORITY.filter((kind) => kind !== 'stopped')

const INDICATOR_LABEL_KEY = {
  running: 'status.running',
  completed: 'status.completed',
  waiting: 'status.waiting',
  error: 'status.error',
  stopped: 'status.stopped',
}

const GLYPH_COLOR = {
  waiting: 'var(--dsw-alias-state-warn-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
  completed: 'var(--dsw-alias-state-success-primary)',
}

const SORT_MODES = ['manual', 'name', 'recent']
const SORT_DIRS = ['asc', 'desc']

/** Each level keeps its own mode and direction. */
const SORT_KEY = 'dsh.folder-sidebar.sort'

const SORT_DEFAULT = {
  folders: { mode: 'manual', dir: 'asc' },
  sessions: { mode: 'recent', dir: 'desc' },
}

/** A mode's natural order; picking a mode resets the direction to it. */
const SORT_NATURAL_DIR = { manual: 'asc', name: 'asc', recent: 'desc' }

/** Archived visibility mirrors the shipped view options. */
const ARCHIVED_KEY = 'dsh.folder-sidebar.archived'
const ARCHIVED_FILTERS = ['hide', 'all', 'only']

/** Sentinel for the pseudo Workspace that owns Sessions outside every Workspace. */
const UNGROUPED = '__ungrouped__'

function safeStorage(storage) {
  if (storage !== undefined && storage !== null) return storage
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

/** Comparator sign for a direction. */
function directionSign(dir) {
  return dir === 'desc' ? -1 : 1
}

function normalizeSort(value, fallback) {
  const mode = value !== null && typeof value === 'object' && SORT_MODES.includes(value.mode) ? value.mode : fallback.mode
  const dir = value !== null && typeof value === 'object' && SORT_DIRS.includes(value.dir) ? value.dir : fallback.dir
  return { mode, dir }
}

function readSortState(storage) {
  const store = safeStorage(storage)
  try {
    const parsed = JSON.parse(store?.getItem(SORT_KEY) ?? 'null')
    return {
      folders: normalizeSort(parsed?.folders, SORT_DEFAULT.folders),
      sessions: normalizeSort(parsed?.sessions, SORT_DEFAULT.sessions),
    }
  } catch {
    return { folders: { ...SORT_DEFAULT.folders }, sessions: { ...SORT_DEFAULT.sessions } }
  }
}

function writeSortState(state, storage) {
  try {
    safeStorage(storage)?.setItem(SORT_KEY, JSON.stringify(state))
  } catch {
    // Storage may be unavailable; the choice still applies this session.
  }
}

function readArchivedFilter(storage) {
  try {
    const saved = safeStorage(storage)?.getItem(ARCHIVED_KEY)
    return ARCHIVED_FILTERS.includes(saved) ? saved : 'hide'
  } catch {
    return 'hide'
  }
}

function writeArchivedFilter(value, storage) {
  try {
    safeStorage(storage)?.setItem(ARCHIVED_KEY, value)
  } catch {
    // Storage may be unavailable; the filter still applies this session.
  }
}

/** Last-read failure per Session: a red cell clears once its turn was seen. */
const SEEN_KEY = 'dsh.folder-sidebar.seen'

function readSeenTurns(storage) {
  try {
    const parsed = JSON.parse(safeStorage(storage)?.getItem(SEEN_KEY) ?? 'null')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const seen = {}
    for (const [id, turn] of Object.entries(parsed)) {
      if (id !== '' && typeof turn === 'number' && Number.isFinite(turn) && turn >= 0) seen[id] = turn
    }
    return seen
  } catch {
    return {}
  }
}

function writeSeenTurns(seen, storage) {
  try {
    safeStorage(storage)?.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    // Storage may be unavailable; the marker still clears for this session.
  }
}

/** Record a read turn; the map stays bounded by dropping the oldest entries. */
function markTurnSeen(seen, sessionId, turn) {
  if (typeof sessionId !== 'string' || sessionId === '') return seen
  if (typeof turn !== 'number' || !Number.isFinite(turn) || turn < 0) return seen
  const previous = seen[sessionId]
  if (typeof previous === 'number' && previous >= turn) return seen
  const next = { ...seen, [sessionId]: turn }
  const ids = Object.keys(next)
  for (const id of ids.slice(0, Math.max(0, ids.length - 500))) delete next[id]
  return next
}

/**
 * Order Workspaces for the folder list.
 * @param items - Workspaces in Host order.
 * @param sort - `{ mode, dir }`.
 * @param accessors - `nameOf(item)` and `activityOf(item)`.
 */
function sortWorkspaces(items, sort, accessors) {
  const ordered = items.slice()
  const sign = directionSign(sort.dir)
  if (sort.mode === 'name') {
    ordered.sort((a, b) => accessors.nameOf(a).localeCompare(accessors.nameOf(b), undefined, { numeric: true }) * sign)
  } else if (sort.mode === 'recent') {
    ordered.sort((a, b) => (accessors.activityOf(a) - accessors.activityOf(b)) * sign)
  } else if (sign < 0) {
    ordered.reverse()
  }
  return ordered
}

/**
 * Order Sessions inside one Workspace. Pinned rows stay first in every mode;
 * the direction applies inside a group. Descending updates are what the caller
 * already derives, so only ascending needs a sort.
 */
function sortSessions(rows, sort, accessors) {
  const ordered = rows.slice()
  const sign = directionSign(sort.dir)
  const pinOf = (row) => (accessors.isPinned(row) ? 1 : 0)
  if (sort.mode === 'name') {
    ordered.sort((a, b) => {
      const pin = pinOf(b) - pinOf(a)
      if (pin !== 0) return pin
      return accessors.titleOf(a).localeCompare(accessors.titleOf(b), undefined, { numeric: true }) * sign
    })
    return ordered
  }
  // Both "manual" and "recent" order Sessions by recency; the direction only
  // flips the comparison, so the result never depends on the caller's order.
  ordered.sort((a, b) => {
    const pin = pinOf(b) - pinOf(a)
    if (pin !== 0) return pin
    return ((accessors.updatedAtOf(a) ?? 0) - (accessors.updatedAtOf(b) ?? 0)) * sign
  })
  return ordered
}

/**
 * A Workspace shows one status: highest precedence first, then the state that
 * began earliest. A user stop is a Session-level fact and never marks the
 * folder, so `stopped` candidates are ignored.
 * @param candidates - `{ kind, since }` pairs for the Workspace's Sessions.
 */
function pickFolderKind(candidates) {
  let best
  for (const candidate of candidates) {
    const priority = FOLDER_INDICATOR_PRIORITY.indexOf(candidate.kind)
    if (priority < 0) continue
    if (best === undefined || priority < best.priority || (priority === best.priority && candidate.since < best.since)) {
      best = { kind: candidate.kind, priority, since: candidate.since }
    }
  }
  return best === undefined ? undefined : best.kind
}

/**
 * Whether this projection's failure has already been read. Reading means the
 * Session was the one in the main view — the same rule the client uses to
 * clear `completionUnread` — recorded per turn, so a later failure shows again.
 */
function failureSeen(projection, seenTurn) {
  if (projection === undefined || projection === null) return false
  if (projection.state !== 'failed' && projection.state !== 'interrupted') return false
  const turn = typeof projection.turn === 'number' ? projection.turn : 0
  return typeof seenTurn === 'number' && Number.isFinite(seenTurn) && seenTurn >= turn
}

/**
 * One row's leading indicator. Green follows the client's completion-unread
 * rule; a red failure comes from this bundle's projection and clears once the
 * Session was read, just like the green completion. Running wins over
 * everything, a pending question wins over activity.
 */
function indicatorOf(status, projection, seenTurn) {
  const waiting = status !== undefined && status !== null
    && status.pendingInteraction !== undefined && status.pendingInteraction !== null
  if (waiting) return 'waiting'
  const running = status !== undefined && status !== null && status.running === true
  if (running) return 'running'
  const state = projection === undefined || projection === null ? undefined : projection.state
  if (state === 'failed' || state === 'interrupted') return failureSeen(projection, seenTurn) ? undefined : 'error'
  if (status !== undefined && status !== null && status.completionUnread === true) return 'completed'
  if (state === 'running') return 'running'
  if (state === 'stopped') return 'stopped'
  return undefined
}

function relativeTime(ts, now = Date.now()) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return ''
  const delta = now - ts
  if (delta < 60_000) return '<1m'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d`
  const date = new Date(ts)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function baseName(path) {
  if (typeof path !== 'string' || path === '') return ''
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : path
}

/**
 * How far a title must travel to show its tail, or 0 when it already fits.
 * A couple of pixels of rounding should not start a marquee.
 */
function marqueeShiftOf(scrollWidth, clientWidth) {
  if (!Number.isFinite(scrollWidth) || !Number.isFinite(clientWidth)) return 0
  const shift = Math.round(scrollWidth - clientWidth)
  return shift > 2 ? shift : 0
}

/** Longer titles scroll slower, so the reading speed stays roughly even. */
function marqueeDurationOf(shift) {
  return Math.min(14000, Math.max(2200, Math.round(shift * 26)))
}

/**
 * Web Client half of dsh-folder-sidebar.
 *
 * Replaces the sidebar's `sidebar.workspaces` region (shipped browser:
 * ui-workspace) with a drill-down "folder" view:
 *   1. folder list — one row per Workspace; the folder icon itself is that
 *      Workspace's single status cell, showing its oldest Session state;
 *   2. enter a folder — only that Workspace's Sessions, each with its own
 *      state dot, a "…" menu, and a back row.
 * A search field switches the region to a flat result list across Workspaces.
 *
 * Controls prefer the shipped primitives
 * (`@deepseek-ai/dsh-client-ui-primitives`); the header, rows and search
 * geometry are copied from ui-workspace, with local fallbacks that keep the
 * same contract when the package is unavailable. See AGENTS.md.
 *
 * Data comes from the slot's standard projection props (`useWorkspaces`,
 * `useSessions`, `useSessionStatus`); actions go through Client services
 * (`uiWorkspace`, `workspaces`, `sessions`). Failure state is read from this
 * bundle's Host projection (`folder-sidebar/turn`), because a Session summary
 * carries no failure field.
 */

if (typeof window !== 'undefined' && window.__ModuleLoader__ !== undefined) {
  window.__ModuleLoader__.load({
  id: 'dsh-folder-sidebar',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'folder-sidebar'

    /** Host projection key: this bundle's per-Session last-turn state. */
    const TURN_KEY = 'folder-sidebar/turn'

    const DICTS = {
      zh: {
        'section.title': '工作区',
        'action.back': '全部工作区',
        'action.newSession': '新会话',
        'action.addWorkspace': '添加工作区',
        'action.search': '搜索会话',
        'action.close': '关闭',
        'action.menu': '更多操作',
        'action.pin': '置顶',
        'action.unpin': '取消置顶',
        'action.rename': '重命名',
        'action.archive': '归档',
        'action.fork': '分叉',
        'action.copyId': '复制会话 ID',
        'action.renameWorkspace': '重命名工作区',
        'action.deleteWorkspace': '删除工作区',
        'action.newSessionHere': '在此新建会话',
        'action.moveUp': '上移',
        'action.moveDown': '下移',
        'action.sort': '排序',
        'level.folders': '文件夹',
        'level.sessions': '会话',
        'sort.manual': '手动顺序',
        'sort.name': '按名称',
        'sort.recent': '按最近活动',
        'sort.asc': '正序',
        'sort.desc': '倒序',
        'confirm.archive': '该会话仍在运行，停止并归档？',
        'confirm.deleteWorkspace': '删除这个工作区？会话与文件不会被删除。',
        'confirm.yes': '确认',
        'confirm.cancel': '取消',
        'empty.workspaces': '还没有工作区',
        'empty.sessions': '这个工作区还没有会话',
        'empty.search': '没有匹配的会话',
        'empty.archived': '暂无已归档会话',
        'group.ungrouped': '未分组',
        'action.undo': '撤销',
        'action.unarchive': '取消归档',
        'action.view': '视图选项',
        'view.hide': '隐藏已归档',
        'view.all': '全部会话',
        'view.only': '仅显示已归档',
        'notice.archived': '已归档',
        'notice.archivedNotOpenable': '已归档，取消归档后才能打开',
        'notice.pinFailed': '置顶操作失败',
        'notice.archiveFailed': '归档失败',
        'notice.unarchiveFailed': '取消归档失败',
        'notice.renameFailed': '重命名失败',
        'notice.forkFailed': '分叉失败',
        'notice.moveFailed': '调整顺序失败',
        'notice.deleteFailed': '删除工作区失败',
        'notice.addWorkspaceFailed': '添加工作区失败',
        'session.untitled': '未命名会话',
        'copied': '已复制',
        'unit.sessions': '个会话',
        'rail.expand': '展开侧栏',
        'search.placeholder': '搜索会话…',
        'search.content': '内容匹配',
        'status.running': '运行中',
        'status.completed': '已完成',
        'status.error': '失败或中断',
        'status.waiting': '等待你的回答',
        'status.waitingApproval': '等待审批',
        'status.waitingPlanReview': '等待计划确认',
        'status.waitingAnswer': '等待回答',
        'status.stopped': '已停止',
        'status.idle': '空闲',
        'dialog.renameSession': '重命名会话',
        'dialog.renameWorkspace': '重命名工作区',
        'dialog.archiveTitle': '归档会话',
        'dialog.archiveConfirm': '该会话仍在运行，停止并归档？',
        'dialog.deleteWorkspaceTitle': '删除工作区',
        'dialog.deleteWorkspaceDesc': '删除这个工作区？会话与文件不会被删除。',
        'dialog.archive': '归档',
        'dialog.delete': '删除',
        'dialog.save': '保存',
        'dialog.cancel': '取消',
        'search.searching': '搜索中…',
        'gallery.title': '组件测试页',
        'gallery.close': '退出测试页',
        'gallery.hint': '这里就是标准写法：控件先在此立用例，再进业务。',
        'gallery.hostKit': '宿主组件',
        'gallery.native': 'native（全部可用）',
        'gallery.partial': 'partial（部分缺失）',
        'gallery.fallback': 'fallback（包不可用）',
        'gallery.secControls': '控件',
        'gallery.secRows': '列表行',
        'gallery.secOverlays': '浮层',
        'gallery.caseIconButton': '图标按钮',
        'gallery.caseButton': '按钮',
        'gallery.caseStateDot': '状态点',
        'gallery.caseTitle': '长标题（悬停跑马灯）',
        'gallery.caseMenu': '菜单',
        'gallery.caseHover': '悬浮卡',
        'gallery.caseToast': '轻提示',
        'gallery.caseModal': '对话框',
        'gallery.caseFolderRow': '文件夹行',
        'gallery.caseSessionRow': '会话行',
        'gallery.caseSearchRow': '搜索结果行',
        'gallery.hoverAnchor': '悬停查看',
        'gallery.longTitle': '这是一个很长很长、需要悬停才能看全的会话标题',
        'gallery.sampleSession': '重做侧栏界面',
      },
      en: {
        'section.title': 'Workspaces',
        'action.back': 'All workspaces',
        'action.newSession': 'New session',
        'action.addWorkspace': 'Add workspace',
        'action.search': 'Search sessions',
        'action.close': 'Close',
        'action.menu': 'More actions',
        'action.pin': 'Pin',
        'action.unpin': 'Unpin',
        'action.rename': 'Rename',
        'action.archive': 'Archive',
        'action.fork': 'Fork',
        'action.copyId': 'Copy session ID',
        'action.renameWorkspace': 'Rename workspace',
        'action.deleteWorkspace': 'Delete workspace',
        'action.newSessionHere': 'New session here',
        'action.moveUp': 'Move up',
        'action.moveDown': 'Move down',
        'action.sort': 'Sort',
        'level.folders': 'folders',
        'level.sessions': 'sessions',
        'sort.manual': 'Manual order',
        'sort.name': 'By name',
        'sort.recent': 'By recent activity',
        'sort.asc': 'Ascending',
        'sort.desc': 'Descending',
        'confirm.archive': 'This session is still running. Stop it and archive?',
        'confirm.deleteWorkspace': 'Delete this workspace? Sessions and files are kept.',
        'confirm.yes': 'Confirm',
        'confirm.cancel': 'Cancel',
        'empty.workspaces': 'No workspaces yet',
        'empty.sessions': 'No sessions in this workspace yet',
        'empty.search': 'No matching sessions',
        'empty.archived': 'No archived sessions',
        'group.ungrouped': 'Ungrouped',
        'action.undo': 'Undo',
        'action.unarchive': 'Unarchive',
        'action.view': 'View options',
        'view.hide': 'Hide archived',
        'view.all': 'All sessions',
        'view.only': 'Archived only',
        'notice.archived': 'Archived',
        'notice.archivedNotOpenable': 'Archived — unarchive it to open',
        'notice.pinFailed': 'Pin failed',
        'notice.archiveFailed': 'Archive failed',
        'notice.unarchiveFailed': 'Unarchive failed',
        'notice.renameFailed': 'Rename failed',
        'notice.forkFailed': 'Fork failed',
        'notice.moveFailed': 'Reorder failed',
        'notice.deleteFailed': 'Deleting the workspace failed',
        'notice.addWorkspaceFailed': 'Adding the workspace failed',
        'session.untitled': 'Untitled session',
        'copied': 'Copied',
        'unit.sessions': 'sessions',
        'rail.expand': 'Expand sidebar',
        'search.placeholder': 'Search sessions…',
        'search.content': 'content match',
        'status.running': 'Running',
        'status.completed': 'Completed',
        'status.error': 'Failed or interrupted',
        'status.waiting': 'Waiting for your answer',
        'status.waitingApproval': 'Waiting for approval',
        'status.waitingPlanReview': 'Waiting for plan review',
        'status.waitingAnswer': 'Waiting for your answer',
        'status.stopped': 'Stopped',
        'status.idle': 'Idle',
        'dialog.renameSession': 'Rename session',
        'dialog.renameWorkspace': 'Rename workspace',
        'dialog.archiveTitle': 'Archive session',
        'dialog.archiveConfirm': 'This session is still running. Stop it and archive?',
        'dialog.deleteWorkspaceTitle': 'Delete workspace',
        'dialog.deleteWorkspaceDesc': 'Delete this workspace? Sessions and files are kept.',
        'dialog.archive': 'Archive',
        'dialog.delete': 'Delete',
        'dialog.save': 'Save',
        'dialog.cancel': 'Cancel',
        'search.searching': 'Searching…',
        'gallery.title': 'Component test page',
        'gallery.close': 'Leave the test page',
        'gallery.hint': 'This page is the standard: add a case here before using a control in the sidebar.',
        'gallery.hostKit': 'Host kit',
        'gallery.native': 'native (all available)',
        'gallery.partial': 'partial (some missing)',
        'gallery.fallback': 'fallback (package unavailable)',
        'gallery.secControls': 'Controls',
        'gallery.secRows': 'Rows',
        'gallery.secOverlays': 'Overlays',
        'gallery.caseIconButton': 'Icon button',
        'gallery.caseButton': 'Button',
        'gallery.caseStateDot': 'State dot',
        'gallery.caseTitle': 'Long title (hover marquee)',
        'gallery.caseMenu': 'Menu',
        'gallery.caseHover': 'Hover card',
        'gallery.caseToast': 'Toast',
        'gallery.caseModal': 'Dialog',
        'gallery.caseFolderRow': 'Folder row',
        'gallery.caseSessionRow': 'Session row',
        'gallery.caseSearchRow': 'Search result row',
        'gallery.hoverAnchor': 'Hover me',
        'gallery.longTitle': 'A long session title that only hover reveals in full',
        'gallery.sampleSession': 'Redo the sidebar UI',
      },
    }

    /**
     * Precedence for a Workspace's single status cell, matching the Session row
     * order: an actionable question outranks activity, a failure outranks an
     * unread result. Ties inside one kind fall back to the oldest state.
     */
    /**
     * Styles. Geometry and interaction values are copied from the shipped
     * sidebar (ui-workspace: WorkspaceBrowser.module.css, Rows.module.css) and
     * the host primitives (ui-primitives CSS modules); only the class prefix
     * (`dfs-`) is ours. Colors are tokens only, hairlines stay .5px.
     */
    const CSS = `
.dfs-root{position:relative;flex:1 1 auto;min-height:0;height:100%;display:flex;flex-direction:column;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:14px}

/* ---- header: shipped sectionHeader (title, inline search, two actions) ---- */
.dfs-header{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:4px;height:36px;padding-left:var(--dsh-sidebar-row-padding,12px);margin-bottom:0;box-sizing:border-box;border-radius:var(--dsw-radius-md);overflow:hidden;color:var(--dsw-alias-label-tertiary)}
.dfs-headerLabel{position:relative;left:-1px;flex:none;max-width:45%;min-width:0;overflow:hidden;white-space:nowrap;line-height:20px;opacity:1;visibility:visible;transition:max-width 180ms var(--ds-ease-in-out,ease),margin-right 180ms var(--ds-ease-in-out,ease),opacity 120ms var(--ds-ease-in-out,ease),transform 180ms var(--ds-ease-in-out,ease),visibility 0s linear}
.dfs-headerLabel.is-hidden{max-width:0;margin-right:-4px;opacity:0;transform:translateX(-4px);visibility:hidden;transition-delay:0s,0s,0s,0s,180ms}
.dfs-searchSlot{flex:1;max-width:28px;min-width:0;display:flex;align-items:center;margin-left:auto;padding-left:0;box-sizing:border-box;transition:max-width 180ms var(--ds-ease-in-out,ease),padding-left 180ms var(--ds-ease-in-out,ease)}
.dfs-searchSlot.is-expanded{max-width:100%}
.dfs-headerActions{flex:none;display:flex;align-items:center;gap:4px;max-width:60px;opacity:1;overflow:hidden;visibility:visible;transition:max-width 180ms var(--ds-ease-in-out,ease),opacity 120ms var(--ds-ease-in-out,ease),transform 180ms var(--ds-ease-in-out,ease),visibility 0s linear}
.dfs-headerActions.is-hidden{max-width:0;opacity:0;transform:translateX(4px);visibility:hidden;pointer-events:none;transition-delay:0s,0s,0s,180ms}
.dfs-header:has(.dfs-search.is-open){margin-right:0;padding-inline:calc(var(--dsh-sidebar-paint-inset,3px) + 1px);gap:0}
.dfs-search{flex:none;display:flex;align-items:center;gap:0;width:100%;height:28px;margin:0;padding:0;box-sizing:border-box;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:text;color:var(--dsw-alias-label-secondary);overflow:hidden;transition:width 180ms var(--ds-ease-in-out,ease),padding 180ms var(--ds-ease-in-out,ease),border-color 180ms var(--ds-ease-in-out,ease),background-color 180ms var(--ds-ease-in-out,ease)}
.dfs-search.is-open{width:100%;height:32px;margin-inline:0;padding:0 4px 0 0;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-tertiary)}
.dfs-searchButton{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);padding:0;background:transparent;cursor:pointer;color:inherit}
.dfs-search.is-open .dfs-searchButton{height:32px}
.dfs-searchInput{flex:1;width:0;min-width:0;border:none;outline:none;background:transparent;opacity:0;pointer-events:none;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);transition:opacity 120ms var(--ds-ease-in-out,ease)}
.dfs-search.is-open .dfs-searchInput{margin-left:-2px;opacity:1;pointer-events:auto}
.dfs-searchInput::placeholder{color:var(--dsw-alias-label-tertiary)}
.dfs-clearButton{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;border-radius:var(--dsw-radius-sm);padding:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
/* Adapter overrides: .dfs-iconBtn is 28x28, the shipped search/clear cells are not. */
.dfs-iconBtn.dfs-searchButton{width:28px;height:28px;color:inherit}
.dfs-search.is-open .dfs-iconBtn.dfs-searchButton{height:32px;background:transparent}
.dfs-iconBtn.dfs-clearButton{width:24px;height:24px}
@media (hover:hover){.dfs-search.is-open .dfs-searchButton:hover{background:transparent}}
.dfs-searchRow.is-archived .dfs-searchTitle,.dfs-searchRow.is-archived .dfs-searchWorkspace,.dfs-searchRow.is-archived .dfs-searchSnippet{color:var(--dsw-alias-label-caption)}

/* ---- icon button: shipped .iconButton ---- */
.dfs-iconBtn{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);padding:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dfs-iconBtn:disabled{opacity:.4;cursor:not-allowed}
@media (hover:hover){.dfs-iconBtn:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover)}}

/* ---- list seat: shipped .listArea ---- */
.dfs-listArea{flex:1;min-height:0;display:block;overflow-x:hidden;overflow-y:auto;margin-left:-4px;margin-right:calc(2px - var(--dsh-sidebar-inline-padding,8px));padding-left:4px;padding-right:calc(var(--dsh-sidebar-inline-padding,8px) - var(--dsh-scrollbar-width,0px) - 2px);padding-bottom:16px;scrollbar-gutter:stable}
.dfs-listArea > * + *{margin-top:2px}

/* ---- rows: shipped projectRow / sessionRow ---- */
.dfs-row{position:relative;display:flex;align-items:center;gap:var(--dsh-sidebar-label-gap,6px);box-sizing:border-box;height:32px;border-radius:var(--dsw-radius-md);border-inline:var(--dsh-sidebar-paint-inset,3px) solid transparent;background-clip:padding-box;padding:0 8px;padding-inline-start:calc(var(--dsh-sidebar-row-padding,12px) - var(--dsh-sidebar-paint-inset,3px));cursor:pointer;-webkit-user-select:none;user-select:none;color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px}
.dfs-sessionRow{gap:0}
.dfs-sessionRow.is-current{background-color:var(--dsw-alias-interactive-bg-hover)}
.dfs-row.has-menu{background-color:var(--dsw-alias-interactive-bg-hover)}
.dfs-row.is-archived .dfs-rowTitle{color:var(--dsw-alias-label-caption)}
@media (hover:hover){.dfs-projectRow:hover,.dfs-sessionRow:hover{background-color:var(--dsw-alias-interactive-bg-hover)}}
.dfs-slot{flex:none;width:16px;height:20px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}
.dfs-rowTitle{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px}
.dfs-sessionRow .dfs-rowTitle{flex:1;margin:0 12px 0 var(--dsh-sidebar-label-gap,6px)}
.dfs-projectRow .dfs-rowTitle{flex:1}
.dfs-rowResting{flex:none;display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary)}
.dfs-time{flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-inline-end:-1px}
.dfs-pin{display:inline-flex;flex:none;width:16px;height:20px;align-items:center;justify-content:center;margin-left:6px;color:var(--dsw-alias-label-caption)}
.dfs-rowActions{flex:none;display:none;align-items:center;gap:12px;margin-left:1px}
@media (hover:hover){.dfs-projectRow:hover .dfs-rowActions,.dfs-sessionRow:hover .dfs-rowActions,.dfs-row.has-menu .dfs-rowActions,.dfs-row:focus-within .dfs-rowActions{display:inline-flex}.dfs-sessionRow:hover .dfs-rowResting,.dfs-row.has-menu .dfs-rowResting{display:none}.dfs-row:hover .dfs-rowTitle,.dfs-row.has-menu .dfs-rowTitle{text-overflow:clip}}
@media (hover:none){.dfs-rowActions{display:inline-flex}}
.dfs-rowAction{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin:-4px;border:none;border-radius:var(--dsw-radius-xs);padding:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-tertiary)}
@media (hover:hover){.dfs-rowAction:hover{color:var(--dsw-alias-label-primary)}}

/* ---- folder cell: the folder glyph doubles as the workspace status cell ---- */
.dfs-folderSlot{position:relative;flex:none;width:16px;height:20px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}
.dfs-folderSlot.is-waiting{color:var(--dsw-alias-state-warn-primary)}
.dfs-folderSlot.is-error{color:var(--dsw-alias-state-error-primary)}
.dfs-folderSlot.is-completed{color:var(--dsw-alias-state-success-primary)}
.dfs-folderSlot.is-stopped{color:var(--dsw-alias-state-idle-primary)}
.dfs-folderGlyph,.dfs-enterGlyph{display:inline-flex;align-items:center;justify-content:center}
.dfs-enterGlyph{display:none;color:var(--dsw-alias-label-caption)}
@media (hover:hover){.dfs-projectRow:hover .dfs-folderGlyph{display:none}.dfs-projectRow:hover .dfs-enterGlyph{display:inline-flex}}

/* ---- breadcrumb row (level 2) ---- */
.dfs-crumb{display:flex;align-items:center;gap:var(--dsh-sidebar-label-gap,6px);box-sizing:border-box;height:32px;margin:0 0 2px;padding:0 8px;padding-inline-start:calc(var(--dsh-sidebar-row-padding,12px) - var(--dsh-sidebar-paint-inset,3px));border-inline:var(--dsh-sidebar-paint-inset,3px) solid transparent;border-radius:var(--dsw-radius-md);background-clip:padding-box;cursor:pointer;color:var(--dsw-alias-label-primary)}
@media (hover:hover){.dfs-crumb:hover{background-color:var(--dsw-alias-interactive-bg-hover)}}
.dfs-crumbChevron{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-label-caption)}
.dfs-crumbFolder{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary)}
.dfs-crumbName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px}

/* ---- search results: shipped searchResultRow ---- */
.dfs-searchRow{display:flex;flex-direction:column;align-items:stretch;width:100%;min-height:48px;box-sizing:border-box;border:none;border-radius:var(--dsw-radius-lg);padding:4px calc(var(--dsh-sidebar-row-padding,12px) - var(--dsh-sidebar-paint-inset,3px));border-inline:var(--dsh-sidebar-paint-inset,3px) solid transparent;background:transparent;background-clip:padding-box;cursor:pointer;text-align:left;color:var(--dsw-alias-label-primary)}
@media (hover:hover){.dfs-searchRow:hover{background-color:var(--dsw-alias-interactive-bg-hover)}}
.dfs-searchHeading{display:flex;align-items:center;min-width:0}
.dfs-searchTitle{flex:1;min-width:0;margin:0 var(--dsh-sidebar-label-gap,6px);overflow:hidden;font-size:14px;line-height:20px}
.dfs-searchMeta{display:flex;align-items:center;gap:6px;min-width:0;margin-left:calc(16px + var(--dsh-sidebar-label-gap,6px))}
.dfs-searchWorkspace,.dfs-searchSnippet{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:17px}
.dfs-searchWorkspace{flex:none;max-width:40%;color:var(--dsw-alias-label-tertiary)}
.dfs-searchWorkspace:only-child{max-width:100%}
.dfs-searchSnippet{flex:1;min-width:0;color:var(--dsw-alias-label-secondary)}

/* ---- empty states: shipped .empty / .emptyState ---- */
.dfs-empty{padding:16px 12px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dfs-emptyState{display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:64px;padding:0 12px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;text-align:center}
.dfs-emptyAction{padding:0;border:none;background:none;cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary))}

/* ---- hover card body: shipped .hoverContent ---- */
.dfs-hoverContent{display:flex;flex-direction:column;gap:8px}
.dfs-hoverTitle{font-size:14px;line-height:20px;color:var(--dsw-alias-hovercard-label-primary);overflow-wrap:break-word}
.dfs-hoverPath{font-size:12px;line-height:16px;color:var(--dsw-alias-hovercard-label-secondary);word-break:break-all}
.dfs-hoverTime{font-size:12px;line-height:16px;color:var(--dsw-alias-hovercard-label-secondary)}
.dfs-hoverStatus{display:flex;align-items:center;gap:8px;font-size:12px;line-height:20px;color:var(--dsw-alias-hovercard-label-tertiary)}

/* ---- drag insertion marker: shipped .dropBefore/.dropAfter ---- */
.dfs-row.dropBefore::before,.dfs-row.dropAfter::after{content:'';position:absolute;z-index:1;left:calc(-1 * var(--dsh-sidebar-paint-inset,3px));right:calc(4px - var(--dsh-sidebar-paint-inset,3px));height:12px;background:linear-gradient(55deg,transparent calc(50% - 1px),var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)) 0 0 / 5px 7px no-repeat,linear-gradient(125deg,transparent calc(50% - 1px),var(--dsw-alias-state-business-primary) calc(50% - 1px) calc(50% + 1px),transparent calc(50% + 1px)) 0 5px / 5px 7px no-repeat,linear-gradient(var(--dsw-alias-state-business-primary) 0 0) 4px 5px / calc(100% - 4px) 2px no-repeat;pointer-events:none}
.dfs-row.dropBefore::before{top:-7px}
.dfs-row.dropAfter::after{bottom:-7px}

/* ---- fallback StateDot (host StateDot missing) ---- */
.dfs-dotFallback{flex:none;display:inline-block;position:relative;width:10px;height:10px}
.dfs-dotFallback::after{content:'';position:absolute;inset:20%;border-radius:50%;background:currentColor}
.dfs-dotFallback.is-done{color:var(--dsw-alias-state-success-primary)}
.dfs-dotFallback.is-warning{color:var(--dsw-alias-state-warn-primary)}
.dfs-dotFallback.is-error{color:var(--dsw-alias-state-error-primary)}
.dfs-dotFallback.is-idle{color:var(--dsw-alias-state-idle-primary)}
.dfs-stopDot{flex:none;display:inline-block;box-sizing:border-box;width:10px;height:10px;border:1.5px solid var(--dsw-alias-state-idle-primary);border-radius:50%;opacity:.85}
.dfs-spinnerFallback{flex:none;display:inline-block;box-sizing:border-box;width:12px;height:12px;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-tertiary);border-radius:50%;animation:dfs-spin .8s linear infinite}
@keyframes dfs-spin{to{transform:rotate(360deg)}}

/* ---- fallback Menu ---- */
.dfs-menuAnchor{display:inline-flex;position:relative}
.dfs-menuFallback{position:fixed;z-index:1100;min-width:156px;box-sizing:border-box;padding:4px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent);display:flex;flex-direction:column}
.dfs-menuItem{display:flex;align-items:center;gap:5px;width:100%;box-sizing:border-box;min-height:30px;padding:4px 6px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;text-align:left;cursor:pointer}
.dfs-menuItem:disabled{opacity:.4;cursor:not-allowed}
@media (hover:hover){.dfs-menuItem:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover)}}
.dfs-menuItem.is-danger,.dfs-menuItem.is-danger .dfs-menuCheck{color:var(--dsw-alias-state-error-primary)}
.dfs-menuLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfs-menuCheck{flex:none;display:inline-flex;width:14px;justify-content:center;color:var(--dsw-alias-label-primary)}
.dfs-menuIcon{flex:none;display:inline-flex;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-menu-icon,var(--dsw-alias-label-secondary))}
.dfs-menuCaption{padding:4px 7px 2px;font-size:11px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-tertiary)}
.dfs-menuSeparator{height:.5px;margin:3px 8px;background:var(--dsw-alias-border-l2)}

/* ---- fallback HoverCard ---- */
.dfs-hoverAnchor{display:block;position:relative}
.dfs-hoverFallback{position:fixed;z-index:1100;box-sizing:border-box;width:244px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-hovercard-bg);box-shadow:var(--dsw-shadow-lv3);padding:12px 16px;pointer-events:none}

/* ---- fallback Modal ---- */
.dfs-scrim{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent)}
.dfs-dialog{width:min(420px,100%);box-sizing:border-box;display:flex;flex-direction:column;gap:14px;padding:20px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent)}
.dfs-dialogTitle{font-size:16px;line-height:24px;font-weight:600}
.dfs-dialogText{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.dfs-dialogFoot{display:flex;justify-content:flex-end;gap:8px}
.dfs-dialogInput{box-sizing:border-box;width:100%;height:44px;padding:7px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);outline:none;background:transparent;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dfs-dialogInput:focus{border-color:var(--dsw-alias-state-business-primary)}

/* ---- fallback Button ---- */
.dfs-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;box-sizing:border-box;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;height:36px;cursor:pointer}
.dfs-btn.is-sm{height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px}
.dfs-btn.is-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dfs-btn.is-ghost:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
.dfs-btn.is-outline{box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3)}
.dfs-btn:disabled{opacity:.4;cursor:not-allowed}
@media (hover:hover){.dfs-btn.is-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}.dfs-btn.is-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.dfs-dangerText{color:var(--dsw-alias-state-error-primary)}

/* ---- fallback Toast ---- */
.dfs-toastFallback{position:fixed;z-index:1100;top:40px;left:50%;transform:translateX(-50%);box-sizing:border-box;display:flex;align-items:center;gap:10px;max-width:min(640px,100vw - 48px);padding:12px 16px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);box-shadow:var(--dsw-shadow-lv3);font-size:14px;line-height:22px;pointer-events:none}
.dfs-toastAction{margin-inline:3px;padding:0;border:none;background:transparent;color:var(--dsw-alias-toast-action);font:inherit;cursor:pointer;pointer-events:auto}

/* ---- rail (narrow column): shipped 36x36 rail controls ---- */
.dfs-rail{display:flex;flex-direction:column;align-items:center;padding-top:8px}
.dfs-railBtn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border:none;border-radius:var(--dsw-radius-md);padding:0;background:transparent;cursor:pointer;color:var(--dsw-alias-label-primary)}
@media (hover:hover){.dfs-railBtn:hover{background-color:var(--dsw-alias-interactive-bg-hover)}}

/* ---- focus ring: shipped outline-offset -2 ---- */
.dfs-iconBtn:focus-visible,.dfs-rowAction:focus-visible,.dfs-searchButton:focus-visible,.dfs-clearButton:focus-visible,.dfs-railBtn:focus-visible,.dfs-emptyAction:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dfs-row:focus-visible,.dfs-crumb:focus-visible,.dfs-searchRow:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dfs-btn:focus-visible,.dfs-menuItem:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}

/* ---- marquee fallback (host MarqueeText missing) ---- */
.dfs-title{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfs-title.is-marquee{text-overflow:clip}
.dfs-title.is-marquee .dfs-titleText{display:inline-block;white-space:nowrap;animation:dfs-marquee var(--dfs-marquee-duration,4s) ease-in-out infinite alternate}
@keyframes dfs-marquee{0%,10%{transform:translateX(0)}90%,100%{transform:translateX(var(--dfs-marquee-shift,0))}}
@media (prefers-reduced-motion:reduce){.dfs-title.is-marquee .dfs-titleText{animation:none}.dfs-spinnerFallback{animation:none}}

/* ---- component test page (?folder-sidebar=gallery) ---- */
.dfs-gallery{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:100%;box-sizing:border-box;font-size:13px;color:var(--dsw-alias-label-primary)}
.dfs-galleryHead{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dfs-galleryTitle{flex:1;min-width:0;font-size:14px;line-height:20px;font-weight:600}
.dfs-galleryHint{padding:6px 12px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dfs-galleryBody{flex:1;min-height:0;overflow:auto;padding:10px 12px 24px;display:flex;flex-direction:column;gap:12px}
.dfs-gallerySection{display:flex;flex-direction:column;gap:8px}
.dfs-gallerySectionTitle{padding-top:6px;font-size:11px;line-height:16px;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary)}
.dfs-galleryCase{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg)}
.dfs-galleryCaseTitle{display:flex;align-items:baseline;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dfs-galleryAdapter{display:inline-block;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11px;line-height:17px}
.dfs-galleryRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dfs-galleryCode{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11px;line-height:17px;overflow-x:auto;white-space:pre}
`

    // ---------------------------------------------------------------------
    // Host UI kit — the only place that loads the shipped primitives package.
    // Everything below goes through hostComponent()/adapters so a fallback
    // build (package missing, older DSH) still renders the same geometry.
    // ---------------------------------------------------------------------
    let PRIMITIVES = null
    try {
      PRIMITIVES = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      PRIMITIVES = null
    }

    function hostComponent(name) {
      if (PRIMITIVES === null) return null
      const value = PRIMITIVES[name]
      if (typeof value === 'function') return value
      if (value !== null && typeof value === 'object' && value.$$typeof) return value
      return null
    }

    /** The primitives the sidebar actually renders; the gallery reports these. */
    const HOST_KIT_COMPONENTS = [
      'Button', 'Tooltip', 'Menu', 'StateDot', 'HoverCard',
      'MarqueeText', 'useHoverMarquee', 'Toast', 'Modal',
    ]

    function hostKitState() {
      if (PRIMITIVES === null) return { state: 'fallback', missing: HOST_KIT_COMPONENTS.slice() }
      const missing = HOST_KIT_COMPONENTS.filter((name) => hostComponent(name) === null)
      return { state: missing.length === 0 ? 'native' : 'partial', missing }
    }

    /** Local icon name → shipped icon export (icons are primitives too). */
    const HOST_ICON_MAP = {
      folderClose: 'IconFolderCloseRegular',
      folderOpen: 'IconFolderOpenRegular',
      arrow: 'IconTriangleRightFillRegular',
      chevronLeft: 'IconChevronLeftOutlineRegular',
      chevronUp: 'IconChevronUpOutlineRegular',
      chevronDown: 'IconChevronDownOutlineRegular',
      chevrons: 'IconChevronsUpDownOutlineRegular',
      search: 'IconSearchOutlineRegular',
      close: 'IconCloseFillRegular',
      more: 'IconEllipsisOutlineRegular',
      sliders: 'IconSlidersTwoOutlineRegular',
      pin: 'IconPinFillRegular',
      pinOutline: 'IconPinOutlineRegular',
      newChat: 'IconNewChatOutlineRegular',
      projectAdd: 'IconProjectAddOutlineRegular',
      check: 'IconCheckOutlineRegular',
      question: 'IconQuestionOutlineRegular',
      warning: 'IconWarningOutlineRegular',
      clock: 'IconClockOutlineRegular',
      flatList: 'IconFlatListOutlineRegular',
      queue: 'IconQueueOutlineRegular',
      archive: 'IconArchiveOutlineRegular',
      archiveOff: 'IconArchiveOffOutlineRegular',
      archiveCheck: 'IconArchiveCheckOutlineRegular',
      unarchive: 'IconUnarchiveOutlineRegular',
      copy: 'IconCopyOutlineRegular',
      branch: 'IconBranchOutlineRegular',
      trash: 'IconTrashOutlineRegular',
      rename: 'IconListPenOutlineRegular',
    }

    function cls(...values) {
      return values.filter((value) => typeof value === 'string' && value !== '').join(' ')
    }

    // Local SVG copies keep the profile readable when the host kit is absent.
    // All are 16×16, stroke-width 1, currentColor (the shipped Regular grid).
    function iconFrame(children, options) {
      const size = options?.size ?? 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true,
        strokeWidth: 1,
        style: { flex: 'none', color: options?.color ?? 'currentColor' },
      }, children)
    }

    function LocalFolderIcon(options) {
      return iconFrame([
        h('path', {
          key: 'body',
          d: 'M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z',
          stroke: 'currentColor',
        }),
        h('path', { key: 'line', d: 'M3.63501 7.66614H12.3647', stroke: 'currentColor' }),
      ], { size: options?.size })
    }

    function LocalArrowIcon(options) {
      return iconFrame(h('path', {
        d: 'M5.5 4.5C5.5 4.40714 5.52586 4.31612 5.57467 4.23713C5.62349 4.15815 5.69334 4.09431 5.77639 4.05279C5.85945 4.01126 5.95242 3.99368 6.0449 4.00202C6.13738 4.01036 6.22572 4.04429 6.3 4.1L10.967 7.6C11.0291 7.64657 11.0795 7.70697 11.1142 7.77639C11.1489 7.84582 11.167 7.92238 11.167 8C11.167 8.07762 11.1489 8.15418 11.1142 8.22361C11.0795 8.29303 11.0291 8.35343 10.967 8.4L6.3 11.9C6.22572 11.9557 6.13738 11.9896 6.0449 11.998C5.95242 12.0063 5.85945 11.9887 5.77639 11.9472C5.69334 11.9057 5.62349 11.8419 5.57467 11.7629C5.52586 11.6839 5.5 11.5929 5.5 11.5V4.5Z',
        fill: 'currentColor',
      }), { size: options?.size ?? 12 })
    }

    function LocalBackIcon(options) {
      return iconFrame(h('path', {
        d: 'M10 4L6.70711 7.29289C6.31658 7.68342 6.31658 8.31658 6.70711 8.70711L10 12',
        stroke: 'currentColor',
      }), { size: options?.size ?? 14 })
    }

    function LocalDotsIcon(options) {
      return iconFrame([
        h('path', { key: 'a', d: 'M3 9C3.55228 9 4 8.55228 4 8C4 7.44772 3.55228 7 3 7C2.44772 7 2 7.44772 2 8C2 8.55228 2.44772 9 3 9Z', fill: 'currentColor' }),
        h('path', { key: 'b', d: 'M8 9C8.55228 9 9 8.55228 9 8C9 7.44772 8.55228 7 8 7C7.44772 7 7 7.44772 7 8C7 8.55228 7.44772 9 8 9Z', fill: 'currentColor' }),
        h('path', { key: 'c', d: 'M13 9C13.5523 9 14 8.55228 14 8C14 7.44772 13.5523 7 13 7C12.4477 7 12 7.44772 12 8C12 8.55228 12.4477 9 13 9Z', fill: 'currentColor' }),
      ], { size: options?.size })
    }

    function LocalSearchIcon(options) {
      return iconFrame([
        h('path', {
          key: 'lens',
          d: 'M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z',
          stroke: 'currentColor',
        }),
        h('path', { key: 'handle', d: 'M10.2991 10.3933L14.7783 14.8725', stroke: 'currentColor' }),
      ], { size: options?.size })
    }

    function LocalSlidersIcon(options) {
      return iconFrame([
        h('path', { key: 'l1', d: 'M2.3 5h5.85M12.05 5h1.65', stroke: 'currentColor' }),
        h('circle', { key: 'c1', cx: 9.95, cy: 5, r: 1.45, stroke: 'currentColor' }),
        h('path', { key: 'l2', d: 'M2.3 11h1.65M7.85 11h5.85', stroke: 'currentColor' }),
        h('circle', { key: 'c2', cx: 5.75, cy: 11, r: 1.45, stroke: 'currentColor' }),
      ], { size: options?.size })
    }

    function LocalPinIcon(options) {
      return iconFrame([
        h('path', {
          key: 'body',
          d: 'M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z',
          fill: 'currentColor', stroke: 'currentColor', strokeLinejoin: 'round',
        }),
        h('path', {
          key: 'needle',
          d: 'M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708L3.21223 13.9291L6.05285 9.47511Z',
          fill: 'currentColor',
        }),
      ], { size: options?.size ?? 14 })
    }

    function LocalCloseIcon(options) {
      return iconFrame([
        h('path', { key: 'a', d: 'M3.5 3.5L12.5 12.5', stroke: 'currentColor' }),
        h('path', { key: 'b', d: 'M12.5 3.5L3.5 12.5', stroke: 'currentColor' }),
      ], { size: options?.size ?? 14 })
    }

    function LocalNewChatIcon(options) {
      return iconFrame([
        h('path', {
          key: 'bubble',
          d: 'M2.37091 11.2501C1.58745 9.89288 1.32067 8.29835 1.61969 6.76006C1.91872 5.22177 2.76342 3.8433 3.99826 2.87846C5.2331 1.91362 6.77494 1.42737 8.33988 1.50925C9.90482 1.59113 11.3875 2.23562 12.5149 3.32406C13.6425 4.41269 14.3387 5.87206 14.4754 7.4334C14.612 8.99474 14.18 10.5529 13.2587 11.8209C12.3375 13.0888 10.9891 13.9813 9.46194 14.3337C8.18691 14.628 6.85895 14.5294 5.64989 14.0605C5.1712 13.8748 4.76962 13.4932 4.26534 13.3967C3.67413 13.2835 2.95257 13.5598 2.03794 14.3337',
          stroke: 'currentColor',
        }),
        h('path', { key: 'v', d: 'M8 5V11', stroke: 'currentColor' }),
        h('path', { key: 'h', d: 'M5 8H11', stroke: 'currentColor' }),
      ], { size: options?.size })
    }

    function LocalProjectAddIcon(options) {
      return iconFrame([
        h('path', {
          key: 'body',
          d: 'M5.54492 2.06738C5.91034 2.06754 6.26318 2.20149 6.53711 2.44336L7.94043 3.68164V4.7998C7.71462 4.74105 7.50367 4.63139 7.32617 4.47461L5.87598 3.19238C5.78477 3.11185 5.66658 3.06754 5.54492 3.06738H2.94922C2.67322 3.06738 2.44946 3.29145 2.44922 3.56738V12.4326C2.44927 12.7087 2.67311 12.9326 2.94922 12.9326H12.9326C13.2086 12.9325 13.4326 12.7086 13.4326 12.4326V8.53613H14.4326V12.4326C14.4326 13.2609 13.7609 13.9325 12.9326 13.9326H2.94922C2.12083 13.9326 1.44927 13.261 1.44922 12.4326V3.56738C1.44946 2.73916 2.12094 2.06738 2.94922 2.06738H5.54492Z',
          fill: 'currentColor',
        }),
        h('path', { key: 'h', d: 'M9.75977 4.50208H14.5509', stroke: 'currentColor' }),
        h('path', { key: 'v', d: 'M12.1492 6.89758L12.1492 2.10642', stroke: 'currentColor' }),
      ], { size: options?.size })
    }

    function LocalCheckIcon(options) {
      return iconFrame(h('path', {
        d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4',
        stroke: 'currentColor',
      }), { size: options?.size ?? 14 })
    }

    function LocalQuestionIcon(options) {
      return iconFrame([
        h('path', {
          key: 'circle',
          d: 'M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z',
          stroke: 'currentColor',
        }),
        h('path', {
          key: 'curve',
          d: 'M5.75 6.69646C5.75 6.29865 5.88196 5.90976 6.12919 5.57899C6.37643 5.24821 6.72783 4.99041 7.13896 4.83817C7.5501 4.68593 8.0025 4.6461 8.43895 4.72371C8.87541 4.80132 9.27632 4.99289 9.59099 5.27419C9.90566 5.55549 10.12 5.91388 10.2068 6.30406C10.2936 6.69423 10.249 7.09866 10.0787 7.4662C9.90843 7.83373 9.62004 8.14787 9.25003 8.36889C9.19476 8.4019 9.13803 8.43262 9.08004 8.46099C8.52566 8.73217 8 9.20817 8 9.82532',
          stroke: 'currentColor',
        }),
        h('path', { key: 'dot', d: 'M8 10.7416V11.7416', stroke: 'currentColor' }),
      ], { size: options?.size ?? 14 })
    }

    function LocalWarningIcon(options) {
      return iconFrame([
        h('path', {
          key: 'circle',
          d: 'M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z',
          stroke: 'currentColor',
        }),
        h('path', { key: 'bar', d: 'M8 4.29199V9.79199', stroke: 'currentColor' }),
        h('path', { key: 'dot', d: 'M8 10.708V11.708', stroke: 'currentColor' }),
      ], { size: options?.size ?? 14 })
    }

    const LOCAL_ICONS = {
      folderClose: LocalFolderIcon,
      arrow: LocalArrowIcon,
      chevronLeft: LocalBackIcon,
      more: LocalDotsIcon,
      search: LocalSearchIcon,
      sliders: LocalSlidersIcon,
      pin: LocalPinIcon,
      pinOutline: LocalPinIcon,
      close: LocalCloseIcon,
      newChat: LocalNewChatIcon,
      projectAdd: LocalProjectAddIcon,
      check: LocalCheckIcon,
      question: LocalQuestionIcon,
      warning: LocalWarningIcon,
    }

    /** Shipped icon when the kit exposes it, otherwise the local copy (or null). */
    function icon(name, size) {
      const HostIcon = hostComponent(HOST_ICON_MAP[name] ?? '')
      if (HostIcon !== null) return h(HostIcon, size === undefined ? {} : { size })
      const Local = LOCAL_ICONS[name]
      if (Local === undefined) return null
      return h(Local, { size })
    }

    /** Our indicator kinds → the shipped StateDot state names. */
    function dotState(kind) {
      if (kind === 'waiting') return 'warning'
      if (kind === 'running') return 'ongoing'
      if (kind === 'error') return 'error'
      if (kind === 'completed') return 'done'
      if (kind === 'stopped') return 'stopped'
      return 'idle'
    }

    // ---------------------------------------------------------------------
    // Adapters: one call style for business code, host or fallback underneath.
    // ---------------------------------------------------------------------
    function IconButton(props) {
      const HostTooltip = hostComponent('Tooltip')
      const tooltip = props.tooltip !== false
        && HostTooltip !== null
        && typeof props.title === 'string'
        && props.title !== ''
      const attributes = {
        type: 'button',
        className: cls('dfs-iconBtn', props.className),
        'aria-label': props.title,
        'aria-haspopup': props.haspopup,
        'aria-expanded': props.expanded === undefined ? undefined : (props.expanded === true ? 'true' : 'false'),
        disabled: props.disabled === true,
        onClick: props.onClick,
        onPointerDown: props.onPointerDown,
        onContextMenu: props.onContextMenu,
        title: tooltip ? undefined : props.title,
      }
      const node = h('button', attributes, icon(props.icon, props.size ?? 16))
      if (!tooltip) return node
      return h(HostTooltip, {
        label: props.title,
        side: props.side ?? 'bottom',
        align: props.align ?? 'center',
        delayMs: 500,
        disabled: props.expanded === true,
        portal: true,
      }, node)
    }

    /** Shipped Button (variant/size), fallback keeps the same geometry. */
    function Button(props) {
      const HostButton = hostComponent('Button')
      const variant = props.variant === 'primary' ? 'primary' : props.variant === 'ghost' ? 'ghost' : 'outline'
      const size = props.size === 'sm' ? 'sm' : 'md'
      if (HostButton !== null) {
        return h(HostButton, {
          variant,
          size,
          className: props.className,
          disabled: props.disabled === true,
          onClick: props.onClick,
          type: 'button',
        }, props.children)
      }
      return h('button', {
        type: 'button',
        className: cls('dfs-btn', 'is-' + variant, size === 'sm' && 'is-sm', props.className),
        disabled: props.disabled === true,
        onClick: props.onClick,
      }, props.children)
    }

    /** Shipped StateDot; `stopped` is our hollow dot (host has no such state). */
    function KitStateDot(props) {
      const state = props.state === undefined ? 'idle' : props.state
      const style = props.size === undefined ? undefined : { width: props.size, height: props.size }
      if (state === 'stopped') {
        return h('span', { className: cls('dfs-stopDot', props.className), style, 'aria-hidden': 'true' })
      }
      const HostDot = hostComponent('StateDot')
      if (HostDot !== null) {
        if (props.size === undefined) return h(HostDot, { state, className: props.className })
        return h(HostDot, { state, size: props.size, className: props.className })
      }
      if (state === 'ongoing') {
        return h('span', { className: cls('dfs-spinnerFallback', props.className), style, 'aria-hidden': 'true' })
      }
      return h('span', { className: cls('dfs-dotFallback', 'is-' + state, props.className), style, 'aria-hidden': 'true' })
    }

    function menuEntries(items, selectedIds, onSelect, onClose) {
      const selected = Array.isArray(selectedIds) ? selectedIds : (typeof selectedIds === 'string' ? [selectedIds] : [])
      return h('div', { className: 'dfs-menuFallback', role: 'menu' },
        (Array.isArray(items) ? items : []).map((item) => {
          if (item.type === 'separator') return h('div', { key: item.id, className: 'dfs-menuSeparator', role: 'separator' })
          if (item.type === 'label') return h('div', { key: item.id, className: 'dfs-menuCaption' }, item.text)
          const active = selected.includes(item.id)
          return h('button', {
            key: item.id,
            type: 'button',
            role: 'menuitem',
            className: cls('dfs-menuItem', item.danger === true && 'is-danger'),
            disabled: item.disabled === true,
            onClick: () => { if (typeof onClose === 'function') onClose(); if (typeof onSelect === 'function') onSelect(item.id) },
          },
            h('span', { className: 'dfs-menuCheck' }, active ? icon('check', 14) : null),
            item.icon === undefined || item.icon === null ? null : h('span', { className: 'dfs-menuIcon' }, item.icon),
            h('span', { className: 'dfs-menuLabel' }, item.label))
        }))
    }

    /** Host Menu (portal, anchored points, keyboard); local fallback otherwise. */
    function KitMenu(props) {
      const HostMenu = hostComponent('Menu')
      if (HostMenu !== null) {
        return h(HostMenu, {
          open: props.open === true,
          anchor: props.anchor ?? null,
          anchorPoint: props.anchorPoint,
          items: Array.isArray(props.items) ? props.items : [],
          selectedId: props.selectedId,
          selectedIds: props.selectedIds,
          onSelect: props.onSelect,
          onClose: props.onClose,
          side: props.side ?? 'bottom',
          align: props.align ?? 'start',
          portal: true,
          dense: props.dense === true,
          contextual: props.contextual === true,
          autoFocus: props.contextual === true,
          listClassName: props.listClassName,
          onKeyDown: props.onKeyDown,
        })
      }
      return h(FallbackMenu, props)
    }

    function FallbackMenu(props) {
      const anchorRef = React.useRef(null)
      const [point, setPoint] = React.useState(null)
      React.useEffect(() => {
        if (props.open !== true) { setPoint(null); return undefined }
        if (props.anchorPoint !== undefined) { setPoint(props.anchorPoint); return undefined }
        const node = anchorRef.current
        const rect = node === null ? null : node.getBoundingClientRect()
        if (rect === null) return undefined
        const width = 156
        setPoint({ x: props.align === 'end' ? rect.right - width : rect.left, y: rect.bottom + 4 })
        return undefined
      }, [props.open, props.anchorPoint, props.align])
      React.useEffect(() => {
        if (props.open !== true) return undefined
        const onDown = (event) => {
          const node = anchorRef.current
          if (node !== null && node.contains(event.target)) return
          if (typeof props.onClose === 'function') props.onClose()
        }
        const onKey = (event) => { if (event.key === 'Escape') props.onClose() }
        document.addEventListener('pointerdown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [props.open, props.onClose])
      return h('span', { ref: anchorRef, className: 'dfs-menuAnchor' },
        props.anchor ?? null,
        props.open === true && point !== null
          ? h('div', { style: { position: 'fixed', left: point.x, top: point.y } }, menuEntries(props.items, props.selectedIds, props.onSelect, props.onClose))
          : null)
    }

    /** Host HoverCard (delay, grouping, portal); fallback card otherwise. */
    function KitHoverCard(props) {
      const HostCard = hostComponent('HoverCard')
      if (HostCard !== null) {
        return h(HostCard, {
          anchor: props.anchor,
          content: props.content,
          openDelayMs: props.openDelayMs ?? 800,
          disabled: props.disabled === true,
          grouped: true,
        })
      }
      return h(FallbackHoverCard, props)
    }

    function FallbackHoverCard(props) {
      const [open, setOpen] = React.useState(false)
      const [point, setPoint] = React.useState(null)
      const timer = React.useRef(undefined)
      React.useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current) }, [])
      const show = (event) => {
        if (props.disabled === true) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (timer.current !== undefined) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          timer.current = undefined
          const width = 244
          const viewportW = typeof window === 'undefined' ? 1280 : window.innerWidth
          const viewportH = typeof window === 'undefined' ? 800 : window.innerHeight
          setPoint({ left: Math.max(8, Math.min(rect.left + 8, viewportW - width - 8)), top: Math.max(8, Math.min(rect.bottom + 6, viewportH - 160)) })
          setOpen(true)
        }, props.openDelayMs ?? 800)
      }
      const hide = () => {
        if (timer.current !== undefined) { clearTimeout(timer.current); timer.current = undefined }
        setOpen(false)
      }
      return h('div', { className: 'dfs-hoverAnchor', onPointerEnter: show, onPointerLeave: hide },
        props.anchor,
        open && point !== null ? h('div', { className: 'dfs-hoverFallback', role: 'tooltip', style: { left: point.left, top: point.top } }, props.content) : null)
    }

    /** Host Modal (focus, Escape, portal); fallback dialog otherwise. */
    function KitModal(props) {
      const HostModal = hostComponent('Modal')
      if (HostModal !== null) {
        return h(HostModal, {
          open: props.open !== false,
          onClose: props.onClose,
          title: props.title,
          closeLabel: props.closeLabel,
          description: props.description,
          footer: props.footer,
          className: props.className,
          children: props.children,
        })
      }
      return h(FallbackModal, props)
    }

    function FallbackModal(props) {
      React.useEffect(() => {
        if (props.open === false) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          props.onClose()
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [props.open, props.onClose])
      if (props.open === false) return null
      return h('div', { className: 'dfs-scrim', onPointerDown: (event) => { if (event.target === event.currentTarget) props.onClose() } },
        h('div', { className: 'dfs-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title || '' },
          h('div', { className: 'dfs-dialogTitle' }, props.title || ''),
          props.description === undefined ? null : h('p', { className: 'dfs-dialogText' }, props.description),
          props.children,
          props.footer === undefined ? null : h('div', { className: 'dfs-dialogFoot' }, props.footer)))
    }

    /** Host Toast (self-dismissing); fallback bar with the same timer. */
    function KitToast(props) {
      const HostToast = hostComponent('Toast')
      if (HostToast !== null) {
        return h(HostToast, {
          text: props.text,
          tone: props.tone,
          actions: props.actions,
          holdMs: props.holdMs,
          onDone: props.onDone,
        })
      }
      return h(FallbackToast, props)
    }

    function FallbackToast(props) {
      const onDone = React.useRef(props.onDone)
      onDone.current = props.onDone
      React.useEffect(() => {
        const hold = props.holdMs ?? 3000
        const timer = setTimeout(() => { if (typeof onDone.current === 'function') onDone.current() }, hold + 1000)
        return () => clearTimeout(timer)
      }, [props.holdMs])
      return h('div', { className: 'dfs-toastFallback', role: 'alert' },
        h('span', null, props.text),
        (Array.isArray(props.actions) ? props.actions : []).map((action) => h('button', {
          key: action.label,
          type: 'button',
          className: 'dfs-toastAction',
          onClick: action.onClick,
        }, action.label)))
    }

    // A clipped title marquees on hover. The shipped MarqueeText +
    // useHoverMarquee are used when both exist; the fallback keeps the plugin's
    // own marquee math (pure functions above, covered by test/logic.test.mjs).
    const HOST_MARQUEE_TEXT = hostComponent('MarqueeText')
    const HOST_HOVER_MARQUEE = hostComponent('useHoverMarquee')

    function HostTitle(props) {
      const ref = React.useRef(null)
      const marquee = HOST_HOVER_MARQUEE(ref)
      return h(HOST_MARQUEE_TEXT, {
        ref,
        className: cls('dfs-title', props.className),
        onPointerEnter: marquee.onPointerEnter,
        onPointerLeave: marquee.onPointerLeave,
      }, props.text)
    }

    function FallbackTitle(props) {
      const ref = React.useRef(null)
      const show = (event) => {
        const node = ref.current
        const box = node === null ? null : node.parentElement
        if (node === null || box === null) return
        const shift = marqueeShiftOf(node.scrollWidth, box.clientWidth)
        if (shift === 0) return
        box.style.setProperty('--dfs-marquee-shift', '-' + String(shift) + 'px')
        box.style.setProperty('--dfs-marquee-duration', String(marqueeDurationOf(shift)) + 'ms')
        box.classList.add('is-marquee')
      }
      const hide = () => {
        const box = ref.current === null ? null : ref.current.parentElement
        if (box === null) return
        box.classList.remove('is-marquee')
        box.style.removeProperty('--dfs-marquee-shift')
        box.style.removeProperty('--dfs-marquee-duration')
      }
      return h('span', {
        className: cls('dfs-title', props.className),
        title: props.text,
        onPointerEnter: show,
        onPointerLeave: hide,
        onPointerCancel: hide,
      }, h('span', { ref, className: 'dfs-titleText' }, props.text))
    }

    const Title = HOST_MARQUEE_TEXT !== null && HOST_HOVER_MARQUEE !== null ? HostTitle : FallbackTitle

    function galleryRequested() {
      if (typeof window === 'undefined' || typeof window.location === 'undefined') return false
      const search = String(window.location.search || '')
      const hash = String(window.location.hash || '')
      const marker = 'folder-sidebar=gallery'
      return search.indexOf(marker) !== -1 || hash.indexOf(marker) !== -1
    }

    /**
     * One documented control: adapter name, live control, copyable call.
     * The component test page is the single standard — business code only uses
     * calls that appear here.
     */
    function GalleryCase(props) {
      return h('div', { className: 'dfs-galleryCase' },
        h('div', { className: 'dfs-galleryCaseTitle' },
          h('span', null, props.title),
          props.adapter === undefined ? null : h('span', { className: 'dfs-galleryAdapter' }, props.adapter)),
        h('div', { className: 'dfs-galleryRow' }, props.children),
        props.code === undefined ? null : h('pre', { className: 'dfs-galleryCode' }, h('code', null, props.code)))
    }

    function GalleryPage(props) {
      const t = props.t
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [modalOpen, setModalOpen] = React.useState(false)
      const [draft, setDraft] = React.useState('dsh-folder-sidebar')
      const [toast, setToast] = React.useState(null)
      const hostKit = hostKitState()
      const hostLabel = hostKit.state === 'native'
        ? t('gallery.native')
        : hostKit.state === 'partial' ? t('gallery.partial') : t('gallery.fallback')
      const menuItems = [
        { id: 'pin', label: t('action.pin'), icon: icon('pinOutline', 14) },
        { id: 'rename', label: t('action.rename'), icon: icon('rename', 14) },
        { id: 'sep', type: 'separator' },
        { id: 'archive', label: t('action.archive'), danger: true, icon: icon('archive', 14) },
      ]
      const section = (title, cases) => h('div', { className: 'dfs-gallerySection' },
        h('div', { className: 'dfs-gallerySectionTitle' }, title),
        cases)
      const dotStates = ['ongoing', 'warning', 'done', 'error', 'idle', 'stopped']
      return h('div', { className: 'dfs-gallery' },
        h('div', { className: 'dfs-galleryHead' },
          h(IconButton, { icon: 'chevronLeft', title: t('gallery.close'), onClick: props.onClose }),
          h('div', { className: 'dfs-galleryTitle' }, t('gallery.title'))),
        h('div', { className: 'dfs-galleryHint' }, t('gallery.hint')),
        h('div', { className: 'dfs-galleryHint' }, t('gallery.hostKit') + ': ' + hostLabel),
        h('div', { className: 'dfs-galleryBody' },
          section(t('gallery.secControls'), [
            h(GalleryCase, { key: 'icon', title: t('gallery.caseIconButton'), adapter: 'IconButton', code: "h(IconButton, { icon, title, onClick })" },
              h(IconButton, { icon: 'more', title: t('action.menu'), onClick: () => {} }),
              h(IconButton, { icon: 'search', title: t('action.search'), onClick: () => {} }),
              h(IconButton, { icon: 'close', title: t('action.close'), disabled: true, onClick: () => {} })),
            h(GalleryCase, { key: 'button', title: t('gallery.caseButton'), adapter: 'Button', code: "h(Button, { variant, onClick }, label)" },
              h(Button, { variant: 'outline', onClick: () => {} }, t('dialog.cancel')),
              h(Button, { variant: 'primary', onClick: () => {} }, t('dialog.save')),
              h(Button, { variant: 'primary', disabled: true, onClick: () => {} }, t('dialog.save'))),
            h(GalleryCase, { key: 'dot', title: t('gallery.caseStateDot'), adapter: 'KitStateDot', code: "h(KitStateDot, { state })" },
              dotStates.map((state) => h('span', { key: state, style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } },
                h(KitStateDot, { state }),
                h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' } }, state)))),
            h(GalleryCase, { key: 'title', title: t('gallery.caseTitle'), adapter: 'Title', code: "h(Title, { className, text })" },
              h('span', { style: { display: 'block', width: '100%', maxWidth: '220px', fontSize: '14px' } },
                h(Title, { className: 'dfs-rowTitle', text: t('gallery.longTitle') }))),
          ]),
          section(t('gallery.secRows'), [
            h(GalleryCase, { key: 'folder', title: t('gallery.caseFolderRow'), adapter: 'dfs-projectRow', code: 'h(Title, { text })  // 行样式照搬 Rows.module.css' },
              h('div', { className: 'dfs-row dfs-projectRow', style: { width: '100%' } },
                h('span', { className: 'dfs-folderSlot is-completed' },
                  h('span', { className: 'dfs-folderGlyph' }, icon('folderClose', 16)),
                  h('span', { className: 'dfs-enterGlyph' }, icon('arrow', 12))),
                h(Title, { className: 'dfs-rowTitle', text: props.sampleFolder }),
                h('span', { className: 'dfs-rowActions' },
                  h('button', { type: 'button', className: 'dfs-rowAction', 'aria-label': t('action.menu') }, icon('more', 14))))),
            h(GalleryCase, { key: 'session', title: t('gallery.caseSessionRow'), adapter: 'dfs-sessionRow', code: 'h(KitStateDot, { state }) + h(Title, { text })' },
              h('div', { className: 'dfs-row dfs-sessionRow is-current', style: { width: '100%' } },
                h('span', { className: 'dfs-slot' }, h(KitStateDot, { state: 'done' })),
                h(Title, { className: 'dfs-rowTitle', text: props.sampleSession }),
                h('span', { className: 'dfs-rowResting' },
                  h('span', { className: 'dfs-time' }, '5m'),
                  h('span', { className: 'dfs-pin' }, icon('pin', 14))),
                h('span', { className: 'dfs-rowActions' },
                  h('button', { type: 'button', className: 'dfs-rowAction', 'aria-label': t('action.menu') }, icon('more', 14))))),
            h(GalleryCase, { key: 'search', title: t('gallery.caseSearchRow'), adapter: 'dfs-searchRow', code: 'h(Title, { text }) + meta' },
              h('div', { className: 'dfs-searchRow', style: { width: '100%' } },
                h('span', { className: 'dfs-searchHeading' },
                  h('span', { className: 'dfs-slot' }, h(KitStateDot, { state: 'warning' })),
                  h('span', { className: 'dfs-searchTitle' }, h(Title, { className: 'dfs-rowTitle', text: props.sampleSession }))),
                h('span', { className: 'dfs-searchMeta' },
                  h('span', { className: 'dfs-searchWorkspace' }, props.sampleFolder),
                  h('span', { className: 'dfs-searchSnippet' }, t('search.content') + ': …')))),
          ]),
          section(t('gallery.secOverlays'), [
            h(GalleryCase, { key: 'menu', title: t('gallery.caseMenu'), adapter: 'KitMenu', code: "h(KitMenu, { open, anchor, items, selectedIds, onSelect, onClose })" },
              h(KitMenu, {
                open: menuOpen,
                anchor: h(Button, { size: 'sm', onClick: () => setMenuOpen((value) => !value) }, t('gallery.caseMenu')),
                items: menuItems,
                selectedIds: ['pin'],
                onSelect: (id) => { setMenuOpen(false); setToast({ id: Date.now(), text: id }) },
                onClose: () => setMenuOpen(false),
                align: 'end',
                dense: true,
                portal: true,
              })),
            h(GalleryCase, { key: 'hover', title: t('gallery.caseHover'), adapter: 'KitHoverCard', code: "h(KitHoverCard, { anchor, content, openDelayMs })" },
              h(KitHoverCard, {
                anchor: h(Button, { size: 'sm', variant: 'ghost' }, t('gallery.hoverAnchor')),
                content: h('div', { className: 'dfs-hoverContent' },
                  h('div', { className: 'dfs-hoverTitle' }, props.sampleSession),
                  h('div', { className: 'dfs-hoverTime' }, '5m'),
                  h('div', { className: 'dfs-hoverStatus' }, h(KitStateDot, { state: 'done' }), h('span', null, t('status.completed')))),
                openDelayMs: 400,
              })),
            h(GalleryCase, { key: 'toast', title: t('gallery.caseToast'), adapter: 'KitToast', code: "h(KitToast, { text, actions, holdMs, onDone })" },
              h(Button, { size: 'sm', variant: 'ghost', onClick: () => setToast({ id: Date.now(), text: t('notice.archived'), action: { label: t('action.undo'), onClick: () => setToast(null) } }) }, t('gallery.caseToast'))),
            h(GalleryCase, { key: 'modal', title: t('gallery.caseModal'), adapter: 'KitModal', code: "h(KitModal, { open, title, onClose, footer })" },
              h(Button, { size: 'sm', variant: 'ghost', onClick: () => setModalOpen(true) }, t('gallery.caseModal'))),
          ])),
        toast === null ? null : h(KitToast, {
          key: toast.id,
          text: toast.text,
          holdMs: 3000,
          actions: toast.action === undefined ? undefined : [toast.action],
          onDone: () => setToast(null),
        }),
        modalOpen ? h(KitModal, {
          open: true,
          title: t('dialog.renameWorkspace'),
          closeLabel: t('dialog.cancel'),
          onClose: () => setModalOpen(false),
          footer: [
            h(Button, { key: 'cancel', variant: 'ghost', onClick: () => setModalOpen(false) }, t('dialog.cancel')),
            h(Button, { key: 'save', variant: 'primary', onClick: () => setModalOpen(false) }, t('dialog.save')),
          ],
        }, h('input', { className: 'dfs-dialogInput', value: draft, onChange: (event) => setDraft(event.target.value) })) : null)
    }

    class RenderBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { message: null }
      }

      static getDerivedStateFromError(error) {
        return { message: error instanceof Error ? error.message : String(error) }
      }

      componentDidCatch(error) {
        console.error('[folder-sidebar] render failed', error)
      }

      render() {
        if (this.state.message !== null) {
          return h('div', { className: 'dfs-empty', style: { color: 'var(--dsw-alias-state-error-primary)' } },
            'folder-sidebar: ', this.state.message)
        }
        return this.props.children
      }
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace', 'workspaces', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTS))
        const t = ctx.locale.bind(NS)
        const gallerySampleFolder = 'dsh-folder-sidebar'
        const gallerySampleSession = t('gallery.sampleSession')

        /**
         * The slot can render us while the Host is reconnecting, and for a few
         * frames `useWorkspaces` / `useSessions` / `useSessionStatus` are not
         * passed. Calling them conditionally changes the hook count between
         * renders, which React reports as error #300, so this outer component
         * calls no hooks at all and only mounts the connected body once all
         * three exist.
         */
        function FolderSidebar(props) {
          if (galleryRequested()) {
            return h('div', { className: 'dfs-root', 'data-dfs-gallery': '1' }, h('style', null, CSS), h(GalleryPage, {
              t,
              sampleFolder: gallerySampleFolder,
              sampleSession: gallerySampleSession,
              onClose: () => {
                if (typeof window === 'undefined' || window.location === undefined) return
                const url = new URL(window.location.href)
                url.searchParams.delete('folder-sidebar')
                if (url.hash.indexOf('folder-sidebar=gallery') !== -1) url.hash = ''
                window.location.href = url.toString()
              },
            }))
          }
          const hooksReady = typeof props.useWorkspaces === 'function'
            && typeof props.useSessions === 'function'
            && typeof props.useSessionStatus === 'function'
          if (!hooksReady) {
            return h('div', { className: 'dfs-root', 'aria-busy': 'true' })
          }
          return h(FolderSidebarConnected, props)
        }

        function FolderSidebarConnected(props) {
          const wide = props.wide !== false
          const expandSidebar = props.expandSidebar
          const useWorkspaces = props.useWorkspaces
          const useSessions = props.useSessions
          const useSessionStatus = props.useSessionStatus

          const [openId, setOpenId] = React.useState(null)
          const [query, setQuery] = React.useState('')
          const [menu, setMenu] = React.useState(null)
          const [rename, setRename] = React.useState(null)
          const [confirm, setConfirm] = React.useState(null)
          const [archivedFilter, setArchivedFilter] = React.useState(() => readArchivedFilter())
          const [seenTurns, setSeenTurns] = React.useState(() => readSeenTurns())
          const [notice, setNotice] = React.useState(null)
          const [contentHits, setContentHits] = React.useState([])
          const [searching, setSearching] = React.useState(false)
          const [searchOpen, setSearchOpen] = React.useState(false)
          const [dragId, setDragId] = React.useState(null)
          const [dropEdge, setDropEdge] = React.useState(null)
          const [sortState, setSortState] = React.useState(() => readSortState())
          const searchInput = React.useRef(null)
          const searchRoot = React.useRef(null)
          const folderSort = sortState.folders
          const sessionSort = sortState.sessions

          const workspaceItems = useWorkspaces((state) => state.items)
          const archivedIds = useWorkspaces((state) => state.archivedSessionIds)
          const pinnedIds = useWorkspaces((state) => state.pinnedSessionIds)
          const list = useSessions((state) => state)
          const projections = useSessions((state) => state.projectionsBySession)
          const statusMap = useSessionStatus((state) => state)

          const workspaces = Array.isArray(workspaceItems) ? workspaceItems : []
          const archived = React.useMemo(() => new Set(archivedIds ?? []), [archivedIds])
          const pinned = React.useMemo(() => new Set(pinnedIds ?? []), [pinnedIds])

          const statusOf = React.useCallback((sessionId) => {
            if (statusMap === undefined || statusMap === null) return undefined
            return typeof statusMap.get === 'function' ? statusMap.get(sessionId) : undefined
          }, [statusMap])

          const projectionOf = React.useCallback((sessionId) => {
            if (projections === undefined || projections === null) return undefined
            const cell = projections[sessionId]
            const values = cell === undefined || cell === null ? undefined : cell.values
            return values === undefined || values === null ? undefined : values[TURN_KEY]
          }, [projections])

          const byId = list === undefined || list === null ? undefined : list.byId

          const currentId = React.useMemo(() => {
            if (byId === undefined || byId === null) return undefined
            for (const id of Object.keys(byId)) {
              const summary = byId[id]
              if (summary !== null && typeof summary === 'object' && (summary.retainedBy?.mainView ?? 0) > 0) return id
            }
            return undefined
          }, [byId])

          /**
           * Reading a failed/interrupted Session clears its red cell, matching
           * the completion-unread rule: once it is the main view it has been
           * seen. The read turn is stored, so the next failure lights up again.
           */
          React.useEffect(() => {
            if (currentId === undefined) return
            const projection = projectionOf(currentId)
            if (projection === undefined || projection === null) return
            if (projection.state !== 'failed' && projection.state !== 'interrupted') return
            const turn = typeof projection.turn === 'number' ? projection.turn : 0
            setSeenTurns((previous) => {
              const next = markTurnSeen(previous, currentId, turn)
              if (next === previous) return previous
              writeSeenTurns(next)
              return next
            })
          }, [currentId, projectionOf])

          const currentWorkspaceId = React.useMemo(() => {
            if (currentId === undefined) return undefined
            for (const workspace of workspaces) {
              if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(currentId)) return workspace.workspaceId
            }
            return undefined
          }, [workspaces, currentId])

          React.useEffect(() => {
            if (currentWorkspaceId === undefined) return
            setOpenId((previous) => (previous === null ? currentWorkspaceId : previous))
          }, [currentWorkspaceId])

          /** One transient toast; an optional action keeps "撤销" reachable. */
          const notify = (message, action) => setNotice({ id: Date.now(), message, action: action ?? null })

          // Host content search, debounced; titles stay local and instant.
          React.useEffect(() => {
            const text = query.trim()
            if (text === '' || typeof ctx.sessions?.search !== 'function') {
              setContentHits([])
              setSearching(false)
              return undefined
            }
            const controller = new AbortController()
            setSearching(true)
            const timer = setTimeout(() => {
              Promise.resolve(ctx.sessions.search(text, controller.signal))
                .then((result) => {
                  if (controller.signal.aborted) return
                  const items = result?.ok === true && Array.isArray(result.value?.items) ? result.value.items : []
                  setContentHits(items)
                  setSearching(false)
                })
                .catch(() => { if (!controller.signal.aborted) { setContentHits([]); setSearching(false) } })
            }, 250)
            return () => {
              clearTimeout(timer)
              controller.abort()
              setSearching(false)
            }
          }, [query])

          React.useEffect(() => {
            if (!searchOpen) return undefined
            const node = searchInput.current
            if (node !== null && typeof node.focus === 'function') node.focus()
            return undefined
          }, [searchOpen])

          // Shipped behavior: clicking outside an empty expanded search closes it.
          React.useEffect(() => {
            if (!searchOpen) return undefined
            const onClick = (event) => {
              const node = searchRoot.current
              if (node !== null && node.contains(event.target)) return
              if (query.trim() !== '') return
              setSearchOpen(false)
            }
            document.addEventListener('click', onClick)
            return () => document.removeEventListener('click', onClick)
          }, [searchOpen, query])

          // A context menu is positioned from the pointer, so scrolling dismisses it.
          React.useEffect(() => {
            if (menu === null || menu.point === undefined) return undefined
            const onScroll = () => setMenu(null)
            document.addEventListener('scroll', onScroll, true)
            return () => document.removeEventListener('scroll', onScroll, true)
          }, [menu])

          /** Sessions that belong to no Workspace (shipped "Ungrouped" bucket). */
          const ungroupedWorkspace = React.useMemo(() => {
            const ids = list === undefined || list === null || !Array.isArray(list.ids) ? [] : list.ids
            const accounted = new Set()
            for (const workspace of workspaces) {
              for (const id of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) accounted.add(id)
            }
            const members = []
            for (const id of ids) {
              const summary = byId === undefined || byId === null ? undefined : byId[id]
              if (summary === null || typeof summary !== 'object') continue
              if (accounted.has(id)) continue
              if (summary.origin === 'subagent') continue
              members.push(summary)
            }
            return { workspaceId: UNGROUPED, path: '', title: t('group.ungrouped'), sessionIds: members.map((summary) => summary.id) }
          }, [list, byId, workspaces, t])

          /**
           * Rows per Workspace, derived once per render instead of once per
           * caller: the list, its status cell and the hover card all read it.
           */
          const rowsIndex = React.useMemo(() => {
            const collect = (ids) => {
              const rows = []
              for (const id of Array.isArray(ids) ? ids : []) {
                const summary = byId === undefined || byId === null ? undefined : byId[id]
                if (summary === null || typeof summary !== 'object') continue
                if (summary.origin === 'subagent') continue
                const isArchived = archived.has(id)
                if (archivedFilter === 'hide' && isArchived) continue
                if (archivedFilter === 'only' && !isArchived) continue
                if (summary.blank === true && id !== currentId) continue
                rows.push(summary)
              }
              rows.sort((a, b) => {
                const pinDelta = (pinned.has(b.id) ? 1 : 0) - (pinned.has(a.id) ? 1 : 0)
                if (pinDelta !== 0) return pinDelta
                return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
              })
              return rows
            }
            const index = new Map()
            for (const workspace of workspaces) index.set(workspace.workspaceId, collect(workspace.sessionIds))
            index.set(UNGROUPED, collect(ungroupedWorkspace.sessionIds))
            return index
          }, [byId, archived, pinned, currentId, archivedFilter, workspaces, ungroupedWorkspace])

          const rowsFor = (workspace) => rowsIndex.get(workspace.workspaceId) ?? []

          const titleOf = React.useCallback((summary) => {
            return typeof summary.displayTitle === 'string' && summary.displayTitle !== ''
              ? summary.displayTitle
              : t('session.untitled')
          }, [t])

          const displayNameOf = (workspace) => (typeof workspace.title === 'string' && workspace.title !== ''
            ? workspace.title
            : baseName(workspace.path))

          /** Newest Session activity in a Workspace, used by the "recent" sort. */
          const lastActivityOf = (workspace) => {
            let latest = 0
            for (const id of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) {
              const summary = byId === undefined || byId === null ? undefined : byId[id]
              const time = summary === undefined || summary === null ? undefined : summary.updatedAt
              if (typeof time === 'number' && time > latest) latest = time
            }
            return latest
          }

          const orderedWorkspaces = React.useMemo(
            () => sortWorkspaces(workspaces, folderSort, { nameOf: displayNameOf, activityOf: lastActivityOf }),
            [workspaces, folderSort, byId],
          )

          const orderSessions = (rows) => sortSessions(rows, sessionSort, {
            titleOf,
            isPinned: (row) => pinned.has(row.id),
            updatedAtOf: (row) => row.updatedAt,
          })

          /** The level in view owns the sort: folders outside, Sessions inside. */
          const activeLevel = openId === null ? 'folders' : 'sessions'

          // Folder drag-and-drop: only meaningful when the Host order is the
          // rendered order (manual + ascending) and the flat list is visible.
          const canReorder = folderSort.mode === 'manual' && folderSort.dir === 'asc'
            && openId === null && query.trim() === ''

          React.useEffect(() => {
            if (canReorder) return
            setDragId(null)
            setDropEdge(null)
          }, [canReorder])

          const clearDrag = () => {
            setDragId(null)
            setDropEdge(null)
          }

          // ----- menus -----
          const closeMenu = () => setMenu(null)
          const openMenu = (key) => setMenu((previous) => (previous !== null && previous.key === key && previous.point === undefined ? null : { key }))
          const menuOpenAt = (key) => menu !== null && menu.key === key && menu.point === undefined
          const contextHandler = (key) => (event) => {
            event.preventDefault()
            event.stopPropagation()
            setMenu({ key, point: { x: event.clientX, y: event.clientY } })
          }

          // ----- derived state -----
          const labels = {}
          for (const kind of INDICATOR_PRIORITY) labels[kind] = t(INDICATOR_LABEL_KEY[kind])

          /** The shipped browser names the exact interaction; mirror that. */
          const waitingLabel = (status) => {
            const kind = status !== undefined && status !== null && status.pendingInteraction !== undefined && status.pendingInteraction !== null
              ? status.pendingInteraction.kind
              : undefined
            if (kind === 'approval') return t('status.waitingApproval')
            if (kind === 'plan-review') return t('status.waitingPlanReview')
            if (kind === 'question') return t('status.waitingAnswer')
            return t('status.waiting')
          }

          const folderKindOf = (workspace) => {
            const candidates = []
            for (const summary of rowsFor(workspace)) {
              const kind = indicatorOf(statusOf(summary.id), projectionOf(summary.id), seenTurns[summary.id])
              if (kind === undefined) continue
              const projection = projectionOf(summary.id)
              const since = projection !== undefined && projection !== null
                && typeof projection.since === 'number' && projection.since > 0
                ? projection.since
                : (summary.updatedAt ?? 0)
              candidates.push({ kind, since })
            }
            return pickFolderKind(candidates)
          }

          /** Every status one Session carries, for the hover card. */
          const statusRowsOf = (status, projection, updatedAt, seenTurn) => {
            const rows = []
            if (status !== undefined && status !== null
              && status.pendingInteraction !== undefined && status.pendingInteraction !== null) {
              rows.push({ key: 'waiting', kind: 'waiting', label: waitingLabel(status) })
            }
            if (status !== undefined && status !== null && status.running === true) {
              rows.push({ key: 'running', kind: 'running', label: labels.running })
            }
            const state = projection === undefined || projection === null ? undefined : projection.state
            if ((state === 'failed' || state === 'interrupted') && !failureSeen(projection, seenTurn)) {
              rows.push({ key: 'error', kind: 'error', label: labels.error })
            }
            if (status !== undefined && status !== null && status.completionUnread === true) {
              rows.push({ key: 'completed', kind: 'completed', label: labels.completed })
            }
            if (state === 'stopped') rows.push({ key: 'stopped', kind: 'stopped', label: labels.stopped })
            if (rows.length === 0) rows.push({ key: 'idle', kind: undefined, label: t('status.idle') })
            rows.push({ key: 'time', kind: undefined, label: relativeTime(updatedAt) })
            return rows
          }

          /** Which states a Workspace contains and how many Sessions carry each. */
          const folderStatusRows = (workspace) => {
            const counts = new Map()
            for (const summary of rowsFor(workspace)) {
              const kind = indicatorOf(statusOf(summary.id), projectionOf(summary.id), seenTurns[summary.id])
              if (kind === undefined) continue
              counts.set(kind, (counts.get(kind) ?? 0) + 1)
            }
            const rows = []
            for (const kind of FOLDER_INDICATOR_PRIORITY) {
              const count = counts.get(kind)
              if (count === undefined) continue
              rows.push({ key: kind, kind, label: labels[kind] + ' ×' + String(count) })
            }
            if (rows.length === 0) rows.push({ key: 'idle', kind: undefined, label: t('status.idle') })
            return rows
          }

          // ----- actions -----
          const openSession = (sessionId) => {
            closeMenu()
            setQuery('')
            setSearchOpen(false)
            if (typeof ctx.uiWorkspace?.openSession === 'function') ctx.uiWorkspace.openSession(sessionId)
          }

          const startSession = (workspaceId) => {
            closeMenu()
            if (typeof ctx.uiWorkspace?.startSession === 'function') ctx.uiWorkspace.startSession(workspaceId)
          }

          /** Every failed action is both logged and shown; silence hides bugs. */
          const reportFailure = (error, messageKey) => {
            console.warn('[folder-sidebar] action failed', error)
            notify(t(messageKey))
          }

          const run = (promise, messageKey) => {
            Promise.resolve(promise).catch((error) => reportFailure(error, messageKey))
          }

          const addWorkspace = () => {
            const pickDirectory = ctx.uiWorkspace?.pickDirectory
            if (typeof pickDirectory !== 'function') return
            Promise.resolve(pickDirectory.call(ctx.uiWorkspace))
              .then((path) => {
                if (typeof path !== 'string' || path === '') return undefined
                return ctx.workspaces?.create?.({ path })
              })
              .catch((error) => reportFailure(error, 'notice.addWorkspaceFailed'))
          }

          const togglePin = (sessionId) => {
            closeMenu()
            const call = pinned.has(sessionId) ? ctx.uiWorkspace?.unpinSession : ctx.uiWorkspace?.pinSession
            if (typeof call !== 'function') return
            run(call.call(ctx.uiWorkspace, sessionId), 'notice.pinFailed')
          }

          const unarchive = (sessionId) => {
            closeMenu()
            const call = ctx.uiWorkspace?.unarchiveSession
            if (typeof call !== 'function') return
            Promise.resolve(call.call(ctx.uiWorkspace, sessionId))
              .catch((error) => reportFailure(error, 'notice.unarchiveFailed'))
          }

          const archiveNow = (sessionId, stopActivity) => {
            setConfirm(null)
            closeMenu()
            const archive = ctx.uiWorkspace?.archiveSession
            if (typeof archive !== 'function') return
            Promise.resolve(archive.call(ctx.uiWorkspace, sessionId, stopActivity === true ? { stopActivity: true } : undefined))
              .then(() => notify(t('notice.archived'), { label: t('action.undo'), onSelect: () => unarchive(sessionId) }))
              .catch((error) => {
                const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
                // The Host refuses a session with running work unless told to stop it.
                if (code.includes('session-active') || String(error?.message ?? '').includes('session-active')) setConfirm({ kind: 'archive', sessionId })
                else reportFailure(error, 'notice.archiveFailed')
              })
          }

          const fork = (sessionId) => {
            closeMenu()
            const call = ctx.uiWorkspace?.forkSession
            if (typeof call === 'function') run(call.call(ctx.uiWorkspace, sessionId), 'notice.forkFailed')
          }

          const copyId = (sessionId) => {
            closeMenu()
            const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
            if (clipboard === undefined || typeof clipboard.writeText !== 'function') return
            Promise.resolve(clipboard.writeText(sessionId))
              .then(() => notify(t('copied')))
              .catch(() => {})
          }

          const startRenameSession = (summary) => {
            closeMenu()
            setRename({ kind: 'session', id: summary.id, value: titleOf(summary) })
          }

          const startRenameWorkspace = (workspace) => {
            closeMenu()
            setRename({ kind: 'workspace', id: workspace.workspaceId, value: workspace.title || baseName(workspace.path) })
          }

          const commitRename = () => {
            const draft = rename
            if (draft === null) return
            setRename(null)
            const value = typeof draft.value === 'string' ? draft.value.trim() : ''
            if (value === '') return
            if (draft.kind === 'workspace') {
              run(ctx.workspaces?.rename?.(draft.id, value), 'notice.renameFailed')
              return
            }
            const sessions = ctx.sessions
            if (sessions === undefined || typeof sessions.using !== 'function') return
            Promise.resolve(sessions.using(draft.id, { source: 'workspaceOperation' }, (reference) => reference.binding.session.rename(value)))
              .then((result) => {
                if (result !== null && typeof result === 'object' && result.ok === false) throw new Error(result.error?.message ?? 'rename failed')
              })
              .catch((error) => reportFailure(error, 'notice.renameFailed'))
          }

          const deleteWorkspace = (workspaceId) => {
            setConfirm(null)
            closeMenu()
            const remove = ctx.workspaces?.delete
            if (typeof remove !== 'function') return
            Promise.resolve(remove.call(ctx.workspaces, workspaceId))
              .then(() => setOpenId(null))
              .catch((error) => reportFailure(error, 'notice.deleteFailed'))
          }

          /** Move one Workspace before another; `undefined` appends. */
          const moveWorkspace = (workspaceId, beforeId) => {
            closeMenu()
            const insertBefore = ctx.workspaces?.insertBefore
            if (typeof insertBefore !== 'function') return
            run(insertBefore.call(ctx.workspaces, workspaceId, beforeId), 'notice.moveFailed')
          }

          const applyArchivedFilter = (value) => {
            setArchivedFilter(value)
            writeArchivedFilter(value)
            closeMenu()
          }

          const commitSort = (patch) => {
            const next = {
              ...sortState,
              [activeLevel]: { ...sortState[activeLevel], ...patch },
            }
            setSortState(next)
            writeSortState(next)
            closeMenu()
          }

          const chooseMode = (mode) => commitSort({ mode, dir: SORT_NATURAL_DIR[mode] })

          /** Land one Workspace before a Host-order anchor (`undefined` appends). */
          const dropOn = (targetId, edge) => {
            if (dragId === null || dragId === targetId) { clearDrag(); return }
            const ids = workspaces.map((workspace) => workspace.workspaceId)
            const targetIndex = ids.indexOf(targetId)
            if (targetIndex < 0) { clearDrag(); return }
            const beforeId = edge === 'before' ? ids[targetIndex] : ids[targetIndex + 1]
            // Dropping onto the neighbour it already precedes is a no-op.
            if (beforeId !== dragId) moveWorkspace(dragId, beforeId)
            clearDrag()
          }

          // ----- menu item definitions (host Menu items + one dispatcher) -----
          const sessionMenuDef = (summary) => {
            const isPinned = pinned.has(summary.id)
            const isArchived = archived.has(summary.id)
            const items = isArchived
              ? [
                { id: 'unarchive', label: t('action.unarchive'), icon: icon('unarchive', 14) },
                { id: 'rename', label: t('action.rename'), icon: icon('rename', 14) },
                { id: 'fork', label: t('action.fork'), icon: icon('branch', 14) },
                { id: 'copy', label: t('action.copyId'), icon: icon('copy', 14) },
              ]
              : [
                { id: 'pin', label: isPinned ? t('action.unpin') : t('action.pin'), icon: icon(isPinned ? 'pin' : 'pinOutline', 14) },
                { id: 'rename', label: t('action.rename'), icon: icon('rename', 14) },
                { id: 'fork', label: t('action.fork'), icon: icon('branch', 14) },
                { id: 'copy', label: t('action.copyId'), icon: icon('copy', 14) },
                { id: 'sep-archive', type: 'separator' },
                { id: 'archive', label: t('action.archive'), danger: true, icon: icon('archive', 14) },
              ]
            const runItem = (id) => {
              closeMenu()
              if (id === 'pin') togglePin(summary.id)
              else if (id === 'rename') startRenameSession(summary)
              else if (id === 'fork') fork(summary.id)
              else if (id === 'copy') copyId(summary.id)
              else if (id === 'archive') archiveNow(summary.id, false)
              else if (id === 'unarchive') unarchive(summary.id)
            }
            return { items, run: runItem }
          }

          const folderMenuDef = (workspace) => {
            const hostIndex = workspaces.indexOf(workspace)
            const items = [
              { id: 'rename', label: t('action.renameWorkspace'), icon: icon('rename', 14) },
              { id: 'new', label: t('action.newSessionHere'), icon: icon('newChat', 14) },
            ]
            if (folderSort.mode === 'manual' && folderSort.dir === 'asc') {
              if (hostIndex > 0) items.push({ id: 'up', label: t('action.moveUp'), icon: icon('chevronUp', 14) })
              if (hostIndex < workspaces.length - 1) items.push({ id: 'down', label: t('action.moveDown'), icon: icon('chevronDown', 14) })
            }
            items.push({ id: 'sep-delete', type: 'separator' })
            items.push({ id: 'delete', label: t('action.deleteWorkspace'), danger: true, icon: icon('trash', 14) })
            const runItem = (id) => {
              closeMenu()
              if (id === 'rename') startRenameWorkspace(workspace)
              else if (id === 'new') startSession(workspace.workspaceId)
              else if (id === 'up') moveWorkspace(workspace.workspaceId, workspaces[hostIndex - 1].workspaceId)
              else if (id === 'down') {
                const following = hostIndex + 2 < workspaces.length ? workspaces[hostIndex + 2].workspaceId : undefined
                moveWorkspace(workspace.workspaceId, following)
              } else if (id === 'delete') setConfirm({ kind: 'deleteWorkspace', workspaceId: workspace.workspaceId })
            }
            return { items, run: runItem }
          }

          /** One view-options menu: ordering for the level in view, then visibility. */
          const viewMenuDef = () => {
            const level = openId === null ? 'folders' : 'sessions'
            const active = sortState[level]
            const items = [
              { id: 'sort-label', type: 'label', text: t('action.sort') + ' · ' + t(level === 'folders' ? 'level.folders' : 'level.sessions') },
              { id: 'mode:manual', label: t('sort.manual'), icon: icon('chevrons', 14) },
              { id: 'mode:name', label: t('sort.name'), icon: icon('flatList', 14) },
              { id: 'mode:recent', label: t('sort.recent'), icon: icon('clock', 14) },
              { id: 'dir:asc', label: t('sort.asc') + ' ↑', icon: icon('chevronUp', 14) },
              { id: 'dir:desc', label: t('sort.desc') + ' ↓', icon: icon('chevronDown', 14) },
              { id: 'sep-sort', type: 'separator' },
              { id: 'view-label', type: 'label', text: t('action.view') },
              { id: 'view:hide', label: t('view.hide'), icon: icon('archiveOff', 14) },
              { id: 'view:all', label: t('view.all'), icon: icon('queue', 14) },
              { id: 'view:only', label: t('view.only'), icon: icon('archiveCheck', 14) },
            ]
            const selectedIds = ['mode:' + active.mode, 'dir:' + active.dir, 'view:' + archivedFilter]
            const runItem = (id) => {
              if (id.indexOf('mode:') === 0) { chooseMode(id.slice(5)); return }
              if (id.indexOf('dir:') === 0) { commitSort({ dir: id.slice(4) }); return }
              if (id.indexOf('view:') === 0) { applyArchivedFilter(id.slice(5)); return }
              closeMenu()
            }
            return { items, selectedIds, run: runItem }
          }

          const defFromKey = (key) => {
            if (key === null || key === undefined) return null
            if (key === 'view') return viewMenuDef()
            if (key.indexOf('session:') === 0) {
              const summary = byId === undefined || byId === null ? undefined : byId[key.slice(8)]
              return summary === undefined || summary === null ? null : sessionMenuDef(summary)
            }
            if (key.indexOf('workspace:') === 0) {
              const workspace = workspaces.find((item) => item.workspaceId === key.slice(10))
              return workspace === undefined ? null : folderMenuDef(workspace)
            }
            return null
          }

          // ----- hover card bodies (shipped .hoverContent) -----
          const folderHover = (workspace, name) => {
            const rows = folderStatusRows(workspace)
            return h('div', { className: 'dfs-hoverContent' },
              h('div', { className: 'dfs-hoverTitle' }, name),
              typeof workspace.path === 'string' && workspace.path !== ''
                ? h('div', { className: 'dfs-hoverPath' }, workspace.path)
                : null,
              rows.map((row) => h('div', { key: row.key, className: 'dfs-hoverStatus' },
                row.kind === undefined ? null : h(KitStateDot, { state: dotState(row.kind) }),
                h('span', null, row.label))))
          }

          const sessionHover = (summary, status, kind) => {
            const rows = statusRowsOf(status, projectionOf(summary.id), summary.updatedAt, seenTurns[summary.id])
            return h('div', { className: 'dfs-hoverContent' },
              h('div', { className: 'dfs-hoverTitle' }, titleOf(summary)),
              rows.map((row) => h('div', { key: row.key, className: 'dfs-hoverStatus' },
                row.kind === undefined ? null : h(KitStateDot, { state: dotState(row.kind) }),
                h('span', null, row.label))))
          }

          // ----- rows -----
          const FOLDER_STATUS_CLASS = {
            waiting: 'is-waiting',
            error: 'is-error',
            completed: 'is-completed',
            stopped: 'is-stopped',
          }

          const renderFolderCell = (kind) => h('span', {
            className: cls('dfs-folderSlot', kind !== undefined && FOLDER_STATUS_CLASS[kind]),
          },
            h('span', { className: 'dfs-folderGlyph' },
              kind === 'running' ? h(KitStateDot, { state: 'ongoing', size: 14 }) : icon('folderClose', 16)),
            h('span', { className: 'dfs-enterGlyph' }, icon('arrow', 12)))

          const menuTrigger = (key, def, onPointerDown) => h(KitMenu, {
            open: menuOpenAt(key),
            anchor: h(IconButton, {
              icon: 'more',
              size: 14,
              className: 'dfs-rowAction',
              title: t('action.menu'),
              expanded: menuOpenAt(key),
              haspopup: 'menu',
              onPointerDown,
              onClick: (event) => { event.stopPropagation(); openMenu(key) },
            }),
            items: def.items,
            selectedIds: def.selectedIds,
            onSelect: def.run,
            onClose: closeMenu,
            align: 'end',
            dense: true,
            portal: true,
          })

          const renderFolderRow = (workspace) => {
            const rows = rowsFor(workspace)
            if (archivedFilter === 'only' && rows.length === 0) return null
            const name = displayNameOf(workspace)
            const isCurrent = workspace.workspaceId === currentWorkspaceId
            const kind = folderKindOf(workspace)
            const menuKey = 'workspace:' + workspace.workspaceId
            const def = folderMenuDef(workspace)
            const dropping = dropEdge !== null && dropEdge.id === workspace.workspaceId
            const row = h('div', {
              className: cls(
                'dfs-row dfs-projectRow',
                isCurrent && 'is-current',
                menuOpenAt(menuKey) && 'has-menu',
                dropping && (dropEdge.edge === 'before' ? 'dropBefore' : 'dropAfter'),
              ),
              role: 'button',
              tabIndex: 0,
              title: typeof workspace.path === 'string' && workspace.path !== '' ? workspace.path : name,
              'data-row-key': menuKey,
              onClick: () => setOpenId(workspace.workspaceId),
              onContextMenu: contextHandler(menuKey),
              onKeyDown: (event) => {
                if (event.target !== event.currentTarget) return
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                setOpenId(workspace.workspaceId)
              },
              draggable: canReorder,
              onDragStart: (event) => {
                if (!canReorder) return
                const target = event.target
                if (target !== null && typeof target.closest === 'function' && target.closest('button') !== null) {
                  event.preventDefault()
                  return
                }
                setDragId(workspace.workspaceId)
                try {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', workspace.workspaceId)
                } catch (error) {
                  // Some environments expose a read-only dataTransfer.
                }
              },
              onDragOver: (event) => {
                if (!canReorder || dragId === null || dragId === workspace.workspaceId) return
                event.preventDefault()
                const rect = event.currentTarget.getBoundingClientRect()
                const edge = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                setDropEdge((previous) => (previous !== null && previous.id === workspace.workspaceId && previous.edge === edge
                  ? previous
                  : { id: workspace.workspaceId, edge }))
              },
              onDragLeave: (event) => {
                if (event.currentTarget.contains(event.relatedTarget)) return
                setDropEdge((previous) => (previous !== null && previous.id === workspace.workspaceId ? null : previous))
              },
              onDrop: (event) => {
                if (!canReorder) return
                event.preventDefault()
                const edge = dropEdge !== null && dropEdge.id === workspace.workspaceId ? dropEdge.edge : 'before'
                dropOn(workspace.workspaceId, edge)
              },
              onDragEnd: clearDrag,
            },
              renderFolderCell(kind),
              h(Title, { className: 'dfs-rowTitle', text: name === '' ? t('section.title') : name }),
              h('span', { className: 'dfs-rowActions' },
                menuTrigger(menuKey, def, (event) => event.stopPropagation())))
            return h(KitHoverCard, {
              key: 'hover-workspace:' + workspace.workspaceId,
              anchor: row,
              content: folderHover(workspace, name),
              openDelayMs: 800,
              disabled: menuOpenAt(menuKey),
            })
          }

          const renderUngroupedRow = () => {
            const kind = folderKindOf(ungroupedWorkspace)
            const row = h('div', {
              className: cls('dfs-row dfs-projectRow', openId === UNGROUPED && 'is-current'),
              role: 'button',
              tabIndex: 0,
              title: t('group.ungrouped'),
              onClick: () => setOpenId(UNGROUPED),
              onKeyDown: (event) => {
                if (event.target !== event.currentTarget) return
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                setOpenId(UNGROUPED)
              },
            },
              renderFolderCell(kind),
              h(Title, { className: 'dfs-rowTitle', text: t('group.ungrouped') }))
            return h(KitHoverCard, {
              key: 'hover-ungrouped',
              anchor: row,
              content: folderHover(ungroupedWorkspace, t('group.ungrouped')),
              openDelayMs: 800,
            })
          }

          const renderSessionRow = (summary) => {
            const status = statusOf(summary.id)
            const kind = indicatorOf(status, projectionOf(summary.id), seenTurns[summary.id])
            const label = kind === undefined ? t('status.idle') : (kind === 'waiting' ? waitingLabel(status) : labels[kind])
            const isPinned = pinned.has(summary.id)
            const isArchived = archived.has(summary.id)
            const selected = summary.id === currentId
            const menuKey = 'session:' + summary.id
            const def = sessionMenuDef(summary)
            const openRow = () => {
              if (isArchived) { notify(t('notice.archivedNotOpenable')); return }
              openSession(summary.id)
            }
            const row = h('div', {
              className: cls(
                'dfs-row dfs-sessionRow',
                selected && 'is-current',
                isArchived && 'is-archived',
                menuOpenAt(menuKey) && 'has-menu',
              ),
              role: 'button',
              tabIndex: 0,
              'aria-current': selected ? 'true' : undefined,
              'aria-description': isArchived ? t('notice.archivedNotOpenable') : undefined,
              title: isArchived ? t('notice.archivedNotOpenable') : (kind === undefined ? titleOf(summary) : titleOf(summary) + ' — ' + label),
              'data-row-key': menuKey,
              onClick: openRow,
              onContextMenu: contextHandler(menuKey),
              onKeyDown: (event) => {
                if (event.target !== event.currentTarget) return
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                openRow()
              },
            },
              h('span', { className: 'dfs-slot' }, h(KitStateDot, { state: dotState(kind) })),
              h(Title, { className: 'dfs-rowTitle', text: titleOf(summary) }),
              h('span', { className: 'dfs-rowResting' },
                h('span', { className: 'dfs-time' }, relativeTime(summary.updatedAt)),
                isPinned ? h('span', { className: 'dfs-pin', title: t('action.pin') }, icon('pin', 14)) : null),
              h('span', { className: 'dfs-rowActions' },
                menuTrigger(menuKey, def, (event) => event.stopPropagation())))
            return h(KitHoverCard, {
              key: 'hover-session:' + summary.id,
              anchor: row,
              content: sessionHover(summary, status, kind),
              openDelayMs: 800,
              disabled: menuOpenAt(menuKey),
            })
          }

          const renderSearchRow = (hit) => {
            const status = statusOf(hit.sessionId)
            const kind = indicatorOf(status, projectionOf(hit.sessionId), seenTurns[hit.sessionId])
            const isArchived = archived.has(hit.sessionId)
            return h('div', {
              key: hit.sessionId,
              className: cls('dfs-searchRow', isArchived && 'is-archived'),
              role: 'button',
              tabIndex: 0,
              'aria-description': isArchived ? t('notice.archivedNotOpenable') : undefined,
              onClick: () => { if (isArchived) { notify(t('notice.archivedNotOpenable')); return } openSession(hit.sessionId) },
              onKeyDown: (event) => {
                if (event.target !== event.currentTarget) return
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                if (isArchived) { notify(t('notice.archivedNotOpenable')); return }
                openSession(hit.sessionId)
              },
            },
              h('span', { className: 'dfs-searchHeading' },
                h('span', { className: 'dfs-slot' }, isArchived || kind === undefined ? null : h(KitStateDot, { state: dotState(kind) })),
                h('span', { className: 'dfs-searchTitle' },
                  h(Title, { className: 'dfs-rowTitle', text: hit.title })),
                isArchived
                  ? h('span', { className: 'dfs-rowActions' },
                    h(IconButton, {
                      icon: 'unarchive',
                      size: 14,
                      className: 'dfs-rowAction',
                      title: t('action.unarchive'),
                      onClick: (event) => { event.stopPropagation(); unarchive(hit.sessionId) },
                    }))
                  : null),
              h('span', { className: 'dfs-searchMeta' },
                h('span', { className: 'dfs-searchWorkspace' }, baseName(hit.workspace.path) || t('group.ungrouped')),
                hit.snippet === undefined ? null : h('span', { className: 'dfs-searchSnippet' }, hit.snippet)))
          }

          const searchHits = (text) => {
            const lower = text.toLowerCase()
            const seen = new Set()
            const hits = []
            if (byId !== undefined && byId !== null) {
              for (const id of Object.keys(byId)) {
                const summary = byId[id]
                if (summary === null || typeof summary !== 'object') continue
                const isArchivedHit = archived.has(id)
                if (archivedFilter === 'hide' && isArchivedHit) continue
                if (archivedFilter === 'only' && !isArchivedHit) continue
                const title = titleOf(summary)
                if (!title.toLowerCase().includes(lower)) continue
                const workspace = workspaces.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(id)) ?? ungroupedWorkspace
                seen.add(id)
                hits.push({ sessionId: id, title, workspace, snippet: undefined })
              }
            }
            for (const item of contentHits) {
              if (seen.has(item.sessionId)) continue
              const summary = byId === undefined || byId === null ? undefined : byId[item.sessionId]
              if (summary === undefined || summary === null) continue
              const isArchivedHit = archived.has(item.sessionId)
              if (archivedFilter === 'hide' && isArchivedHit) continue
              if (archivedFilter === 'only' && !isArchivedHit) continue
              const workspace = workspaces.find((entry) => Array.isArray(entry.sessionIds) && entry.sessionIds.includes(item.sessionId)) ?? ungroupedWorkspace
              seen.add(item.sessionId)
              hits.push({ sessionId: item.sessionId, title: titleOf(summary), workspace, snippet: item.snippet })
            }
            return hits.slice(0, 30)
          }

          // ----- header -----
          const openSearch = () => {
            setSearchOpen(true)
            const node = searchInput.current
            if (node !== null && typeof node.focus === 'function') node.focus()
          }

          const closeSearch = () => {
            setSearchOpen(false)
            setQuery('')
          }

          const renderHeader = () => {
            const viewDef = viewMenuDef()
            return h('div', { className: 'dfs-header', 'data-dfs-header': '1' },
              h('span', { className: cls('dfs-headerLabel', searchOpen && 'is-hidden') }, t('section.title')),
              h('div', { ref: searchRoot, className: cls('dfs-searchSlot', searchOpen && 'is-expanded') },
                h('div', { className: cls('dfs-search', searchOpen && 'is-open'), onClick: openSearch },
                  h(IconButton, {
                    icon: 'search',
                    size: searchOpen ? 11 : 14,
                    className: 'dfs-searchButton',
                    title: t('action.search'),
                    expanded: searchOpen,
                    tooltip: !searchOpen,
                    onClick: (event) => { event.stopPropagation(); openSearch() },
                  }),
                  h('input', {
                    ref: searchInput,
                    className: 'dfs-searchInput',
                    type: 'text',
                    placeholder: t('search.placeholder'),
                    value: query,
                    'aria-label': t('action.search'),
                    tabIndex: searchOpen ? 0 : -1,
                    onChange: (event) => setQuery(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key !== 'Escape') return
                      event.preventDefault()
                      closeSearch()
                    },
                  }),
                  searchOpen
                    ? h(IconButton, {
                      icon: 'close',
                      size: 12,
                      className: 'dfs-clearButton',
                      title: t('action.close'),
                      tooltip: false,
                      onClick: (event) => { event.stopPropagation(); closeSearch() },
                    })
                    : null)),
              h('div', { className: cls('dfs-headerActions', searchOpen && 'is-hidden') },
                h(KitMenu, {
                  open: menuOpenAt('view'),
                  anchor: h(IconButton, {
                    icon: 'sliders',
                    size: 16,
                    title: t('action.view'),
                    expanded: menuOpenAt('view'),
                    haspopup: 'menu',
                    onClick: (event) => { event.stopPropagation(); openMenu('view') },
                  }),
                  items: viewDef.items,
                  selectedIds: viewDef.selectedIds,
                  onSelect: viewDef.run,
                  onClose: closeMenu,
                  align: 'end',
                  dense: true,
                  portal: true,
                }),
                h(IconButton, {
                  icon: 'projectAdd',
                  size: 16,
                  title: t('action.addWorkspace'),
                  onClick: addWorkspace,
                })))
          }

          const renderCrumb = () => {
            const isUngrouped = openWorkspace.workspaceId === UNGROUPED
            const name = isUngrouped ? t('group.ungrouped') : displayNameOf(openWorkspace)
            return h('div', {
              key: 'crumb',
              className: 'dfs-crumb',
              role: 'button',
              tabIndex: 0,
              title: t('action.back'),
              onClick: () => setOpenId(null),
              onKeyDown: (event) => {
                if (event.target !== event.currentTarget) return
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                setOpenId(null)
              },
            },
              h('span', { className: 'dfs-crumbChevron' }, icon('chevronLeft', 14)),
              h('span', { className: 'dfs-crumbFolder' }, icon('folderClose', 16)),
              h(Title, { className: 'dfs-crumbName', text: name }),
              isUngrouped ? null : h(IconButton, {
                icon: 'newChat',
                size: 14,
                className: 'dfs-rowAction',
                title: t('action.newSession'),
                onClick: (event) => { event.stopPropagation(); startSession(openWorkspace.workspaceId) },
              }))
          }

          // ----- dialogs and transient layers -----
          const renameEl = () => {
            if (rename === null) return null
            const title = rename.kind === 'workspace' ? t('dialog.renameWorkspace') : t('dialog.renameSession')
            const canSave = String(rename.value).trim() !== ''
            return h(KitModal, {
              key: 'rename-dialog',
              open: true,
              title,
              closeLabel: t('dialog.cancel'),
              onClose: () => setRename(null),
              footer: [
                h(Button, { key: 'cancel', variant: 'ghost', onClick: () => setRename(null) }, t('dialog.cancel')),
                h(Button, { key: 'save', variant: 'primary', disabled: !canSave, onClick: commitRename }, t('dialog.save')),
              ],
            }, h('input', {
              className: 'dfs-dialogInput',
              value: rename.value,
              autoFocus: true,
              'aria-label': title,
              onChange: (event) => setRename({ ...rename, value: event.target.value }),
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                commitRename()
              },
            }))
          }

          const confirmEl = () => {
            if (confirm === null) return null
            if (confirm.kind === 'archive') {
              const summary = byId === undefined || byId === null ? undefined : byId[confirm.sessionId]
              const name = summary === undefined || summary === null ? t('session.untitled') : titleOf(summary)
              return h(KitModal, {
                key: 'archive-dialog',
                open: true,
                title: t('dialog.archiveTitle'),
                closeLabel: t('dialog.cancel'),
                description: t('dialog.archiveConfirm'),
                onClose: () => setConfirm(null),
                footer: [
                  h(Button, { key: 'cancel', variant: 'ghost', onClick: () => setConfirm(null) }, t('dialog.cancel')),
                  h(Button, { key: 'archive', variant: 'primary', className: 'dfs-dangerText', onClick: () => archiveNow(confirm.sessionId, true) }, t('dialog.archive')),
                ],
              }, h('p', { className: 'dfs-dialogText' }, name))
            }
            const workspace = workspaces.find((item) => item.workspaceId === confirm.workspaceId)
            const name = workspace === undefined ? '' : displayNameOf(workspace)
            return h(KitModal, {
              key: 'delete-dialog',
              open: true,
              title: t('dialog.deleteWorkspaceTitle'),
              closeLabel: t('dialog.cancel'),
              description: t('dialog.deleteWorkspaceDesc'),
              onClose: () => setConfirm(null),
              footer: [
                h(Button, { key: 'cancel', variant: 'ghost', onClick: () => setConfirm(null) }, t('dialog.cancel')),
                h(Button, { key: 'delete', variant: 'primary', className: 'dfs-dangerText', onClick: () => deleteWorkspace(confirm.workspaceId) }, t('dialog.delete')),
              ],
            }, h('p', { className: 'dfs-dialogText' }, name))
          }

          const toastEl = () => {
            if (notice === null) return null
            return h(KitToast, {
              key: 'toast-' + String(notice.id),
              text: notice.message,
              holdMs: notice.action === null ? 3000 : 6000,
              actions: notice.action === null ? undefined : [{
                label: notice.action.label,
                onClick: () => { const action = notice.action; setNotice(null); action.onSelect() },
              }],
              onDone: () => setNotice(null),
            })
          }

          const contextMenuEl = () => {
            if (menu === null || menu.point === undefined) return null
            const def = defFromKey(menu.key)
            if (def === null) return null
            return h(KitMenu, {
              key: 'context-menu',
              open: true,
              anchor: null,
              anchorPoint: menu.point,
              contextual: true,
              items: def.items,
              selectedIds: def.selectedIds,
              onSelect: def.run,
              onClose: closeMenu,
            })
          }

          const openWorkspace = openId === null
            ? undefined
            : (openId === UNGROUPED
              ? ungroupedWorkspace
              : workspaces.find((workspace) => workspace.workspaceId === openId))

          if (!wide) {
            return h('div', { className: 'dfs-rail' },
              h('button', {
                type: 'button',
                className: 'dfs-railBtn',
                title: t('rail.expand'),
                'aria-label': t('rail.expand'),
                onClick: () => { if (typeof expandSidebar === 'function') expandSidebar() },
              }, icon('folderClose', 18)))
          }

          const body = [h('style', { key: 'style' }, CSS), renderHeader()]
          const text = query.trim()
          if (text !== '') {
            const hits = searchHits(text)
            const rows = hits.length === 0
              ? [h('div', { key: 'empty', className: 'dfs-empty' }, searching ? t('search.searching') : t('empty.search'))]
              : hits.map(renderSearchRow)
            body.push(h('div', { key: 'list', className: 'dfs-listArea' }, rows))
            return h('div', { className: 'dfs-root' }, body, contextMenuEl(), renameEl(), confirmEl(), toastEl())
          }

          if (openWorkspace === undefined) {
            const listRows = []
            for (const workspace of orderedWorkspaces) {
              const row = renderFolderRow(workspace)
              if (row !== null) listRows.push(row)
            }
            if (rowsFor(ungroupedWorkspace).length > 0) listRows.push(renderUngroupedRow())
            if (listRows.length === 0) {
              listRows.push(h('div', { key: 'empty', className: 'dfs-emptyState' },
                icon('folderClose', 24),
                h('span', null, t(archivedFilter === 'only' ? 'empty.archived' : 'empty.workspaces'))))
            }
            body.push(h('div', { key: 'list', className: 'dfs-listArea' }, listRows))
            return h('div', { className: 'dfs-root' }, body, contextMenuEl(), renameEl(), confirmEl(), toastEl())
          }

          body.push(renderCrumb())
          const sessionRows = orderSessions(rowsFor(openWorkspace)).map(renderSessionRow)
          if (sessionRows.length === 0) {
            sessionRows.push(h('div', { key: 'empty', className: 'dfs-empty' }, t('empty.sessions')))
          }
          body.push(h('div', { key: 'list', className: 'dfs-listArea' }, sessionRows))
          return h('div', { className: 'dfs-root' }, body, contextMenuEl(), renameEl(), confirmEl(), toastEl())
        }

        // A single slot refuses a second registration at the same priority and
        // renders the lowest priority, so this row must sit below the shipped
        // browser (priority 0) to replace it. The boundary keeps a render bug
        // from abdicating this entry back to the shipped browser: it renders the
        // message in place instead, which is what a reader can diagnose.
        ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
          name: 'sidebar.workspaces',
          priority: -1,
          locale: NS,
        }, (props) => h(RenderBoundary, null, h(FolderSidebar, props))))
      },
    }
  },
})
}

if (typeof module === 'object' && module !== null && module.exports !== undefined) {
  module.exports = {
    INDICATOR_PRIORITY, FOLDER_INDICATOR_PRIORITY, INDICATOR_LABEL_KEY, GLYPH_COLOR,
    SORT_MODES, SORT_DIRS, SORT_DEFAULT, SORT_NATURAL_DIR,
    ARCHIVED_FILTERS, UNGROUPED,
    directionSign, normalizeSort, readSortState, writeSortState,
    readArchivedFilter, writeArchivedFilter,
    SEEN_KEY, readSeenTurns, writeSeenTurns, markTurnSeen, failureSeen,
    sortWorkspaces, sortSessions, pickFolderKind, indicatorOf,
    relativeTime, baseName, marqueeShiftOf, marqueeDurationOf,
  }
}
