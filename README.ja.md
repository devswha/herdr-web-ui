# herdr web ui

<p align="center">
  <img src="public/icons/icon-192.png" alt="herdr web ui" width="100">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <strong>日本語</strong>
</p>

<p align="center">
  <a href="https://devswha.github.io/herdr-web-ui/">公式サイト</a> ·
  <a href="#install">インストール</a> ·
  <a href="https://devswha.github.io/herdr-web-ui/demo/">デモを試す</a> ·
  <a href="docs/guide.md#quick-start">クイックスタート</a> ·
  <a href="#docs">ドキュメント</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT ライセンス"></a>
  <a href="https://github.com/devswha/herdr-web-ui/stargazers"><img src="https://img.shields.io/github/stars/devswha/herdr-web-ui?labelColor=333333&color=666666&logo=github" alt="GitHub スター数"></a>
  <a href="https://github.com/devswha/herdr-web-ui/releases/latest"><img src="https://img.shields.io/github/v/release/devswha/herdr-web-ui?label=release&labelColor=333333&color=666666" alt="最新リリース"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
  <a href="docs/guide.md#on-your-phone"><img src="https://img.shields.io/badge/PWA-installable-666666?labelColor=333333" alt="インストール可能な PWA"></a>
</p>

---

https://github.com/user-attachments/assets/6162cf5a-b29b-4f14-b2a2-7a01564791d6

<p align="center"><sub>ターミナルのペインで動く Claude Code。同じセッションをチャットで、さらにスマートフォンで操作 · 実際の動作を収録 · <a href="https://devswha.github.io/herdr-web-ui/media/herdr-web-ui-film.mp4">▶ 56 秒の紹介動画</a></sub></p>

**エージェントとのやり取りを、読みやすいチャットで。パソコンでもスマートフォンでも。**

