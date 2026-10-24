# Changelog

## 0.1.4 — 状态位回到原生规则，外加一批 review 修复

- **会话状态显示规则改成和原生侧栏逐条一致。** 以前每行都画一个 10px 的点，于是「空闲」是灰点、「运行中」是绿点、「未读完成」是近黑（深色主题下近白）的 brand 色——三种状态各占一个颜色，和旁边原生会话行对不上。现在按原生 `sessionStatuses()` 的口径渲染状态位：
  - **空闲不画点**，只留一格空位（标题左边界不变）；
  - **运行中换成转圈**（14px，淡轨道 + 旋转圆弧，`prefers-reduced-motion` 下静止），不再是绿点；
  - **未读完成是绿点**（`--dsw-alias-state-success-primary`）；
  - **待处理交互是琥珀点**（`--dsw-alias-state-warn-primary`），优先级最高；
  - **子会话还在跑的父会话也算运行中**（读会话投影的 `subagentCatalog`，和原生 `runningChildCount` 同口径）。
- 待处理交互时，行尾的相对时间像原生一样换成短词（待审批 / 计划待审 / 待回答），完整文案放进状态位的读屏标签（视觉隐藏，样式与原生 `visuallyHidden` 同构）。
- **「跑完未看」不再只靠宿主那颗绿点。** 排查确认：宿主 `completionUnread` 的置位条件是 `ui-session` 的 `observeRunning()` 里 `!isMain()`——只要主视图还保留着刚切走的会话，宿主就永远不标，侧栏和面板于是一起不亮（0.2.1-rc.2 源码核对过；这也是「两边都没绿点」的直接原因）。现在插件额外订阅 `ctx.uiSession.sessionStatus`（running 缺失时退回会话行的 running）：观察到某个会话 `running` 从 true 变 false、且它当时不是 `uiSession.current`（你正在看的那个），就记一笔「跑完未看」，面板亮绿点；打开它或它重新开始跑就清掉。侧栏那颗绿点是宿主的内部状态，插件写不了，所以会出现「面板有、侧栏没有」——这是有意的：面板至少能告诉你它跑完了。
- 「含空会话」打开时空会话不显示状态位；未知的 pending 类型按原生 `visiblePendingKind` 的规则忽略，退回到运行中/完成/空闲。
- 测试覆盖四种状态、空会话与未知 kind 的降级，以及待处理短词替换行尾时间。
- **一轮全量 review 的修复**（同版本内）：
  - **置顶会话单独成组**。之前是「先全局排序（置顶优先）→ 再按时间桶重排」，分桶把置顶打散了：一个上个月的置顶会话会掉到今天的新会话后面。现在置顶独立一组建在时间桶之前，组内仍按当前排序；「最久没动」模式下同样成立。
  - **「填入输入框」不再把宿主的 `void` 返回当成失败**。旧判定是 `=== true`，插入其实成功也会走失败分支（复制到剪贴板、想法仍然是待问，再点一次就重复插入一遍）。现在只有明确的 `false` 才算失败，`captureInsertion` 也只在真要插入时才调用。
  - **旧键迁移写回失败不再丢想法**。`localStorage` 拒绝写入（配额 / 隐私模式）时，已经成功解析的旧数据会被整批丢弃；现在照旧数据渲染，等写入恢复后再重做迁移并清旧键。
  - **视图状态写入失败会回滚并提示**，不再出现「界面已经应用筛选、刷新后又还原」的静默不一致。
  - **「跑完未看」不再误标**：拿不到 `uiSession.current` 的可读快照时整条判定不启用 —— 宁可漏一颗绿点，也不要把你正盯着的会话标成未看。
  - **投影失败改为冷却重试**：一次 15s 超时不再终身拉黑，5 分钟后由下一次渲染重新排上；「跑完未看」的标记按 7 天清理，长开窗口不再无限增长。
  - **工作区形状异常不再拖垮整块面板**（`ws.items` 不是数组时直接跳过，而不是让错误边界接管）。
  - 删掉只写不读的 `rowMeta.unsettled` / `rowMeta.turnCount`。
  - 发布包只带 README 与 `screenshots.json` 实际引用的那张截图（原先把 `assets/` 整个打进去，多带了 403 kB 没人引用的 png）。
  - 测试补到 31 条：置顶分组、宿主返回 void 时的插入判定、迁移写回失败、视图回滚、活动会话不可读时的静默降级。
- **发布名改为 `@whybebabo/dsh-recent-sessions`。** 客户端模块 id 与 `cordis.patch.yml` 的 row name 同步改成新包名（DSH 的 loader 按包名认领 client bundle，短名会报 "loaded without registering"，整个 Web 启动失败）；本地 profile 的 `link:` 依赖一并更新。`STORE_KEY` / `STYLE_ID` 保持原样，已有本地想法与视图状态不受影响。

## 0.1.3 — native-looking UI, two entry points removed, and review fixes

