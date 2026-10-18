# herdr web ui

This edition serves one workstation. Authorized remote browsers connect through operator-configured HTTPS or VPN infrastructure. Token authentication, device pairing and read-only devices are supported. Software installation and updates are separate operator deployment tasks; the app never provisions prerequisites or additional PCs. No maintainer telemetry or built-in Tailscale integration is included. The plugin ID remains `devswha.herdr-web-ui` to preserve installed state.

<p align="center">
  <img src="public/icons/icon-192.png" alt="herdr web ui" width="100">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="#install">install</a> ·
  <a href="docs/guide.md#quick-start">quick start</a> ·
  <a href="#faq">faq</a> ·
  <a href="#docs">docs</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT license"></a>
  <a href="https://github.com/tomrutsaert/herdr-web-ui/stargazers"><img src="https://img.shields.io/github/stars/tomrutsaert/herdr-web-ui?labelColor=333333&color=666666&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/tomrutsaert/herdr-web-ui/releases/latest"><img src="https://img.shields.io/github/v/release/tomrutsaert/herdr-web-ui?label=release&labelColor=333333&color=666666" alt="Latest release"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
  <a href="docs/guide.md#on-your-phone"><img src="https://img.shields.io/badge/PWA-installable-666666?labelColor=333333" alt="Installable PWA"></a>
</p>

---

https://github.com/user-attachments/assets/d854dbb6-64bd-4eba-81c7-fbd3f525726b

<p align="center"><sub>One Claude Code session: in herdr's terminal, then the browser's Terminal and Chat, then the phone, where a new worktree starts beside it · recorded live, no cuts</sub></p>

**Claude Code and Codex, from your phone.**

