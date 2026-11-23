# AGENTS.md

`dsh-folder-sidebar` — DeepSeek Harness（DSH）的文件夹式侧栏插件。

**AGENT的任务**：帮助开发者维护、修复、更新这个插件。

参考官方实现（只读，不要当依赖）：DSH 安装包 `resources/app.asar` 里的 `dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace`（官方侧栏）与 `dsh-client-ui-primitives`（宿主原语）；读法见「怎么读官方实现」。

## 边界

✅ **总是做**

- **分析、修复问题一律采用第一性原理的思想**，第一性原理是：把问题拆到最小、可验证的事实，从这些事实推导原因，而不是从惯例、符号或猜测出发。
- **新增或修改任何界面组件前，先加载并使用 skill `dsh-component-development`**（会话内已提供；本项目不自带规范副本，完整规范在同级 `dsh-music/A_other/组件开发规范/`，基线 DSH 0.2.2-rc.5）。宿主签名以**安装包里当前版本**为准，按该规范 `09-升级复核.md` 从 asar 重新核对后再改。
- **新增任何持久化/存储时**，同步扩充“清空插件所有数据”的范围、分类与测试：Host 文件/目录、localStorage、IndexedDB、CacheStorage、内存缓存、远端 session 都算；只加存储不更新清理视为未完成。
- **文档命名一律用中文**：新建或改名的说明文档都用中文文件名（如 `踩坑记录.md`、`发布手册.md`），路径里也不夹带英文标题。例外只有平台约定的 `README.md` / `CHANGELOG.md` / `AGENTS.md` / `LICENSE`。
- **每做完一步修改就打一个 git 存档点**（`git commit`），message 中文写清这一步做了什么，回退时能直接找到；没验证过的改动不要攒进存档点。
- **最终给用户的回答格式：**简要修改流程 代码块“段A→段B→段C...、通俗易懂的简要说明（问题、思路、做法、收益）、(若有)受影响的文档修改清单和变更内容简介（代码块）、存档点代码块（axxbxx：优化了...）”。
- **界面只认宿主原语与官方 token**：全插件只有一处 `require('@deepseek-ai/dsh-client-ui-primitives')`（`client.js` 的 host-ui 区），业务代码只通过 `hostComponent` 与适配层取控件；颜色、圆角、阴影、焦点环只用 `--dsw-*`，发丝线 `.5px`，几何对齐官方（行 32px、图标按钮 28/24px、圆角 `--dsw-radius-md`）。
- **改界面前先在组件测试页立用例**：测试页是 `?folder-sidebar=gallery`（渲染在同一个侧栏槽位里），业务界面只允许出现测试页验证过的写法；每个用例要有适配层名、实际控件、可复制的调用代码。
- **对齐官方时能照搬就照搬**：官方 `ui-workspace` 的 DOM 结构与 CSS 数值、`ui-primitives` 的组件与几何，直接照搬（类名改 `dfs-` 前缀、颜色换 token、去掉 hashed 类名），不要只“借鉴思路”。
- 相关文档描述内容实际发生变更时，要更新文档。

🚫 **不要做**

- 不要把 `@deepseek-ai/dsh-client-ui-primitives` 写进 `package.json` 依赖（运行期由宿主模块表注入），也不要缓存“上次是 native”的判断，每次渲染都通过 `hostComponent` 判断。
- 不要在业务代码里散落 `require` 宿主包，也不要复制宿主 CSS 的 hashed 类名；抄值，不抄类名。
- 不要条件调用 slot hook（`useWorkspaces` / `useSessions` / `useSessionStatus`），也不要在 `if (!wide)` 早退之后调用 hook——分别是 React #300 与 #310，曾经两次把侧栏打成错误页。
- 不要在 `client.js` 里引入构建步骤或新依赖；发布物就是这份可读源码，浏览器直接加载。
- 不要改 Host 投影的 key / `since` / 状态语义而不升 `STATE_VERSION`，否则旧 checkpoint 会带着旧语义复活。
- 不要改动只读参考（`dsh-music`、DSH 安装包）。