- **Rebuilt the panel in DSH's own design language** — the page now uses the native heading scale, 13px controls, 0.5px strokes, `--dsw-radius-*` / `--dsw-elevation-soft` tokens, hover rows and 10px state dots. Emoji actions were replaced with the same line-icons the shell uses for sessions, folders, copy, edit, pin, search and close.
- **The sidebar entry now uses the native chat-lines glyph** (the shell's conversation/queue artwork) instead of the old crosshair.
- **Removed the floating “Recent Sessions” pill** in the bottom-right corner together with its `shell.overlay` registration, `react-dom` portal code and styles.
- **Removed “Open in a separate window”** from the panel header, along with the `#recent-sessions` pop-out marker and its dictionary entries.
- **Interaction and correctness** — each row now has a proper title button and sibling action buttons, so pressing Enter on “jot”, “copy”, “reveal” or “save” no longer also opens the session. “Only unfinished” now checks every candidate session (projections are fetched with bounded concurrency, retried once, and the loop stops taking new work on cleanup) and only pending thoughts keep a session in that list. Content search drops aborted/stale responses; clipboard failures are reported honestly; content hits respect the current filters; empty states distinguish “no sessions” from “no matches”.
- **Accessibility and localization** — sort buttons expose `aria-pressed`; icon-only actions have labels; hover-only row actions are visible on touch devices; relative times, directory fallbacks, the dock and the sidebar entry now follow the active locale (the sidebar label is a locale-bound function).
- **Robustness** — the `Safe` boundary now sits above the slot component, so render errors in the panel or dock itself are isolated too; a gate requires all three root hooks; projection failures no longer retry forever; a failed `localStorage` write rolls the change back instead of silently losing or misreporting it.
- **Tests and packaging** — added `npm test` (time buckets, relative time, path labels, store migration and rollback, unfinished-filter behavior, row structure, registration), and the published package now includes `assets/` and `screenshots.json`.
- **“This week” is now “Last 7 days”** to match the actual rolling window.

## 0.1.2 — the panel can no longer lose its stylesheet, and the README leads in Chinese

- **Fixed: the panel could come back stripped of all styling** — default grey buttons, default checkboxes, default font — while still rendering every row correctly.

  The stylesheet was injected exactly once, from the plugin's `apply()`. `document.head` is not ours to keep: the shell injects its own `<style>`/`<script>` rows into it at boot, a plugin can be disabled and re-enabled, and hot-reload disposes effects in an order we do not control. Any of those can drop our `<style>` — and since `apply()` never runs a second time, the panel kept rendering the markup with no CSS behind it, permanently.

  Now every render of the panel, the thought strip and the floating pill calls an idempotent `ensureStyles()` that re-appends the stylesheet when it is missing (and rewrites it if the id exists with unexpected content). There is no longer a reachable state where the panel is mounted without its styles.

- **The README now leads in Chinese.** `README.md` is the Chinese documentation and `README.en.md` is the English one. The plugin market fetches `README.md` from the repository root by a hardcoded path, so this makes Chinese the default text on the storefront card and detail page, with the English version one click away at the top of the file.

## 0.1.1 — floating pill can no longer land in the top-left corner

- The floating **Recent Sessions** pill is now rendered through a React portal onto `document.body`, and its position is set inline. Previously it was rendered inside the shell overlay layer, so `position: fixed` resolved against the nearest containing block: during the first moments of a cold start (column-width animation, viewport not settled yet) an ancestor could briefly become that containing block, pinning the pill to the window's top-left corner, clipped, until the layout settled. With no intermediate container between the pill and the viewport, that race is gone by construction.
- Styling still comes from the `.dsh-recent-pill` class; only the positioning is inline, so it no longer depends on when the stylesheet is injected. If `react-dom` is unavailable the pill falls back to rendering in place — the pill is an optional entry point and never affects the panel itself.

## 0.1.0 — first public release

- **Recent sessions panel** (global panel, not tied to any session): every session across every workspace, newest first, including sessions the sidebar is currently hiding (collapsed workspaces, unregistered directories).
- Each row carries its workspace as a **clickable filter chip**, a status dot, pin state, and a second line with that session's **last human prompt** (hover for the last assistant reply preview, read from the host `turnOutline` projection).
- **Time grouping** (Today / Yesterday / This week / Earlier) and two sort orders: most recent, or **least recently touched** (time buckets flip too). Filters: only unfinished / include blank / include subagent sessions; archived hidden by default. View state is remembered locally.
- **Find it again**: full-text search over message content (host index) plus instant local title/path filtering; per-row actions to open the session, **reveal its workspace folder in the file manager**, and copy the path.
- **Deferred thoughts**: jot a line on any row (stored locally, never sent). When you reopen that session a one-line strip appears above the composer — insert it into the draft (official, undoable editor insertion), silence it until something new arrives, or discard it.
- Open the panel in its own same-origin window.
- **Zero writes to your conversations**: the host half is an empty `apply`; notes, thoughts and view state live in `localStorage` only.
