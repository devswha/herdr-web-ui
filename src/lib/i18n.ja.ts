import { SETTINGS_JA } from "./i18n/settings.ja.ts";
import { TERMINAL_JA } from "./i18n/terminal.ja.ts";
import { COMPOSER_JA } from "./i18n/composer.ja.ts";
import { CHAT_JA } from "./i18n/chat.ja.ts";
import { SIDEBAR_JA } from "./i18n/sidebar.ja.ts";
import { MACHINES_JA } from "./i18n/machines.ja.ts";
import { WORKSPACE_JA } from "./i18n/workspace.ja.ts";
import { FILES_JA } from "./i18n/files.ja.ts";
import { DEVICES_JA } from "./i18n/devices.ja.ts";
import { USAGE_JA } from "./i18n/usage.ja.ts";

/**
 * Japanese for every `t("…")` in src/ that no part in lib/i18n/ holds: keys more than one feature
 * uses, and the app shell's. JA at the end is this and the parts together. The English string is
 * the key. Grouped by where the text
 * shows; within a group, roughly in the order it appears. Register: labels and buttons as concise
 * nouns or verbs, sentences in です・ます調. Fixed terms: ペイン, ワークスペース, エージェント,
 * ターミナル, チャット, ペアリング, デバイス, セッション, 入力欄, キー (SSH key; 秘密鍵 for private
 * key), デフォルト (not 既定). Product names (herdr, Tailscale, Codex, Claude Code, GitHub), GitHub
 * labels (Star, Issue), acronyms (SSH, CLI, HTTPS, QR) and names like Markdown, Enter, Skill ツール stay
 * in English. Placeholders in braces keep their English names.
 */
