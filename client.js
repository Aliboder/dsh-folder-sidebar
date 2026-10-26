/**
 * Pure logic for dsh-folder-sidebar.
 *
 * This block lives at module scope, outside the Client factory, so that the
 * exact shipped source can be exercised by `node` tests: with `window` absent
 * the browser bootstrap below is skipped and `module.exports` exposes these
 * functions. Nothing here touches React, the DOM, or a specific Cordis context.
 */

const INDICATOR_PRIORITY = ['waiting', 'running', 'error', 'completed', 'stopped']

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
 * began earliest.
 * @param candidates - `{ kind, since }` pairs for the Workspace's Sessions.
 */
function pickFolderKind(candidates) {
  let best
  for (const candidate of candidates) {
    const priority = INDICATOR_PRIORITY.indexOf(candidate.kind)
    if (priority < 0) continue
    if (best === undefined || priority < best.priority || (priority === best.priority && candidate.since < best.since)) {
      best = { kind: candidate.kind, priority, since: candidate.since }
    }
  }
  return best === undefined ? undefined : best.kind
}

/**
 * One row's leading indicator. Green follows the client's completion-unread
 * rule; failure comes from this bundle's projection and is not cleared by
 * viewing. Running wins over everything, a pending question wins over activity.
 */
function indicatorOf(status, projection) {
  const waiting = status !== undefined && status !== null
    && status.pendingInteraction !== undefined && status.pendingInteraction !== null
  if (waiting) return 'waiting'
  const running = status !== undefined && status !== null && status.running === true
  if (running) return 'running'
  const state = projection === undefined || projection === null ? undefined : projection.state
  if (state === 'failed' || state === 'interrupted') return 'error'
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
 *      state colour, a "…" menu, inline rename, and a back row.
 * A search field switches the region to a flat result list across Workspaces.
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
      },
    }

    /**
     * Precedence for a Workspace's single status cell, matching the Session row
     * order: an actionable question outranks activity, a failure outranks an
     * unread result. Ties inside one kind fall back to the oldest state.
     */
    const CSS = `
.dfs-root{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:100%;font-size:13px;color:var(--dsw-alias-label-primary);padding:4px 8px 10px}
.dfs-head{display:flex;align-items:center;gap:4px;flex:none;box-sizing:border-box;height:32px;margin:0 2px 8px;padding:0 2px}
.dfs-topbar{position:relative;display:flex;align-items:center;flex:none;box-sizing:border-box;height:32px;margin:0 2px 8px}
.dfs-topbar > .dfs-head{flex:1 1 auto;min-width:0;height:100%;margin:0;padding:0 2px;opacity:1;visibility:visible;transition:opacity .15s ease,visibility 0s linear 0s}
.dfs-topbar > .dfs-search{position:absolute;inset:0;height:100%;margin:0;opacity:0;visibility:hidden;pointer-events:none;transform:scaleX(.94);transform-origin:right center;transition:opacity .15s ease,transform .18s ease,visibility 0s linear .18s}
.dfs-topbar.is-search > .dfs-head{opacity:0;pointer-events:none;visibility:hidden;transition:opacity .15s ease,visibility 0s linear .15s}
.dfs-topbar.is-search > .dfs-search{opacity:1;visibility:visible;pointer-events:auto;transform:none;transition:opacity .15s ease,transform .18s ease,visibility 0s linear 0s}
@media (prefers-reduced-motion: reduce){.dfs-topbar > .dfs-head,.dfs-topbar > .dfs-search{transition:none}}
.dfs-headTitle{flex:1;min-width:0;font-size:12px;font-weight:500;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfs-headBack{width:20px;height:20px;font-size:14px;color:var(--dsw-alias-label-secondary)}
.dfs-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.dfs-iconBtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dfs-iconBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dfs-search{display:flex;align-items:center;flex:none;gap:8px;box-sizing:border-box;height:32px;margin:0 2px 8px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);transition:border-color .12s ease}

.dfs-search:focus-within{border-color:var(--dsw-alias-brand-primary)}
.dfs-search input{flex:1;min-width:0;padding:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px}
.dfs-search input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.dfs-crumb{display:flex;align-items:center;flex:none;gap:8px;box-sizing:border-box;height:28px;margin:0 2px 2px;padding:0 8px;border-radius:7px;cursor:pointer}
.dfs-crumb:hover{background:var(--dsw-alias-bg-layer-2)}
.dfs-crumb:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dfs-crumbChevron{flex:none;width:12px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dfs-crumb .dfs-folderGlyph{display:inline-flex;align-items:center}
.dfs-crumb .dfs-iconBtn{width:20px;height:20px}
.dfs-crumbName{flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfs-list{display:flex;flex-direction:column;flex:1 1 auto;gap:2px;overflow-y:auto;min-height:0;padding-bottom:2px}
.dfs-rowWrap{position:relative;display:flex;flex-direction:column}
.dfs-rowWrap.is-drop-before:before,.dfs-rowWrap.is-drop-after:after{content:"";position:absolute;left:4px;right:4px;height:2px;border-radius:1px;background:var(--dsw-alias-brand-primary);z-index:5;pointer-events:none}
.dfs-rowWrap.is-drop-before:before{top:-1px}
.dfs-rowWrap.is-drop-after:after{bottom:-1px}
.dfs-rowWrap[draggable=true]{cursor:grab}
.dfs-row{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:5px 8px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;line-height:1.3;text-align:left;cursor:pointer}
.dfs-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dfs-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dfs-row.is-current{background:var(--dsw-alias-bg-layer-1)}
.dfs-row.is-current .dfs-title{font-weight:600}
.dfs-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfs-titleText{display:inline-block;white-space:nowrap;will-change:transform}
.dfs-title.is-marquee{text-overflow:clip}
.dfs-title.is-marquee .dfs-titleText,
.dfs-crumbName.is-marquee .dfs-titleText{animation:dfs-title-marquee var(--dfs-marquee-duration,4s) ease-in-out infinite alternate}
@keyframes dfs-title-marquee{0%,10%{transform:translateX(0)}90%,100%{transform:translateX(var(--dfs-marquee-shift,0))}}
@media (prefers-reduced-motion: reduce){.dfs-title.is-marquee .dfs-titleText,.dfs-crumbName.is-marquee .dfs-titleText{animation:none}}
.dfs-snippet{flex:1 1 100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dfs-time{flex:none;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dfs-status{display:inline-flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px}
.dfs-statusDot{position:relative;width:12px;height:12px;border-radius:50%;color:var(--dsw-alias-state-idle-primary)}
.dfs-statusDot:after{content:"";position:absolute;inset:20%;border-radius:50%;background:currentColor}
.dfs-statusDot.is-none{color:var(--dsw-alias-state-idle-primary);opacity:.55}
.dfs-statusDot.is-completed{color:var(--dsw-alias-state-success-primary)}
.dfs-statusDot.is-waiting{color:var(--dsw-alias-state-warn-primary)}
.dfs-statusDot.is-error{color:var(--dsw-alias-state-error-primary)}
.dfs-statusDot.is-stopped{color:var(--dsw-alias-state-idle-primary)}
.dfs-statusDot.is-stopped:after{background:transparent;inset:15%;border:1.5px solid currentColor}
.dfs-spinner{width:14px;height:14px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);animation:dfs-spin .8s linear infinite}
@keyframes dfs-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.dfs-spinner{animation:none;border-top-color:var(--dsw-alias-label-secondary);opacity:.85}}
.dfs-statusFolder{width:18px}
.dfs-glyph{font-size:15px;font-weight:700;line-height:1}
.dfs-folderGlyph{display:inline-flex;align-items:center;justify-content:center}
.dfs-badge{flex:none;min-width:16px;text-align:center;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dfs-rowActions{display:inline-flex;align-items:center;gap:2px;flex:none;opacity:0;transition:opacity .12s ease}
.dfs-rowWrap:hover .dfs-rowActions,.dfs-rowActions.is-open{opacity:1}
.dfs-pin{flex:none;font-size:10px;color:var(--dsw-alias-brand-primary)}
.dfs-input{flex:1;min-width:0;height:20px;padding:0 4px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.dfs-menu{position:fixed;z-index:40;width:168px;padding:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 24px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:1px}
.dfs-menuItem{display:flex;align-items:center;gap:4px;width:100%;box-sizing:border-box;padding:5px 8px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer}
.dfs-menuCheck{flex:none;width:16px;text-align:center;color:var(--dsw-alias-brand-primary)}
.dfs-menuLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfs-menuItem:hover{background:var(--dsw-alias-bg-layer-2)}
.dfs-menuItem.is-danger{color:var(--dsw-alias-state-error-primary)}
.dfs-menuDivider{height:1px;margin:4px 2px;background:var(--dsw-alias-border-l1)}
.dfs-menuCaption{padding:3px 8px 1px;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary);opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dfs-confirm{display:flex;align-items:center;gap:6px;padding:5px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dfs-confirmText{flex:1;min-width:0;line-height:1.4}
.dfs-miniBtn{padding:2px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer}
.dfs-miniBtn.is-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dfs-miniBtn:hover{background:var(--dsw-alias-bg-layer-2)}
.dfs-empty{padding:10px 8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dfs-row.is-archived{opacity:.55}
.dfs-notice{display:flex;align-items:center;gap:8px;margin:6px 2px 0;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:1.4}
.dfs-noticeText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dfs-noticeAction{flex:none;padding:0 2px;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer}
.dfs-noticeAction:hover{text-decoration:underline}
.dfs-hover{position:fixed;z-index:39;min-width:150px;max-width:260px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 24px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:2px;pointer-events:none}
.dfs-hoverRow{display:flex;align-items:center;gap:6px;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary)}
.dfs-hoverRow .dfs-status{width:18px;height:16px}
.dfs-hoverLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dfs-hoverSpacer{width:16px;flex:none}
.dfs-rail{display:flex;flex-direction:column;align-items:center;padding-top:8px}
`

    // Icons below reproduce the shipped `ui-primitives` geometry (16×16 grid,
    // stroke width 1 for the "Regular" weight) instead of importing the package.
    function iconFrame(children, options) {
      const size = options?.size ?? 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true,
        strokeWidth: 1,
        style: { flex: 'none', color: options?.color ?? 'currentColor' },
      }, children)
    }

    /** IconFolderCloseRegular */
    function FolderIcon(options) {
      return iconFrame([
        h('path', {
          key: 'body',
          d: 'M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z',
          stroke: 'currentColor',
        }),
        h('path', { key: 'line', d: 'M3.63501 7.66614H12.3647', stroke: 'currentColor' }),
      ], { size: options?.size ?? 16, color: options?.color })
    }

    /** IconTriangleRightFillRegular — the shipped row arrow. */
    function ChevronIcon() {
      return iconFrame(h('path', {
        d: 'M5.5 4.5C5.5 4.40714 5.52586 4.31612 5.57467 4.23713C5.62349 4.15815 5.69334 4.09431 5.77639 4.05279C5.85945 4.01126 5.95242 3.99368 6.0449 4.00202C6.13738 4.01036 6.22572 4.04429 6.3 4.1L10.967 7.6C11.0291 7.64657 11.0795 7.70697 11.1142 7.77639C11.1489 7.84582 11.167 7.92238 11.167 8C11.167 8.07762 11.1489 8.15418 11.1142 8.22361C11.0795 8.29303 11.0291 8.35343 10.967 8.4L6.3 11.9C6.22572 11.9557 6.13738 11.9896 6.0449 11.998C5.95242 12.0063 5.85945 11.9887 5.77639 11.9472C5.69334 11.9057 5.62349 11.8419 5.57467 11.7629C5.52586 11.6839 5.5 11.5929 5.5 11.5V4.5Z',
        fill: 'currentColor',
      }), { size: 14, color: 'var(--dsw-alias-label-secondary)' })
    }

    /** IconChevronLeftOutlineRegular */
    function BackIcon() {
      return iconFrame(h('path', {
        d: 'M10 4L6.70711 7.29289C6.31658 7.68342 6.31658 8.31658 6.70711 8.70711L10 12',
        stroke: 'currentColor',
      }), { size: 14, color: 'var(--dsw-alias-label-secondary)' })
    }

    /** IconEllipsisOutlineRegular */
    function DotsIcon() {
      return iconFrame([
        h('path', { key: 'a', d: 'M3 9C3.55228 9 4 8.55228 4 8C4 7.44772 3.55228 7 3 7C2.44772 7 2 7.44772 2 8C2 8.55228 2.44772 9 3 9Z', fill: 'currentColor' }),
        h('path', { key: 'b', d: 'M8 9C8.55228 9 9 8.55228 9 8C9 7.44772 8.55228 7 8 7C7.44772 7 7 7.44772 7 8C7 8.55228 7.44772 9 8 9Z', fill: 'currentColor' }),
        h('path', { key: 'c', d: 'M13 9C13.5523 9 14 8.55228 14 8C14 7.44772 13.5523 7 13 7C12.4477 7 12 7.44772 12 8C12 8.55228 12.4477 9 13 9Z', fill: 'currentColor' }),
      ], { size: 16 })
    }

    /** IconSearchOutlineRegular */
    function SearchIcon() {
      return iconFrame([
        h('path', {
          key: 'lens',
          d: 'M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z',
          stroke: 'currentColor',
        }),
        h('path', { key: 'handle', d: 'M10.2991 10.3933L14.7783 14.8725', stroke: 'currentColor' }),
      ], { size: 16, color: 'var(--dsw-alias-label-secondary)' })
    }

    /** IconSlidersTwoOutlineRegular — the shipped view-options glyph. */
    function SlidersIcon() {
      return iconFrame([
        h('path', { key: 'l1', d: 'M2.3 5h5.85M12.05 5h1.65', stroke: 'currentColor' }),
        h('circle', { key: 'c1', cx: 9.95, cy: 5, r: 1.45, stroke: 'currentColor' }),
        h('path', { key: 'l2', d: 'M2.3 11h1.65M7.85 11h5.85', stroke: 'currentColor' }),
        h('circle', { key: 'c2', cx: 5.75, cy: 11, r: 1.45, stroke: 'currentColor' }),
      ], { size: 16 })
    }

    /** IconPinFillRegular */
    function PinIcon() {
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
      ], { size: 14 })
    }

    /** IconCloseFillRegular */
    function CloseIcon() {
      return iconFrame([
        h('path', { key: 'a', d: 'M3.5 3.5L12.5 12.5', stroke: 'currentColor' }),
        h('path', { key: 'b', d: 'M12.5 3.5L3.5 12.5', stroke: 'currentColor' }),
      ], { size: 14 })
    }

    /** IconNewChatOutlineRegular */
    function NewChatIcon() {
      return iconFrame([
        h('path', {
          key: 'bubble',
          d: 'M2.37091 11.2501C1.58745 9.89288 1.32067 8.29835 1.61969 6.76006C1.91872 5.22177 2.76342 3.8433 3.99826 2.87846C5.2331 1.91362 6.77494 1.42737 8.33988 1.50925C9.90482 1.59113 11.3875 2.23562 12.5149 3.32406C13.6425 4.41269 14.3387 5.87206 14.4754 7.4334C14.612 8.99474 14.18 10.5529 13.2587 11.8209C12.3375 13.0888 10.9891 13.9813 9.46194 14.3337C8.18691 14.628 6.85895 14.5294 5.64989 14.0605C5.1712 13.8748 4.76962 13.4932 4.26534 13.3967C3.67413 13.2835 2.95257 13.5598 2.03794 14.3337',
          stroke: 'currentColor',
        }),
        h('path', { key: 'v', d: 'M8 5V11', stroke: 'currentColor' }),
        h('path', { key: 'h', d: 'M5 8H11', stroke: 'currentColor' }),
      ], { size: 16 })
    }

    /** IconProjectAddOutlineRegular — add-workspace. */
    function ProjectAddIcon() {
      return iconFrame([
        h('path', {
          key: 'body',
          d: 'M5.54492 2.06738C5.91034 2.06754 6.26318 2.20149 6.53711 2.44336L7.94043 3.68164V4.7998C7.71462 4.74105 7.50367 4.63139 7.32617 4.47461L5.87598 3.19238C5.78477 3.11185 5.66658 3.06754 5.54492 3.06738H2.94922C2.67322 3.06738 2.44946 3.29145 2.44922 3.56738V12.4326C2.44927 12.7087 2.67311 12.9326 2.94922 12.9326H12.9326C13.2086 12.9325 13.4326 12.7086 13.4326 12.4326V8.53613H14.4326V12.4326C14.4326 13.2609 13.7609 13.9325 12.9326 13.9326H2.94922C2.12083 13.9326 1.44927 13.261 1.44922 12.4326V3.56738C1.44946 2.73916 2.12094 2.06738 2.94922 2.06738H5.54492Z',
          fill: 'currentColor',
        }),
        h('path', { key: 'h', d: 'M9.75977 4.50208H14.5509', stroke: 'currentColor' }),
        h('path', { key: 'v', d: 'M12.1492 6.89758L12.1492 2.10642', stroke: 'currentColor' }),
      ], { size: 16 })
    }

    /** IconCheckOutlineRegular — completed. */
    function CheckIcon() {
      return iconFrame(h('path', {
        d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4',
        stroke: 'currentColor',
      }), { size: 14 })
    }

    /** IconQuestionOutlineRegular — waiting for you. */
    function QuestionIcon() {
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
      ], { size: 14 })
    }

    /** IconWarningOutlineRegular — failure or interruption. */
    function WarningIcon() {
      return iconFrame([
        h('path', {
          key: 'circle',
          d: 'M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z',
          stroke: 'currentColor',
        }),
        h('path', { key: 'bar', d: 'M8 4.29199V9.79199', stroke: 'currentColor' }),
        h('path', { key: 'dot', d: 'M8 10.708V11.708', stroke: 'currentColor' }),
      ], { size: 14 })
    }

    /**
     * One title line: the outer span clips, the inner span scrolls on hover.
     * The marquee only starts for text that does not fit, so short names stay
     * still and keep their ellipsis when narrowed.
     */
    function Title(props) {
      const className = props.className ?? 'dfs-title'
      return h('span', { className, title: props.title ?? props.text },
        h('span', { className: 'dfs-titleText' }, props.text))
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
          return h('div', {
            className: 'dfs-empty',
            style: { color: 'var(--dsw-alias-state-error-primary)' },
          }, 'folder-sidebar: ', this.state.message)
        }
        return this.props.children
      }
    }




    return {
      inject: ['slots', 'locale', 'uiWorkspace', 'workspaces', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTS))
        const t = ctx.locale.bind(NS)

        /**
         * The leading status cell: a fixed 16px slot on every Session row so
         * titles stay aligned whether or not the row has a state. Completed,
         * waiting and failure reuse the shipped glyphs; running is the spinner.
         */
        function statusIcon(kind) {
          if (kind === 'completed') return CheckIcon
          if (kind === 'waiting') return QuestionIcon
          if (kind === 'error') return WarningIcon
          return undefined
        }

        function Indicator({ kind, title }) {
          const Glyph = statusIcon(kind)
          if (Glyph !== undefined) {
            return h('span', {
              className: 'dfs-status dfs-glyph',
              style: { color: GLYPH_COLOR[kind] },
              title,
              'aria-label': title,
              role: 'img',
            }, h(Glyph))
          }
          if (kind === undefined) {
            return h('span', { className: 'dfs-status', title, 'aria-label': title, role: 'img' },
              h('span', { className: 'dfs-statusDot is-none' }))
          }
          if (kind === 'running') {
            return h('span', { className: 'dfs-status', title, 'aria-label': title, role: 'img' },
              h('span', { className: 'dfs-spinner' }))
          }
          return h('span', { className: 'dfs-status', title, 'aria-label': title, role: 'img' },
            h('span', { className: `dfs-statusDot is-${kind}` }))
        }

        /** A Workspace row's single status cell: the folder icon itself. */
        function FolderGlyph({ kind, label }) {
          const color = kind === 'error' ? 'var(--dsw-alias-state-error-primary)'
            : kind === 'waiting' ? 'var(--dsw-alias-state-warn-primary)'
              : kind === 'completed' ? 'var(--dsw-alias-state-success-primary)'
                : kind === 'stopped' ? 'var(--dsw-alias-state-idle-primary)'
                  : 'var(--dsw-alias-label-secondary)'
          const Glyph = statusIcon(kind)
          if (Glyph !== undefined) {
            return h('span', {
              className: 'dfs-status dfs-statusFolder dfs-glyph',
              style: { color: GLYPH_COLOR[kind] },
              title: label,
              'aria-label': label,
              role: 'img',
            }, h(Glyph))
          }
          if (kind === 'running') {
            return h('span', {
              className: 'dfs-status dfs-statusFolder',
              title: label,
              'aria-label': label,
              role: 'img',
            }, h('span', { className: 'dfs-spinner' }))
          }
          return h('span', {
            className: 'dfs-status dfs-statusFolder',
            title: label,
            'aria-label': label,
            role: 'img',
          }, h('span', { className: 'dfs-folderGlyph' }, h(FolderIcon, { color })))
        }

        function FolderSidebar(props) {
          const wide = props.wide !== false
          const expandSidebar = props.expandSidebar
          const useWorkspaces = props.useWorkspaces
          const useSessions = props.useSessions
          const useSessionStatus = props.useSessionStatus

          const [openId, setOpenId] = React.useState(null)
          const [query, setQuery] = React.useState('')
          const [menuFor, setMenuFor] = React.useState(null)
          const [rename, setRename] = React.useState(null)
          const [confirm, setConfirm] = React.useState(null)
          const [archivedFilter, setArchivedFilter] = React.useState(() => readArchivedFilter())
          const [notice, setNotice] = React.useState(null)
          const [contentHits, setContentHits] = React.useState([])
          const [searching, setSearching] = React.useState(false)
          const [hoverFor, setHoverFor] = React.useState(null)
          const [searchOpen, setSearchOpen] = React.useState(false)
          const searchInput = React.useRef(null)
          const hoverTimer = React.useRef(undefined)
          const [sortState, setSortState] = React.useState(() => readSortState())
          const folderSort = sortState.folders
          const sessionSort = sortState.sessions

          const workspaceItems = typeof useWorkspaces === 'function' ? useWorkspaces((state) => state.items) : undefined
          const archivedIds = typeof useWorkspaces === 'function' ? useWorkspaces((state) => state.archivedSessionIds) : undefined
          const pinnedIds = typeof useWorkspaces === 'function' ? useWorkspaces((state) => state.pinnedSessionIds) : undefined
          const list = typeof useSessions === 'function' ? useSessions((state) => state) : undefined
          const projections = typeof useSessions === 'function' ? useSessions((state) => state.projectionsBySession) : undefined
          const statusMap = typeof useSessionStatus === 'function' ? useSessionStatus((state) => state) : undefined

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

          const currentId = React.useMemo(() => {
            const byId = list === undefined || list === null ? undefined : list.byId
            if (byId === undefined || byId === null) return undefined
            for (const id of Object.keys(byId)) {
              const summary = byId[id]
              if (summary !== null && typeof summary === 'object' && (summary.retainedBy?.mainView ?? 0) > 0) return id
            }
            return undefined
          }, [list])

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

          // Close transient UI when the region loses the selection it belongs to.
          React.useEffect(() => {
            if (menuFor === null) return undefined
            const onDown = (event) => {
              const target = event.target
              if (target === null || typeof target.closest !== 'function') { setMenuFor(null); return }
              // A press inside the panel must reach the item; a press on the
              // trigger is the trigger's own toggle. Anything else dismisses.
              const insideMenu = target.closest('[data-dfs-menu]') !== null
              const onTrigger = target.closest('[data-dfs-menu-trigger]') !== null
              if (!insideMenu && !onTrigger) setMenuFor(null)
            }
            const onKey = (event) => { if (event.key === 'Escape') setMenuFor(null) }
            const onScroll = () => setMenuFor(null)
            document.addEventListener('pointerdown', onDown)
            document.addEventListener('keydown', onKey)
            document.addEventListener('scroll', onScroll, true)
            return () => {
              document.removeEventListener('pointerdown', onDown)
              document.removeEventListener('keydown', onKey)
              document.removeEventListener('scroll', onScroll, true)
            }
          }, [menuFor])

          /** One transient bar; an optional action keeps "撤销" reachable. */
          const notify = (message, action) => setNotice({ message, action: action ?? null })

          React.useEffect(() => {
            if (notice === null) return undefined
            const timer = setTimeout(() => setNotice(null), notice.action === null ? 2200 : 6000)
            return () => clearTimeout(timer)
          }, [notice])

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

          /** Sessions that belong to no Workspace (shipped "Ungrouped" bucket). */
          const ungroupedWorkspace = React.useMemo(() => {
            const byId = list === undefined || list === null ? undefined : list.byId
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
          }, [list, workspaces, t])

          /**
           * Rows per Workspace, derived once per render instead of once per
           * caller: the list, its status cell and the hover card all read it.
           */
          const rowsIndex = React.useMemo(() => {
            const byId = list === undefined || list === null ? undefined : list.byId
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
          }, [list, archived, pinned, currentId, archivedFilter, workspaces, ungroupedWorkspace])

          const rowsFor = (workspace) => rowsIndex.get(workspace.workspaceId) ?? []


          const workspaceOf = React.useCallback((sessionId) => {
            for (const workspace of workspaces) {
              if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) return workspace
            }
            return undefined
          }, [workspaces])

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
            const byId = list === undefined || list === null ? undefined : list.byId
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
            [workspaces, folderSort, list],
          )

          /** Pinned rows stay first in every mode; direction applies inside groups. */
          /** Session ordering for the active level (pure comparator lives up top). */
          const orderSessions = (rows) => sortSessions(rows, sessionSort, {
            titleOf,
            isPinned: (row) => pinned.has(row.id),
            updatedAtOf: (row) => row.updatedAt,
          })

          /** The level in view owns the sort: folders outside, Sessions inside. */
          const activeLevel = openId === null ? 'folders' : 'sessions'
          const activeSort = sortState[activeLevel]

          // Folder drag-and-drop: only meaningful when the Host order is the
          // rendered order (manual + ascending) and the flat list is visible.
          const [dragId, setDragId] = React.useState(null)
          const [dropEdge, setDropEdge] = React.useState(null)
          const canReorder = folderSort.mode === 'manual' && folderSort.dir === 'asc'
            && openId === null && query.trim() === ''
          const clearDrag = () => {
            setDragId(null)
            setDropEdge(null)
          }

          React.useEffect(() => {
            if (!canReorder) clearDrag()
          }, [canReorder])

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

          const commitSort = (patch) => {
            const next = {
              ...sortState,
              [activeLevel]: { ...sortState[activeLevel], ...patch },
            }
            setSortState(next)
            writeSortState(next)
            setMenuFor(null)
          }

          const chooseMode = (mode) => commitSort({ mode, dir: SORT_NATURAL_DIR[mode] })

          const modeItems = () => SORT_MODES.map((mode) => ({
            key: `mode:${mode}`,
            label: t(`sort.${mode}`),
            check: mode === activeSort.mode,
            onSelect: () => chooseMode(mode),
          }))

          const dirItems = () => SORT_DIRS.map((dir) => ({
            key: `dir:${dir}`,
            label: `${t(`sort.${dir}`)} ${dir === 'desc' ? '↓' : '↑'}`,
            check: dir === activeSort.dir,
            onSelect: () => commitSort({ dir }),
          }))

          const folderKindOf = React.useCallback((workspace) => {
            const candidates = []
            for (const summary of rowsFor(workspace)) {
              const kind = indicatorOf(statusOf(summary.id), projectionOf(summary.id))
              if (kind === undefined) continue
              const projection = projectionOf(summary.id)
              const since = projection !== undefined && projection !== null
                && typeof projection.since === 'number' && projection.since > 0
                ? projection.since
                : (summary.updatedAt ?? 0)
              candidates.push({ kind, since })
            }
            return pickFolderKind(candidates)
          }, [rowsFor, statusOf, projectionOf])

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

          /** Every status one Session carries, for the hover card. */
          const statusRowsOf = (status, projection, updatedAt) => {
            const rows = []
            if (status !== undefined && status !== null
              && status.pendingInteraction !== undefined && status.pendingInteraction !== null) {
              rows.push({ key: 'waiting', kind: 'waiting', label: waitingLabel(status) })
            }
            if (status !== undefined && status !== null && status.running === true) {
              rows.push({ key: 'running', kind: 'running', label: labels.running })
            }
            const state = projection === undefined || projection === null ? undefined : projection.state
            if (state === 'failed' || state === 'interrupted') rows.push({ key: 'error', kind: 'error', label: labels.error })
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
              const kind = indicatorOf(statusOf(summary.id), projectionOf(summary.id))
              if (kind === undefined) continue
              counts.set(kind, (counts.get(kind) ?? 0) + 1)
            }
            const rows = []
            for (const kind of INDICATOR_PRIORITY) {
              const count = counts.get(kind)
              if (count === undefined) continue
              rows.push({ key: kind, kind, label: `${labels[kind]} ×${count}` })
            }
            if (rows.length === 0) rows.push({ key: 'idle', kind: undefined, label: t('status.idle') })
            return rows
          }

          const cancelHover = () => {
            if (hoverTimer.current !== undefined) {
              clearTimeout(hoverTimer.current)
              hoverTimer.current = undefined
            }
            setHoverFor(null)
          }

          const scheduleHover = (key, rows, event) => {
            if (menuFor !== null || dragId !== null) return
            if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current)
            const rect = event.currentTarget.getBoundingClientRect()
            hoverTimer.current = setTimeout(() => {
              hoverTimer.current = undefined
              const width = 200
              const height = rows.length * 20 + 16
              const viewportW = typeof window === 'undefined' ? 1280 : window.innerWidth
              const viewportH = typeof window === 'undefined' ? 800 : window.innerHeight
              setHoverFor({
                key,
                rows,
                left: Math.max(8, Math.min(rect.left + 8, viewportW - width - 8)),
                top: Math.max(8, Math.min(rect.bottom + 6, viewportH - height - 8)),
              })
            }, 350)
          }

          React.useEffect(() => () => {
            if (hoverTimer.current !== undefined) clearTimeout(hoverTimer.current)
          }, [])

          /** Reveal a clipped title by scrolling it while the row is hovered. */
          const startMarquee = (event) => {
            const row = event.currentTarget
            if (row === null || typeof row.querySelector !== 'function') return
            const text = row.querySelector('.dfs-titleText')
            const box = text === null ? null : text.parentElement
            if (text === null || box === null) return
            const shift = marqueeShiftOf(text.scrollWidth, box.clientWidth)
            if (shift === 0) return
            text.style.setProperty('--dfs-marquee-shift', `-${shift}px`)
            text.style.setProperty('--dfs-marquee-duration', `${marqueeDurationOf(shift)}ms`)
            box.classList.add('is-marquee')
          }

          const stopMarquee = (event) => {
            const row = event.currentTarget
            if (row === null || typeof row.querySelector !== 'function') return
            const text = row.querySelector('.dfs-titleText')
            const box = text === null ? null : text.parentElement
            if (text === null || box === null) return
            box.classList.remove('is-marquee')
            text.style.removeProperty('--dfs-marquee-shift')
            text.style.removeProperty('--dfs-marquee-duration')
          }


          React.useEffect(() => {
            if (hoverFor === null) return undefined
            const onScroll = () => setHoverFor(null)
            document.addEventListener('scroll', onScroll, true)
            return () => document.removeEventListener('scroll', onScroll, true)
          }, [hoverFor])

          const openSession = (sessionId) => {
            setMenuFor(null)
            setQuery('')
            setSearchOpen(false)
            if (typeof ctx.uiWorkspace?.openSession === 'function') ctx.uiWorkspace.openSession(sessionId)
          }

          const startSession = (workspaceId) => {
            setMenuFor(null)
            if (typeof ctx.uiWorkspace?.startSession === 'function') ctx.uiWorkspace.startSession(workspaceId)
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

          /** Every failed action is both logged and shown; silence hides bugs. */
          const reportFailure = (error, messageKey) => {
            console.warn('[folder-sidebar] action failed', error)
            notify(t(messageKey))
          }

          const run = (promise, messageKey) => {
            Promise.resolve(promise).catch((error) => reportFailure(error, messageKey))
          }

          const togglePin = (sessionId) => {
            setMenuFor(null)
            const call = pinned.has(sessionId) ? ctx.uiWorkspace?.unpinSession : ctx.uiWorkspace?.pinSession
            if (typeof call !== 'function') return
            run(call.call(ctx.uiWorkspace, sessionId), 'notice.pinFailed')
          }

          const archiveNow = (sessionId, stopActivity) => {
            setConfirm(null)
            setMenuFor(null)
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
            setMenuFor(null)
            const call = ctx.uiWorkspace?.forkSession
            if (typeof call === 'function') run(call.call(ctx.uiWorkspace, sessionId), 'notice.forkFailed')
          }

          const copyId = (sessionId) => {
            setMenuFor(null)
            const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
            if (clipboard === undefined || typeof clipboard.writeText !== 'function') return
            Promise.resolve(clipboard.writeText(sessionId))
              .then(() => notify(t('copied')))
              .catch(() => {})
          }

          const startRenameSession = (summary) => {
            setMenuFor(null)
            setRename({ kind: 'session', id: summary.id, value: titleOf(summary) })
          }

          const startRenameWorkspace = (workspace) => {
            setMenuFor(null)
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
            setMenuFor(null)
            const remove = ctx.workspaces?.delete
            if (typeof remove !== 'function') return
            Promise.resolve(remove.call(ctx.workspaces, workspaceId))
              .then(() => setOpenId(null))
              .catch((error) => reportFailure(error, 'notice.deleteFailed'))
          }

          /** Move one Workspace before another; `undefined` appends. */
          const moveWorkspace = (workspaceId, beforeId) => {
            setMenuFor(null)
            const insertBefore = ctx.workspaces?.insertBefore
            if (typeof insertBefore !== 'function') return
            run(insertBefore.call(ctx.workspaces, workspaceId, beforeId), 'notice.moveFailed')
          }

          // ----- rename input -----
          const renameInput = (draft) => h('input', {
            key: 'rename',
            className: 'dfs-input',
            value: draft.value,
            autoFocus: true,
            onClick: (event) => event.stopPropagation(),
            onContextMenu: (event) => event.stopPropagation(),
            onChange: (event) => setRename({ ...draft, value: event.target.value }),
            onKeyDown: (event) => {
              if (event.key === 'Enter') { event.preventDefault(); commitRename() }
              if (event.key === 'Escape') { event.preventDefault(); setRename(null) }
            },
          })

          // ----- menu -----
          // Rendered once at the root as a fixed layer: a panel inside the
          // scrolling list would be clipped at the list's edge.
          const menuEl = menuFor === null ? null : h('div', {
            className: 'dfs-menu',
            'data-dfs-menu': '1',
            role: 'menu',
            style: { left: menuFor.left, top: menuFor.top },
          }, menuFor.items.map((item) => (item.kind === 'divider'
            ? h('div', { key: item.key, className: 'dfs-menuDivider', role: 'separator' })
            : item.kind === 'caption'
              ? h('div', { key: item.key, className: 'dfs-menuCaption', role: 'presentation' }, item.label)
              : h('button', {
                key: item.key,
                type: 'button',
                role: item.check === undefined ? 'menuitem' : 'menuitemradio',
                'aria-checked': item.check === undefined ? undefined : item.check,
                className: `dfs-menuItem${item.danger === true ? ' is-danger' : ''}`,
                onClick: (event) => { event.stopPropagation(); item.onSelect() },
              },
              item.check === undefined
                ? item.label
                : [
                  h('span', { key: 'check', className: 'dfs-menuCheck', 'aria-hidden': true }, item.check ? '✓' : ''),
                  h('span', { key: 'label', className: 'dfs-menuLabel' }, item.label),
                ]))))

          const noticeEl = () => h('div', { className: 'dfs-notice', role: 'status' },
            h('span', { className: 'dfs-noticeText' }, notice.message),
            notice.action === null ? null : h('button', {
              key: 'action',
              type: 'button',
              className: 'dfs-noticeAction',
              onClick: () => { notice.action.onSelect(); setNotice(null) },
            }, notice.action.label))

          const hoverEl = hoverFor === null ? null : h('div', {
            className: 'dfs-hover',
            role: 'tooltip',
            style: { left: hoverFor.left, top: hoverFor.top },
          }, hoverFor.rows.map((row) => h('div', { key: row.key, className: 'dfs-hoverRow' },
            row.kind === undefined
              ? h('span', { className: 'dfs-hoverSpacer' })
              : h(Indicator, { kind: row.kind, title: row.label }),
            h('span', { className: 'dfs-hoverLabel' }, row.label))))

          /** Place the menu with the pointer or a trigger rect, kept in the viewport. */
          const showMenu = (key, items, x, y) => {
            cancelHover()
            const width = 168
            const height = items.length * 26 + 10
            const viewportW = typeof window === 'undefined' ? 1280 : window.innerWidth
            const viewportH = typeof window === 'undefined' ? 800 : window.innerHeight
            setMenuFor({
              key,
              items,
              left: Math.max(8, Math.min(x, viewportW - width - 8)),
              top: Math.max(8, Math.min(y, viewportH - height - 8)),
            })
          }

          const toggleMenuAt = (key, items, event) => {
            event.stopPropagation()
            if (menuFor !== null && menuFor.key === key) { setMenuFor(null); return }
            const rect = event.currentTarget.getBoundingClientRect()
            showMenu(key, items, rect.right - 168, rect.bottom + 4)
          }

          const contextMenuHandler = (key, items) => (event) => {
            event.preventDefault()
            event.stopPropagation()
            showMenu(key, items, event.clientX, event.clientY)
          }

          const menuTrigger = (key, items) => h('button', {
            type: 'button',
            className: 'dfs-iconBtn',
            'data-dfs-menu-trigger': '1',
            title: t('action.menu'),
            'aria-label': t('action.menu'),
            'aria-expanded': menuFor !== null && menuFor.key === key,
            onClick: (event) => toggleMenuAt(key, items, event),
          }, DotsIcon())

          if (!wide) {
            return h('div', { className: 'dfs-rail' },
              h('button', {
                type: 'button', className: 'dfs-iconBtn', title: t('rail.expand'),
                'aria-label': t('rail.expand'),
                onClick: () => { if (typeof expandSidebar === 'function') expandSidebar() },
              }, FolderIcon()))
          }

          const body = [h('style', { key: 'style' }, CSS)]

          // ----- search results replace both levels while a query exists -----
          const text = query.trim()
          if (text !== '') {
            const lower = text.toLowerCase()
            const byId = list === undefined || list === null ? undefined : list.byId
            const seen = new Set()
            const hits = []
            if (byId !== undefined && byId !== null) {
              for (const id of Object.keys(byId)) {
                const summary = byId[id]
                if (summary === null || typeof summary !== 'object') continue
                const isArchivedHit = archived.has(id)
                if (archivedFilter === 'hide' && isArchivedHit) continue
                if (archivedFilter === 'only' && !isArchivedHit) continue
                const workspace = workspaceOf(id) ?? ungroupedWorkspace
                const title = titleOf(summary)
                if (!title.toLowerCase().includes(lower)) continue
                seen.add(id)
                hits.push({ sessionId: id, title, workspace, snippet: undefined })
              }
            }
            for (const item of contentHits) {
              if (!seen.has(item.sessionId)) {
                const summary = byId === undefined || byId === null ? undefined : byId[item.sessionId]
                const workspace = workspaceOf(item.sessionId) ?? ungroupedWorkspace
                const isArchivedHit = archived.has(item.sessionId)
                if (summary === undefined) continue
                if (archivedFilter === 'hide' && isArchivedHit) continue
                if (archivedFilter === 'only' && !isArchivedHit) continue
                seen.add(item.sessionId)
                hits.push({ sessionId: item.sessionId, title: titleOf(summary), workspace, snippet: item.snippet })
              }
            }
            const resultRows = hits.slice(0, 30).map((hit) => h('div', { key: hit.sessionId, className: 'dfs-rowWrap' },
              h('div', {
                className: 'dfs-row', role: 'button', tabIndex: 0,
                onMouseEnter: startMarquee,
                onMouseLeave: stopMarquee,
                onClick: () => openSession(hit.sessionId),
                onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openSession(hit.sessionId) } },
              },
              h(Title, { text: hit.title }),
              h('span', { className: 'dfs-time' }, baseName(hit.workspace.path) || t('group.ungrouped')),
              hit.snippet === undefined ? null : h('span', { className: 'dfs-snippet' }, `${t('search.content')}: ${hit.snippet}`))))
            body.push(topBar())
            body.push(h('div', { key: 'list', className: 'dfs-list' },
              resultRows.length === 0 ? [h('div', { key: 'empty', className: 'dfs-empty' }, t('empty.search'))] : resultRows))
            return h('div', { className: 'dfs-root' }, body)
          }

          /** Shared top bar for both levels: optional back, title, actions. */
          function headerBar(key, options) {
            const parts = []
            if (options.back === true) {
              parts.push(h('button', {
                key: 'back',
                type: 'button',
                className: 'dfs-iconBtn dfs-headBack',
                title: t('action.back'),
                'aria-label': t('action.back'),
                onClick: () => { setOpenId(null); setQuery('') },
              }, h(BackIcon)))
            }
            parts.push(options.titleNode ?? h('span', { key: 'title', className: 'dfs-headTitle', title: options.title }, options.title))
            for (const action of options.actions ?? []) parts.push(action)
            return h('div', { key, className: 'dfs-head' }, parts)
          }

          /** The search bar that overlays the header while expanded. */
          function searchBar(key) {
            return h('div', { key, className: 'dfs-search dfs-searchHeader', 'aria-hidden': searchOpen ? undefined : 'true' },
              h(SearchIcon, null),
              h('input', {
                ref: searchInput,
                tabIndex: searchOpen ? 0 : -1,
                value: query,
                placeholder: t('search.placeholder'),
                'aria-label': t('action.search'),
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Escape') closeSearch() },
              }),
              h('button', {
                key: 'close',
                type: 'button',
                tabIndex: searchOpen ? 0 : -1,
                className: 'dfs-iconBtn',
                title: t('action.close'),
                'aria-label': t('action.close'),
                onClick: () => closeSearch(),
              }, h(CloseIcon)))
          }

          const closeSearch = () => {
            setSearchOpen(false)
            setQuery('')
          }

          React.useEffect(() => {
            if (!searchOpen) return undefined
            const node = searchInput.current
            if (node !== null && typeof node.focus === 'function') node.focus()
            return undefined
          }, [searchOpen])

          /** The fixed top bar: identical on both levels, a home for actions. */
          function mainHeader(key) {
            return headerBar(key, {
            title: t('section.title'),
            actions: [
              h('button', {
                key: 'search',
                type: 'button',
                className: 'dfs-iconBtn',
                title: t('action.search'),
                'aria-label': t('action.search'),
                onClick: (event) => { event.stopPropagation(); setSearchOpen(true) },
              }, SearchIcon()),
              h('button', {
                key: 'view',
                type: 'button',
                className: 'dfs-iconBtn',
                title: `${t('action.view')} · ${t(`sort.${activeSort.mode}`)} ${activeSort.dir === 'desc' ? '↓' : '↑'} · ${t(`view.${archivedFilter}`)}`,
                'aria-label': t('action.view'),
                onClick: (event) => {
                  event.stopPropagation()
                  const rect = event.currentTarget.getBoundingClientRect()
                  showMenu('view', viewMenuItems(), rect.right - 168, rect.bottom + 4)
                },
              }, h(SlidersIcon)),
              h('button', {
                key: 'add',
                type: 'button', className: 'dfs-iconBtn', title: t('action.addWorkspace'),
                'aria-label': t('action.addWorkspace'), onClick: addWorkspace,
              }, h(ProjectAddIcon)),
            ],
            })
          }

          /** One top bar: header and search overlay share a row so the switch animates. */
          function topBar() {
            return h('div', { key: 'topbar', className: 'dfs-topbar' + (searchOpen ? ' is-search' : '') },
              mainHeader('head'),
              searchBar('searchbar'))
          }

          const unarchive = (sessionId) => {
            setMenuFor(null)
            const call = ctx.uiWorkspace?.unarchiveSession
            if (typeof call !== 'function') return
            Promise.resolve(call.call(ctx.uiWorkspace, sessionId))
              .catch((error) => reportFailure(error, 'notice.unarchiveFailed'))
          }

          const applyArchivedFilter = (value) => {
            setArchivedFilter(value)
            writeArchivedFilter(value)
            setMenuFor(null)
          }

          /** One view-options menu: ordering for the level in view, then visibility. */
          const viewMenuItems = () => ([
            { key: 'caption:sort', kind: 'caption', label: `${t('action.sort')} · ${activeLevel === 'folders' ? t('level.folders') : t('level.sessions')}` },
            ...modeItems(),
            ...dirItems(),
            { key: 'divider', kind: 'divider' },
            { key: 'caption:view', kind: 'caption', label: t('action.view') },
            ...ARCHIVED_FILTERS.map((value) => ({
              key: `view:${value}`,
              label: t(`view.${value}`),
              check: value === archivedFilter,
              onSelect: () => applyArchivedFilter(value),
            })),
          ])

          const openWorkspace = openId === null
            ? undefined
            : (openId === UNGROUPED
              ? ungroupedWorkspace
              : workspaces.find((workspace) => workspace.workspaceId === openId))

          if (openWorkspace === undefined) {
            const listRows = []
            orderedWorkspaces.forEach((workspace) => {
              const rows = rowsFor(workspace)
              if (archivedFilter === 'only' && rows.length === 0) return
              const name = displayNameOf(workspace)
              const isCurrent = workspace.workspaceId === currentWorkspaceId
              const renaming = rename !== null && rename.kind === 'workspace' && rename.id === workspace.workspaceId
              const menuKey = `workspace:${workspace.workspaceId}`
              const folderKind = folderKindOf(workspace)
              const hostIndex = workspaces.indexOf(workspace)
              const moveItems = []
              if (folderSort.mode === 'manual' && folderSort.dir === 'asc') {
                if (hostIndex > 0) {
                  moveItems.push({
                    key: 'up',
                    label: t('action.moveUp'),
                    onSelect: () => moveWorkspace(workspace.workspaceId, workspaces[hostIndex - 1].workspaceId),
                  })
                }
                if (hostIndex < workspaces.length - 1) {
                  const following = hostIndex + 2 < workspaces.length ? workspaces[hostIndex + 2].workspaceId : undefined
                  moveItems.push({
                    key: 'down',
                    label: t('action.moveDown'),
                    onSelect: () => moveWorkspace(workspace.workspaceId, following),
                  })
                }
              }
              const folderMenu = [
                { key: 'rename', label: t('action.renameWorkspace'), onSelect: () => startRenameWorkspace(workspace) },
                { key: 'new', label: t('action.newSessionHere'), onSelect: () => startSession(workspace.workspaceId) },
                ...moveItems,
                { key: 'delete', label: t('action.deleteWorkspace'), danger: true, onSelect: () => { setMenuFor(null); setConfirm({ kind: 'deleteWorkspace', workspaceId: workspace.workspaceId }) } },
              ]
              listRows.push(h('div', {
                key: workspace.workspaceId,
                className: `dfs-rowWrap${dropEdge !== null && dropEdge.id === workspace.workspaceId ? ` is-drop-${dropEdge.edge}` : ''}`,
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
                  } catch {
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
                h('div', {
                  className: `dfs-row${isCurrent ? ' is-current' : ''}`,
                  role: 'button',
                  tabIndex: 0,
                  title: typeof workspace.path === 'string' && workspace.path !== '' ? workspace.path : name,
                  onClick: () => { if (!renaming) setOpenId(workspace.workspaceId) },
                  onContextMenu: contextMenuHandler(menuKey, folderMenu),
                  onMouseEnter: (event) => {
                    startMarquee(event)
                    scheduleHover(menuKey, folderStatusRows(workspace), event)
                  },
                  onMouseLeave: (event) => { stopMarquee(event); cancelHover() },
                  onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpenId(workspace.workspaceId) } },
                },
                h(FolderGlyph, { kind: folderKind, label: folderKind === undefined ? undefined : labels[folderKind] }),
                renaming
                  ? renameInput(rename)
                  : h(Title, { text: name === '' ? t('section.title') : name }),
                h('span', { className: `dfs-rowActions${menuFor !== null && menuFor.key === menuKey ? ' is-open' : ''}` },
                  menuTrigger(menuKey, folderMenu)),
                rows.length > 0 ? h('span', { className: 'dfs-badge' }, String(rows.length)) : null,
                h(ChevronIcon, null)),
                confirm !== null && confirm.kind === 'deleteWorkspace' && confirm.workspaceId === workspace.workspaceId
                  ? h('div', { className: 'dfs-confirm' },
                    h('span', { className: 'dfs-confirmText' }, t('confirm.deleteWorkspace')),
                    h('button', { type: 'button', className: 'dfs-miniBtn is-danger', onClick: () => deleteWorkspace(workspace.workspaceId) }, t('confirm.yes')),
                    h('button', { type: 'button', className: 'dfs-miniBtn', onClick: () => setConfirm(null) }, t('confirm.cancel')))
                  : null))
            })
            const ungroupedRows = rowsFor(ungroupedWorkspace)
            if (ungroupedRows.length > 0) {
              const menuKey = 'workspace:' + UNGROUPED
              listRows.push(h('div', { key: UNGROUPED, className: 'dfs-rowWrap' },
                h('div', {
                  className: `dfs-row${openId === UNGROUPED ? ' is-current' : ''}`,
                  role: 'button',
                  tabIndex: 0,
                  title: t('group.ungrouped'),
                  onClick: () => setOpenId(UNGROUPED),
                  onMouseEnter: (event) => {
                    startMarquee(event)
                    scheduleHover(menuKey, folderStatusRows(ungroupedWorkspace), event)
                  },
                  onMouseLeave: (event) => { stopMarquee(event); cancelHover() },
                  onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpenId(UNGROUPED) } },
                },
                h(FolderGlyph, { kind: folderKindOf(ungroupedWorkspace), label: undefined }),
                h(Title, { text: t('group.ungrouped') }),
                h('span', { className: 'dfs-badge' }, String(ungroupedRows.length)),
                h(ChevronIcon, null))))
            }
            if (listRows.length === 0) {
              listRows.push(h('div', { key: 'empty', className: 'dfs-empty' }, t(archivedFilter === 'only' ? 'empty.archived' : 'empty.workspaces')))
            }
            body.push(topBar())
            body.push(h('div', { key: 'list', className: 'dfs-list' }, listRows))
            return h('div', { className: 'dfs-root' }, body, menuEl, hoverEl, notice === null ? null : noticeEl())
          }

          // ----- one Workspace's Session list -----
          const isUngrouped = openWorkspace.workspaceId === UNGROUPED
          const name = isUngrouped
            ? t('group.ungrouped')
            : (typeof openWorkspace.title === 'string' && openWorkspace.title !== ''
              ? openWorkspace.title
              : baseName(openWorkspace.path))
          const workspaceRenaming = rename !== null && rename.kind === 'workspace' && rename.id === openWorkspace.workspaceId
          body.push(topBar())

          // The folder row sits below the search field: the whole row goes back
          // to the folder list, the trailing plus starts a Session here.
          body.push(h('div', {
            key: 'crumb',
            className: 'dfs-crumb',
            role: 'button',
            tabIndex: 0,
            title: t('action.back'),
            onMouseEnter: startMarquee,
            onMouseLeave: stopMarquee,
            onClick: () => { setOpenId(null); setQuery('') },
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpenId(null); setQuery('') }
            },
          },
          h('span', { className: 'dfs-crumbChevron', 'aria-hidden': true }, h(BackIcon)),
          h(FolderIcon, null),
          workspaceRenaming
            ? renameInput(rename)
            : h(Title, { className: 'dfs-crumbName', text: name }),
          isUngrouped ? null : h('button', {
            key: 'new',
            type: 'button', className: 'dfs-iconBtn', title: t('action.newSession'),
            'aria-label': t('action.newSession'),
            onClick: (event) => { event.stopPropagation(); startSession(openWorkspace.workspaceId) },
          }, h(NewChatIcon))))

          const rows = orderSessions(rowsFor(openWorkspace))
          const sessionRows = []
          for (const summary of rows) {
            const status = statusOf(summary.id)
            const kind = indicatorOf(status, projectionOf(summary.id))
            const label = kind === undefined ? undefined : (kind === 'waiting' ? waitingLabel(status) : labels[kind])
            const menuKey = `session:${summary.id}`
            const renaming = rename !== null && rename.kind === 'session' && rename.id === summary.id
            const isPinned = pinned.has(summary.id)
            const isArchived = archived.has(summary.id)
            const openRow = () => {
              if (isArchived) { notify(t('notice.archivedNotOpenable')); return }
              openSession(summary.id)
            }
            const sessionMenu = isArchived
              ? [
                { key: 'unarchive', label: t('action.unarchive'), onSelect: () => unarchive(summary.id) },
                { key: 'rename', label: t('action.rename'), onSelect: () => startRenameSession(summary) },
                { key: 'fork', label: t('action.fork'), onSelect: () => fork(summary.id) },
                { key: 'copy', label: t('action.copyId'), onSelect: () => copyId(summary.id) },
              ]
              : [
                { key: 'pin', label: isPinned ? t('action.unpin') : t('action.pin'), onSelect: () => togglePin(summary.id) },
                { key: 'rename', label: t('action.rename'), onSelect: () => startRenameSession(summary) },
                { key: 'fork', label: t('action.fork'), onSelect: () => fork(summary.id) },
                { key: 'copy', label: t('action.copyId'), onSelect: () => copyId(summary.id) },
                { key: 'archive', label: t('action.archive'), danger: true, onSelect: () => archiveNow(summary.id, false) },
              ]
            sessionRows.push(h('div', { key: summary.id, className: 'dfs-rowWrap' },
              h('div', {
                className: `dfs-row${summary.id === currentId ? ' is-current' : ''}${isArchived ? ' is-archived' : ''}`,
                role: 'button',
                tabIndex: 0,
                title: isArchived ? t('notice.archivedNotOpenable') : (kind === undefined ? titleOf(summary) : `${titleOf(summary)} — ${label}`),
                onClick: () => { if (!renaming) openRow() },
                onContextMenu: contextMenuHandler(menuKey, sessionMenu),
                onMouseEnter: (event) => {
                  startMarquee(event)
                  scheduleHover(menuKey, statusRowsOf(status, projectionOf(summary.id), summary.updatedAt), event)
                },
                onMouseLeave: (event) => { stopMarquee(event); cancelHover() },
                onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openRow() } },
              },
              h(Indicator, { kind, title: label }),
              renaming ? renameInput(rename) : h(Title, { text: titleOf(summary) }),
              isPinned ? h('span', { className: 'dfs-pin', title: t('action.pin'), 'aria-hidden': true }, h(PinIcon)) : null,
              h('span', { className: `dfs-rowActions${menuFor !== null && menuFor.key === menuKey ? ' is-open' : ''}` },
                menuTrigger(menuKey, sessionMenu)),
              h('span', { className: 'dfs-time' }, relativeTime(summary.updatedAt))),
              confirm !== null && confirm.kind === 'archive' && confirm.sessionId === summary.id
                ? h('div', { className: 'dfs-confirm' },
                  h('span', { className: 'dfs-confirmText' }, t('confirm.archive')),
                  h('button', { type: 'button', className: 'dfs-miniBtn is-danger', onClick: () => archiveNow(summary.id, true) }, t('confirm.yes')),
                  h('button', { type: 'button', className: 'dfs-miniBtn', onClick: () => setConfirm(null) }, t('confirm.cancel')))
                : null))
          }
          if (sessionRows.length === 0) sessionRows.push(h('div', { key: 'empty', className: 'dfs-empty' }, t('empty.sessions')))
          body.push(h('div', { key: 'list', className: 'dfs-list' }, sessionRows))
          return h('div', { className: 'dfs-root' }, body, menuEl, hoverEl, notice === null ? null : noticeEl())
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
    INDICATOR_PRIORITY, INDICATOR_LABEL_KEY, GLYPH_COLOR,
    SORT_MODES, SORT_DIRS, SORT_DEFAULT, SORT_NATURAL_DIR,
    ARCHIVED_FILTERS, UNGROUPED,
    directionSign, normalizeSort, readSortState, writeSortState,
    readArchivedFilter, writeArchivedFilter,
    sortWorkspaces, sortSessions, pickFolderKind, indicatorOf,
    relativeTime, baseName, marqueeShiftOf, marqueeDurationOf,
  }
}
