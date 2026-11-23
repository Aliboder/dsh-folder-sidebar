# dsh-folder-sidebar

把 DeepSeek Harness 侧栏的「工作区 / 会话」列表换成分文件夹的进入式导航：**侧栏先只列工作区（文件夹），点进去才显示该工作区的会话列表**，并有返回上一级。会话行首带状态位，文件夹图标本身就是工作区的状态位。

界面按 **宿主优先** 重做：能落到 DSH 官方原语上的控件（`Menu`、`Tooltip`、`StateDot`、`HoverCard`、`Modal`、`Toast`、`Button`、`MarqueeText`）全部渲染宿主组件；行/顶栏/搜索的几何与交互照搬官方 `ui-workspace` 的 CSS 数值；颜色只用 `--dsw-*` token，发丝线保持 `.5px`。宿主包不可用时走同一套几何的本地 fallback。

## 行为

- **顶栏固定**：两级完全相同，按官方 `sectionHeader` 复刻——标题「工作区」+ 搜索 / 视图选项 / 添加工作区，高 36px，操作按钮 28×28。
- **搜索集成在顶栏**（对齐官方）：平时只有一个放大镜按钮；点击后输入框在原位展开并占据整行（标题与按钮收起，约 180ms，尊重 `prefers-reduced-motion`），带关闭按钮；Esc 关闭；点外部且输入为空也关闭。输入后列表切换为跨工作区的扁平结果，点击结果打开会话并收起搜索。
- **视图选项**（宿主 `Menu`，与官方同一套菜单面与键盘行为）。菜单分三段：
  1. **排序**（标题写明「排序 · 文件夹 / 会话」，两级各自独立）：手动顺序 / 按名称 / 按最近活动，外加 **正序 ↑ / 倒序 ↓**；选中项用官方勾选标记。
  2. **显示**：隐藏已归档 / 全部会话 / 仅显示已归档。
  - 两级偏好互不影响，存在 `localStorage` 的 `dsh.folder-sidebar.sort`（`{ folders: {mode, dir}, sessions: {mode, dir} }`）；归档筛选存在 `dsh.folder-sidebar.archived`。
  - 选模式时会重置到该模式的自然方向：名称 = 正序，最近活动 = 倒序，手动顺序 = 正序；之后可以单独切方向。
  - 文件夹级只有在「手动顺序 + 正序」下才显示「上移 / 下移」，也只有这时能拖拽。
  - **拖拽排序**：文件夹行可直接拖动，落在目标行的上半/下半决定插到它前面还是后面，落点使用官方的插入标记（箭头 + 2px 品牌色横线）；搜索中或排序模式非「手动 + 正序」时自动禁用。
- **第一级：工作区文件夹列表**。每行高 32px、圆角 `--dsw-radius-md`：文件夹图标（兼状态位）、名称、悬停时出现的 `…` 菜单。悬停行时文件夹图标换成官方行箭头（右三角），提示「点进去」。
- **第二级：进入某个工作区**。顶栏保持不变；顶栏下面多一条**面包屑行**（同样 32px 行几何）：
  ```text
  ‹  文件夹名                                      +
  ```
  点这一行任意位置 = 返回上一级；点右侧 `+` = 在当前工作区新开会话（不触发返回）。下面才是该工作区的会话列表。
- **默认停在当前会话所在的工作区**；返回后停在文件夹列表，不会被自动拉回。
- **搜索**：标题匹配即时本地过滤；内容匹配 250ms 防抖后走 Host 的会话检索，结果使用官方两行 `searchResultRow`（内容区 48px、圆角 `--dsw-radius-lg`），第二行是所属工作区与命中片段，点击直接打开（归档结果不可打开，可一键取消归档）。
- **长名称**：宿主 `MarqueeText` + `useHoverMarquee`——悬停行时放不下的标题匀速滚到末尾并停在末尾，离开即回到起点；能放下的标题静止。宿主缺失时用插件自己的位移/时长纯函数兜底（`prefers-reduced-motion` 下不滚动）。
- 侧栏收起成窄栏时只渲染一个 36×36 的文件夹按钮（官方 rail 几何），点击展开。

## 状态位

状态点直接使用宿主 `StateDot`（运行中 14px 官方转圈，其余 10px 圆点），与官方侧栏同一套语义：

**会话行**：最前面一个固定 16px 的槽位（无状态时留空，标题始终对齐）。