const BASE: Record<string, string> = {
  "Back": "戻る",
  "Scroll pane up": "ペインを上にスクロール",
  "Scroll pane down": "ペインを下にスクロール",
  "Find in terminal": "ターミナル内を検索",
  "Recent folders": "最近のフォルダー",
  "Dismiss": "閉じる",
  "Input line": "入力欄",
  // ---- settings ----
  "Settings": "設定",
  "Chat": "チャット",
  "Agent default": "エージェントの既定",
  "Phone & devices": "スマートフォンとデバイス",
  "Install app": "アプリをインストール",

  // ---- shortcuts (lib/shortcuts.ts labels) ----
  "Command palette": "コマンドパレット",
  "Switch chat / terminal": "チャット / ターミナルを切り替え",
  "Focus pane input": "ペインの入力欄にフォーカス",
  "Toggle sidebar": "サイドバーの切り替え",
  "New workspace": "新しいワークスペース",
  "Previous pane": "前のペイン",
  "Next pane": "次のペイン",

  // ---- agent status words (lib/status.ts) ----
  "READY": "待機",
  "RUN": "実行中",
  "INPUT": "入力待ち",
  "DONE": "完了",
  "BG": "BG待ち",
  "—": "—",

  // ---- app header and shell ----
  "Opening link…": "リンクを開いています…",
  "Connecting to Ovis…": "Ovis に接続しています…",
  "Close workspace list": "ワークスペース一覧を閉じる",
  "Open workspace list": "ワークスペース一覧を開く",
  "Show workspace list": "ワークスペース一覧を表示",
  "Hide workspace list": "ワークスペース一覧を非表示",
  "Pane closed": "ペインは閉じられました",
  "Show the terminal": "ターミナルを表示",
  "Show the chat": "チャットを表示",
  "Close this half": "この半分を閉じる",
  "Toggle sidebar (⌘⇧B)": "サイドバーの切り替え (⌘⇧B)",
  "Chat transcript (⌘⇧J)": "チャット履歴 (⌘⇧J)",
  "Live terminal (⌘⇧J)": "ライブターミナル (⌘⇧J)",
  "Live terminal: coming to Windows PCs once herdr can attach there": "ライブターミナル: herdr が Windows でアタッチに対応したら使えます",
  "soon": "近日",
  "Terminal": "ターミナル",
  "herdr {version} · protocol {protocol}": "herdr {version} · プロトコル {protocol}",
  "live": "接続中",
  "disconnected": "切断",
  "reconnecting": "再接続中",
  "connecting": "接続しています",
  "herdr offline": "herdr オフライン",
  "Status unknown": "状態不明",
  "herdr unavailable": "herdr 応答なし",
  "The last health check failed. Last seen: herdr {version} · protocol {protocol}": "直近の状態確認に失敗しました。最後に確認した状態: herdr {version} · プロトコル {protocol}",
  "The health check failed": "状態確認に失敗しました",
  "Start herdr on this PC, or check HERDR_SOCKET.": "この PC で herdr を起動するか、HERDR_SOCKET を確認してください。",
  "The other PC's answer was larger than this app accepts": "別の PC の応答が、このアプリで受け取れるサイズを超えています",
  "The other PC's answer could not be read": "別の PC の応答を読み取れませんでした",
  "Browse files": "ファイルを参照",
  "Copy link": "リンクをコピー",
  "Link copied": "リンクをコピーしました",
  "That agent has closed: its workspace is open": "そのエージェントは閉じられました。代わりにワークスペースを開きました",
  "That link's workspace is closed": "そのリンクのワークスペースは閉じられています",
  "That link's PC is not set up here": "そのリンクの PC はここに設定されていません",
  "Command palette (⌘⇧K)": "コマンドパレット (⌘⇧K)",
  "Could not sign out. Try again.": "サインアウトできませんでした。もう一度お試しください。",
  "Retry": "再試行",
  "Enable notifications": "通知を有効にする",
  "Notify me when a pane needs input or finishes": "ペインが入力を待っているときや完了したときに通知します",
  "On, pushed to this device": "オン、この端末にプッシュ",
  "Alerts on, pushed to this device, even with the app closed. Tap to turn them off": "通知オン。このデバイスにプッシュされます。アプリを閉じていても届きます。タップするとオフになります",
  "Off on this device": "この端末ではオフ",
  "More": "その他",
  "More · alerts are off": "その他 · 通知オフ",
  "Alerts off on this device. Tap to turn them on": "このデバイスでは通知がオフです。タップするとオンになります",
  "On in this tab": "このタブでオン",
  "Alerts on while this tab is open. Tap to turn them off": "このタブを開いている間は通知が届きます。タップするとオフになります",
  "On in the app": "アプリ内でオン",
  "Alerts on in the app. Tap to allow them when it is closed too": "アプリ内の通知はオンです。タップすると、アプリを閉じてるときにも許可できます",
  "Alerts on in the app. Tap to turn them off": "アプリ内の通知はオンです。タップするとオフになります",
  "Alerts on while this tab is open (closed-app alerts need https, and on iPhone the home-screen app). Tap to turn them off": "このタブを開いている間は通知が届きます (アプリを閉じた後の通知には https が必要で、iPhone ではホーム画面のアプリである必要があります)。タップするとオフになります",

  // ---- sidebar ----
  "Rename pane": "ペインの名前を変更",
  "Branch": "ブランチ",
  "Opening…": "開いています…",
  "Detached HEAD": "分離した HEAD",
  "Delete": "削除",
  "Close": "閉じる",
  "Rename failed: {reason}": "名前を変更できませんでした: {reason}",

  // ---- PCs sidebar ----
  "Connecting…": "接続しています…",
  "Connected": "接続済み",
  "Reconnecting…": "再接続しています…",
  "Add PC": "PC を追加",
  "Connect": "接続",
  "Step {n} of {total}": "ステップ {n} / {total}",
  "{done} of {total}": "{done} / {total}",

  // ---- command palette ----
  "Switch to terminal": "ターミナルに切り替え",
  "Switch to chat": "チャットに切り替え",
  "Toggle theme": "テーマを切り替え",
  "Refresh": "更新",
  "Search panes and actions…": "ペインと操作を検索…",
  "Search panes and actions": "ペインと操作を検索",
  "Close command palette": "コマンドパレットを閉じる",
  "Filter panes by status": "状態でペインを絞り込む",
  "All": "すべて",
  "Recent": "最近",
  "Workspace": "ワークスペース",
  "Selected": "選択中",
  "Unknown workspace": "不明なワークスペース",
  "Actions": "操作",
  "Plugin actions": "プラグインの操作",
  "Running…": "実行中…",
  "{action} failed: {detail}": "{action} に失敗しました: {detail}",
  "{action} failed (exit code {code})": "{action} に失敗しました (終了コード {code})",
  "No matching panes or actions": "一致するペインや操作はありません",

  // ---- new workspace ----
  "Browse": "参照",
  "Cancel": "キャンセル",
  "Starting…": "起動しています…",
  "Start": "開始",
  // the launch's model, effort, first message and skills (lib/agentLaunchMode.ts, lib/newSession.ts)

  // ---- folder browser ----
  "No matching folders": "一致するフォルダーはありません",
  "This folder cannot be opened.": "このフォルダーは開けません。",
  "Folders could not be loaded.": "フォルダーを読み込めませんでした。",

  // ---- files ----
  "Files": "ファイル",
  "This image is {size}; download it to view.": "この画像は {size} です。表示するにはダウンロードしてください。",
  "Download": "ダウンロード",
  "Open {path}": "{path} を開く",

  // ---- PC dialog ----
  "Continue": "続行",

  // ---- updates ----
  "Updates": "更新",
  "Running {version}": "{version} を実行中",
  "Installing dependencies and building…": "依存関係をインストールしてビルドしています…",
  "Restarting the bridge…": "ブリッジを再起動しています…",
  "Checking for updates…": "更新を確認しています…",
  "Version {version} is available.": "バージョン {version} が利用可能です。",
  "What's new": "更新内容",
  "Earlier releases not shown here: {count}.": "ここに表示されていない以前のリリース: {count} 件。",
  "Full changelog": "すべての変更履歴",
  "What the last update brought": "前回のアップデートの内容",
  "New features": "新機能",
  "Improvements": "改善",
  "Bug fixes": "バグ修正",
  "Show every change": "すべての変更を表示",
  "Ovis was updated to v{version}.": "Ovis を v{version} に更新しました。",
  "These notes could not be shown.": "このノートを表示できませんでした。",
  "Up to date.": "最新の状態です。",
  "Waiting for an update check…": "更新の確認を待っています…",
  "Checks for new releases every 5 minutes.": "5 分ごとに新しいリリースを確認します。",
  "Automatic installation is enabled.": "自動インストールが有効です。",
  "Install when you are ready; the bridge briefly reconnects and herdr sessions keep running.": "準備ができたらインストールしてください。ブリッジは一時的に再接続しますが、herdr のセッションは実行されたままです。",
  "Remote PCs' bridges are updated afterwards when the new version needs it.": "新しいバージョンで必要な場合は、続けてリモート PC のブリッジも更新されます。",
  "Check for updates": "更新を確認",
  "Update and restart": "更新して再起動",
  "Running herdr {version}": "herdr {version} を実行中",
  "herdr {installed} is installed, but the running server is {running}. Updating moves your panes onto the installed version.": "herdr {installed} がインストールされていますが、実行中のサーバーは {running} です。更新するとペインがインストール済みのバージョンに移ります。",
  "Installs the newest herdr on the PC this app runs on and moves its running panes onto it. Panes and agents keep running, and open terminals reconnect.": "このアプリが動いている PC に最新の herdr をインストールし、実行中のペインを新しいバージョンに移します。ペインとエージェントは動き続け、開いているターミナルは再接続します。",
  "Update herdr": "herdr を更新",
  "Updating herdr…": "herdr を更新しています…",
  "The server was updated. Save any unsent drafts, then": "サーバーが更新されました。未送信の下書きを保存してから",
  "This tab still runs {version} until it is reloaded.": "このタブは再読み込みするまで {version} のままです。",
  "Reload app": "アプリを再読み込み",
  "App updated. Save unsent drafts before reloading.": "アプリが更新されました。再読み込みする前に未送信の下書きを保存してください。",
  "Part of the app could not load. Save unsent drafts, then reload.": "アプリの一部を読み込めませんでした。未送信の下書きを保存してから再読み込みしてください。",
  "Ovis was updated on this PC. Restart it there to load the update.": "このPCの Ovis が更新されました。更新を読み込むには、PCで再起動してください。",
  "A newer release was published after you chose this update, so nothing was installed. Check again to review it.": "この更新を選んだ後に新しいリリースが公開されたため、何もインストールしていません。もう一度確認して内容を見てください。",
  "Restart Ovis on this PC to update from here: the server running now cannot install exactly the release shown.": "ここから更新するには、このPCで Ovis を再起動してください。現在動いているサーバーは、表示されたリリースを正確にインストールできません。",
  "How to restart": "再起動の方法",
  "Ovis v{version} is available.": "Ovis v{version} が利用可能です。",
  "An Ovis update is available.": "Ovis の更新が利用可能です。",
  "Update": "更新",
  "Details": "詳細",
  "Starting the update…": "更新を開始しています…",
  "The update could not be installed.": "更新をインストールできませんでした。",
  "Downloading the update": "更新をダウンロード中",
  "Installing dependencies": "依存関係をインストール中",
  "Checking the new version": "新しいバージョンを確認中",
  "Building the app": "アプリをビルド中",
  "Restarting the app": "アプリを再起動中",

  // ---- key bar ----

  // ---- prompt card ----
  "Submit": "送信",
  "Recommended": "推奨",

  // ---- markdown ----

  // ---- composer ----
  "Drag to resize · double-click to reset": "ドラッグでサイズ変更 · ダブルクリックでリセット",
  "Failed": "失敗",
  "Send now": "今すぐ送信",

  // ---- chat view ----
  "Copied": "コピーしました",
  "Worked for {duration}": "{duration} 作業しました",
  "Copy message": "メッセージをコピー",
  "Last checked {when}": "最終確認: {when}",
  "terminal ended": "ターミナルが終了しました",
  "{m}m": "{m}分",
  "{h}h {m}m": "{h}時間 {m}分",

  // ---- terminal ----
  "The question on screen changed; check it and answer again.": "画面上の質問が変わりました。確認してもう一度回答してください。",
  "Reconnect": "再接続",
  "Discard": "破棄",
  "Held message — review and send": "保持中のメッセージ。確認して送信してください",

  // ---- install help ----

  // ---- voice input ----
  "Dictate (hold)": "音声入力（長押し）",
  "Microphone permission was denied": "マイクの使用が許可されませんでした",
  "Voice input needs HTTPS": "音声入力には HTTPS が必要です",
  // ---- errors (lib/userError.ts) ----
  "This browser is not signed in to this PC any more. Pair it again in Settings → Phone & devices.": "このブラウザーはもうこの PC にサインインしていません。設定 → スマートフォンとデバイスでもう一度ペアリングしてください。",
  "That item no longer exists on the PC. Refresh and try again.": "その項目は PC にもうありません。更新してからもう一度お試しください。",
  "It changed on the PC while you were acting. Check it and try again.": "操作中に PC 側で変更されました。確認してからもう一度お試しください。",
  "The PC took too long to answer. Try again.": "PC の応答に時間がかかりすぎました。もう一度お試しください。",
  "OpenCode did not confirm the answer. Check the question before sending again.": "OpenCode から回答の受信確認が届きませんでした。再送する前に質問を確認してください。",
  "The PC could not do that. Try again; if it keeps failing, restart Ovis on the PC.": "PC でその操作を実行できませんでした。もう一度お試しください。失敗が続く場合は PC で Ovis を再起動してください。",
  "Can't reach the PC. Check your connection, then try again.": "PC に接続できません。接続を確認してからもう一度お試しください。",
  "Something went wrong. Try again.": "問題が発生しました。もう一度お試しください。",
  "Not signed in to this PC": "この PC にサインインしていません",
  "It no longer exists on the PC": "PC にはもうありません",
  "It changed on the PC": "PC 側で変更されました",
  "The PC took too long": "PC の応答が遅すぎました",
  "Can't reach the PC": "PC に接続できません",
  "PC disk is full": "PC のディスクがいっぱいです",
  "No permission on the PC": "PC で権限がありません",
  "Pair it again in Settings → Phone & devices.": "設定 → スマートフォンとデバイスでもう一度ペアリングしてください。",
  "Refresh and try again.": "更新してからもう一度お試しください。",
  "Check it and try again.": "確認してからもう一度お試しください。",
  "Check your connection, then try again.": "接続を確認してからもう一度お試しください。",
  "Try again; if it keeps failing, restart Ovis on the PC.": "もう一度お試しください。失敗が続く場合は PC で Ovis を再起動してください。",
  "The server cannot save settings: check that its state folder is writable.": "サーバーが設定を保存できません。サーバーの状態フォルダーに書き込めるか確認してください。",

  // ---- sign-in ----

  // ---- devices ----
  "Loading…": "読み込んでいます…",
  "Done": "完了",

  // ---- phone ----
  "Copy": "コピー",
  "…": "…",
  "Alerts": "通知",
  "Sending…": "送信中…",
  "Needs input": "入力が必要",
  "Finished": "完了",
  "Open pane": "ペインを開く",
  "Quick replies": "クイック返信",
  "Skills": "スキル",
  "Not sent: send or discard the held input first.": "未送信: 先に保持した入力を送信するか破棄してください。",
  "Queue could not be saved. Keep this tab open or copy the messages before reloading.": "キューを保存できませんでした。このタブを開いたままにするか、再読み込みする前にメッセージをコピーしてください。",
  "Queued messages": "キュー内のメッセージ",
  "Not confirmed. Check the terminal before sending again.": "送信を確認できませんでした。再送信する前にターミナルを確認してください。",
  "Too large to attach: {name} ({size}). A file can be up to {limit}.": "添付するには大きすぎます: {name}（{size}）。ファイルは {limit} まで添付できます。",
  // ---- subscription usage ----
  "Move {name} up": "{name} を上へ移動",
  "Move {name} down": "{name} を下へ移動",
  "Subscription usage": "サブスクリプション使用量",
  "Resets in {time}": "{time}後にリセット",
  "{n} background task": "バックグラウンドタスク {n} 件",
  "{n} background tasks": "バックグラウンドタスク {n} 件",
  "Try again": "再試行",
  // tabs: the strip over the pane, and the New tab dialog
  "New tab": "新しいタブ",
  "Zoom pane": "ペインをズーム",
  "Unzoom pane": "ズームを解除",
  "This PC's bridge does not offer this yet": "このPCのブリッジはまだこの機能に対応していません。",
  "Split pane right": "ペインを右に分割",
  "Split pane down": "ペインを下に分割",
  "Split pane right and open it": "ペインを右に分割して開く",
  "Split pane down and open it": "ペインを下に分割して開く",
  "Plan: {done} of {total} done": "計画: {total} 件中 {done} 件完了",
  "Plan": "計画",
  "Something went wrong": "問題が発生しました",
  "The app hit an error and stopped drawing. Your terminals keep running in herdr.": "アプリでエラーが発生し、表示できなくなりました。ターミナルは herdr で動き続けています。",
  "Copy details": "詳細をコピー",
  "This pane can't be shown.": "このペインを表示できません。",
  "The sidebar can't be shown.": "サイドバーを表示できません。",
  "Diff layout": "差分の表示形式",
  "Unified": "1列",
  "Split": "並べて表示",
  // t3code ports (a)
  "Browse folders": "フォルダを参照",
  "Folders": "フォルダ",
  "Open in Files": "ファイルで開く",
  "Pinned folders": "固定したフォルダ",
  // t3code ports (d)
  "Change PC": "PCを切り替え",
};

/** The parts JA is made of; src/lib/i18n.test.ts fails when a key is in two parts, since a spread keeps only the last. */
export const JA_PARTS: Record<string, Record<string, string>> = {
  base: BASE,
  settings: SETTINGS_JA,
  terminal: TERMINAL_JA,
  composer: COMPOSER_JA,
  chat: CHAT_JA,
  sidebar: SIDEBAR_JA,
  machines: MACHINES_JA,
  workspace: WORKSPACE_JA,
  files: FILES_JA,
  devices: DEVICES_JA,
  usage: USAGE_JA,
};

export const JA: Record<string, string> = Object.assign({}, ...Object.values(JA_PARTS));