## 命令

```bash
npm test                      # smoke + projection + logic 三份 Node 测试
npm run check                 # node --check index.js client.js
npm run pack:check            # npm pack --dry-run，核对 files 清单与产物

node test/smoke.test.mjs      # 清单 / 注册 / hook 规则 / UI 规范静态检查
node test/projection.test.mjs # 投影状态机
node test/logic.test.mjs      # 纯函数（排序、状态优先级、聚合、时间、路径、跑马灯）
```

装进 DSH 验证：

```bash
npm pack
# 用 plugin_manager 的 install_bundle 指到 .tgz 或本目录；本地链接时：
#   client.js / locale 改动 → 刷新页面
#   index.js 改动（投影）     → 完全退出 DSH 再启动
```

组件测试页：浏览器打开 `<DSH Web 地址>/?folder-sidebar=gallery`，侧栏槽位会渲染测试页（业务界面同一套适配层）。

## 架构

```text
index.js                  Host 入口：Cordis 插件（name="folder-sidebar"），只注册 session projection
cordis.patch.yml          DSH bundle patch：插入 folder-sidebar 行
client.js                 Client 全部界面（单文件、无构建，直接发布）
locale/zh.json · en.json  插件列表标题与简介
icon.svg                  插件图标
test/                     smoke（清单与 UI 规范）、projection（投影状态机）、logic（纯函数）
```

Client 内部分区：

```text
client.js
├─ 纯逻辑           模块顶层，无 React/DOM，末尾导出给 Node 测试
└─ ModuleLoader      factory 内：
   ├─ host-ui        唯一 require 宿主原语 + hostComponent / hostIcon / hostKitState
   ├─ adapters       IconButton / KitStateDot / KitMenu / KitHoverCard / KitModal / KitToast / Title
   ├─ gallery        组件测试页（?folder-sidebar=gallery）
   ├─ components     FolderRow / SessionRow / SearchResult / TopBar（官方 sectionHeader 复刻）
   └─ apply          注册 sidebar.workspaces（priority -1，替换内置 browser）
```

分工：

- **Host（`index.js`）**：只做一件 Client 拿不到的事——把 `turn/start`、`turn/end` 折叠成 `folder-sidebar/turn` 投影（`idle / running / completed / failed / interrupted / stopped` + `since` + `turn`）。
- **Client**：两级导航（工作区文件夹 → 会话）、搜索（标题本地 + 内容走 Host 索引）、状态位与悬浮卡、菜单与对话框、排序与拖拽、归档筛选。状态由投影 + `useSessionStatus` 组合，不在浏览器里翻事件。
- **样式**：行/顶栏/搜索的几何照搬官方 `WorkspaceBrowser.module.css`、`Rows.module.css`；控件只走适配层（宿主 `Button` / `Menu` / `Tooltip` / `StateDot` / `Modal` / `Toast` / `HoverCard` / `MarqueeText`）。

怎么读官方实现（升级后复核用）：

```text
1. 解析 app.asar：offset 12 是 JSON 字节长度，JSON 头从 offset 16 开始，数据起点 16 + jsonLen；
2. 官方侧栏：dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js 与 src/**/*.module.css；
3. 宿主原语：dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js 里搜 @deepseek-ai/dsh-client-ui-primitives 的导出表与 meta 样式表；
4. 图标一律走 hostComponent('IconXxx')，未命中时才用本地 SVG 兜底。
```

## 参考

- [README](README.md)
- [CHANGELOG](CHANGELOG.md)
- 组件开发规范（只读）：`../dsh-music/A_other/组件开发规范/README.md`
- 官方侧栏源码（只读）：`<DSH 安装目录>/resources/app.asar` → `dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace`