| 图形 | 含义 | 来源 |
|---|---|---|
| 转圈（`ongoing`，14px） | 正在运行 | `useSessionStatus` 的 `running`（含摘要的 `running`） |
| 绿点（`done`） | **有未读的新完成**（你当时没在看它）；打开这个会话即清除 | `useSessionStatus` 的 `completionUnread` |
| 黄点（`warning`） | 正在等你回答或审批（`pendingInteraction`） | `useSessionStatus` |
| 红点（`error`） | 最近一轮失败或中断（`error` / `blocked` / `max-tokens` / `interrupted`，及非用户原因的 `aborted`）；**打开并读过这个会话即清除**，下一次失败（轮次更大的 `turn`）会重新点亮 | Host 投影 `failed` / `interrupted` + 本地已读标记 |
| 空心灰点 | 你自己按停止（`aborted` by user） | Host 投影 `stopped` |
| 淡灰点（`idle`） | 已处理完（读过、没有新完成）、读过的失败/中断、从未运行过 | 有意偏离官方：官方空闲时不画点，这里保留淡点以免状态槽塌陷 |

**文件夹行**：状态固定在文件夹图标本身，只有一个，不额外占位。

| 图标 | 含义 |
|---|---|
| 转圈（14px，代替文件夹图标） | 有会话正在运行 |
| 黄色文件夹 | 有会话在等你回答/审批 |
| 红色文件夹 | 有会话最近一轮失败或中断（读过后消失） |
| 绿色文件夹 | 有会话最近一轮正常完成 |
| 普通（次要灰）文件夹 | 没有可显示的状态 |

一个文件夹里有多种状态时按**优先级取一个**：等待 > 运行 > 失败 > 未读完成；同一优先级里取**状态起始时间最早**的那个（`since` 最早；投影缺失时退化为会话 `updatedAt`）。用户主动停止（`aborted` by user）只在该会话行上显示空心灰点，**不会改变文件夹图标**，也不会让文件夹变灰。

**悬浮卡**：宿主 `HoverCard`（800ms，分组、菜单打开时禁用）。会话行列出该会话的**全部**状态（等待的具体类型、运行、失败、未读完成、停止，最后一行是相对时间）；文件夹行列出它包含的状态及各自会话数（如「运行中 ×2」）。内容样式照搬官方 `.hoverContent`。

**为什么完成用「未读」而不是「完成过」**：内置 ui-session 的 `completionUnread` 才是官方的「已处理」判定——它只在**看到某个会话从运行变为结束、且当时它不是当前会话**时置位，并且每次开启/切到该会话就清除；这个事实只存在于浏览器，永不上报 Host。用它作绿点，读完切走就不会再亮。

**为什么红也按「读过」清除**：失败本身是持久事实（`turn/end` 的 reason，来自 Host 投影），但「还要不要提醒你」取决于你有没有看过。插件沿用官方 `completionUnread` 的判定：会话成为主视图（`retainedBy.mainView > 0`）就算读过；读过的轮次记在浏览器本地（`dsh.folder-sidebar.seen`，按会话 + `turn`），所以刷新后不会复活，而同一会话下一次失败仍会重新点亮红点。

**为什么状态要 Host 投影**：会话摘要（`SessionSummary`）只有 `running`、`updatedAt` 等字段，没有「最近一轮结果」；唯一可靠来源是会话事件 `turn/end` 的 `reason`。插件因此在 Host 侧注册一个 session projection，把最近一轮折叠成 `idle / running / completed / failed / interrupted / stopped` 并带上状态起始时间 `since`（`stateVersion = 3`），Client 从 `projectionsBySession[id].values['folder-sidebar/turn']` 读取——值在 Host 算好并增量推送，浏览器不自己翻事件。

## 与官方实现的对齐情况

| 能力 | 官方做法 | 本插件 | 状态 |
|---|---|---|---|
| 行几何 / 内衬 / 圆角 | 32px 行、`--dsh-sidebar-row-padding` 内衬、`--dsw-radius-md`、`.5px` 发丝线 | 照搬同一组变量与数值 | 已对齐 |
| 运行 / 等待 / 完成态 | `StateDot`（14px 转圈、10px 点） | 同源 `StateDot` | 已对齐 |
| 空闲 | 不渲染 | 渲染 `idle` 淡点 | 有意偏离（保留状态槽） |
| 失败 / 中断 | 无失败状态（`StateDot` 有 `error` 色，侧栏不用） | `error` 点，来自本插件 Host 投影；读过即清除 | 本插件新增 |
| 主动停止 | 无对应概念 | 空心灰点（只影响会话行） | 本插件新增 |
| 文件夹聚合 | 官方不聚合 | 文件夹图标着色 / 转圈，优先级 + 同级最旧 | 本插件新增 |
| 悬浮卡 | 宿主 `HoverCard` | 同源，内容照搬 `.hoverContent` | 已对齐 |
| 菜单 | 宿主 `Menu`（`portal`、锚点、右键指针点） | 同源 | 已对齐 |
| 搜索顶栏 | 标题 + 内联搜索 + 两个操作，36px | DOM/CSS 照搬 | 已对齐 |
| 搜索结果行 | 两行 `searchResultRow` + 状态点 + 工作区/片段 | 同左 | 已对齐 |
| 归档筛选 / 取消归档 / 撤销 | 视图选项、归档行不可打开、Toast 可撤销 | 同左 | 已对齐 |
| 重命名 / 二次确认 | 官方使用 `Modal` + 44px 输入框 | 同源 `Modal`，同一套输入几何 | 已对齐 |
| 操作失败提示 | 宿主 `Toast`（顶部居中） | 同源 | 已对齐 |
| 长标题 | 宿主 `MarqueeText` | 同源，fallback 用插件纯函数 | 已对齐 |
| 拖拽排序 | 拖拽 + 插入标记 + 跨组落点 | 文件夹级拖拽 + 官方标记；会话级暂用菜单 | 会话级待做 |
| 未分组 | 不属于任何工作区的会话进 Ungrouped | 同左（列表末尾伪文件夹） | 已对齐 |
| subagent 会话隐藏 | 侧栏不显示 subagent 来源会话 | 同左 | 已对齐 |