A browser and phone client for [herdr](https://github.com/herdrdev/herdr). Read and reply to the same agent sessions running on your computer — on desktop or phone, as chat, with the terminal when you need it.

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/32ca9aa4-960f-4629-9fb5-17c12ba35c80"><img src="docs/media/readme/terminal.webp" width="100%" alt="Live recording. The browser shows Claude Code's reply in Chat; a click on Terminal shows the same pane as Claude Code's own terminal, with its edit adding the test &quot;unknown refund is 404&quot; to src/server.test.ts. On the phone, in the tests tab's terminal, ↑ on the key bar brings back bun test and the key bar's Enter runs it: 5 pass, 0 fail."></a>
      <br><b>Switch to the live terminal</b>
      <br><sub>One click turns the chat into the pane's real terminal; on the phone, ↑ on the key bar brings back the test command and Enter beside it runs it again.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/22d10639-9aa6-4953-a5f3-a1b743f4053b"><img src="docs/media/readme/layout.webp" width="100%" alt="Live recording. The browser shows herdr's layout: four workspaces in the sidebar, each row ending in its agent's state (a green dot on checkout-api, whose Claude has finished, a turning arc on web-dashboard, whose Codex is working, nothing on infra and release), and checkout-api's tabs payments and dev. A click on the dev tab shows its first pane, tests, with bun test's 4 pass; the tab's pane menu lists the split's two panes, tests and git, and a click on git shows its git log while checkout-api's row names git. On the phone, ☰ opens the same four workspaces with the same states, and a tap on checkout-api opens Claude's chat: &quot;What does this repo do? Answer in one line.&quot; and its answer."></a>
      <br><b>Your herdr layout, in the browser</b>
      <br><sub>Every workspace, tab and split pane, with each agent's state: click a tab, pick a pane of a split, or switch workspaces from the phone.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/b228a2b8-6db5-4546-a15b-972056000cab"><img src="docs/media/readme/alerts.webp" width="100%" alt="Live recording. The phone shows another workspace's terminal while Claude works on checkout-api in the browser. When Claude asks which rate limit to use, an alert reading &quot;checkout-api Needs input&quot; drops in on the phone and a tap opens the question as a card; in the browser, checkout-api's row and its row under Agents show a red question mark, and the same card waits in its chat."></a>
      <br><b>Know when an agent needs you</b>
      <br><sub>On another workspace, an alert drops in when Claude asks; one tap opens its question.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/a193b426-259c-47d9-bd73-10acc2594265"><img src="docs/media/readme/attach.webp" width="100%" alt="Live recording. On the phone, checkout-api's empty chat asks &quot;What should Claude do in checkout-api?&quot;. The + button attaches a screenshot of a receipt whose total reads $NaN and inserts its path, then &quot;Fix this, with a test.&quot; is typed and sent. The camera pulls back as the message with the screenshot appears on the phone and in the desktop's chat, then moves in on the desktop's chat. In the full video, Claude then runs its first command, which reads src/routes/receipt.ts and src/server.ts."></a>
      <br><b>Send a screenshot from your phone</b>
      <br><sub>The + button uploads it into the pane's folder and adds its path; Claude reads the image.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/bc419d3e-ebda-4fb5-acc5-e498609559fe"><img src="docs/media/readme/open.webp" width="100%" alt="Live recording. In the browser's terminal, Claude Code has written bench/p95.svg; a click on the path in its answer opens the chart in the file viewer, and a tap on the same path in the phone's chat opens it full screen."></a>
      <br><b>Open what the agent made</b>
      <br><sub>Click a path in the terminal, or tap it in the chat: the file opens right there.</sub>
    </td>
    <td width="50%" valign="top">
      <a href="https://github.com/user-attachments/assets/150a4c9d-7667-4f63-ba56-8f91e6a25878"><img src="docs/media/readme/worktree.webp" width="100%" alt="Live recording. On the phone, checkout-api's ⋯ menu → New worktree opens a form with the branch worktree/clear-field-23e0 already filled in; Claude Code is picked and Create worktree is tapped. The camera moves to the browser, where checkout-api's folder is open with the new checkout nested under it, marked as Claude; its row then reads Claude Code over worktree-clear-field-23e0, and the Agents list shows it as a fourth agent."></a>
      <br><b>Branch off a second agent</b>
      <br><sub>From the phone, ⋯ → New worktree: the branch is filled in, pick an agent, and it starts beside the first.</sub>
    </td>
  </tr>
</table>

<p align="center"><sub>Each clip is a live recording of the desktop and a phone at once, in real time with no cuts. Click one for the full video.</sub></p>

- **Chat and terminal, one pane** — native Claude Code, Codex, omp, omo, gjc, pi, Hermes and explicitly identified Devin CLI transcripts, plus OpenCode 2 sessions herdr identifies, with the live terminal a click away. Write the next message while the agent works: it goes in with the next turn, or at once with Send now. [Supported agents →](docs/guide.md#supported-agents)
- **Approve with a tap** — approvals, questions and plan menus become cards, checked to be current before your answer is sent.
- **Know when you’re needed** — live pane status and in-app alerts while the app is open. Closed-app alerts are not supported.
- **Install it on your phone** — a PWA with a key bar above the keyboard (Esc, Tab, Ctrl, Alt, Shift, Enter, arrows) that you can rearrange and extend with your own combinations in Settings, and a QR code for the current address when opened through non-loopback HTTPS. [Phone setup →](docs/guide.md#on-your-phone)
- **Keep your workflow** — herdr owns the agents; this app connects to them. New tabs and worktrees come from a row’s ⋯ menu. Operators build and update separately. [All features →](docs/guide.md#features)

---

## install

**Already installed upstream?** The stable plugin ID is shared, so the installer refuses an
upstream or unknown checkout rather than starting or replacing it. Follow
[fork migration](INSTALL.md#fork-migration): preserve config/state, explicitly stop and replace
only the web plugin, then restart it. Never restart the herdr daemon for this migration.

For a private repository, use an authenticated checkout and run its installer locally; anonymous
raw-file URLs require read access. Use the explicit deployment process in [INSTALL.md](INSTALL.md#update).

```bash
curl -fsSL https://raw.githubusercontent.com/tomrutsaert/herdr-web-ui/main/install.sh | sh
```

Linux (x64, arm64) or macOS. Install herdr 0.9.0+, Bun 1.4+, Git and Node 18+ separately first. The operator-invoked helper installs the plugin, not its prerequisites. Configure HTTPS or VPN access separately.

Windows x64, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/tomrutsaert/herdr-web-ui/main/install.ps1 | iex
```

Windows x64 requires Git, herdr 0.9.0+ and Bun 1.4+ already installed. No Node or WSL is needed. Terminals use a fixed-grid screen mirror until herdr supports terminal attach there.

Already have herdr 0.9.0+, Bun 1.4+ and Node 18+ (Node isn't needed on Windows)? Install just the plugin:

```bash
herdr plugin install tomrutsaert/herdr-web-ui
```

With herdr running, open **[127.0.0.1:7317](http://127.0.0.1:7317)**. On a new install on a PC with a desktop, the installer opens it in your browser for you; click **Install** in the address bar to add the app. The installed app belongs to that exact address, so keep using `http://127.0.0.1:7317` rather than `localhost`. Set `HERDR_WEB_NO_OPEN=1` before running the installer to skip opening the browser. Pick a pane or start an agent with **New workspace**. To use your phone, open your configured HTTPS address, pair the device and add the app to your home screen. [Quick start →](docs/guide.md#quick-start)

A pairing QR is available only in a browser already using a non-loopback HTTPS address.
The local page and terminal Phone setup show a pairing code instead; they do not discover a
remote address.

The server listens on `127.0.0.1` by default. For access from another device, see [phone setup](docs/guide.md#on-your-phone) and [access and safety](docs/guide.md#access-and-safety).

## faq

**Can I use Claude Code or Codex from my phone?**

Yes. Run the agent in a [herdr](https://github.com/herdrdev/herdr) pane on your computer, and this app shows the same pane in your phone's browser: the agent's own transcript as a chat, its approvals and questions as cards you tap, and the live terminal a tap away. It installs to the home screen as a PWA and shows alerts while open. [Phone setup →](docs/guide.md#on-your-phone)

**Which agents does the chat view support?**

Claude Code, Codex, omp, omo, gjc, pi and Hermes are read from their own session stores. For OpenCode 2, the chat reads the session herdr reports from OpenCode's database; the home screen and OpenCode 1.x use the live terminal instead. Devin CLI is a chat when herdr or the running process names its session, as `devin --resume <id>` does; a plain `devin` shows the live terminal. Any other program in a herdr pane gets the live terminal and its status. [Supported agents →](docs/guide.md#supported-agents)

**Does it replace herdr's own TUI?**

No. Both attach to the same terminals at the same time, so the pane stays live at your desk, in the browser and on the phone. Nothing is stopped or handed over. [TUI and browser →](docs/guide.md#faq)

**How do I connect another device?**

Use an SSH tunnel or your own HTTPS reverse proxy to reach the PC. PWA installation and optional open-tab notifications need a secure context such as HTTPS or localhost; basic browsing also works over plain HTTP on a LAN. [The options →](docs/guide.md#faq)

**Does my code or conversation leave my machine?**

Session files remain on the host workstation and are served to authorized connected browsers. The app does not contact vendor services, discover accounts, provision software or aggregate other PCs. Agents’ own model traffic, user-opened external links/media and operator network infrastructure are separate.

**Does it work on Windows?**

Yes, on Windows x64 without WSL. Until herdr can attach a terminal there, the terminal is a [screen mirror](docs/guide.md#supported-agents) with typing and a fixed grid.

**How is it different from collie, roamgate or herdr-remote?**

These are other phone or browser clients for herdr. This one reads the agent's own transcript, so a pane is a chat with the work folded per turn rather than terminal output, and it serves one workstation. It brings no tunnel and drives only herdr: if you want tmux or zellij, diffs, Telegram or a tunnel out of the box, one of the others is the better fit. [The full comparison →](docs/guide.md#faq)

**How is it different from Happy, Paseo or CloudCLI UI?**

Those projects provide their own ways to start or manage agent sessions. This app works with the herdr panes you already run, keeping the same terminals available in the TUI and browser. If you do not use herdr, compare those projects’ deployment options and agent support. [The full comparison →](docs/guide.md#faq)

## docs

Start with the [user guide](docs/guide.md): [quick start](docs/guide.md#quick-start) · [supported agents](docs/guide.md#supported-agents) · [features](docs/guide.md#features) · [phone](docs/guide.md#on-your-phone) · [access and safety](docs/guide.md#access-and-safety) · [configuration](docs/guide.md#configuration) · [keyboard shortcuts](docs/guide.md#keyboard-shortcuts) · [FAQ](docs/guide.md#faq).

For a closer look: [how it works](docs/guide.md#how-it-works) · [chat transcripts](docs/chat-mode-audit.md) · [terminal flow control](docs/terminal-flow-control.md) · [changelog](CHANGELOG.md).

## thanks

Built on [herdr](https://github.com/herdrdev/herdr), with inspiration from [chatmux](https://github.com/devswha/chatmux), and powered by [xterm.js](https://xtermjs.org), [React](https://react.dev), [Bun](https://bun.sh) and [Lucide](https://lucide.dev).

Thanks to everyone who has contributed, including [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha).

## agent instructions

Helping someone install the app? Follow [INSTALL.md](INSTALL.md). For repository changes, follow [CONTRIBUTING.md](CONTRIBUTING.md), the [review rules](.github/REVIEW.md) and [AGENTS.md](AGENTS.md).

## development

```bash
git clone https://github.com/tomrutsaert/herdr-web-ui.git
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

See [CONTRIBUTING.md](CONTRIBUTING.md) to send a change, [development](docs/development.md) for tests and releases, and [DESIGN.md](DESIGN.md) for UI conventions. Report security problems privately: [SECURITY.md](SECURITY.md).

## license

[MIT](LICENSE). Copyright © 2026 devswha.
