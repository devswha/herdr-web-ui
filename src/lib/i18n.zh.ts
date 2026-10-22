import { SETTINGS_ZH } from "./i18n/settings.zh.ts";
import { TERMINAL_ZH } from "./i18n/terminal.zh.ts";
import { COMPOSER_ZH } from "./i18n/composer.zh.ts";
import { CHAT_ZH } from "./i18n/chat.zh.ts";
import { SIDEBAR_ZH } from "./i18n/sidebar.zh.ts";
import { MACHINES_ZH } from "./i18n/machines.zh.ts";
import { WORKSPACE_ZH } from "./i18n/workspace.zh.ts";
import { FILES_ZH } from "./i18n/files.zh.ts";
import { DEVICES_ZH } from "./i18n/devices.zh.ts";
import { USAGE_ZH } from "./i18n/usage.zh.ts";

/**
 * Simplified Chinese for every `t("…")` in src/ that no part in lib/i18n/ holds: keys more than
 * one feature uses, and the app shell's. ZH at the end is this and the parts together. The English
 * string is the key. Grouped by where
 * the text shows; within a group, roughly in the order it appears. Register: zh-CN software UI
 * (like VS Code 简体中文): concise labels and buttons, plain declarative sentences, full-width
 * punctuation in Chinese sentences, a half-width space between Chinese and Latin words. Fixed
 * terms: 窗格 (pane; 面板 only in 命令面板), 工作区 (workspace), 终端 (terminal), 聊天 (chat),
 * 配对 (pairing), 设备 (device), 会话 (session), 输入框 (composer). Terms Chinese developers read
 * in English stay English: Agent, Token, Skill, Star, bridge, Issue, CLI, SSH, Markdown, Shell;
 * product names (herdr, Tailscale, Codex, Claude Code, GitHub) and key caps stay as they are.
 * Placeholders in braces keep their English names.
 */