## 菜单与对话框

**行内菜单**（`…` 按钮或鼠标右键）：宿主 `Menu`，图标、危险项、分隔线与键盘行为都由宿主提供；右键通过 `anchorPoint` 在指针位置打开，滚动即关闭。

会话行：置顶 / 取消置顶、重命名、分叉、复制会话 ID、归档。归档仍在运行的会话时，Host 会拒绝，弹出「停止并归档」二次确认对话框。

文件夹行：重命名工作区、在此新建会话、上移 / 下移、删除工作区（二次确认；只删注册，不动会话与文件）。顶部 `+` 是添加工作区（系统目录选择器）。

> 会话没有「删除」能力：Host 只提供归档 / 取消归档，所以菜单里是「归档」。

> 「上移 / 下移」通过 Host 的 workspace 排序接口持久化，改动会同步到内置侧栏的顺序；它只在文件夹级「手动顺序 + 正序」时出现。

重命名是官方风格的对话框：标题 + 44px 输入框（`.5px` 描边、`--dsw-radius-lg`）+ 取消 / 保存；Enter 保存，Esc 取消。

## 组件测试页

打开 `<DSH Web 地址>/?folder-sidebar=gallery`，侧栏槽位会渲染组件测试页（业务界面同一套适配层）：

- 顶部显示 `宿主组件: native / partial / fallback`（真实 `hostKitState()`，不是写死的）；
- 每个用例给出**适配层名**、**实际控件**、**可复制的调用代码**；
- 覆盖：IconButton / Button / KitStateDot / Title（跑马灯）/ KitMenu / KitHoverCard / KitToast / KitModal，以及文件夹行、会话行、搜索结果行三种行样式。

这里的写法就是标准写法：**新增控件先立用例，再进业务**。点左上角返回箭头退出测试页。

## 安装与生效

从 npm 安装（推荐）：

```bash
npm install dsh-folder-sidebar
# 或在 DSH 的 Plugin Manager / plugin_manager 里指定 install_bundle 目标 dsh-folder-sidebar
```

从源码目录安装（本地链接，便于改代码）：

- `plugin_manager` 的 `install_bundle` 指向本目录。
- **Client 改动**（`client.js`、locale）：刷新页面。
- **Host 改动**（`index.js`——状态色投影）：需要**完整重启 DSH**。
- **启用/停用插件行**属于 bundle 组合变更：保存后浏览器侧要刷新页面才会挂载/卸载座位；只有在本机同时跑 `pnpm run dev:web` 时才有免刷新热更。

仓库：<https://github.com/Aliboder/dsh-folder-sidebar> · 包：<https://www.npmjs.com/package/dsh-folder-sidebar>

## 归档与「未分组」（对齐官方）

- **视图选项**（顶栏滑块按钮）：隐藏已归档（默认）/ 全部会话 / 仅显示已归档；选择存在浏览器 `localStorage`（`dsh.folder-sidebar.archived`）。
- 已归档会话以弱化标签色显示、**点击不会打开**（提示「已归档，取消归档后才能打开」）；菜单改为「取消归档 / 重命名 / 分叉 / 复制 ID」；「仅显示已归档」时没有归档会话的文件夹会被隐藏。
- 归档成功的 Toast 带**撤销**按钮，直接取消归档。
- **未分组**：不属于任何工作区（且非 subagent 来源）的会话出现在文件夹列表末尾的「未分组」里，可打开、可归档；它没有「新建会话」（没有工作区可归属）。
- **subagent 来源的会话始终隐藏**，与官方侧栏一致。

## 图标

插件不把宿主包写进依赖，而是在运行时通过 `hostComponent()` 取官方图标组件；宿主缺失时才用本地 SVG（同为 16×16 网格、`strokeWidth: 1`、`currentColor`）兜底。