[herdr](https://github.com/herdrdev/herdr) のブラウザ・スマートフォン向けクライアントです。すでに実行中のセッションを開き、エージェントの作業を確認して、どこからでも返答できます。

- **チャットとターミナルを、ひとつのペインで** — Claude Code、Codex、omp、omo、gjc のネイティブな会話履歴を表示します。コマンドや編集内容はターンごとに折りたたまれ、対応する ToDo ツールの計画は下部に固定表示されます。ライブターミナルに切り替えれば、全画面の TUI、直接のキー入力、herdr のスクロールバックも使えます。[対応エージェント →](docs/guide.md#supported-agents)
- **タップで承認** — 対応エージェントの承認リクエスト、質問、計画メニューをチャット内のカードとして表示します。選択肢を選ぶと、その問いかけがまだ有効か確認してから回答を送信します。
- **外出先からもエージェントを操作** — スマートフォンに PWA をインストールして、タッチでスクロール。キーボードの上にある Esc、Tab、Ctrl、矢印キーも使えます。Settings（設定）には Tailscale のアドレスが QR コードで表示されます。[スマートフォンの設定 →](docs/guide.md#on-your-phone)
- **対応が必要なときに通知** — すべてのペインの状態をリアルタイムに表示します。エージェントが入力を求めたとき、作業を完了したとき、ターミナルが終了したときには、アプリを閉じていてもプッシュ通知が届きます。
- **すべての PC を、ひとつのサイドバーに** — SSH 経由で Linux や macOS のマシンを追加できます。リモートのワークスペース、チャット、ファイル、ターミナルが、ローカルのセッションと並んで表示されます。[リモート PC →](docs/remote-pcs.md)
- **必要な情報を送り、結果を開く** — スラッシュコマンド、ファイルへのメンション、画像やファイルの添付、クイック返信に対応しています。エージェントの作業中には複数のメッセージを送信待ちキューに保存でき、生成されたファイルはプレビューやダウンロードが可能です。[すべての機能 →](docs/guide.md#features)
- **いつもの作業環境をそのままに** — エージェントとターミナルは herdr が管理し、このアプリはそこに接続します。TUI とブラウザを同時に利用でき、ローカルアクセス、デバイスのペアリング、共有トークンに対応しています。[アクセスと安全性 →](docs/guide.md#access-and-safety)
- **エージェントを止めずにアップデート** — Settings（設定）から新しいリリースをインストールできます。ヘルスチェックとロールバックにも対応しています。`HERDR_WEB_AUTO_UPDATE=1` を設定すると、自動インストールを有効にできます。[アップデート →](docs/guide.md#updates)

---

<a id="install"></a>

## インストール

```bash
curl -fsSL https://devswha.github.io/herdr-web-ui/install.sh | sh
```

Linux（x64、arm64）または macOS に対応しています。必要な herdr 0.9.0+、Bun 1.4+、Node 18+ がなければ現在のユーザー向けにインストールし、その後アプリを herdr プラグインとしてインストールします。既存の herdr が 0.9.0 より古い場合は、自分で herdr を更新・再起動してからインストーラーを再実行してください。デフォルトの待ち受けアドレスを使用し、Tailscale が起動している場合、HTTPS の設定に成功すると tailnet 内のアクセス用アドレスと QR コードが表示されます。

<p align="center">
  <img src="docs/screenshots/install.png" width="720" alt="インストーラーの出力：Bun、Node、herdr プラグインのインストール後、tailscale serve でアプリへのアクセスを有効にし、スマートフォン用の QR コードを表示します。">
</p>

必要なソフトウェアがすでにそろっている場合は、プラグインだけをインストールできます。

```bash
herdr plugin install devswha/herdr-web-ui
```

herdr が起動した状態で **[localhost:7317](http://localhost:7317)** を開きます。ペインを選ぶか、**New session（新規セッション）** からエージェントを起動してください。スマートフォンで使う場合は、インストーラーの QR コードを読み取り、アプリをホーム画面に追加します。[クイックスタート →](docs/guide.md#quick-start)

サーバーのデフォルトの待ち受けアドレスは `127.0.0.1` です。別のデバイスからアクセスする場合は、[スマートフォンの設定](docs/guide.md#on-your-phone)と[アクセスと安全性](docs/guide.md#access-and-safety)を参照してください。

<a id="feature-videos"></a>

## 機能ごとの動画

約 20 秒の動画をさらに 4 本。冒頭の動画と同じく実際の動作を収録したもので、パソコンとスマートフォンを同時に録画し、待ち時間と進捗表示は早送りしています。

### スマートフォンからスクリーンショットを添付

https://github.com/user-attachments/assets/344a01d6-dd0d-44d3-a531-262257b48f9e

<p align="center"><sub>合計が $NaN になっているレシートのスクリーンショットをスマートフォンから添付し、Claude に修正を依頼します。パソコンにも画像付きの同じメッセージが表示されます。Claude がバグを修正してテストを追加し、差分はチャットから開けます。</sub></p>

### エージェントが作ったファイルを開く

https://github.com/user-attachments/assets/cf3953f8-df95-4efc-bd2b-df515798f364

<p align="center"><sub>Claude がグラフを SVG ファイルとして書き出し、そのパスを返答に含めます。パソコンではクリック、スマートフォンではタップで、ファイルビューアーに表示されます。</sub></p>

### ペインのファイルを見る

https://github.com/user-attachments/assets/c4170cfb-b1dc-492d-8660-1b09dbac31f8

<p align="center"><sub>フォルダボタンでペインの作業フォルダを開き、Claude が書いたファイルをビューアーで表示します。スマートフォンでは、コマンドパレットの Browse files（ファイルを参照）から同じ操作ができます。</sub></p>

### SSH で PC を追加

https://github.com/user-attachments/assets/3a8e40f3-7988-4a28-8729-9f8b9ad64610

<p align="center"><sub>Add PC（PC を追加）から SSH で Linux PC に接続し、ブリッジをインストールします。その PC のセッションがサイドバーに加わり、ターミナルはその PC 上で動きます。スマートフォンのメニューには両方の PC が表示されます。リモートのセッションは撮影用に用意したものです。</sub></p>

<a id="docs"></a>

## ドキュメント

まずは[ユーザーガイド](docs/guide.md)をご覧ください：[クイックスタート](docs/guide.md#quick-start) · [対応エージェント](docs/guide.md#supported-agents) · [機能](docs/guide.md#features) · [スマートフォン](docs/guide.md#on-your-phone) · [リモート PC](docs/remote-pcs.md) · [アクセスと安全性](docs/guide.md#access-and-safety) · [設定](docs/guide.md#configuration) · [キーボードショートカット](docs/guide.md#keyboard-shortcuts) · [よくある質問](docs/guide.md#faq)。

さらに詳しく：[仕組み](docs/guide.md#how-it-works) · [チャットの会話履歴](docs/chat-mode-audit.md) · [ターミナルのフロー制御](docs/terminal-flow-control.md) · [アプリのアップデート](docs/app-updates.md) · [変更履歴](CHANGELOG.md)。

<a id="thanks"></a>

## 謝辞

[herdr](https://github.com/herdrdev/herdr) を基盤とし、[chatmux](https://github.com/devswha/chatmux) から着想を得て、[xterm.js](https://xtermjs.org)、[React](https://react.dev)、[Bun](https://bun.sh)、[Lucide](https://lucide.dev) を使用しています。

[@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha) をはじめ、貢献してくださったすべての方に感謝します。

<a id="agent-instructions"></a>

## エージェント向けの手順

アプリのインストールを支援する場合は、[INSTALL.md](INSTALL.md) に従ってください。リポジトリを変更する場合は、ローカルの `AGENTS.md` があればその指示と、リポジトリ内の[レビュールール](.github/REVIEW.md)に従ってください。

<a id="development"></a>

## 開発

```bash
git clone https://github.com/devswha/herdr-web-ui.git
cd herdr-web-ui
bun install

bun run server      # API + WebSocket on :7317
bun run dev         # Vite on :5173; run in a second terminal
```

```bash
bun run typecheck
bun run test:unit   # no herdr needed
bun test           # isolated herdr test session
bun run test:ui    # browser regression checks
```

テスト、メディア素材、リリースについては[開発ドキュメント](docs/development.md)、UI の規約については [DESIGN.md](DESIGN.md) を参照してください。

<a id="license"></a>

## ライセンス

[MIT](LICENSE)。Copyright © 2026 devswha.