const BASE: Record<string, string> = {
  "Back": "返回",
  "Scroll pane up": "向上滚动面板",
  "Scroll pane down": "向下滚动面板",
  "Find in terminal": "在终端中查找",
  "Recent folders": "最近的文件夹",
  "Dismiss": "关闭",
  "Input line": "输入框",
  // ---- settings ----
  "Settings": "设置",
  "Chat": "聊天",
  "Agent default": "代理默认",
  "Phone & devices": "手机和设备",
  "Install app": "安装应用",

  // ---- shortcuts (lib/shortcuts.ts labels) ----
  "Command palette": "命令面板",
  "Switch chat / terminal": "切换聊天 / 终端",
  "Focus pane input": "聚焦面板输入框",
  "Toggle sidebar": "切换侧边栏",
  "New workspace": "新建工作区",
  "Previous pane": "上一个窗格",
  "Next pane": "下一个窗格",

  // ---- agent status words (lib/status.ts) ----
  "READY": "就绪",
  "RUN": "运行",
  "INPUT": "输入",
  "DONE": "完成",
  "BG": "后台",
  "—": "—",

  // ---- app header and shell ----
  "Opening link…": "正在打开链接…",
  "Connecting to Ovis…": "正在连接 Ovis…",
  "Close workspace list": "关闭工作区列表",
  "Open workspace list": "打开工作区列表",
  "Show workspace list": "显示工作区列表",
  "Hide workspace list": "隐藏工作区列表",
  "Pane closed": "窗格已关闭",
  "Show the terminal": "显示终端",
  "Show the chat": "显示聊天",
  "Close this half": "关闭这一半",
  "Toggle sidebar (⌘⇧B)": "切换侧边栏 (⌘⇧B)",
  "Chat transcript (⌘⇧J)": "聊天记录 (⌘⇧J)",
  "Live terminal (⌘⇧J)": "实时终端 (⌘⇧J)",
  "Live terminal: coming to Windows PCs once herdr can attach there": "实时终端：待 herdr 支持在 Windows 上附加终端后开放",
  "soon": "即将",
  "Terminal": "终端",
  "herdr {version} · protocol {protocol}": "herdr {version} · 协议 {protocol}",
  "live": "已连接",
  "disconnected": "已断开",
  "reconnecting": "正在重连",
  "connecting": "正在连接",
  "herdr offline": "herdr 离线",
  "Status unknown": "状态未知",
  "herdr unavailable": "herdr 无响应",
  "The last health check failed. Last seen: herdr {version} · protocol {protocol}": "最近一次状态检查失败。上次确认：herdr {version} · 协议 {protocol}",
  "The health check failed": "状态检查失败",
  "Start herdr on this PC, or check HERDR_SOCKET.": "请在此电脑上启动 herdr，或检查 HERDR_SOCKET。",
  "The other PC's answer was larger than this app accepts": "另一台电脑的响应超出了此应用可接受的大小",
  "The other PC's answer could not be read": "无法读取另一台电脑的响应",
  "Browse files": "浏览文件",
  "Copy link": "复制链接",
  "Link copied": "已复制链接",
  "That agent has closed: its workspace is open": "该代理已关闭，已改为打开其工作区",
  "That link's workspace is closed": "该链接的工作区已关闭",
  "That link's PC is not set up here": "该链接的电脑未在此处设置",
  "Command palette (⌘⇧K)": "命令面板 (⌘⇧K)",
  "Could not sign out. Try again.": "无法退出登录，请重试。",
  "Retry": "重试",
  "Enable notifications": "开启通知",
  "Notify me when a pane needs input or finishes": "窗格需要输入或完成时通知我",
  "On, pushed to this device": "已开启，推送到此设备",
  "Alerts on, pushed to this device, even with the app closed. Tap to turn them off": "提醒已开启，推送到此设备。即使关闭应用也会收到。点按可关闭",
  "Off on this device": "此设备已关闭",
  "More": "更多",
  "More · alerts are off": "更多 · 提醒已关闭",
  "Alerts off on this device. Tap to turn them on": "此设备上的提醒已关闭。点按可开启",
  "On in this tab": "在此标签页开启",
  "Alerts on while this tab is open. Tap to turn them off": "此标签页打开期间会收到提醒。点按可关闭",
  "On in the app": "在应用内开启",
  "Alerts on in the app. Tap to allow them when it is closed too": "应用内提醒已开启。点按可允许在应用关闭时也收到提醒",
  "Alerts on in the app. Tap to turn them off": "应用内提醒已开启。点按可关闭",
  "Alerts on while this tab is open (closed-app alerts need https, and on iPhone the home-screen app). Tap to turn them off": "此标签页打开期间会收到提醒（关闭应用后的提醒需要 https，在 iPhone 上还需使用主屏幕应用）。点按可关闭",

  // ---- sidebar ----
  "Rename pane": "重命名窗格",
  "Branch": "分支",
  "Opening…": "正在打开…",
  "Detached HEAD": "游离 HEAD",
  "Delete": "删除",
  "Close": "关闭",
  "Rename failed: {reason}": "重命名失败：{reason}",

  // ---- PCs sidebar ----
  "Connecting…": "正在连接…",
  "Connected": "已连接",
  "Reconnecting…": "正在重连…",
  "Add PC": "添加 PC",
  "Connect": "连接",
  "Step {n} of {total}": "第 {n} 步，共 {total} 步",
  "{done} of {total}": "{done} / {total}",

  // ---- command palette ----
  "Switch to terminal": "切换到终端",
  "Switch to chat": "切换到聊天",
  "Toggle theme": "切换主题",
  "Refresh": "刷新",
  "Search panes and actions…": "搜索窗格和操作…",
  "Search panes and actions": "搜索窗格和操作",
  "Close command palette": "关闭命令面板",
  "Filter panes by status": "按状态筛选窗格",
  "All": "全部",
  "Recent": "最近",
  "Workspace": "工作区",
  "Selected": "已选择",
  "Unknown workspace": "未知工作区",
  "Actions": "操作",
  "Plugin actions": "插件操作",
  "Running…": "正在运行…",
  "{action} failed: {detail}": "{action} 失败：{detail}",
  "{action} failed (exit code {code})": "{action} 失败（退出码 {code}）",
  "No matching panes or actions": "没有匹配的窗格或操作",

  // ---- new workspace ----
  "Browse": "浏览",
  "Cancel": "取消",
  "Starting…": "正在启动…",
  "Start": "启动",
  // the launch's model, effort, first message and skills (lib/agentLaunchMode.ts, lib/newSession.ts)

  // ---- folder browser ----
  "No matching folders": "没有匹配的文件夹",
  "This folder cannot be opened.": "无法打开此文件夹。",
  "Folders could not be loaded.": "无法加载文件夹。",

  // ---- files ----
  "Files": "文件",
  "This image is {size}; download it to view.": "此图片大小为 {size}；请下载后查看。",
  "Download": "下载",
  "Open {path}": "打开 {path}",

  // ---- PC dialog ----
  "Continue": "继续",

  // ---- updates ----
  "Updates": "更新",
  "Running {version}": "正在运行 {version}",
  "Installing dependencies and building…": "正在安装依赖并构建…",
  "Restarting the bridge…": "正在重启 bridge…",
  "Checking for updates…": "正在检查更新…",
  "Version {version} is available.": "有新版本 {version} 可用。",
  "What's new": "更新内容",
  "Earlier releases not shown here: {count}.": "此处未显示的更早版本：{count} 个。",
  "Full changelog": "完整更新日志",
  "What the last update brought": "上次更新的内容",
  "New features": "新功能",
  "Improvements": "改进",
  "Bug fixes": "问题修复",
  "Show every change": "查看全部更改",
  "Ovis was updated to v{version}.": "Ovis 已更新到 v{version}。",
  "These notes could not be shown.": "无法显示这些说明。",
  "Up to date.": "已是最新版本。",
  "Waiting for an update check…": "正在等待检查更新…",
  "Checks for new releases every 5 minutes.": "每 5 分钟检查一次新版本。",
  "Automatic installation is enabled.": "已启用自动安装。",
  "Install when you are ready; the bridge briefly reconnects and herdr sessions keep running.": "准备好后即可安装。bridge 会短暂重连，herdr 会话会继续运行。",
  "Remote PCs' bridges are updated afterwards when the new version needs it.": "如新版本需要，远程 PC 的 bridge 随后也会更新。",
  "Check for updates": "检查更新",
  "Update and restart": "更新并重启",
  "Running herdr {version}": "正在运行 herdr {version}",
  "herdr {installed} is installed, but the running server is {running}. Updating moves your panes onto the installed version.": "已安装 herdr {installed}，但正在运行的服务器是 {running}。更新后，窗格会迁移到已安装的版本。",
  "Installs the newest herdr on the PC this app runs on and moves its running panes onto it. Panes and agents keep running, and open terminals reconnect.": "在运行此应用的 PC 上安装最新的 herdr，并把正在运行的窗格迁移到新版本。窗格和 Agent 会继续运行，已打开的终端会重新连接。",
  "Update herdr": "更新 herdr",
  "Updating herdr…": "正在更新 herdr…",
  "The server was updated. Save any unsent drafts, then": "服务器已更新。请先保存未发送的草稿，然后",
  "This tab still runs {version} until it is reloaded.": "此标签页在重新加载前仍运行 {version}。",
  "Reload app": "重新加载应用",
  "App updated. Save unsent drafts before reloading.": "应用已更新。重新加载前请保存未发送的草稿。",
  "Part of the app could not load. Save unsent drafts, then reload.": "应用的一部分未能加载。请先保存未发送的草稿，再重新加载。",
  "Ovis was updated on this PC. Restart it there to load the update.": "此 PC 上的 Ovis 已更新。请在 PC 上重新启动它以加载更新。",
  "A newer release was published after you chose this update, so nothing was installed. Check again to review it.": "你选择此更新后发布了更新的版本，因此没有安装任何内容。请再次检查以查看新版本。",
  "Restart Ovis on this PC to update from here: the server running now cannot install exactly the release shown.": "请在此 PC 上重新启动 Ovis 后再从这里更新：当前运行的服务器无法准确安装所显示的版本。",
  "How to restart": "如何重新启动",
  "Ovis v{version} is available.": "Ovis v{version} 已发布。",
  "An Ovis update is available.": "Ovis 有可用更新。",
  "Update": "更新",
  "Details": "详情",
  "Starting the update…": "正在开始更新…",
  "The update could not be installed.": "无法安装更新。",
  "Downloading the update": "正在下载更新",
  "Installing dependencies": "正在安装依赖",
  "Checking the new version": "正在检查新版本",
  "Building the app": "正在构建应用",
  "Restarting the app": "正在重启应用",

  // ---- key bar ----

  // ---- prompt card ----
  "Submit": "提交",
  "Recommended": "推荐",

  // ---- markdown ----

  // ---- composer ----
  "Drag to resize · double-click to reset": "拖动以调整大小 · 双击重置",
  "Failed": "失败",
  "Send now": "立即发送",

  // ---- chat view ----
  "Copied": "已复制",
  "Worked for {duration}": "工作了 {duration}",
  "Copy message": "复制消息",
  "Last checked {when}": "上次检查：{when}",
  "terminal ended": "终端已结束",
  "{m}m": "{m} 分钟",
  "{h}h {m}m": "{h} 小时 {m} 分",

  // ---- terminal ----
  "The question on screen changed; check it and answer again.": "屏幕上的问题已变化。请查看后重新回答。",
  "Reconnect": "重新连接",
  "Discard": "丢弃",
  "Held message — review and send": "保留的消息。请检查后发送",

  // ---- install help ----

  // ---- voice input ----
  "Dictate (hold)": "听写（按住）",
  "Microphone permission was denied": "麦克风权限已被拒绝",
  "Voice input needs HTTPS": "语音输入需要 HTTPS",
  // ---- errors (lib/userError.ts) ----
  "This browser is not signed in to this PC any more. Pair it again in Settings → Phone & devices.": "此浏览器已不再登录此电脑。请在设置 → 手机和设备中重新配对。",
  "That item no longer exists on the PC. Refresh and try again.": "该项目在电脑上已不存在。请刷新后重试。",
  "It changed on the PC while you were acting. Check it and try again.": "你操作期间电脑上的内容已更改。请检查后重试。",
  "The PC took too long to answer. Try again.": "电脑响应时间过长。请重试。",
  "OpenCode did not confirm the answer. Check the question before sending again.": "未收到 OpenCode 的回答接收确认。请先检查问题，再决定是否重新发送。",
  "The PC could not do that. Try again; if it keeps failing, restart Ovis on the PC.": "电脑无法完成该操作。请重试；如果一直失败，请在电脑上重启 Ovis。",
  "Can't reach the PC. Check your connection, then try again.": "无法连接到电脑。请检查网络连接后重试。",
  "Something went wrong. Try again.": "出了点问题。请重试。",
  "Not signed in to this PC": "未登录此电脑",
  "It no longer exists on the PC": "电脑上已不存在",
  "It changed on the PC": "电脑上的内容已更改",
  "The PC took too long": "电脑响应太慢",
  "Can't reach the PC": "无法连接到电脑",
  "PC disk is full": "电脑磁盘已满",
  "No permission on the PC": "电脑上没有权限",
  "Pair it again in Settings → Phone & devices.": "请在设置 → 手机和设备中重新配对。",
  "Refresh and try again.": "请刷新后重试。",
  "Check it and try again.": "请检查后重试。",
  "Check your connection, then try again.": "请检查网络连接后重试。",
  "Try again; if it keeps failing, restart Ovis on the PC.": "请重试；如果一直失败，请在电脑上重启 Ovis。",
  "The server cannot save settings: check that its state folder is writable.": "服务器无法保存设置：请检查其状态文件夹是否可写。",

  // ---- sign-in ----

  // ---- devices ----
  "Loading…": "正在加载…",
  "Done": "完成",

  // ---- phone ----
  "Copy": "复制",
  "…": "…",
  "Alerts": "提醒",
  "Sending…": "正在发送…",
  "Needs input": "需要输入",
  "Finished": "已完成",
  "Open pane": "打开窗格",
  "Quick replies": "快捷回复",
  "Skills": "Skill",
  "Not sent: send or discard the held input first.": "未发送：请先发送或丢弃保留的输入。",
  "Queue could not be saved. Keep this tab open or copy the messages before reloading.": "无法保存队列。请保持此标签页打开，或在重新加载前复制这些消息。",
  "Queued messages": "排队的消息",
  "Not confirmed. Check the terminal before sending again.": "未确认。重新发送前请检查终端。",
  "Too large to attach: {name} ({size}). A file can be up to {limit}.": "文件过大，无法附加：{name}（{size}）。单个文件最大为 {limit}。",
  // ---- subscription usage ----
  "Move {name} up": "将 {name} 上移",
  "Move {name} down": "将 {name} 下移",
  "Subscription usage": "订阅用量",
  "Resets in {time}": "{time}后重置",
  "{n} background task": "{n} 个后台任务",
  "{n} background tasks": "{n} 个后台任务",
  "Try again": "重试",
  // tabs: the strip over the pane, and the New tab dialog
  "New tab": "新建标签页",
  "Zoom pane": "放大窗格",
  "Unzoom pane": "取消放大",
  "This PC's bridge does not offer this yet": "此电脑的桥接尚未提供此功能。",
  "Split pane right": "向右拆分窗格",
  "Split pane down": "向下拆分窗格",
  "Split pane right and open it": "向右拆分窗格并打开",
  "Split pane down and open it": "向下拆分窗格并打开",
  "Plan: {done} of {total} done": "计划：已完成 {done}/{total}",
  "Plan": "计划",
  "Something went wrong": "出了点问题",
  "The app hit an error and stopped drawing. Your terminals keep running in herdr.": "应用出错，无法继续显示。你的终端仍在 herdr 中运行。",
  "Copy details": "复制详细信息",
  "This pane can't be shown.": "无法显示此窗格。",
  "The sidebar can't be shown.": "无法显示侧边栏。",
  "Diff layout": "差异布局",
  "Unified": "单栏",
  "Split": "并排",
  // t3code ports (a)
  "Browse folders": "浏览文件夹",
  "Folders": "文件夹",
  "Open in Files": "在文件中打开",
  "Pinned folders": "已固定的文件夹",
  // t3code ports (d)
  "Change PC": "切换电脑",
};

/** The parts ZH is made of; src/lib/i18n.test.ts fails when a key is in two parts, since a spread keeps only the last. */
export const ZH_PARTS: Record<string, Record<string, string>> = {
  base: BASE,
  settings: SETTINGS_ZH,
  terminal: TERMINAL_ZH,
  composer: COMPOSER_ZH,
  chat: CHAT_ZH,
  sidebar: SIDEBAR_ZH,
  machines: MACHINES_ZH,
  workspace: WORKSPACE_ZH,
  files: FILES_ZH,
  devices: DEVICES_ZH,
  usage: USAGE_ZH,
};

export const ZH: Record<string, string> = Object.assign({}, ...Object.values(ZH_PARTS));