| 用途 | 宿主导出 |
|---|---|
| 文件夹 | `IconFolderCloseRegular` |
| 行箭头 / 进入 | `IconTriangleRightFillRegular` |
| 返回 | `IconChevronLeftOutlineRegular` |
| 搜索 | `IconSearchOutlineRegular` |
| 关闭搜索 | `IconCloseFillRegular` |
| 更多 `…` | `IconEllipsisOutlineRegular` |
| 视图选项 | `IconSlidersTwoOutlineRegular` |
| 置顶 | `IconPinFillRegular` / `IconPinOutlineRegular` |
| 新建会话 | `IconNewChatOutlineRegular` |
| 添加工作区 | `IconProjectAddOutlineRegular` |
| 排序 / 方向 | `IconChevronsUpDownOutlineRegular` / `IconChevronUpOutlineRegular` / `IconChevronDownOutlineRegular` |
| 归档筛选 | `IconArchiveOffOutlineRegular` / `IconQueueOutlineRegular` / `IconArchiveCheckOutlineRegular` |
| 行菜单动作 | `IconListPenOutlineRegular` / `IconBranchOutlineRegular` / `IconCopyOutlineRegular` / `IconArchiveOutlineRegular` / `IconUnarchiveOutlineRegular` / `IconTrashOutlineRegular` |

## 失败提示

置顶 / 归档 / 取消归档 / 重命名 / 分叉 / 排序 / 删除工作区 / 添加工作区失败时，顶部显示宿主 `Toast`（宿主缺失时用同几何的本地提示条），不再只写 console。

## 已知限制

- 没有「展开其余」水位线。
- 搜索内容命中走 Host 索引；搜索期间列表被结果替代（Esc 清空恢复），最多展示 30 条。
- 文件夹状态位只统计当前筛选下可见的会话。
- 失败「已读」标记只存在本机浏览器（`dsh.folder-sidebar.seen`，按会话 + 轮次，最多保留 500 条）；换设备或清空站点数据后，未重读的旧失败会重新显示。
- 会话级拖拽排序仍走菜单（文件夹级已支持拖拽）。

## 工程结构

- **Host（`index.js`）只做一件 Client 拿不到的事**：把 `turn/start`、`turn/end` 折叠成 `folder-sidebar/turn` 投影。
- **Client（`client.js`）单文件、无构建**，内部分区：

```text
client.js
├─ 纯逻辑         模块顶层，无 React/DOM；末尾导出给 Node 测试
└─ ModuleLoader   factory 内：
   ├─ host-ui     唯一 require 宿主原语 + hostComponent / icon / hostKitState
   ├─ adapters    IconButton / Button / KitStateDot / KitMenu / KitHoverCard / KitModal / KitToast / Title
   ├─ gallery     组件测试页（?folder-sidebar=gallery）
   ├─ components  FolderRow / SessionRow / SearchResult / TopBar（官方 sectionHeader 复刻）
   └─ apply       注册 sidebar.workspaces（priority -1）
```

- 纯逻辑（排序比较器、状态优先级、文件夹状态聚合、归档筛选、相对时间、路径 basename、跑马灯位移/时长）集中放在 `client.js` **模块顶层**，不依赖 React/DOM；文件末尾在 Node 环境（`module.exports` 存在且 `window` 缺失）把这份 API 导出，因此 `test/logic.test.mjs` 加载的是**真正发布的那份源码**。
- 每个文件夹的会话行用一次 `useMemo` 建索引（`rowsIndex`），列表渲染、状态位聚合、悬浮卡共用同一份。
- `test/render.test.mjs` 用自带的 mini React 运行时把发布源码渲染一遍：宿主包存在（native）与缺失（fallback）两条路径都跑，覆盖进入文件夹、行菜单、重命名对话框、搜索、右键菜单与组件测试页。

## 文件

```text
package.json          # dsh.bundle.patch + dsh.client + zod 依赖
cordis.patch.yml      # 插入 folder-sidebar 行
index.js              # Host：sessionProjections 单元 folder-sidebar/turn
client.js             # 全部 UI：host-ui / 适配层 / 测试页 / 两级导航 / 菜单 / 搜索
locale/en.json        # 插件列表展示文案
locale/zh.json
icon.svg
AGENTS.md             # 给维护者/AI 的边界、命令与架构说明
test/smoke.test.mjs   # 清单、id、hook 规则与界面规范静态检查
test/projection.test.mjs # 投影状态机单测（不启动 DSH）
test/logic.test.mjs   # 纯函数单测
test/render.test.mjs  # native / fallback 两条渲染路径
```

## 本地验证

```bash
npm run check      # node --check index.js client.js
npm test           # smoke + projection + logic + render
npm run pack:check # npm pack --dry-run，核对 files 清单
```
