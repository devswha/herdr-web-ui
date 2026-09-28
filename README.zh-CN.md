# herdr web ui

<p align="center">
  <img src="public/icons/icon-192.png" alt="herdr web ui" width="100">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://devswha.github.io/herdr-web-ui/">官网</a> ·
  <a href="#install">安装</a> ·
  <a href="https://devswha.github.io/herdr-web-ui/demo/">体验演示</a> ·
  <a href="docs/guide.md#quick-start">快速入门</a> ·
  <a href="#docs">文档</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT 许可证"></a>
  <a href="https://github.com/devswha/herdr-web-ui/stargazers"><img src="https://img.shields.io/github/stars/devswha/herdr-web-ui?labelColor=333333&color=666666&logo=github" alt="GitHub 星标数"></a>
  <a href="https://github.com/devswha/herdr-web-ui/releases/latest"><img src="https://img.shields.io/github/v/release/devswha/herdr-web-ui?label=release&labelColor=333333&color=666666" alt="最新版本"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
  <a href="docs/guide.md#on-your-phone"><img src="https://img.shields.io/badge/PWA-installable-666666?labelColor=333333" alt="可安装的 PWA"></a>
</p>

---

https://github.com/user-attachments/assets/7d30e956-df88-4513-a432-5f91e756c262

<p align="center"><sub>在终端窗格中运行 Claude Code，同一会话切换为聊天，再到手机上继续 · 实机录制 · <a href="https://devswha.github.io/herdr-web-ui/media/herdr-web-ui-film.mp4">▶ 56 秒演示影片</a></sub></p>

**在电脑和手机上，随时与智能体对话。**

[herdr](https://github.com/herdrdev/herdr) 的浏览器与手机客户端。打开已经运行的会话，查看智能体正在做什么，无论身在何处都能回复。

- **聊天与终端，共用一个窗格** — 阅读 Claude Code、Codex、omp、omo 和 gjc 的原生会话记录；每轮对话中的命令和编辑操作可折叠查看，由受支持的待办工具生成的计划固定显示在下方。切换到实时终端，即可使用全屏终端界面、直接发送按键并查看 herdr 的回滚历史。[支持的智能体 →](docs/guide.md#supported-agents)
- **轻点即可批准** — 支持的智能体所发出的审批请求、问题和计划菜单会显示为聊天卡片。选择选项后，应用会先确认提示仍然有效，再发送你的回答。
- **随身访问智能体** — 在手机上安装 PWA，通过触摸滚动，并使用键盘上方的 Esc、Tab、Ctrl 和方向键。Settings（设置）会将你的 Tailscale 地址显示为二维码。[手机设置 →](docs/guide.md#on-your-phone)
- **需要你时及时提醒** — 实时显示每个窗格的状态；当智能体需要输入、完成任务或终端结束时，发送推送通知，即使应用已关闭也能收到。
- **一个侧边栏，管理所有电脑** — 通过 SSH 添加 Linux 和 macOS 电脑。它们的工作区、聊天、文件和终端会与本地会话并列显示。[远程电脑 →](docs/remote-pcs.md)
- **发送上下文，查看结果** — 支持斜杠命令、文件引用、图片和文件附件、快捷回复，以及在智能体工作时暂存多条待发送消息。预览或下载智能体生成的文件。[全部功能 →](docs/guide.md#features)
- **沿用现有工作流** — 智能体和终端由 herdr 管理，本应用负责连接。终端界面与浏览器可以同时使用，并支持本地访问、设备配对或共享令牌。[访问与安全 →](docs/guide.md#access-and-safety)
- **更新应用，无需停止智能体** — 在 Settings（设置）中安装新版本，支持健康检查和回滚。设置 `HERDR_WEB_AUTO_UPDATE=1` 可启用自动安装。[更新 →](docs/guide.md#updates)

---

<a id="install"></a>

## 安装

```bash
curl -fsSL https://devswha.github.io/herdr-web-ui/install.sh | sh
```

支持 Linux（x64、arm64）或 macOS。安装程序会为当前用户补齐 herdr 0.9.0+、Bun 1.4+ 和 Node 18+ 依赖，然后将应用安装为 herdr 插件。如果已安装的 herdr 低于 0.9.0，请先自行更新并重启 herdr，再重新运行安装程序。使用默认监听地址且 Tailscale 正在运行时，HTTPS 配置成功后会提供 tailnet 内的访问地址和二维码。

<p align="center">
  <img src="docs/screenshots/install.png" width="720" alt="安装程序输出：安装 Bun、Node 和 herdr 插件，然后通过 tailscale serve 提供应用访问地址，并显示供手机扫描的二维码。">
</p>

已经安装了所需依赖？只需安装插件：

```bash
herdr plugin install devswha/herdr-web-ui
```

在 herdr 运行时，打开 **[localhost:7317](http://localhost:7317)**。选择一个窗格，或点击 **New session（新建会话）** 启动智能体。要在手机上使用，请扫描安装程序提供的二维码，并将应用添加到主屏幕。[快速入门 →](docs/guide.md#quick-start)

服务器默认监听 `127.0.0.1`。如需从其他设备访问，请参阅[手机设置](docs/guide.md#on-your-phone)和[访问与安全](docs/guide.md#access-and-safety)。

<a id="docs"></a>

## 文档

从[用户指南](docs/guide.md)开始：[快速入门](docs/guide.md#quick-start) · [支持的智能体](docs/guide.md#supported-agents) · [功能](docs/guide.md#features) · [手机](docs/guide.md#on-your-phone) · [远程电脑](docs/remote-pcs.md) · [访问与安全](docs/guide.md#access-and-safety) · [配置](docs/guide.md#configuration) · [键盘快捷键](docs/guide.md#keyboard-shortcuts) · [常见问题](docs/guide.md#faq)。

深入了解：[工作原理](docs/guide.md#how-it-works) · [聊天记录](docs/chat-mode-audit.md) · [终端流量控制](docs/terminal-flow-control.md) · [应用更新](docs/app-updates.md) · [更新日志](CHANGELOG.md)。

## 致谢

本项目基于 [herdr](https://github.com/herdrdev/herdr) 构建，灵感来自 [chatmux](https://github.com/devswha/chatmux)，并使用了 [xterm.js](https://xtermjs.org)、[React](https://react.dev)、[Bun](https://bun.sh) 和 [Lucide](https://lucide.dev)。

感谢所有贡献者，包括 [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha)。

## 智能体操作指南

正在协助他人安装应用？请遵循 [INSTALL.md](INSTALL.md)。修改仓库时，请遵循本地 `AGENTS.md` 中的说明（如有）以及仓库中的[审查规则](.github/REVIEW.md)。

## 开发

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

测试、媒体素材和发布流程请参阅[开发文档](docs/development.md)，界面规范请参阅 [DESIGN.md](DESIGN.md)。

## 许可证

[MIT](LICENSE)。Copyright © 2026 devswha.
