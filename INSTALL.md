# Operator installation and deployment

This app serves one workstation's herdr terminals, native agent conversations and files.
Authorized browsers can use it remotely through an operator-managed HTTPS reverse proxy or VPN.
It does not provision software, tunnels or other PCs. These instructions are explicit deployment
steps, not actions performed by startup or browser settings.

## Prerequisites

Install and verify prerequisites separately: herdr 0.9.0+, Bun 1.4+, Git, and Node 18+ on
Linux/macOS for the PTY sidecar. Windows x64 uses a fixed-grid terminal mirror and needs no Node.
A missing prerequisite is an error; installers do not download or upgrade it.
Never install or restart a user's tools or deployment without their authorization.

## Install

Use an authenticated checkout for a private repository. From its reviewed revision:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build
bun run start
```

`start` runs the prepared checkout without building, discovering releases or installing software.
The default address is `http://127.0.0.1:7317`. Configure `HERDR_SOCKET` for the intended herdr
session. The app never creates a herdr daemon automatically.

For operator-managed plugin installation, with prerequisites already present:

```bash
herdr plugin install tomrutsaert/herdr-web-ui --ref <reviewed-revision>
```

herdr's explicit plugin install runs the dependency install and build steps in
`herdr-plugin.toml`; plugin startup only launches the prepared app. `install.sh` and `install.ps1`
are optional operator-invoked plugin helpers. They verify prerequisites and existing fork identity,
and refuse unknown/upstream installations. Nothing installs prerequisites for you.

## Fork migration

An existing `devswha.herdr-web-ui` entry is not proof of this fork. The installers require the
fork distribution marker and a fork Git origin before they start it. Unknown/upstream copies
are refused without uninstalling them. A replaced checkout also cannot count an older running
server or an unexplained live PID as a running fork.

**Ask** before migrating. Record the checkout path from `herdr plugin list --json`, the config
path from `herdr plugin config-dir devswha.herdr-web-ui`, and the configured app state path
(`HERDR_WEB_STATE_DIR`, otherwise `~/.config/herdr-web-ui`). Back up those config/state directories
and preserve the plugin's state directory. They hold device credentials and settings.
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
   `/api/health` for `web_ui.distribution: "tomrutsaert/herdr-web-ui"`. Existing paired devices
   and shared preferences remain at their original paths; deployment never resumes an in-app update.

## Remote browser access

Keep `HOST=127.0.0.1` unless another bind is explicitly authorized. Configure an HTTPS reverse
proxy, private forwarding path or VPN outside the app; see [proxy setup](docs/guide.md#behind-a-reverse-proxy).
Set `HERDR_WEB_TOKEN` before exposing an address. Never print, log or commit the token. Plugin
configuration goes in `env` or `.env` under `herdr plugin config-dir devswha.herdr-web-ui`.
Preserve that directory and restrict its permissions.

Token authentication, pairing and read-only devices work through the operator's HTTPS address.
The proxy must forward WebSocket upgrades, disable buffering for `/api/events`, and set truthful
`Host` and `X-Forwarded-Proto` headers. Strip client-supplied proxy and Authorization headers.
Test that an unauthenticated visitor gets 401 from `/api/session` and `/api/events`.
Use Settings → Phone & devices or `bun scripts/plugin.ts pair` to issue a ten-minute pairing code.
A non-loopback HTTPS page can display a QR for its own address; no external address is discovered.

A plugin follows the socket of the herdr session that starts it (`HERDR_SOCKET_PATH`). Set
`HERDR_SOCKET` in the plugin config to override that session explicitly.

## State and configuration

`HERDR_WEB_STATE_DIR` defaults to `~/.config/herdr-web-ui`. Keep it across deployments: it holds
paired devices, shared preferences and local completion state. `HOST`, `PORT`, `HERDR_SOCKET`,
`HERDR_WEB_TOKEN` and UI/file settings are described in the [guide](docs/guide.md#configuration).
This edition does not consume old PC registrations, SSH keys, voice/provider credentials,
Push/Portal state or updater builds. It does not delete those files; the operator can archive
or remove obsolete state after checking that no older installation uses it.

## Update

Updates are a separate operator deployment task, never a control in the app. Save browser drafts
and preserve the plugin configuration and `HERDR_WEB_STATE_DIR` before replacing a deployment.
Choose and review the desired revision in your authenticated checkout, install its locked
dependencies with `bun install --frozen-lockfile`, then run `bun run typecheck` and `bun run build`.
Stop only the web app, replace its files or switch to the prepared checkout, and restart it with
`bun run start` (or the plugin's Start action). Verify `/api/health`, authentication, a terminal and
chat through the configured browser address. Keep the previous checkout/build for a manual rollback.
Do not restart herdr or its agents for an app deployment. Update herdr and prerequisites separately
using the operator's chosen package/deployment process, outside this web app.

## Uninstall

With explicit authorization, stop only the web app (the plugin's Stop action, or its source
process), then run `herdr plugin uninstall devswha.herdr-web-ui` if installed as a plugin.
Do not stop herdr. Configuration and application state are separate; remove them only when
requested and after preserving any needed pairing/preferences data.
