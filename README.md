# herdr web ui

<p align="center">
  <img src="public/icons/icon-192.png" alt="herdr web ui" width="100">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://devswha.github.io/herdr-web-ui/">website</a> ·
  <a href="#install">install</a> ·
  <a href="https://devswha.github.io/herdr-web-ui/demo/">try the demo</a> ·
  <a href="docs/guide.md#quick-start">quick start</a> ·
  <a href="#docs">docs</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT license"></a>
  <a href="https://github.com/devswha/herdr-web-ui/stargazers"><img src="https://img.shields.io/github/stars/devswha/herdr-web-ui?labelColor=333333&color=666666&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/devswha/herdr-web-ui/releases/latest"><img src="https://img.shields.io/github/v/release/devswha/herdr-web-ui?label=release&labelColor=333333&color=666666" alt="Latest release"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
  <a href="docs/guide.md#on-your-phone"><img src="https://img.shields.io/badge/PWA-installable-666666?labelColor=333333" alt="Installable PWA"></a>
</p>

---

https://github.com/user-attachments/assets/7d30e956-df88-4513-a432-5f91e756c262

<p align="center"><sub>Claude Code in a terminal pane, the same session as a chat, then on the phone · recorded live · <a href="https://devswha.github.io/herdr-web-ui/media/herdr-web-ui-film.mp4">▶ the 56-second film</a></sub></p>

**Your agents, in plain conversation. On your desktop and your phone.**

A browser and phone client for [herdr](https://github.com/herdrdev/herdr). Open the sessions you already run, read what your agents are doing, and answer them from wherever you are.

- **Chat and terminal, one pane** — read native Claude Code, Codex, omp, omo and gjc transcripts with commands and edits folded per turn and the plan pinned below. Switch to the live terminal for full-screen TUIs, raw keys and herdr's scrollback. [Supported agents →](docs/guide.md#supported-agents)
- **Approve with a tap** — supported agents' approvals, questions and plan menus become cards in the chat. Pick an option; the app checks that the prompt is still current before sending your answer.
- **Take your agents with you** — install the PWA on your phone, scroll by touch, and use Esc, Tab, Ctrl and arrows above the keyboard. Settings shows your Tailscale address as a QR code. [Phone setup →](docs/guide.md#on-your-phone)
- **Know when you're needed** — live status for every pane, plus push alerts when an agent needs input, finishes or its terminal ends, even with the app closed.
- **Every PC in one sidebar** — add Linux and macOS machines over SSH. Their workspaces, chats, files and terminals appear alongside your local sessions. [Remote PCs →](docs/remote-pcs.md)
- **Send context, open results** — slash commands, file mentions, image and file attachments, quick replies and multiple queued messages while the agent works. Preview or download the files it produces. [All features →](docs/guide.md#features)
- **Keep your existing workflow** — herdr owns the agents and terminals; this app connects to them. Use your TUI and browser together, with local access, device pairing or a shared token. [Access and safety →](docs/guide.md#access-and-safety)
- **Update without stopping your agents** — install releases from Settings, with health checks and rollback. Opt into automatic installation with `HERDR_WEB_AUTO_UPDATE=1`. [Updates →](docs/guide.md#updates)

---

## install

```bash
curl -fsSL https://devswha.github.io/herdr-web-ui/install.sh | sh
```

Linux (x64, arm64) or macOS. Installs missing herdr 0.9.0+, Bun 1.4+ and Node 18+ prerequisites for your user, then installs the app as a herdr plugin. If an existing herdr installation is older than 0.9.0, update and restart herdr yourself before rerunning the installer. With the default listen address and Tailscale running, successful HTTPS setup provides a tailnet address and QR code.

<p align="center">
  <img src="docs/screenshots/install.png" width="720" alt="Installer output: Bun, Node and the herdr plugin install, then tailscale serve publishes the app and a QR code for the phone appears.">
</p>

Already have the prerequisites? Install just the plugin:

```bash
herdr plugin install devswha/herdr-web-ui
```

With herdr running, open **[localhost:7317](http://localhost:7317)**. Pick a pane or start an agent with **New session**. To use your phone, scan the installer's QR code and add the app to your home screen. [Quick start →](docs/guide.md#quick-start)

The server listens on `127.0.0.1` by default. For access from another device, see [phone setup](docs/guide.md#on-your-phone) and [access and safety](docs/guide.md#access-and-safety).

## docs

Start with the [user guide](docs/guide.md): [quick start](docs/guide.md#quick-start) · [supported agents](docs/guide.md#supported-agents) · [features](docs/guide.md#features) · [phone](docs/guide.md#on-your-phone) · [remote PCs](docs/remote-pcs.md) · [access and safety](docs/guide.md#access-and-safety) · [configuration](docs/guide.md#configuration) · [keyboard shortcuts](docs/guide.md#keyboard-shortcuts) · [FAQ](docs/guide.md#faq).

For a closer look: [how it works](docs/guide.md#how-it-works) · [chat transcripts](docs/chat-mode-audit.md) · [terminal flow control](docs/terminal-flow-control.md) · [app updates](docs/app-updates.md) · [changelog](CHANGELOG.md).

## thanks

Built on [herdr](https://github.com/herdrdev/herdr), with inspiration from [chatmux](https://github.com/devswha/chatmux), and powered by [xterm.js](https://xtermjs.org), [React](https://react.dev), [Bun](https://bun.sh) and [Lucide](https://lucide.dev).

Thanks to everyone who has contributed, including [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha).

## agent instructions

Helping someone install the app? Follow [INSTALL.md](INSTALL.md). For repository changes, follow the local `AGENTS.md` instructions when present and the committed [review rules](.github/REVIEW.md).

## development

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

See [development](docs/development.md) for tests, media and releases, and [DESIGN.md](DESIGN.md) for UI conventions.

## license

[MIT](LICENSE). Copyright © 2026 devswha.
