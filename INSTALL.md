# Installing herdr web ui (guide for coding agents)

Follow these steps in order to install herdr web ui for a user. Run each command and check its output
before moving on. Every step says what success looks like. Stop and ask the user whenever a step says
**Ask**.

herdr web ui is a browser and phone client for [herdr](https://github.com/herdrdev/herdr). It adds a
web server on port `7317` and never replaces herdr, its sessions or the user's own terminal.

## Rules

- Bind to `127.0.0.1` (the default) unless the user asks for remote access. Anyone who can reach an
  ungated server can type into the user's terminals. Never bind to `0.0.0.0` or a LAN address, or
  put it behind a proxy other people can reach, without a token (`HERDR_WEB_TOKEN`).
- Never print, log or commit the token. Write it only to the config file named below and tell the
  user where it is.
- Do not install herdr, Bun or Node yourself unless the user agrees. Say which one is missing and how
  to install it.
- Do not stop or restart the user's herdr server (`herdr server stop`). Restarting herdr web ui is fine.

## 1. Check prerequisites

```bash
bun --version        # need 1.4 or newer
node --version       # Linux/macOS only: need v18 or newer for the terminal-attach sidecar
herdr --version      # need 0.9.0 or newer
herdr status server  # the herdr server must be running
git --version
```

- A missing tool: **Ask** before installing it. Bun: `curl -fsSL https://bun.sh/install | bash`.
  herdr: <https://herdr.dev>. Node: the user's usual package manager.
- If herdr is not running, ask the user to start it in a terminal, then check again.
- Supported platforms: Linux x64/arm64, macOS and Windows x64. Windows uses a screen mirror
  and does not need Node. No compiler or Python is needed on supported platforms.

## 2. Choose the install method

| Method | When | Updates |
| --- | --- | --- |
| **A. herdr plugin** (default) | Start with herdr | Manual Check/Update in Settings → About |
| **B. Source checkout** | Development or a requested clone | Manual Check/Update on a clean `main` |
| **C. One-line installer** | The user approves installing missing prerequisites | Same as A |

For a private repository, authenticate Git and run the installer from an authenticated checkout;
anonymous raw-file and release asset URLs may be unavailable. Use local remote-runtime builds
when fork assets are private ([remote PCs](docs/remote-pcs.md)). Never fall back to upstream.

Use A unless the user chooses otherwise. C installs missing prerequisites for the user and this
fork's latest `fork-vX.Y.Z` release:

```bash
curl -fsSL https://raw.githubusercontent.com/tomrutsaert/herdr-web-ui/main/install.sh | sh
```

It does not configure remote access. Ask before installing missing prerequisites. A first install
may ask about starring the fork at an interactive terminal; never answer for the user.

On Windows x64, use `irm https://raw.githubusercontent.com/tomrutsaert/herdr-web-ui/main/install.ps1 | iex` in PowerShell.
It requires Git for Windows and installs missing herdr and Bun for the user, without Node or WSL.
It starts the plugin when herdr runs. Phone access stays optional: use the **Phone setup** action.
`HERDR_WEB_UI_REF` selects a fork release tag or an explicit development branch/commit; inherited
upstream app and runtime tags are refused. Otherwise it installs the latest fork release.

## Fork migration

An existing `devswha.herdr-web-ui` entry is not proof of this fork. The installers require the
fork distribution marker and a fork Git origin before they start it. Unknown/upstream copies
are refused without uninstalling them. A replaced checkout also cannot count an older running
server or an unexplained live PID as a running fork.

**Ask** before migrating. Record the checkout path from `herdr plugin list --json`, the config
path from `herdr plugin config-dir devswha.herdr-web-ui`, and the configured app state path
(`HERDR_WEB_STATE_DIR`, otherwise `~/.config/herdr-web-ui`). Back up those config/state directories
and preserve the plugin's state directory. They hold device credentials, push keys and settings.
Keep the stable plugin ID and original paths; never delete them to make an install pass.

1. Identify the old web plugin's listener/process before invoking its Stop action. If a recorded
   PID cannot be identified as that web plugin, investigate it instead of killing an unrelated
   process. Once ownership is confirmed, stop **only the web plugin** with
   `herdr plugin action invoke devswha.herdr-web-ui.stop`
   (`devswha.herdr-web-ui.stop-windows` on Windows), then confirm that its listener/process has
   exited. Do not run `herdr server stop` or restart the daemon.
2. With a clean checkout and the user's approval, explicitly replace its source using a
   published fork release. In the commands below, `root` is the recorded plugin checkout and
   `fork-vX.Y.Z` is an actual fork release, not an inherited upstream tag:

   ```bash
   git -C "$root" status --short       # stop if there are local changes
   git -C "$root" remote set-url origin https://github.com/tomrutsaert/herdr-web-ui.git
   git -C "$root" fetch --no-tags origin tag fork-vX.Y.Z
   git -C "$root" checkout --detach fork-vX.Y.Z
   (cd "$root" && bun install --frozen-lockfile && bun run build)
   ```

   Use authenticated Git access for a private fork. These commands leave config and app state
   in place. Do not use an upstream reinstall command afterwards. The fork installer validates
   the checkout rather than relying on the registry's historical repository label. In-place
   replacement **does not update herdr's registry provenance**. Every later reinstall or plugin
   operation that names a repository must explicitly name `tomrutsaert/herdr-web-ui`; do not
   let a registry-recorded upstream repository choose the source. There is no automatic upstream
   fallback. Use a supported explicit uninstall/reinstall only after confirming its state-retention
   behavior and backing up config/state; this guide does not assume uninstall preserves them.
3. Start the web plugin explicitly (`devswha.herdr-web-ui.start`, or `.start-windows`). Check
   `/api/health` for `web_ui.distribution: "tomrutsaert/herdr-web-ui"`. The in-app updater's state
   is distribution-scoped; inherited upstream releases are not resumed. Existing pairing and
   push state remain at their original paths.

## 3A. Install as a herdr plugin

```bash
herdr plugin install tomrutsaert/herdr-web-ui --yes
```

herdr clones the repository, runs `bun install` and `bun run build`, then registers the plugin. This
takes about a minute.

- Success: the command exits 0 and `herdr plugin list` shows `devswha.herdr-web-ui`.
- The first build step is a check that prints, in one line, what is missing (`bun`, `node`, or a
  version too old) and how to fix it. `bun` or `node` not found means herdr runs build commands
  with **its own** environment: make sure they are on the `PATH` of the shell that started herdr
  (Bun installs to `~/.bun/bin`), ask the user to restart herdr from that shell, then retry.
- On Windows, the plugin launcher reads the current user PATH and Bun's user-local directory,
  so installing Bun while herdr is running does not require restarting herdr.
- "installing over a locally linked plugin is refused": run `herdr plugin unlink devswha.herdr-web-ui`
  first.

Start it now. Otherwise it starts the next time herdr starts:

```bash
herdr plugin action invoke devswha.herdr-web-ui.start
```

On Windows, the start and stop action IDs are `devswha.herdr-web-ui.start-windows` and
`devswha.herdr-web-ui.stop-windows`. The menu titles are the same on every platform.

The command only queues the action and prints herdr's JSON acknowledgement; the action's own output
(`herdr web ui listening at http://127.0.0.1:7317`, and possibly `no token set: ...`, expected for a
local-only install) goes to the plugin log (`herdr plugin log list`). Check it with step 4.

Plugin settings do **not** come from the user's shell. They go in an `env` file (no dot):

```bash
CONFIG_DIR="$(herdr plugin config-dir devswha.herdr-web-ui)"
echo "$CONFIG_DIR/env"
```

The file holds `KEY=value` lines. A plugin checkout from 0.3.25 on also reads `.env` there (the name
herdr's plugin docs use), and `.env` wins where both set a key. An older checkout reads only `env`,
and in-app updates do not replace the checkout: reinstall the plugin (see [Update](#update)) before
relying on `.env`. The plugin path comes from `herdr plugin list`, since herdr 0.9.4 moved plugin
checkouts. Run:

```bash
root=$(herdr plugin list --json | bun -e 'const d = JSON.parse(await Bun.stdin.text()); console.log(d.result.plugins.find((p) => p.plugin_id === "devswha.herdr-web-ui")?.plugin_root ?? "")')
bun "$root/scripts/plugin.ts" status
```

This prints the files it read. After editing, restart the plugin:

```bash
herdr plugin action invoke devswha.herdr-web-ui.stop
herdr plugin action invoke devswha.herdr-web-ui.start
```

## 3B. Install from source

```bash
git clone https://github.com/tomrutsaert/herdr-web-ui.git
cd herdr-web-ui
bun install
bun run start
```

`bun run start` runs in the foreground. Start it in a separate herdr pane, or under the user's
service manager, so it keeps running. Settings are environment variables on that command.
`bun run server` and `bun run dev` are development commands and do not update themselves.

## 4. Verify

```bash
curl -s http://127.0.0.1:7317/api/health
```

Success is JSON with `"ok":true` and a `herdr` object, for example
`{"ok":true,"herdr":{"version":"0.9.0","protocol":...},"auth":{"required":false,...},...}`.

- Connection refused: the server is not running. For the plugin, run the `status` action. Command
  logs are listed by `herdr plugin log list`; the server's own log is `server.log` in the plugin's
  state directory. Port `7317` in use: set `PORT` (see [Configuration](#configuration)) and restart.
- An error mentioning the herdr socket: herdr is not running, or it uses a named session. For a
  named session, set `HERDR_SOCKET=~/.config/herdr/sessions/<name>/herdr.sock`. The plugin follows
  herdr's session automatically.

Tell the user to open <http://127.0.0.1:7317>.

## 5. Optional: phone or remote access

**Ask** first: remote access exposes terminals and files. Keep the server on loopback and use
an approved HTTPS reverse proxy or private SSH forward. Set `HERDR_WEB_TOKEN` before exposing
a proxy; never print or log the token. See [proxy setup](docs/guide.md#behind-a-reverse-proxy).
The installer does not discover or publish routes.

For a desktop SSH forward: `ssh -L 7317:127.0.0.1:7317 <server>`, then open
`http://127.0.0.1:7317` locally. A phone needs HTTPS to install the PWA and receive alerts.
At the configured HTTPS address, use a token or pair with a code from **Settings → Phone &
devices** on a signed-in device. For a headless plugin installation, run `pair` from its checkout:

```bash
root=$(herdr plugin list --json | bun -e 'const d = JSON.parse(await Bun.stdin.text()); console.log(d.result.plugins.find((p) => p.plugin_id === "devswha.herdr-web-ui")?.plugin_root ?? "")')
bun "$root/scripts/plugin.ts" pair
```

A code is a one-use secret valid for ten minutes; do not record it in logs. Forwarded or
foreign-host loopback requests always require credentials. Direct non-loopback binds remain
open until a token is set or a device is confirmed, so never expose one unprotected.
Other PCs over SSH are added from **Settings → Remote PCs → Add PC**.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `7317` | HTTP and WebSocket port |
| `HERDR_WEB_TOKEN` | unset | Token for scripts and proxies. Once set, every client that is not a paired device needs it, this PC included |
| `HERDR_SOCKET` | `~/.config/herdr/herdr.sock` | herdr socket (source installs; the plugin follows herdr) |
| `HERDR_WEB_STATE_DIR` | `~/.config/herdr-web-ui` | Push keys, device subscriptions, PC registrations, update builds. Keep it across reinstalls. |

The [user guide](docs/guide.md#configuration) lists the rest.

## Update

- Settings → **About** → **Check for updates**, then **Update and restart** when a new release (`fork-vX.Y.Z`) is out. It works for
  both install methods. The new
  version is built separately and the app restarts only if the build and health check pass.
- Plugin alternative: `herdr plugin install tomrutsaert/herdr-web-ui --yes` again. It replaces the
  checkout; restart the plugin afterwards.
- Source alternative: `git pull` on `main`, then restart `bun run start`. The in-app updater only
  offers published releases (`fork-vX.Y.Z` tags); `main` can be ahead of the latest release.

## Uninstall

```bash
herdr plugin action invoke devswha.herdr-web-ui.stop
herdr plugin uninstall devswha.herdr-web-ui
```

Uninstall removes herdr's managed checkout. It does not touch `~/.config/herdr-web-ui` (push
subscriptions, saved PCs, update builds). Check whether the plugin config directory (it holds the
token) is still there. Delete either one only if the user asks.
