/**
 * 最近会话（Recent Sessions）——浏览器半（手写 bundle，无需构建链）。
 *
 * 为什么是手写：DSH 的客户端插件产物只是 `window.__ModuleLoader__.load({ id, factory })`
 * 这一层包装，容器里的代码通过 `require("react")` 等拿到外壳提供的共享模块
 * （PLATFORM_MODULES 基座：React / react-dom / 静态 UI 库）。因此一个足够小的插件
 * 完全可以零构建链直接写 —— 本文件即证明。
 *
 * 它注册三样东西：
 *   1. root 作用域 `main` keyed slot 的一个新 key（recent-sessions）= 全局面板；
 *   2. `sidebar.panellist` 的一枚图标 = 面板入口（id 必须与上面的 key 一致）；
 *   3. `conversation.input.dock` 的「待问」小条。
 *
 * 面板内的数据全部来自外壳提供的 root hooks（useSessions / useSessionStatus /
 * useWorkspaces），不读文件、不碰会话日志。
 */
window.__ModuleLoader__.load({
	id: "@whybebabo/dsh-recent-sessions",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** 全局面板 key；侧栏条目的 id 必须与它相同（侧栏用 id 调 layout.selectPanel）。 */
		const PANEL_ID = "recent-sessions";
		const NS = "recentSessions";
		const STYLE_ID = "dsh-recent-sessions-style";
		const DAY = 86400000;
		const PROJECTION_CONCURRENCY = 4;
		const PROJECTION_RETRIES = 1;
		const PROJECTION_RETRY_DELAY = 1200;
		const PROJECTION_TIMEOUT = 15000;
		/** 失败后的冷却时间：一次超时就终身不再尝试太狠，冷却过后允许重试。 */
		const PROJECTION_RETRY_AFTER = 5 * 60 * 1000;
		/**
		 * 轮次大纲投影的加载状态（模块级，跨渲染/跨实例共享）：
		 * loaded 里的会话不再请求；inFlight 去重并发请求；failed 记录失败时刻，
		 * 冷却期内不再自动重试（避免失败后无限循环），冷却过后由下一次渲染重新排上。
		 */
		const projectionLoaded = new Set();
		const projectionFailed = new Map();
		const projectionInFlight = new Map();

		/** 这个会话是否刚刚失败过（冷却中）。 */
		function projectionFailedRecently(sessionId) {
			const at = projectionFailed.get(sessionId);
			return at !== undefined && Date.now() - at < PROJECTION_RETRY_AFTER;
		}

		/**
		 * 确保样式表在文档里存在，返回它。
		 *
		 * 为什么不能只在 apply() 里注入一次：`document.head` 不是我们的地盘。外壳启动时
		 * 会往 head 注入自己的 style/script（见 web boot 的注入器），插件热更新、插件被
		 * 禁用再启用、以及任何一处整体重建 <head> 的动作，都可能让我们的 <style> 消失，
		 * 而 apply() 早已跑过、不会再跑第二次 —— 结果就是面板留在 DOM 里、样式却没了，
		 * 渲染出浏览器默认外观（这正是"变丑"那次的现场）。
		 *
		 * 所以每次渲染都顺手确认一次：不存在就补回来。按钮的点击处理里也调它，因此
		 * 即使在极端时序下也不会有"永久无样式"的状态。
		 */
		function ensureStyles() {
			if (typeof document === "undefined" || !document.head) return null;
			let style = document.getElementById(STYLE_ID);
			if (!style) {
				style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = CSS;
				document.head.appendChild(style);
			} else if (style.textContent !== CSS) {
				// 同一个 id 但内容不是我们的（理论上不会发生）：改写而不是叠加。
				style.textContent = CSS;
			}
			return style;
		}

		const DICT = {
			zh: {
				panel: "最近会话",
				tagline: "跨所有工作目录（点任意一行回到那个会话）",
				search: "搜索标题 / 目录…",
				today: "今天",
				yesterday: "昨天",
				week: "近 7 天",
				earlier: "更早",
				untitled: "（未命名）",
				newSession: "（新会话）",
				unregisteredDir: "（未注册）",
				empty: "还没有任何会话。先在左侧开一个会话吧。",
				emptyFiltered: "没有符合当前筛选条件的会话。",
				loading: "正在读取会话…",
				checkingUnfinished: "正在核对未收尾状态…",
				projectionUnavailable: "部分会话的状态暂时无法读取，已按未收尾显示。",
				showBlank: "含空会话",
				showChild: "含子会话",
				count: "{n} 个会话 · {d} 个目录",
				sortLabel: "会话排序",
				sortRecent: "最近活动",
				sortRecentTitle: "按最近活动排序",
				sortStale: "最久没动",
				sortStaleTitle: "按最久没动排序（适合清理搁置的会话）",
				onlyUnfinished: "仅未收尾",
				contentHits: "内容命中 · {n}",
				pinned: "已置顶",
				pinnedGroup: "已置顶",
				statusRunning: "进行中",
				statusIdle: "空闲",
				statusCompleted: "已完成",
				statusApproval: "等待审批",
				statusPlanReview: "计划待审",
				statusAnswer: "等待回答",
				statusApprovalShort: "待审批",
				statusPlanReviewShort: "计划待审",
				statusAnswerShort: "待回答",
				statusSubagentOne: "{n} 个子会话运行中",
				statusSubagentOther: "{n} 个子会话运行中",
				openSession: "打开会话：{title}",
				filterDir: "只看这个目录：{path}",
				filterDirClear: "只看：{path}（点击取消）",
				lastAnswer: "它的结论：{text}",
				jot: "记一笔（只存在本机，不会发给模型）",
				reveal: "在文件管理器中显示这个目录",
				copyDir: "复制目录路径",
				thoughts: "查看这个会话下的想法（{n}）",
				editorPlaceholder: "记一句：以后要接着问、要改、或当时没想清楚的地方…（Ctrl/⌘+Enter 保存，Esc 取消）",
				save: "保存（Ctrl/⌘+Enter）",
				cancel: "取消",
				editorHint: "存在本机；下次打开这个会话时，输入框上方会提示你",
				delivered: "已填入过",
				deleteThought: "删除这条想法",
				thoughtsCount: "{n} 条想法",
				collapse: "收起",
				expand: "展开",
				mute: "先不打扰（不改动想法；以后再记新的会重新出现）",
				notNow: "先不打扰",
				insertDraft: "填入输入框",
				discard: "丢弃",
				discardTitle: "把这些想法标记为丢弃（最近会话面板里也不再多显示）",
				insertFailedCopied: "编辑器此刻不接受插入，已复制到剪贴板：直接粘贴即可",
				insertFailedManual: "编辑器此刻不接受插入，请到「最近会话」面板里手动复制",
				revealed: "已在文件管理器中显示",
				revealFailedCopied: "打不开文件管理器，路径已复制到剪贴板",
				copied: "已复制路径",
				copyFailed: "复制失败（浏览器未授权剪贴板）",
				storageFailed: "本地存储写入失败，想法没有保存。请清理浏览器存储后重试。",
				internalError: "最近会话内部出错，已隔离（不影响其它界面）。刷新页面可重试。",
				hooksUnavailable: "recent-sessions: 缺少必需的 root hooks，面板无法加载。",
				justNow: "刚刚",
				minutesAgo: "{n} 分钟前",
				hoursAgo: "{n} 小时前",
				daysAgo: "{n} 天前",
				weeksAgo: "{n} 周前",
				monthsAgo: "{n} 个月前",
			},
			en: {
				panel: "Recent Sessions",
				tagline: "Across every workspace (click a row to jump back)",
				search: "Search title / directory…",
				today: "Today",
				yesterday: "Yesterday",
				week: "Last 7 days",
				earlier: "Earlier",
				untitled: "(untitled)",
				newSession: "(new session)",
				unregisteredDir: "(unregistered)",
				empty: "No sessions yet. Start one from the sidebar.",
				emptyFiltered: "No sessions match the current filters.",
				loading: "Loading sessions…",
				checkingUnfinished: "Checking which sessions are unfinished…",
				projectionUnavailable: "Some session states could not be loaded; those sessions are shown as unfinished.",
				showBlank: "Include blank",
				showChild: "Include subagents",
				count: "{n} sessions · {d} directories",
				sortLabel: "Sort sessions",
				sortRecent: "Recent",
				sortRecentTitle: "Sort by most recent activity",
				sortStale: "Least recent",
				sortStaleTitle: "Sort by least recent activity (for cleanup)",
				onlyUnfinished: "Only unfinished",
				contentHits: "In messages · {n}",
				pinned: "Pinned",
				pinnedGroup: "Pinned",
				statusRunning: "Running",
				statusIdle: "Idle",
				statusCompleted: "Completed",
				statusApproval: "Waiting for approval",
				statusPlanReview: "Plan awaiting review",
				statusAnswer: "Waiting for answer",
				statusApprovalShort: "Approval",
				statusPlanReviewShort: "Plan review",
				statusAnswerShort: "Answer",
				statusSubagentOne: "{n} subagent running",
				statusSubagentOther: "{n} subagents running",
				openSession: "Open session: {title}",
				filterDir: "Show only this directory: {path}",
				filterDirClear: "Showing only: {path} (click to clear)",
				lastAnswer: "Its last answer: {text}",
				jot: "Jot a thought (stored locally, never sent to the model)",
				reveal: "Reveal this directory in the file manager",
				copyDir: "Copy directory path",
				thoughts: "View thoughts for this session ({n})",
				editorPlaceholder: "Jot a line: something to ask later, something to change, or something you had not figured out… (Ctrl/⌘+Enter to save, Esc to cancel)",
				save: "Save (Ctrl/⌘+Enter)",
				cancel: "Cancel",
				editorHint: "Stored locally; it will appear above the composer the next time you open this session.",
				delivered: "inserted once",
				deleteThought: "Delete this thought",
				thoughtsCount: "{n} thoughts",
				collapse: "Collapse",
				expand: "Expand",
				mute: "Not now (the thought stays; new thoughts will appear again)",
				notNow: "Not now",
				insertDraft: "Insert into draft",
				discard: "Discard",
				discardTitle: "Mark these thoughts as discarded (they will no longer show in the Recent Sessions panel)",
				insertFailedCopied: "The editor would not accept an insertion, so the text was copied. Paste it in.",
				insertFailedManual: "The editor would not accept an insertion. Copy the text manually from the Recent Sessions panel.",
				revealed: "Revealed in the file manager",
				revealFailedCopied: "Could not open the file manager; the path was copied instead",
				copied: "Path copied",
				copyFailed: "Copy failed (clipboard access was denied)",
				storageFailed: "Could not write to local storage; the thought was not saved. Free up browser storage and try again.",
				internalError: "Recent Sessions hit an internal error (isolated from the rest of the UI). Refresh the page to retry.",
				hooksUnavailable: "recent-sessions: required root hooks are unavailable; the panel cannot load.",
				justNow: "just now",
				minutesAgo: "{n} min ago",
				hoursAgo: "{n} hr ago",
				daysAgo: "{n} days ago",
				weeksAgo: "{n} wks ago",
				monthsAgo: "{n} mos ago",
			},
		};

		const CSS = `
.dsh-recent { height:100%; box-sizing:border-box; overflow:auto; padding:28px 32px 56px;
  padding-top:calc(28px + var(--dsh-frame-top-clearance, 0px));
  background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary);
  scrollbar-width:thin; scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent; }
.dsh-recent-inner { width:100%; max-width:840px; margin:0 auto; }
.dsh-recent-head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
.dsh-recent-title { font-size:18px; font-weight:600; line-height:26px; }
.dsh-recent-meta { font-size:13px; line-height:20px; color:var(--dsw-alias-label-tertiary); }
.dsh-recent-tagline { margin:4px 0 20px; font-size:13px; line-height:20px; color:var(--dsw-alias-label-tertiary); }
.dsh-recent-btn { font:inherit; font-size:13px; line-height:20px; height:30px; padding:0 12px; cursor:pointer;
  border-radius:var(--dsw-radius-md); border:.5px solid var(--dsw-alias-border-l3); background:transparent; color:inherit; }
.dsh-recent-btn:hover { background:var(--dsw-alias-interactive-bg-hover); }
.dsh-recent-btn:focus-visible { outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset:1px; }
.dsh-recent-tools { display:flex; align-items:center; gap:10px 12px; flex-wrap:wrap; margin:0 0 4px; }
.dsh-recent-searchwrap { position:relative; display:flex; align-items:center; flex:1 1 240px; max-width:400px; }
.dsh-recent-searchicon { position:absolute; left:10px; display:flex; pointer-events:none; color:var(--dsw-alias-label-tertiary); }
.dsh-recent-search { flex:1; min-width:0; box-sizing:border-box; height:34px; padding:0 10px 0 32px;
  border-radius:var(--dsw-radius-md); border:.5px solid var(--dsw-alias-border-l4);
  background:var(--dsw-alias-bg-layer-1); color:inherit; font:inherit; font-size:13px; line-height:20px; }
.dsh-recent-search::placeholder { color:var(--dsw-alias-label-dimmed); }
.dsh-recent-search:focus { outline:none; border-color:var(--dsw-alias-state-business-primary); }
.dsh-recent-filters { display:flex; align-items:center; gap:6px 12px; flex-wrap:wrap; }
.dsh-recent-toggle { display:inline-flex; align-items:center; gap:6px; font-size:13px; line-height:20px;
  color:var(--dsw-alias-label-secondary); cursor:pointer; user-select:none; }
.dsh-recent-toggle input { flex:none; width:16px; height:16px; margin:0; accent-color:var(--dsw-alias-brand-primary); cursor:inherit; }
.dsh-recent-group { display:flex; align-items:center; gap:5px; margin:22px 0 6px; font-size:12px; font-weight:500;
  line-height:18px; color:var(--dsw-alias-label-tertiary); }
.dsh-recent-groupicon { display:inline-flex; }
.dsh-recent-item { padding:9px 10px; margin-bottom:2px; border-radius:var(--dsw-radius-md); cursor:pointer; }
.dsh-recent-item:hover { background:var(--dsw-alias-interactive-bg-hover); }
.dsh-recent-item:focus-visible { outline:2px solid var(--dsw-alias-label-primary); outline-offset:-2px; }
.dsh-recent-row { display:flex; align-items:center; gap:8px; min-height:22px; }
.dsh-recent-snippet { margin:2px 0 0 18px; font-size:12px; line-height:18px;
  color:var(--dsw-alias-label-tertiary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* 状态位：和原生会话行同一套规则——固定 10px 槽位，空闲不画点 */
.dsh-recent-status { display:flex; flex:none; align-items:center; justify-content:center; width:10px; height:22px; }
.dsh-recent-dot { position:relative; flex:none; width:10px; height:10px; }
.dsh-recent-dot::after { content:""; position:absolute; inset:20%; border-radius:50%; background:currentColor; }
.dsh-recent-dot[data-state="done"] { color:var(--dsw-alias-state-success-primary); }
.dsh-recent-dot[data-state="warning"] { color:var(--dsw-alias-state-warn-primary); }
.dsh-recent-spinner { flex:none; color:var(--dsw-alias-label-tertiary); }
.dsh-recent-spinner-motion { transform-origin:center; animation:dsh-recent-spin 1.5s linear infinite; }
.dsh-recent-spinner-track { fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; opacity:.25; }
.dsh-recent-spinner-arc { fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round;
  stroke-dasharray:12 150; animation:dsh-recent-dash 1.5s ease-in-out infinite; }
@keyframes dsh-recent-spin { to { transform:rotate(360deg); } }
@keyframes dsh-recent-dash {
  0% { stroke-dasharray:12 150; stroke-dashoffset:0; }
  50% { stroke-dasharray:24 150; stroke-dashoffset:-6; }
  100% { stroke-dasharray:12 150; stroke-dashoffset:0; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-recent-spinner-motion { animation:none; }
  .dsh-recent-spinner-arc { animation:none; stroke-dasharray:18 150; stroke-dashoffset:-3; }
}
.dsh-recent-sr { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden;
  clip:rect(0 0 0 0); clip-path:inset(50%); white-space:nowrap; border:0; }
.dsh-recent-ttl { min-width:0; flex:0 1 auto; font:inherit; font-size:14px; line-height:22px;
  padding:0; border:0; background:transparent; color:inherit; text-align:left; cursor:pointer;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-recent-ttl:focus-visible { outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset:1px; border-radius:var(--dsw-radius-sm); }
.dsh-recent-pin { flex:none; display:inline-flex; color:var(--dsw-alias-label-tertiary); }
.dsh-recent-dir { flex:none; display:inline-flex; align-items:center; box-sizing:border-box;
  max-width:240px; height:20px; padding:0 8px; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; border-radius:999px; border:.5px solid var(--dsw-alias-border-l4);
  background:transparent; color:var(--dsw-alias-label-tertiary); font:inherit; font-size:11px; line-height:18px; cursor:pointer; }
.dsh-recent-dir:hover { color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-interactive-bg-hover); }
.dsh-recent-dir-static { cursor:default; }
.dsh-recent-dir-static:hover { color:var(--dsw-alias-label-tertiary); background:transparent; }
.dsh-recent-glyph { display:block; flex:none; }
/* 工具条：排序分段控件 + 目录筛选胶囊 */
.dsh-recent-seg { display:inline-flex; gap:2px; padding:3px; border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-interactive-bg-hover); }
.dsh-recent-segbtn { height:28px; padding:0 12px; border:0; border-radius:var(--dsw-radius-sm);
  background:transparent; color:var(--dsw-alias-label-secondary);
  font:inherit; font-size:13px; line-height:20px; font-weight:500; cursor:pointer; }
.dsh-recent-segbtn:hover { color:var(--dsw-alias-label-primary); }
.dsh-recent-segbtn.on { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); box-shadow:var(--dsw-elevation-soft); }
.dsh-recent-segbtn:focus-visible { outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset:-2px; }
.dsh-recent-dirfilter { display:inline-flex; align-items:center; gap:4px; height:24px; padding:0 8px; cursor:pointer;
  border-radius:999px; border:.5px solid var(--dsw-alias-border-l4); background:transparent;
  color:var(--dsw-alias-label-secondary); font:inherit; font-size:11px; line-height:17px; }
.dsh-recent-dirfilter:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-interactive-bg-hover); }
.dsh-recent-time { flex:none; margin-left:auto; font-size:12px; line-height:18px; color:var(--dsw-alias-label-tertiary); white-space:nowrap; }
.dsh-recent-hintline { margin:8px 0 0; font-size:13px; line-height:20px; color:var(--dsw-alias-label-secondary); }
.dsh-recent-hitmark { flex:none; display:inline-flex; color:var(--dsw-alias-label-tertiary); }
.dsh-recent-empty { display:flex; flex-direction:column; align-items:center; gap:8px; margin-top:80px;
  font-size:13px; line-height:20px; color:var(--dsw-alias-label-tertiary); text-align:center; }
/* 行上的自有动作与「记一笔」编辑器 */
.dsh-recent-iconbtn { flex:none; width:28px; height:28px; padding:0; display:inline-flex; align-items:center;
  justify-content:center; border:0; border-radius:var(--dsw-radius-sm); background:transparent;
  color:var(--dsw-alias-label-tertiary); cursor:pointer; opacity:0; }
.dsh-recent-item:hover .dsh-recent-iconbtn, .dsh-recent-thought:hover .dsh-recent-iconbtn { opacity:1; }
.dsh-recent-iconbtn:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
.dsh-recent-iconbtn:focus-visible { opacity:1; outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset:-2px; }
.dsh-recent-count { flex:none; display:inline-flex; align-items:center; gap:4px; height:20px; padding:0 7px;
  border-radius:999px; border:.5px solid var(--dsw-alias-border-l4); background:transparent;
  color:var(--dsw-alias-label-tertiary); font:inherit; font-size:11px; line-height:18px; cursor:pointer; }
.dsh-recent-count:hover { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-interactive-bg-hover); }
.dsh-recent-editor { margin:8px 0 2px 18px; }
.dsh-recent-textarea { width:100%; box-sizing:border-box; min-height:64px; resize:vertical; padding:8px 10px;
  border-radius:var(--dsw-radius-md); border:.5px solid var(--dsw-alias-border-l4); background:var(--dsw-alias-bg-layer-1);
  color:inherit; font:inherit; font-size:13px; line-height:20px; }
.dsh-recent-textarea::placeholder { color:var(--dsw-alias-label-dimmed); }
.dsh-recent-textarea:focus { outline:none; border-color:var(--dsw-alias-state-business-primary); }
.dsh-recent-editor-actions { display:flex; align-items:center; gap:8px; margin-top:8px; flex-wrap:wrap; }
.dsh-recent-editor-actions .dsh-recent-btn { height:28px; font-size:12px; padding:0 10px; }
.dsh-recent-hint { font-size:12px; line-height:18px; color:var(--dsw-alias-label-tertiary); }
.dsh-recent-thoughts { margin:6px 0 2px 18px; display:flex; flex-direction:column; gap:4px; }
.dsh-recent-thought { display:flex; align-items:baseline; gap:8px; padding:6px 8px; border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1); border:.5px solid var(--dsw-alias-border-l2); }
.dsh-recent-thought-text { flex:1; font-size:12px; line-height:18px; white-space:pre-wrap; word-break:break-word; }
.dsh-recent-thought-meta { flex:none; font-size:11px; color:var(--dsw-alias-label-tertiary); }
.dsh-recent-thought .dsh-recent-iconbtn { width:24px; height:24px; opacity:.55; }
.dsh-recent-thought:hover .dsh-recent-iconbtn { opacity:1; }
/* 输入框上方的「待问」卡片：默认只有一行小条，点「展开」才铺开 */
.dsh-recent-dock { margin:0 0 6px; padding:6px 10px; border-radius:var(--dsw-radius-lg);
  border:.5px solid var(--dsw-alias-border-l3); background:var(--dsw-alias-bg-layer-1); }
.dsh-recent-dock.open { padding-bottom:10px; border-color:var(--dsw-alias-border-l2); box-shadow:var(--dsw-elevation-soft); }
.dsh-recent-dock-bar { display:flex; align-items:center; gap:8px; }
.dsh-recent-dock-bar .dsh-recent-btn { flex:none; height:26px; font-size:12px; padding:0 9px; }
.dsh-recent-dock-title { flex:none; display:inline-flex; align-items:center; gap:4px; font-size:12px; font-weight:500; }
.dsh-recent-dock-peek { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-size:12px; color:var(--dsw-alias-label-tertiary); }
.dsh-recent-dock-when { flex:none; font-size:11px; color:var(--dsw-alias-label-tertiary); }
.dsh-recent-dock-x { width:24px; height:24px; opacity:.6; margin-left:0; }
.dsh-recent-dock-x:hover { opacity:1; }
.dsh-recent-dock-body { margin-top:8px; }
.dsh-recent-dock-text { font-size:12.5px; line-height:20px; white-space:pre-wrap; word-break:break-word;
  max-height:8em; overflow:auto; color:var(--dsw-alias-label-primary); }
.dsh-recent-dock-actions { display:flex; align-items:center; gap:8px; margin-top:8px; flex-wrap:wrap; }
.dsh-recent-dock-actions .dsh-recent-btn { height:26px; font-size:12px; padding:0 9px; }
/* 触屏没有 hover：行内动作不能一直藏在 opacity:0 里。 */
@media (hover: none) {
  .dsh-recent-iconbtn { opacity:.55; }
}
`;

		// ---------------------------------------------------------------- 纯函数

		/** 词典兜底：locale 未绑定时退回中文。 */
		function fallbackT(key, vars) {
			const raw = DICT.zh[key] !== undefined ? DICT.zh[key] : key;
			return vars
				? String(raw).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m))
				: raw;
		}

		function tOf(props) {
			return props && typeof props.t === "function" ? props.t : fallbackT;
		}

		/** 每分钟重算一次“现在”，供相对时间使用。 */
		function useNow(intervalMs) {
			const [now, setNow] = React.useState(() => Date.now());
			React.useEffect(() => {
				const timer = setInterval(() => setNow(Date.now()), intervalMs);
				return () => clearInterval(timer);
			}, [intervalMs]);
			return now;
		}

		/** 相对时间（面板与待问卡片每 60 秒重算一次）。 */
		function relTime(ms, now, t) {
			if (!ms) return "—";
			const d = now - ms;
			if (d < 60000) return t("justNow");
			if (d < 3600000) return t("minutesAgo", { n: Math.floor(d / 60000) });
			if (d < DAY) return t("hoursAgo", { n: Math.floor(d / 3600000) });
			const days = Math.floor(d / DAY);
			if (days === 1) return t("yesterday");
			if (days < 7) return t("daysAgo", { n: days });
			if (days < 30) return t("weeksAgo", { n: Math.floor(days / 7) });
			return t("monthsAgo", { n: Math.floor(days / 30) });
		}

		/** 时间分组桶。 */
		function bucketOf(ms, now) {
			if (!ms) return "earlier";
			const startOfToday = new Date(now).setHours(0, 0, 0, 0);
			if (ms >= startOfToday) return "today";
			if (ms >= startOfToday - DAY) return "yesterday";
			if (ms >= startOfToday - 6 * DAY) return "week";
			return "earlier";
		}

		/** 目录显示名：路径末段（保留完整路径给 tooltip）。 */
		function dirLabel(p, t) {
			if (!p) return t("unregisteredDir");
			const parts = String(p).split(/[\\/]+/).filter(Boolean);
			return parts.length ? parts[parts.length - 1] : String(p);
		}

		/** 投影里的 turnOutline；没有该字段时返回 null（未知，而不是空数组）。 */
		function turnOutlineOf(projectionStore) {
			const values = projectionStore && projectionStore.values;
			return values && Array.isArray(values.turnOutline) ? values.turnOutline : null;
		}

		/** 固定并发跑一批异步任务；alive 变 false 后不再领取新任务。 */
		async function runWithConcurrency(items, limit, worker, alive) {
			let cursor = 0;
			const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
				while (cursor < items.length && (!alive || alive())) {
					const index = cursor;
					cursor += 1;
					await worker(items[index]);
				}
			});
			await Promise.all(runners);
		}

		/** 给宿主 RPC 加超时；原始 Promise 失败/超时后迟到也不再产生未处理异常。 */
		function promiseWithTimeout(factory, timeoutMs) {
			const work = Promise.resolve().then(factory);
			work.catch(() => {});
			let timer;
			const timeout = new Promise((resolve, reject) => {
				timer = setTimeout(() => reject(new Error("projection request timed out")), timeoutMs);
			});
			return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
		}

		/**
		 * 拉取一个会话的轮次大纲投影。
		 * 成功记入 loaded；失败重试一次，仍失败记入 failed，避免后续无限重试。
		 */
		function ensureProjection(sessionId, refreshProjections) {
			if (projectionLoaded.has(sessionId)) return Promise.resolve();
			const existing = projectionInFlight.get(sessionId);
			if (existing) return existing;
			const promise = (async () => {
				let lastError = null;
				for (let attempt = 0; attempt <= PROJECTION_RETRIES; attempt += 1) {
					try {
						await promiseWithTimeout(() => refreshProjections(sessionId), PROJECTION_TIMEOUT);
						projectionLoaded.add(sessionId);
						projectionFailed.delete(sessionId);
						return;
					} catch (error) {
						lastError = error;
						if (attempt < PROJECTION_RETRIES) {
							await new Promise((resolve) => setTimeout(resolve, PROJECTION_RETRY_DELAY));
						}
					}
				}
				projectionFailed.set(sessionId, Date.now());
				throw lastError;
			})().finally(() => {
				projectionInFlight.delete(sessionId);
			});
			projectionInFlight.set(sessionId, promise);
			return promise;
		}

		/** 是否包含（兼容数组与 Set）。 */
		function has(collection, id) {
			if (!collection) return false;
			if (typeof collection.has === "function") return collection.has(id);
			if (Array.isArray(collection)) return collection.indexOf(id) >= 0;
			return false;
		}

		/**
		 * 插件自己判定的「跑完但你当时没在看」。
		 *
		 * 宿主的 completionUnread 只在 ui-session 的 observeRunning 里 `!isMain()` 时置位；
		 * 刚切走的会话如果仍被主视图保留，宿主就永远不标（实测侧栏和面板同时不亮）。
		 * 这里独立盯一次 running 的 true→false：只要那个会话不是当前打开的那个，就记一笔。
		 * 只活在内存里；它成为当前会话、或又开始跑，就清掉。
		 */
		const finishedWhileAway = new Map();

		/** 当前打开的会话 id（uiSession.current 的绑定值）。 */
		function activeSessionId(uiSession) {
			const current = uiSession && uiSession.current;
			if (!current || typeof current.getSnapshot !== "function") return undefined;
			const value = current.getSnapshot();
			return value && typeof value.key === "string" ? value.key : undefined;
		}

		/**
		 * 全局盯会话运行状态：从「在跑」变成「不跑」、且当时不是当前会话，就记一笔。
		 *
		 * running 优先取状态表（和侧栏同一个来源），缺了退回会话行的 running——
		 * 和原生 `status?.running ?? row.running` 同一口径，免得漏掉列表侧的变化。
		 * @returns disposer（uiSession 不可用时返回 undefined）。
		 */
		function watchCompletions(uiSession, sessions) {
			const store = uiSession && uiSession.sessionStatus;
			if (!store || typeof store.subscribe !== "function" || typeof store.getSnapshot !== "function") return undefined;
			const listStore = sessions && sessions.list && typeof sessions.list.getSnapshot === "function" ? sessions.list : undefined;
			/**
			 * 「你是不是正在看它」的绑定值。必须确实可读（既能订阅、也能取快照），
			 * 否则整条判定不启用 —— 宁可漏标一颗绿点，也不要把你正盯着的会话标成未看。
			 */
			const currentStore = () => {
				const current = uiSession && uiSession.current;
				return current && typeof current.subscribe === "function" && typeof current.getSnapshot === "function"
					? current
					: undefined;
			};
			const lastRunning = new Map();
			const refresh = () => {
				const snapshot = store.getSnapshot();
				if (!snapshot || typeof snapshot.get !== "function" || typeof snapshot.keys !== "function" || typeof snapshot[Symbol.iterator] !== "function") return;
				const list = listStore ? listStore.getSnapshot() : undefined;
				const byId = (list && list.byId) || {};
				const canTellAway = Boolean(currentStore());
				const activeId = activeSessionId(uiSession);
				const ids = new Set(snapshot.keys());
				for (const id of Object.keys(byId)) ids.add(id);
				// 只按时间清理：状态表可能只覆盖当前工作区，按列表裁剪会误清别的目录里的标记。
				const cutoff = Date.now() - 7 * DAY;
				for (const [id, at] of finishedWhileAway) {
					if (at < cutoff) finishedWhileAway.delete(id);
				}
				for (const id of ids) {
					const status = snapshot.get(id);
					const row = byId[id];
					const running = Boolean(status && status.running !== undefined ? status.running : row && row.running);
					const wasRunning = lastRunning.get(id) === true;
					lastRunning.set(id, running);
					if (running) {
						finishedWhileAway.delete(id);
						continue;
					}
					if (wasRunning && canTellAway && id !== activeId) finishedWhileAway.set(id, Date.now());
				}
				// 已经打开它了，就别再标「未看」
				if (canTellAway && activeId !== undefined) finishedWhileAway.delete(activeId);
			};
			refresh();
			const disposers = [store.subscribe(refresh)];
			const current = currentStore();
			if (current) disposers.push(current.subscribe(refresh));
			if (listStore && typeof listStore.subscribe === "function") disposers.push(listStore.subscribe(refresh));
			return () => {
				for (const dispose of disposers) {
					try { dispose(); } catch (error) { /* 单个订阅取消失败不影响其它 */ }
				}
			};
		}

		/**
		 * 会话状态 → 原生状态点的状态名。
		 *
		 * 与 DSH 侧栏逐条对齐：待处理交互（warning）> 运行中（ongoing）> 未读完成（done）> 空闲。
		 * 子会话还在跑的父会话，原生同样算「运行中」。
		 * 注意空闲在原生的会话行里**不画点**，只保留一格空位——这里也照做。
		 */
		function statusState(status) {
			if (!status) return "idle";
			if (pendingKind(status)) return "warning";
			if (status.running || status.runningSubagentCount > 0) return "ongoing";
			if (status.completionUnread) return "done";
			return "idle";
		}

		/** 待处理交互的种类（原生只认这三种，其余一律当作没有）。 */
		function pendingKind(status) {
			const kind = status && status.pendingInteraction && status.pendingInteraction.kind;
			return kind === "approval" || kind === "plan-review" || kind === "question" ? kind : "";
		}

		/** 读屏文案：和原生的 status.* 一一对应。 */
		function statusLabel(status, t) {
			const kind = pendingKind(status);
			if (kind === "approval") return t("statusApproval");
			if (kind === "plan-review") return t("statusPlanReview");
			if (kind === "question") return t("statusAnswer");
			if (status && status.running) return t("statusRunning");
			if (status && status.runningSubagentCount > 0) {
				return t(status.runningSubagentCount === 1 ? "statusSubagentOne" : "statusSubagentOther", { n: status.runningSubagentCount });
			}
			if (status && status.completionUnread) return t("statusCompleted");
			return t("statusIdle");
		}

		/**
		 * 还在跑的子会话数：原生用会话投影里的 subagentCatalog 判断，
		 * 运行态仍取宿主状态表（缺失时退回会话行自己的 running）。
		 */
		function runningChildCount(projectionStore, statuses, byId) {
			const catalog = projectionStore && projectionStore.values && projectionStore.values.subagentCatalog;
			if (!Array.isArray(catalog)) return 0;
			let count = 0;
			for (const child of catalog) {
				if (!child || typeof child.id !== "string") continue;
				const childStatus = statuses && typeof statuses.get === "function" ? statuses.get(child.id) : undefined;
				const childRow = byId ? byId[child.id] : undefined;
				const running = childStatus && childStatus.running !== undefined
					? childStatus.running
					: childRow && childRow.running;
				if (running === true) count += 1;
			}
			return count;
		}

		/** 原生会把行尾的相对时间换成待处理短语（待审批 / 计划待审 / 待回答）。 */
		function pendingShortLabel(status, t) {
			const kind = pendingKind(status);
			if (kind === "approval") return t("statusApprovalShort");
			if (kind === "plan-review") return t("statusPlanReviewShort");
			if (kind === "question") return t("statusAnswerShort");
			return "";
		}

		/** 运行中的转圈：与原生 StateDot 的 ongoing 同构（14px，轨道 + 旋转圆弧）。 */
		function StatusSpinner() {
			return h(
				"svg",
				{ className: "dsh-recent-spinner", viewBox: "0 0 24 24", width: 14, height: 14, "aria-hidden": "true" },
				h(
					"g",
					{ className: "dsh-recent-spinner-motion" },
					h("circle", { className: "dsh-recent-spinner-track", cx: 12, cy: 12, r: 9.5 }),
					h("circle", { className: "dsh-recent-spinner-arc", cx: 12, cy: 12, r: 9.5 }),
				),
			);
		}

		/**
		 * 行首状态位：固定 10px 槽位里放 状态点 / 转圈 / 什么都不放。
		 * 空闲时保持空槽，标题的左边界才不会一行一个样。
		 */
		function StatusMark(props) {
			const state = props.blank ? "idle" : statusState(props.status);
			const label = state === "idle" ? "" : statusLabel(props.status, props.t);
			return h(
				"span",
				{ className: "dsh-recent-status" },
				state === "ongoing"
					? StatusSpinner()
					: state === "idle"
						? null
						: h("span", { className: "dsh-recent-dot", "data-state": state }),
				label ? h("span", { className: "dsh-recent-sr" }, label) : null,
			);
		}

		// ------------------------------------------------- 本地存储（想法 / 备注）
		// PRD D7=A：只存本机 localStorage —— 不写宿主存储、不写任何会话日志。
		// 同源的多个标签页共享同一份；跨标签页变更靠 storage 事件同步。
		const STORE_KEY = "dsh-recent-sessions:store:v1";
		/** 旧键（插件还叫「项目雷达」时用的）：首次加载时做一次迁移，之后只写新键。 */
		const LEGACY_STORE_KEY = "dsh-project-radar:store:v1";
		let storeCache = null;
		const storeListeners = new Set();

		/** 读一个键并解析：坏 JSON、非对象、读不到，一律当 "没有"。 */
		function readStored(key) {
			try {
				const value = JSON.parse(localStorage.getItem(key) || "null");
				return value && typeof value === "object" ? value : null;
			} catch (error) {
				return null;
			}
		}

		function storeLoad() {
			if (storeCache) return storeCache;
			let raw = readStored(STORE_KEY);
			if (raw === null) {
				// 改名迁移：接管旧键里已有的想法与视图状态。
				// 写回新键成功之后才删旧键；写回失败时仍然按旧数据渲染 ——
				// 已经在磁盘上的想法不能因为一次配额错误在界面上凭空消失。
				const legacy = readStored(LEGACY_STORE_KEY);
				if (legacy !== null) {
					raw = legacy;
					try {
						localStorage.setItem(STORE_KEY, JSON.stringify(legacy));
						localStorage.removeItem(LEGACY_STORE_KEY);
					} catch (error) {
						console.warn("[recent-sessions] 旧键迁移写回失败，本次仍按旧数据展示", error);
					}
				}
			}
			storeCache = {
				thoughts: raw && Array.isArray(raw.thoughts)
					? raw.thoughts.filter((item) => item && typeof item.text === "string" && typeof item.sessionId === "string")
					: [],
				// 旧版「项目雷达」留下的自由笔记：保留以便回滚/迁移，当前 UI 不读取。
				notes: raw && raw.notes && typeof raw.notes === "object" ? raw.notes : {},
				// 每个会话的「待问卡片」静音时刻：✕ 之后不再打扰，直到有新想法落进来
				dockMuted: raw && raw.dockMuted && typeof raw.dockMuted === "object" ? raw.dockMuted : {},
				// 视图状态（排序 / 过滤 / 目录筛选）：跟着本机走，下次打开保持一致
				view: raw && raw.view && typeof raw.view === "object" ? raw.view : {},
			};
			return storeCache;
		}

		function storeEmit() {
			for (const listener of [...storeListeners]) {
				try { listener(); } catch (error) { /* 单个监听器失败不影响其它 */ }
			}
		}

		function storeSave() {
			let ok = true;
			try {
				localStorage.setItem(STORE_KEY, JSON.stringify(storeLoad()));
			} catch (error) {
				ok = false;
				console.warn("[recent-sessions] 本地存储写入失败", error);
			}
			storeEmit();
			return ok;
		}

		/**
		 * 收起某个会话的待问卡片（不改动想法本身）。
		 *
		 * 语义：这是"先不打扰"，不是"不要了"。此后只有**新记的想法**
		 * （createdAt 晚于静音时刻）才会再把它叫出来；旧想法仍然留在
		 * 最近会话面板的徽标里，随时可以回去看。
		 */
		function muteDock(sessionId) {
			const store = storeLoad();
			const previous = store.dockMuted;
			store.dockMuted = Object.assign({}, previous, { [sessionId]: Date.now() });
			if (!storeSave()) {
				store.dockMuted = previous;
				storeEmit();
				return false;
			}
			return true;
		}

		/** 合并写入一条视图状态（排序 / 过滤 / 目录筛选）；写失败回滚并返回 false。 */
		function storeSetView(patch) {
			const store = storeLoad();
			const previous = store.view;
			store.view = Object.assign({}, previous, patch);
			if (!storeSave()) {
				store.view = previous;
				storeEmit();
				return false;
			}
			return true;
		}

		/**
		 * 新增一条想法。返回 { entry, persisted }；空文本返回 null。
		 * 写入失败时把内存里的条目回滚，让编辑器保留草稿，而不是假装保存成功。
		 */
		function addThought(sessionId, text) {
			const clean = String(text == null ? "" : text).replace(/\s+$/u, "");
			if (clean.trim() === "") return null;
			const entry = {
				id: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
				sessionId,
				text: clean,
				createdAt: Date.now(),
				status: "pending",
			};
			const thoughts = storeLoad().thoughts;
			thoughts.push(entry);
			if (!storeSave()) {
				const index = thoughts.lastIndexOf(entry);
				if (index >= 0) thoughts.splice(index, 1);
				storeEmit();
				return { entry: null, persisted: false };
			}
			return { entry, persisted: true };
		}

		function patchThought(id, patch) {
			const entry = storeLoad().thoughts.find((item) => item.id === id);
			// 条目可能已经被另一个标签页删掉了：目标状态已经成立，不算写入失败。
			// （这里返回 false 会让调用方报「存储写入失败」，那是个错误的原因。）
			if (!entry) return true;
			const previous = Object.assign({}, entry);
			Object.assign(entry, patch);
			if (!storeSave()) {
				Object.assign(entry, previous);
				storeEmit();
				return false;
			}
			return true;
		}

		function removeThought(id) {
			const store = storeLoad();
			const previous = store.thoughts;
			store.thoughts = previous.filter((item) => item.id !== id);
			if (!storeSave()) {
				store.thoughts = previous;
				storeEmit();
				return false;
			}
			return true;
		}

		/** 订阅本地存储（含来自其它标签页的 storage 事件）。 */
		function useRecentStore() {
			const [, bump] = React.useState(0);
			React.useEffect(() => {
				const listener = () => bump((n) => n + 1);
				storeListeners.add(listener);
				const onStorage = (event) => {
					if (event.key !== null && event.key !== STORE_KEY) return;
					storeCache = null;
					storeEmit();
				};
				window.addEventListener("storage", onStorage);
				return () => {
					storeListeners.delete(listener);
					window.removeEventListener("storage", onStorage);
				};
			}, []);
			return storeLoad();
		}

		/** 错误边界：任何子组件炸掉都不许影响宿主界面。 */
		class Safe extends React.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}
			static getDerivedStateFromError() {
				return { failed: true };
			}
			componentDidCatch(error) {
				console.warn("[recent-sessions] 组件异常（已隔离，不影响宿主界面）", error);
			}
			render() {
				if (!this.state.failed) return this.props.children;
				return this.props.fallback || null;
			}
		}

		// ---------------------------------------------------------------- 组件

		/** 统一的原生线条图标外壳：16px 视框、1px 描边、跟随 currentColor。 */
		function Icon(props) {
			const size = props.size || 16;
			return h(
				"svg",
				{
					className: props.className ? `dsh-recent-glyph ${props.className}` : "dsh-recent-glyph",
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1,
					"aria-hidden": "true",
				},
				props.children,
			);
		}

		/** 侧栏图标：与原生会话队列同源的对话气泡（ChatLines），不再用雷达准星。 */
		function RecentGlyph(props) {
			return h(
				Icon,
				{ size: props.size || 16 },
				h("path", { d: "M5 6.75H11" }),
				h("path", { d: "M5 9H8" }),
				h("path", { d: "M2.37067 11.2497C1.5872 9.89252 1.32042 8.29798 1.61945 6.7597C1.91847 5.22141 2.76317 3.84293 3.99801 2.87809C5.23285 1.91325 6.7747 1.427 8.33964 1.50888C9.90458 1.59076 11.3873 2.23526 12.5147 3.32369C13.6422 4.41232 14.3384 5.8717 14.4751 7.43304C14.6118 8.99438 14.1797 10.5525 13.2585 11.8205C12.3372 13.0885 10.9889 13.9809 9.4617 14.3334C8.18666 14.6277 6.8587 14.529 5.64964 14.0601C5.17095 13.8745 4.76937 13.4929 4.26509 13.3963C3.67389 13.2832 2.95232 13.5595 2.0377 14.3334" }),
			);
		}

		function SearchGlyph(props) {
			return h(
				Icon,
				{ size: props.size || 16, className: props.className },
				h("path", { d: "M6.58727 11.8586C9.55061 11.8586 11.9529 9.45637 11.9529 6.49304C11.9529 3.5297 9.55061 1.12744 6.58727 1.12744C3.62394 1.12744 1.22168 3.5297 1.22168 6.49304C1.22168 9.45637 3.62394 11.8586 6.58727 11.8586Z" }),
				h("path", { d: "M10.2991 10.3933L14.7783 14.8725" }),
			);
		}

		function PinGlyph(props) {
			return h(
				Icon,
				{ size: props.size || 14 },
				h("path", {
					d: "M9.96976 1.70572L13.1554 3.93629L10.9019 8.12317L11.5158 11.605L10.7192 12.7427L2.52767 7.00693L3.3243 5.86922L6.80612 5.25528L9.96976 1.70572Z",
					strokeLinejoin: "round",
				}),
				h("path", {
					d: "M6.05285 9.47511C6.27284 9.16094 6.70586 9.08458 7.02003 9.30457C7.3342 9.52455 7.41055 9.95757 7.19057 10.2717L3.98587 14.4708L3.21223 13.9291L6.05285 9.47511Z",
					fill: "currentColor",
					stroke: "none",
				}),
			);
		}

		function EditGlyph(props) {
			return h(
				Icon,
				{ size: props.size || 16 },
				h("path", {
					d: "M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z",
					fill: "currentColor",
					stroke: "none",
				}),
				h("path", { d: "M7.7849 8.23878L13.888 2.13574" }),
			);
		}

		function FolderGlyph(props) {
			return h(
				Icon,
				{ size: props.size || 16 },
				h("path", { d: "M12.3994 13.5986H2.04956C1.49728 13.5986 1.04956 13.1509 1.04956 12.5986V3.40137C1.04956 2.84908 1.49728 2.40137 2.04956 2.40137H4.76632C5.01016 2.40137 5.24561 2.49046 5.42836 2.6519L6.94088 3.98799C7.12364 4.14943 7.35908 4.23852 7.60293 4.23852H12.3994C12.9517 4.23852 13.3994 4.68624 13.3994 5.23852V7.16991" }),
				h("path", { d: "M2.55911 7.93683C2.67584 7.49906 3.07229 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55911 7.93683Z" }),
			);
		}

		function CopyGlyph(props) {
			return h(
				Icon,
				{ size: props.size || 16 },
				h("rect", { x: "1.52075", y: "4.07373", width: "10.3932", height: "10.3932", rx: "2" }),
				h("path", {
					d: "M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z",
					fill: "currentColor",
					stroke: "none",
				}),
			);
		}

		function CloseGlyph(props) {
			return h(
				Icon,
				{ size: props.size || 14 },
				h("path", { d: "M2.5 2.5L13.5 13.5" }),
				h("path", { d: "M13.5 2.5L2.5 13.5" }),
			);
		}

		/**
		 * 面板里的一行 = 一个会话。
		 *
		 * 行本身只负责鼠标点击；键盘/读屏的“打开会话”入口是标题按钮，
		 * 避免 role="button" 里再嵌 button 的无效 ARIA 结构。
		 */
		function RecentRow(props) {
			const row = props.row;
			const t = props.t;
			const now = props.now;
			const thoughts = props.thoughts;
			const [editing, setEditing] = React.useState(false);
			const [draft, setDraft] = React.useState("");
			const [open, setOpen] = React.useState(false);

			const stop = (event) => event.stopPropagation();
			const pendingHint = row.blank ? "" : pendingShortLabel(row.status, t);
			const save = () => {
				const result = addThought(row.id, draft);
				if (!result) return;
				if (!result.persisted) {
					if (props.onStorageError) props.onStorageError();
					return;
				}
				setDraft("");
				setEditing(false);
				setOpen(true);
			};

			const line1 = h(
				"div",
				{ className: "dsh-recent-row" },
				h(StatusMark, { status: row.status, blank: row.blank, t }),
				row.pinned ? h("span", { className: "dsh-recent-pin", title: t("pinned"), role: "img", "aria-label": t("pinned") }, h(PinGlyph, { size: 14 })) : null,
				h(
					"button",
					{
						type: "button",
						className: "dsh-recent-ttl",
						"aria-label": t("openSession", { title: row.title }),
						onClick: (event) => { stop(event); props.openSession(row.id); },
					},
					row.title,
				),
				row.dir
					? h(
						"button",
						{
							type: "button",
							className: "dsh-recent-dir",
							title: t("filterDir", { path: row.dir }),
							onClick: (event) => {
								stop(event);
								if (props.onFilterDir) props.onFilterDir(row.dir);
							},
						},
						row.dirLabel,
					)
					: h("span", { className: "dsh-recent-dir dsh-recent-dir-static", title: t("unregisteredDir") }, row.dirLabel),
				// 待处理交互时，原生把行尾的相对时间换成一句短语（读屏仍由状态位读出完整文案）
				h(
					"span",
					{ className: "dsh-recent-time", "aria-hidden": pendingHint ? true : undefined },
					pendingHint || relTime(row.at, now, t),
				),
				h(
					"button",
					{
						type: "button",
						className: "dsh-recent-iconbtn",
						title: t("jot"),
						"aria-label": t("jot"),
						"aria-expanded": editing,
						onClick: (event) => { stop(event); setEditing((value) => !value); },
					},
					h(EditGlyph),
				),
				// 行级「找回来」动作：在文件管理器中显示目录 / 复制路径（hover 才出现）
				props.canReveal && row.dir
					? h(
						"button",
						{
							type: "button",
							className: "dsh-recent-iconbtn",
							title: t("reveal"),
							"aria-label": t("reveal"),
							onClick: (event) => { stop(event); if (props.onReveal) props.onReveal(row.dir); },
						},
						h(FolderGlyph),
					)
					: null,
				row.dir
					? h(
						"button",
						{
							type: "button",
							className: "dsh-recent-iconbtn",
							title: t("copyDir"),
							"aria-label": t("copyDir"),
							onClick: (event) => { stop(event); if (props.onCopyPath) props.onCopyPath(row.dir); },
						},
						h(CopyGlyph),
					)
					: null,
				thoughts.length > 0
					? h(
						"button",
						{
							type: "button",
							className: "dsh-recent-count",
							title: t("thoughts", { n: thoughts.length }),
							"aria-label": t("thoughts", { n: thoughts.length }),
							"aria-expanded": open,
							onClick: (event) => { stop(event); setOpen((value) => !value); },
						},
						h(RecentGlyph, { size: 12 }),
						String(thoughts.length),
					)
					: null,
			);

			// 第二行：最后一句我在问什么（hover 还能看到最后一句它的结论）
			const snippet = row.lastPrompt
				? h(
					"div",
					{
						className: "dsh-recent-snippet",
						title: row.lastResponse ? t("lastAnswer", { text: row.lastResponse }) : row.lastPrompt,
					},
					row.lastPrompt,
				)
				: null;

			const editor = editing
				? h(
					"div",
					{ className: "dsh-recent-editor", onClick: stop },
					h("textarea", {
						className: "dsh-recent-textarea",
						autoFocus: true,
						value: draft,
						placeholder: t("editorPlaceholder"),
						onChange: (event) => setDraft(event.target.value),
						onKeyDown: (event) => {
							event.stopPropagation();
							if ((event.ctrlKey || event.metaKey) && event.key === "Enter") save();
							if (event.key === "Escape") setEditing(false);
						},
					}),
					h(
						"div",
						{ className: "dsh-recent-editor-actions" },
						h("button", { type: "button", className: "dsh-recent-btn", onClick: save }, t("save")),
						h("button", { type: "button", className: "dsh-recent-btn", onClick: () => setEditing(false) }, t("cancel")),
						h("span", { className: "dsh-recent-hint" }, t("editorHint")),
					),
				)
				: null;

			const list = open && thoughts.length > 0
				? h(
					"div",
					{ className: "dsh-recent-thoughts", onClick: stop },
					thoughts.map((item) =>
						h(
							"div",
							{ className: "dsh-recent-thought", key: item.id },
							h("span", { className: "dsh-recent-thought-text" }, item.text),
							h(
								"span",
								{ className: "dsh-recent-thought-meta" },
								`${relTime(item.createdAt, now, t)}${item.status === "delivered" ? ` · ${t("delivered")}` : ""}`,
							),
							h(
								"button",
								{
									type: "button",
									className: "dsh-recent-iconbtn",
									title: t("deleteThought"),
									"aria-label": t("deleteThought"),
									onClick: () => { if (!removeThought(item.id) && props.onStorageError) props.onStorageError(); },
								},
								h(CloseGlyph, { size: 12 }),
							),
						),
					),
				)
				: null;

			return h(
				"div",
				{
					className: "dsh-recent-item",
					title: row.dir || row.id,
					onClick: () => props.openSession(row.id),
				},
				line1,
				snippet,
				editor,
				list,
			);
		}

		/**
		 * 输入框上方的「待问」卡片（conversation.input.dock，session 作用域）。
		 *
		 * PRD D4=B 的送达机制：当你打开这个会话时，如果本机存着它的想法，
		 * 就在这里出现一张卡片 —— 你必须点一下才填入草稿，绝不自动发送、
		 * 绝不排队投递、绝不触发模型运行。
		 */
		function ThoughtDock(props) {
			ensureStyles();
			const t = tOf(props);
			const sessionId = props.sessionId || (props.session && props.session.id);
			const inputActions = props.inputActions;
			const store = useRecentStore();
			const [hint, setHint] = React.useState("");
			const [expanded, setExpanded] = React.useState(false);
			const now = useNow(60000);

			// delivered 的旧想法不应在静音时间丢失时重新冒出来。
			const all = store.thoughts.filter((item) =>
				item.sessionId === sessionId && item.status !== "dropped" && item.status !== "delivered");
			const mutedAt = (store.dockMuted && store.dockMuted[sessionId]) || 0;
			// 默认只显示一行；被 ✕「先不打扰」之后，只有新记的想法才会再叫它出来
			const pending = all.filter((item) => item.createdAt > mutedAt);
			if (!sessionId || pending.length === 0) return null;

			const text = pending.map((item) => item.text).join("\n");
			const peek = String(pending[0].text).replace(/\s+/g, " ").slice(0, 64);

			const deliver = () => {
				let ok = false;
				try {
					if (inputActions && typeof inputActions.insertText === "function") {
						// captureInsertion 只在真要插入时取一次，避免白占一次插入位
						const span = typeof inputActions.captureInsertion === "function"
							? inputActions.captureInsertion()
							: undefined;
						// 宿主实现可能返回 void：只有明确的 false 才算失败。否则一次成功的插入
						// 会被当成失败（复制到剪贴板 + 想法仍是待问），点第二次就重复插入一遍。
						ok = inputActions.insertText(text, span) !== false;
					}
				} catch (error) {
					ok = false;
					console.warn("[recent-sessions] 插入草稿失败", error);
				}
				if (ok) {
					let saved = true;
					for (const item of pending) {
						if (!patchThought(item.id, { status: "delivered", deliveredAt: Date.now() })) saved = false;
					}
					if (!saved) {
						setHint(t("storageFailed"));
						return;
					}
					// 卡片已完成使命：连同静音一起收起，不再占地方
					muteDock(sessionId);
					return;
				}
				const copied = () => setHint(t("insertFailedCopied"));
				const manual = () => setHint(t("insertFailedManual"));
				try {
					const result = navigator.clipboard.writeText(text);
					if (result && typeof result.then === "function") result.then(copied, manual);
					else copied();
				} catch (error) {
					manual();
				}
			};

			/** ✕ = 先不打扰：不改动想法本身，只是不再主动出现。 */
			const mute = () => {
				if (muteDock(sessionId)) {
					setHint("");
					setExpanded(false);
				} else {
					setExpanded(true);
					setHint(t("storageFailed"));
				}
			};

			return h(
				"div",
				{ className: `dsh-recent-dock${expanded ? " open" : ""}` },
				h(
					"div",
					{ className: "dsh-recent-dock-bar" },
					h(
						"span",
						{ className: "dsh-recent-dock-title" },
						h(RecentGlyph, { size: 12 }),
						t("thoughtsCount", { n: pending.length }),
					),
					h("span", { className: "dsh-recent-dock-peek", title: peek }, peek),
					h("span", { className: "dsh-recent-dock-when" }, relTime(pending[0].createdAt, now, t)),
					h(
						"button",
						{
							type: "button",
							className: "dsh-recent-btn",
							"aria-expanded": expanded,
							onClick: () => setExpanded((value) => !value),
						},
						expanded ? t("collapse") : t("expand"),
					),
					h(
						"button",
						{
							type: "button",
							className: "dsh-recent-iconbtn dsh-recent-dock-x",
							title: t("mute"),
							"aria-label": t("notNow"),
							onClick: mute,
						},
						h(CloseGlyph, { size: 12 }),
					),
				),
				expanded
					? h(
						"div",
						{ className: "dsh-recent-dock-body" },
						h("div", { className: "dsh-recent-dock-text" }, text),
						h(
							"div",
							{ className: "dsh-recent-dock-actions" },
							h("button", { type: "button", className: "dsh-recent-btn", onClick: deliver }, t("insertDraft")),
							h(
								"button",
								{ type: "button", className: "dsh-recent-btn", onClick: mute },
								t("notNow"),
							),
							h(
								"button",
								{
									type: "button",
									className: "dsh-recent-btn",
									title: t("discardTitle"),
									onClick: () => {
										let saved = true;
										for (const item of pending) {
											if (!patchThought(item.id, { status: "dropped" })) saved = false;
										}
										setHint(saved ? "" : t("storageFailed"));
									},
								},
								t("discard"),
							),
							hint ? h("span", { className: "dsh-recent-hint", role: "status" }, hint) : null,
						),
					)
					: null,
			);
		}

		/**
		 * 全局面板。props 里由外壳提供 root hooks 与 locale-bound 的 t。
		 *
		 * 这个组件假定 gate 已经检查过三个 root hooks；所有 hooks 都无条件调用，
		 * 不会出现 early-return / 条件 hook 导致的 hook 顺序变化。
		 */
		function RecentPanel(props) {
			// 每次渲染兜底：样式表若已从文档里消失（head 被重建、插件被禁用再启用、
			// 热更新时序等），这里会补回来，避免面板退化成浏览器默认外观。
			ensureStyles();
			const t = tOf(props);
			const useSessions = props.useSessions;
			const useSessionStatus = props.useSessionStatus;
			const useWorkspaces = props.useWorkspaces;
			const openSession = props.openSession; // 由注册项的 inject face 注入（闭包）
			const refreshProjections = props.refreshProjections;
			const searchSessions = props.searchSessions;
			const canOpenWorkspacePath = props.canOpenWorkspacePath;
			const openWorkspacePath = props.openWorkspacePath;

			const list = useSessions((s) => s);
			const statuses = useSessionStatus((s) => s);
			const ws = useWorkspaces((s) => s);

			// 本地存储：想法 + 视图状态（视图状态跟着本机走，下次打开保持一致）
			const localStore = useRecentStore();
			const view = localStore.view || {};
			const sortMode = view.sort === "stale" ? "stale" : "recent";
			const onlyUnfinished = view.onlyUnfinished === true;
			const showBlank = view.showBlank === true;
			const showChild = view.showChild === true;
			const dirFilter = typeof view.dirFilter === "string" ? view.dirFilter : "";
			const changeView = (patch) => {
				// 写入失败时 storeSetView 已经回滚，这里把原因说出来，别让界面显示一个刷新就还原的筛选
				if (!storeSetView(patch)) notify(t("storageFailed"));
			};

			const [query, setQuery] = React.useState("");
			const [hits, setHits] = React.useState(null); // 内容全文检索命中：{ items, hasMore } | null
			const [hint, setHint] = React.useState(""); // 一次性提示（显示位置 / 复制路径的结果）
			const [canReveal, setCanReveal] = React.useState(false); // 宿主是否具备原生文件管理器能力
			const [, projectionTick] = React.useState(0);
			const now = useNow(60000);

			// 宿主有没有原生文件管理器能力（整页只问一次；没有就隐藏「显示位置」按钮）
			React.useEffect(() => {
				if (typeof canOpenWorkspacePath !== "function") {
					setCanReveal(false);
					return undefined;
				}
				let alive = true;
				(async () => {
					try {
						const value = await canOpenWorkspacePath();
						if (alive) setCanReveal(value === true);
					} catch (error) {
						if (alive) setCanReveal(false);
					}
				})();
				return () => { alive = false; };
			}, [canOpenWorkspacePath]);

			// 内容全文检索：250ms 防抖 + 取消上一请求；失败静默（本地过滤照常显示）
			React.useEffect(() => {
				const needle = query.trim();
				setHits(null);
				if (typeof searchSessions !== "function" || needle === "") return undefined;
				const controller = new AbortController();
				const timer = setTimeout(async () => {
					try {
						const result = await searchSessions(needle, controller.signal);
						if (controller.signal.aborted) return;
						const items = result && Array.isArray(result.items) ? result.items : [];
						setHits({ items, hasMore: Boolean(result && result.hasMore) });
					} catch (error) {
						if (!controller.signal.aborted) setHits(null);
					}
				}, 250);
				return () => {
					clearTimeout(timer);
					controller.abort();
				};
			}, [query, searchSessions]);

			/** 一次性提示；4 秒后自动消失。 */
			const notify = (message) => {
				setHint(message);
				window.setTimeout(() => setHint((current) => (current === message ? "" : current)), 4000);
			};

			/** 剪贴板写入：writeText 返回 Promise，失败必须走 then 的第二个参数。 */
			const writeClipboard = (text) => {
				try {
					const result = navigator.clipboard.writeText(text);
					return result && typeof result.then === "function" ? result : Promise.resolve();
				} catch (error) {
					return Promise.reject(error);
				}
			};

			/** 显示目录失败时的兜底：复制路径；只有复制成功才说复制成功。 */
			const copyFallback = (target) => {
				writeClipboard(target).then(
					() => notify(t("revealFailedCopied")),
					() => notify(t("copyFailed")),
				);
			};

			/** 在文件管理器中显示目录；失败则退化为复制路径。 */
			const revealPath = (target) => {
				if (typeof openWorkspacePath !== "function" || !target) return;
				try {
					const pending = openWorkspacePath(target);
					if (pending && typeof pending.then === "function") {
						pending.then(
							() => notify(t("revealed")),
							() => copyFallback(target),
						);
						return;
					}
					notify(t("revealed"));
				} catch (error) {
					copyFallback(target);
				}
			};

			/** 复制目录路径。 */
			const copyPath = (target) => {
				if (!target) return;
				writeClipboard(target).then(
					() => notify(t("copied")),
					() => notify(t("copyFailed")),
				);
			};

			const ids = (list && list.ids) || [];
			const byId = (list && list.byId) || {};
			const pinned = ws && ws.pinnedSessionIds;
			const archived = ws && ws.archivedSessionIds;
			/** 每会话的投影值（sessionId → { values: { title, turnOutline, … } }）。 */
			const projections = (list && list.projectionsBySession) || {};
			const canRefreshProjections = typeof refreshProjections === "function";
			/** 本地想法：按会话分桶（dropped 的不再出现）。 */
			const thoughtsBySession = {};
			const pendingThoughtsBySession = {};
			for (const item of localStore.thoughts) {
				if (item.status === "dropped") continue;
				if (!thoughtsBySession[item.sessionId]) thoughtsBySession[item.sessionId] = [];
				thoughtsBySession[item.sessionId].push(item);
				if (item.status === "pending") {
					if (!pendingThoughtsBySession[item.sessionId]) pendingThoughtsBySession[item.sessionId] = [];
					pendingThoughtsBySession[item.sessionId].push(item);
				}
			}

			// 目录 chip 的完整路径（优先取登记的工作区路径，回落到会话自身 cwd）
			const workspacePathBySession = {};
			if (ws && Array.isArray(ws.items)) {
				for (const item of ws.items) {
					for (const sid of item.sessionIds || []) workspacePathBySession[sid] = item.path;
				}
			}

			// 先按“视图过滤”建立可见集合，内容命中与下方列表共用同一套过滤。
			const viewVisibleIds = new Set();
			const rowMetaById = new Map();
			const projectionNeededIds = [];
			let checkingProjections = 0;
			let failedProjections = 0;

			for (const id of ids) {
				const row = byId[id];
				if (!row) continue;
				if (row.origin === "subagent" && !showChild) continue;
				if (row.blank && !showBlank) continue;
				if (has(archived, id)) continue;
				const dir = workspacePathBySession[id] || row.cwd || "";
				if (dirFilter && dir !== dirFilter) continue;

				const status = statuses && typeof statuses.get === "function" ? statuses.get(id) : undefined;
				const pendingThoughts = pendingThoughtsBySession[id] || [];
				const title = row.blank ? t("newSession") : String(row.title || row.displayTitle || "").trim() || t("untitled");
				const projectionStore = projections[id];
				const turns = turnOutlineOf(projectionStore);
				const lastTurn = turns && turns.length > 0 ? turns[turns.length - 1] : null;
				// 「未收尾」的口径：有待问想法 / 最后一轮还没落定回复 / 正在跑 / 有未查看的完成
				const unsettled = Boolean(lastTurn && lastTurn.prompt && !lastTurn.response);
				const projectionKnown = turns !== null || projectionLoaded.has(id);
				const busy = Boolean(status && (status.running || status.pendingInteraction || status.completionUnread));

				if (onlyUnfinished && pendingThoughts.length === 0 && !busy) {
					if (!projectionKnown) {
						// 投影未知时保守保留：宁可多显示，也不要静默隐藏真正未收尾的会话。
						projectionNeededIds.push(id);
						if (projectionFailedRecently(id) || !canRefreshProjections) failedProjections += 1;
						else checkingProjections += 1;
					} else if (!unsettled) {
						continue;
					}
				}

				viewVisibleIds.add(id);
				rowMetaById.set(id, {
					id,
					title,
					dir,
					dirLabel: dirLabel(dir, t),
					at: row.updatedAt || 0,
					pinned: has(pinned, id),
					blank: Boolean(row.blank),
					// 渲染用状态：和原生 sessionNode 同一口径（status 缺 running 时退回会话行）；
					// 「未读完成」额外并入插件自己盯到的「跑完未看」
					status: {
						running: status && status.running !== undefined ? Boolean(status.running) : Boolean(row.running),
						pendingInteraction: status ? status.pendingInteraction : undefined,
						completionUnread: Boolean(status && status.completionUnread) || finishedWhileAway.has(id),
						runningSubagentCount: runningChildCount(projectionStore, statuses, byId),
					},
					lastPrompt: lastTurn && typeof lastTurn.prompt === "string" ? lastTurn.prompt : "",
					lastResponse: lastTurn && typeof lastTurn.response === "string" ? lastTurn.response : "",
				});
			}

			// 本地搜索只过滤标题/目录/id；内容命中由宿主的消息索引单独返回，但同样受上面的视图过滤约束。
			const needle = query.trim().toLowerCase();
			const rows = [];
			for (const id of ids) {
				if (!viewVisibleIds.has(id)) continue;
				const meta = rowMetaById.get(id);
				if (!meta) continue;
				if (needle && `${meta.title} ${meta.dir} ${meta.id}`.toLowerCase().indexOf(needle) < 0) continue;
				rows.push(meta);
			}

			// 排序：置顶优先；最近活动（默认）降序，或最久没动升序；从未活动过的永远排最后
			const sortKey = (item) => (item.at ? item.at : (sortMode === "stale" ? Number.MAX_SAFE_INTEGER : -1));
			rows.sort((a, b) => {
				if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
				return sortMode === "stale" ? sortKey(a) - sortKey(b) : sortKey(b) - sortKey(a);
			});
			// 「最久没动」时把时间桶倒过来，最早的排在最前
			const bucketOrder = sortMode === "stale"
				? ["earlier", "week", "yesterday", "today"]
				: ["today", "yesterday", "week", "earlier"];

			// 预览只补前 30 行；勾选「仅未收尾」时，额外补齐所有需要判定状态的会话。
			// 投影读取的是持久缓存，不激活会话、不打开日志正文。
			const projectionTargets = [];
			const projectionTargetSeen = new Set();
			const addProjectionTarget = (id) => {
				if (!id || projectionTargetSeen.has(id)) return;
				projectionTargetSeen.add(id);
				if (projectionLoaded.has(id) || projectionFailedRecently(id)) return;
				if (turnOutlineOf(projections[id]) !== null) return;
				projectionTargets.push(id);
			};
			for (const row of rows.slice(0, 30)) addProjectionTarget(row.id);
			if (onlyUnfinished) {
				for (const id of projectionNeededIds) addProjectionTarget(id);
			}
			const projectionSignature = projectionTargets.join("\u0001");

			React.useEffect(() => {
				if (!canRefreshProjections || projectionTargets.length === 0) return undefined;
				let alive = true;
				const run = async () => {
					await runWithConcurrency(projectionTargets, PROJECTION_CONCURRENCY, async (sessionId) => {
						if (!alive) return;
						try {
							await ensureProjection(sessionId, refreshProjections);
						} catch (error) {
							console.warn("[recent-sessions] 轮次大纲投影加载失败", sessionId, error);
						}
					}, () => alive);
					if (alive) projectionTick((value) => value + 1);
				};
				run().catch((error) => console.warn("[recent-sessions] 投影批处理失败", error));
				return () => { alive = false; };
			}, [projectionSignature, refreshProjections]);

			// 置顶单独成组。之前是「全局排好序 → 再按时间桶重排」，分桶把置顶打散了：
			// 一个上个月的置顶会话会掉到今天的新会话后面。置顶组不再分桶，按当前排序平铺在最前。
			const pinnedRows = rows.filter((row) => row.pinned);
			const groups = { today: [], yesterday: [], week: [], earlier: [] };
			for (const row of rows) {
				if (row.pinned) continue;
				groups[bucketOf(row.at, now)].push(row);
			}
			const dirCount = new Set(rows.map((r) => r.dir).filter(Boolean)).size;

			const visibleHits = hits && Array.isArray(hits.items)
				? hits.items.filter((hit) => hit && viewVisibleIds.has(hit.sessionId))
				: [];

			/** 一行会话（置顶组与时间桶共用，key 在同一层里唯一）。 */
			const rowNode = (row) => h(RecentRow, {
				key: row.id,
				row,
				now,
				t,
				openSession,
				thoughts: thoughtsBySession[row.id] || [],
				onFilterDir: (dir) => changeView({ dirFilter: dir }),
				onReveal: revealPath,
				onCopyPath: copyPath,
				onStorageError: () => notify(t("storageFailed")),
				canReveal,
			});

			const children = [];
			children.push(
				h(
					"div",
					{ className: "dsh-recent-head", key: "head" },
					h("div", { className: "dsh-recent-title", role: "heading", "aria-level": 2 }, t("panel")),
					h("div", { className: "dsh-recent-meta" }, t("count", { n: rows.length, d: dirCount })),
				),
			);
			children.push(h("div", { className: "dsh-recent-tagline", key: "tagline" }, t("tagline")));
			/** 工具条里的一个复选项（视图状态写进本地存储，下次打开保持）。 */
			const check = (label, checked, onChange) => h(
				"label",
				{ className: "dsh-recent-toggle" },
				h("input", { type: "checkbox", checked, onChange: (event) => onChange(event.target.checked) }),
				label,
			);

			children.push(
				h(
					"div",
					{ className: "dsh-recent-tools", key: "tools" },
					h(
						"label",
						{ className: "dsh-recent-searchwrap" },
						h(SearchGlyph, { size: 16, className: "dsh-recent-searchicon" }),
						h("input", {
							className: "dsh-recent-search",
							type: "search",
							placeholder: t("search"),
							"aria-label": t("search"),
							value: query,
							onChange: (e) => setQuery(e.target.value),
						}),
					),
					h(
						"div",
						{ className: "dsh-recent-seg", role: "group", "aria-label": t("sortLabel") },
						h(
							"button",
							{
								type: "button",
								className: `dsh-recent-segbtn${sortMode === "recent" ? " on" : ""}`,
								title: t("sortRecentTitle"),
								"aria-pressed": sortMode === "recent",
								onClick: () => changeView({ sort: "recent" }),
							},
							t("sortRecent"),
						),
						h(
							"button",
							{
								type: "button",
								className: `dsh-recent-segbtn${sortMode === "stale" ? " on" : ""}`,
								title: t("sortStaleTitle"),
								"aria-pressed": sortMode === "stale",
								onClick: () => changeView({ sort: "stale" }),
							},
							t("sortStale"),
						),
					),
					h(
						"div",
						{ className: "dsh-recent-filters" },
						check(t("onlyUnfinished"), onlyUnfinished, (value) => changeView({ onlyUnfinished: value })),
						check(t("showBlank"), showBlank, (value) => changeView({ showBlank: value })),
						check(t("showChild"), showChild, (value) => changeView({ showChild: value })),
						dirFilter
							? h(
								"button",
								{
									type: "button",
									className: "dsh-recent-dirfilter",
									title: t("filterDirClear", { path: dirFilter }),
									"aria-label": t("filterDirClear", { path: dirFilter }),
									onClick: () => changeView({ dirFilter: "" }),
								},
								h(FolderGlyph, { size: 12 }),
								dirLabel(dirFilter, t),
								h(CloseGlyph, { size: 12 }),
							)
							: null,
					),
				),
			);

			if (onlyUnfinished && checkingProjections > 0) {
				children.push(h("div", { className: "dsh-recent-hintline", key: "projection-checking", role: "status" }, t("checkingUnfinished")));
			} else if (onlyUnfinished && failedProjections > 0) {
				children.push(h("div", { className: "dsh-recent-hintline", key: "projection-failed", role: "status" }, t("projectionUnavailable")));
			}
			if (hint) {
				children.push(h("div", { className: "dsh-recent-hintline", key: "hint", role: "status", "aria-live": "polite" }, hint));
			}

			// 内容命中（宿主的消息索引）：与下方列表共用当前视图过滤，点击直接回到那个会话
			if (visibleHits.length > 0) {
				children.push(
					h(
						"div",
						{ className: "dsh-recent-group", key: "g-hits" },
						h("span", { className: "dsh-recent-groupicon" }, h(SearchGlyph, { size: 12 })),
						`${t("contentHits", { n: visibleHits.length })}${hits && hits.hasMore ? "+" : ""}`,
					),
				);
				visibleHits.forEach((hit, index) => {
					const summary = byId[hit.sessionId];
					const hitDir = workspacePathBySession[hit.sessionId] || (summary && summary.cwd) || "";
					const hitTitle = summary
						? (summary.blank ? t("newSession") : String(summary.title || summary.displayTitle || "").trim() || t("untitled"))
						: hit.sessionId;
					children.push(
						h(
							"div",
							{
								className: "dsh-recent-item",
								key: `hit-${hit.sessionId}-${index}`,
								role: "button",
								tabIndex: 0,
								title: hitDir || hit.sessionId,
								"aria-label": t("openSession", { title: hitTitle }),
								onClick: () => openSession(hit.sessionId),
								onKeyDown: (event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										openSession(hit.sessionId);
									}
								},
							},
							h(
								"div",
								{ className: "dsh-recent-row" },
								h("span", { className: "dsh-recent-hitmark" }, h(SearchGlyph, { size: 14 })),
								h("span", { className: "dsh-recent-ttl" }, hitTitle),
								hitDir ? h("span", { className: "dsh-recent-dir dsh-recent-dir-static", title: hitDir }, dirLabel(hitDir, t)) : null,
							),
							h("div", { className: "dsh-recent-snippet" }, hit.snippet),
						),
					);
				});
			}

			if (rows.length > 0) {
				if (pinnedRows.length > 0) {
					children.push(
						h(
							"div",
							{ className: "dsh-recent-group", key: "g-pinned" },
							h("span", { className: "dsh-recent-groupicon" }, h(PinGlyph, { size: 12 })),
							`${t("pinnedGroup")} · ${pinnedRows.length}`,
						),
					);
					for (const row of pinnedRows) children.push(rowNode(row));
				}
				for (const key of bucketOrder) {
					const bucket = groups[key];
					if (bucket.length === 0) continue;
					children.push(h("div", { className: "dsh-recent-group", key: `g-${key}` }, `${t(key)} · ${bucket.length}`));
					for (const row of bucket) children.push(rowNode(row));
				}
			} else if (visibleHits.length > 0) {
				// 内容命中已经显示；不再叠加“没有会话”。
			} else if (list && list.phase && list.phase !== "ready") {
				children.push(h("div", { className: "dsh-recent-empty", key: "loading" }, t("loading")));
			} else if (onlyUnfinished && checkingProjections > 0) {
				children.push(h("div", { className: "dsh-recent-empty", key: "checking" }, t("checkingUnfinished")));
			} else if (needle || dirFilter || onlyUnfinished) {
				children.push(h("div", { className: "dsh-recent-empty", key: "filtered" }, t("emptyFiltered")));
			} else {
				children.push(h("div", { className: "dsh-recent-empty", key: "empty" }, t("empty")));
			}

			return h("div", { className: "dsh-recent" }, h("div", { className: "dsh-recent-inner" }, children));
		}

		/**
		 * root hooks 是否齐全由 gate 判断；gate 自身不调用 hooks，
		 * 所以 hook 缺失/恢复时 React 会重新挂载 RecentPanel，不会改变 hook 数量。
		 */
		function RecentPanelGate(props) {
			if (typeof props.useSessions !== "function"
				|| typeof props.useSessionStatus !== "function"
				|| typeof props.useWorkspaces !== "function") {
				const t = tOf(props);
				return h(
					"div",
					{ className: "dsh-recent" },
					h("div", { className: "dsh-recent-empty" }, t("hooksUnavailable")),
				);
			}
			return h(RecentPanel, props);
		}

		/** Safe 边界放在 slot 注册层，才能覆盖 RecentPanel 自身的渲染错误。 */
		function RecentPanelSlot(props) {
			ensureStyles();
			const t = tOf(props);
			return h(
				Safe,
				{
					fallback: h(
						"div",
						{ className: "dsh-recent" },
						h("div", { className: "dsh-recent-empty" }, t("internalError")),
					),
				},
				h(RecentPanelGate, props),
			);
		}

		function ThoughtDockSlot(props) {
			ensureStyles();
			return h(Safe, null, h(ThoughtDock, props));
		}

		// ---------------------------------------------------------------- 插件

		const inject = ["slots", "locale", "sessions", "remote", "uiWorkspace", "uiSession"];

		function apply(ctx) {
			const uiWorkspace = ctx.get("uiWorkspace");
			const sessions = ctx.get("sessions");
			const remote = ctx.get("remote");

			// 「跑完未看」的兜底判定（宿主那份 completionUnread 对刚切走的会话不亮）
			ctx.effect(() => watchCompletions(ctx.get("uiSession"), sessions), "recent-sessions: completion watch");

			const t = typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : fallbackT;
			ctx.effect(() => ctx.locale.register(NS, DICT), "recent-sessions: dictionaries");

			// 样式注入（声明式；dispose 时移除）。注意：这只是"首次注入"，
			// 之后由 ensureStyles() 在每次渲染时兜底补回（见该函数注释）。
			ctx.effect(() => {
				ensureStyles();
				return () => {
					const style = document.getElementById(STYLE_ID);
					if (style) style.remove();
				};
			}, "recent-sessions: styles");

			// 1) 全局面板
			ctx.effect(
				() =>
					ctx.slots.inject("main", () =>
						ctx.slots.register(
							{
								name: "main",
								key: PANEL_ID,
								locale: NS,
								inject: () => ({
									openSession: (sessionId) => uiWorkspace.openSession(sessionId),
									// 轮次大纲投影：客户端按会话拉取完整投影基线（宿主读持久缓存，不激活会话）
									refreshProjections: (sessionId) => sessions.refreshProjections(sessionId),
									// 内容全文检索（宿主消息索引）
									searchSessions: (query, signal) => sessions.search(query, signal),
									// 原生路径能力：能否打开文件管理器 / 在文件管理器中显示目录
									canOpenWorkspacePath: () => remote.session.canOpenWorkspacePath(),
									openWorkspacePath: (path) => remote.session.openWorkspacePath({ path, action: "reveal" }),
								}),
							},
							RecentPanelSlot,
						),
					),
				"recent-sessions: main panel",
			);

			// 2) 侧栏入口（id 必须等于 main 的 key）
			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.panellist", () =>
						ctx.slots.register(
							{
								name: "sidebar.panellist",
								id: PANEL_ID,
								order: 40,
								locale: NS,
								// label 是函数：跟随当前 locale，切换语言时侧栏文字也能更新
								label: () => t("panel"),
							},
							RecentGlyph,
						),
					),
				"recent-sessions: sidebar entry",
			);

			// 3) 输入框上方的「待问」卡片（session 作用域）
			//    D4=B 的送达机制：打开有想法的会话时出现；必须用户点一下才填入草稿，
			//    绝不自动发送、绝不排队投递、绝不触发模型运行。Safe 边界在 slot 注册层，
			//    任何异常都只让它自己消失，不影响宿主输入框。
			ctx.effect(
				() =>
					ctx.slots.inject("conversation.input.dock", () =>
						ctx.slots.register(
							{
								name: "conversation.input.dock",
								id: "recent-sessions-thoughts",
								order: 30,
								locale: NS,
								// 兜底注入 locale-bound 的 t，避免 session 插槽只给 sessionId 时退回中文
								inject: () => ({ t }),
							},
							ThoughtDockSlot,
						),
					),
				"recent-sessions: thought dock",
			);

		}

		exports.apply = apply;
		exports.inject = inject;
		// 供 node:test 读取纯函数；浏览器里没有 process，不会带上这个入口。
		if (typeof process !== "undefined" && process.env && process.env.NODE_ENV === "test") {
			exports.__test = {
				DICT,
				fallbackT,
				tOf,
				relTime,
				bucketOf,
				dirLabel,
				turnOutlineOf,
				has,
				runWithConcurrency,
				ensureProjection,
				addThought,
				patchThought,
				removeThought,
				muteDock,
				storeLoad,
				storeSave,
				storeSetView,
				Safe,
				StatusMark,
				statusState,
				statusLabel,
				pendingShortLabel,
				watchCompletions,
				finishedWhileAway,
				RecentRow,
				RecentPanel,
				RecentPanelGate,
				RecentPanelSlot,
				ThoughtDock,
				ThoughtDockSlot,
				resetStore() {
					storeCache = null;
					finishedWhileAway.clear();
					projectionLoaded.clear();
					projectionFailed.clear();
					projectionInFlight.clear();
				},
			};
		}
		return module.exports;
	},
});
