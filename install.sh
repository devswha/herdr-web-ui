#!/bin/sh
# Operator-invoked plugin installation. Prerequisites must already be installed.
# Run from an authenticated checkout for a private repository. No prerequisites are downloaded.
set -eu

REPO="tomrutsaert/herdr-web-ui"
PLUGIN="devswha.herdr-web-ui"
BIN_DIR="$HOME/.local/bin"

say() { printf '%s\n' "herdr web ui: $*"; }
# a clickable address in a terminal (OSC 8); $terminal is set once, since $(link …) runs in a pipe
# shellcheck disable=SC1003 # the backslashes end OSC 8 escapes (ESC \\), no quote is escaped
link() { if [ "$terminal" = 1 ]; then printf '\033]8;;%s\033\\%s\033]8;;\033\\' "$1" "$1"; else printf '%s' "$1"; fi; }
fail() { printf '%s\n' "herdr web ui: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "needs '$1', which is not installed. Install it and run this again."; }
# Read the installed distribution as data, never by executing its code.
verify_fork() {
  bun -e '
    const { readFileSync } = await import("node:fs");
    const { spawnSync } = await import("node:child_process");
    try {
      const root = process.argv[1];
      const identity = readFileSync(`${root}/shared/distribution.ts`, "utf8").replace(/\r\n/g, "\n");
      const remote = spawnSync("git", ["-C", root, "config", "--local", "--get", "remote.origin.url"], { encoding: "utf8" });
      if (!/^export const DISTRIBUTION_REPOSITORY = "tomrutsaert\/herdr-web-ui";$/m.test(identity)
          || remote.status !== 0 || !/^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)tomrutsaert\/herdr-web-ui(?:\.git)?$/.test(remote.stdout.trim())) process.exit(1);
    } catch { process.exit(1); }
  ' "$1" || fail "migration required: this plugin is upstream or unknown. Stop only the web plugin, preserve its config/state, then explicitly replace its checkout with tomrutsaert/herdr-web-ui and restart the web plugin (INSTALL.md#fork-migration). Nothing was started or uninstalled."
}
# Stable fork releases only; untagged main commits and inherited tags do not qualify.
latest_release() {
  git ls-remote --tags --refs "https://github.com/$REPO.git" 'fork-v*' 2>/dev/null |
    sed -n 's|.*refs/tags/\(fork-v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' |
    sort -t. -k1.7,1n -k2,2n -k3,3n | tail -n 1
}
# at_least 1.4.0 1.10.2: is the second dotted version the first or newer
at_least() {
  awk -v want="$1" -v have="$2" 'BEGIN { split(want, w, "."); split(have, h, ".");
    for (i = 1; i <= 3; i++) { if (h[i] + 0 > w[i] + 0) exit 0; if (h[i] + 0 < w[i] + 0) exit 1 } exit 0 }'
}
open_app() {
  [ "$new_install" = 1 ] || return 0
  origin=$(bun "$root/scripts/plugin.ts" status </dev/null | awk '$1 == "running" { print $2 }')
  [ -n "$origin" ] || return 0
  hostport=${origin#*://}
  hostport=${hostport%%/*}
  host=${hostport%:*}
  case "$hostport" in *:*) port=${hostport##*:} ;; *) port=80 ;; esac
  loopback=0
  case "$host" in 127.0.0.1 | localhost) loopback=1 ;; esac
  opener=""
  if [ -z "${CI:-}" ] && [ -z "${HERDR_WEB_NO_OPEN:-}" ] && [ -z "${SSH_CONNECTION:-}" ] && [ -z "${SSH_TTY:-}" ] && [ "$loopback" = 1 ]; then
    if [ "$os" = darwin ]; then
      ! command -v open >/dev/null 2>&1 || opener=open
    elif [ -n "${BROWSER:-}" ] && command -v "$BROWSER" >/dev/null 2>&1; then
      opener=$BROWSER
    elif command -v xdg-open >/dev/null 2>&1 && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
      opener=xdg-open
    fi
  fi
  echo
  if [ -n "$opener" ]; then
    "$opener" "$origin" </dev/null >/dev/null 2>&1 &
    say "opened $origin in your browser: click Install in the address bar to add the app"
  elif [ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" ]; then
    say "from your own PC, tunnel to this one and open the app there: ssh -L $port:127.0.0.1:$port <this-pc>"
    say "the phone address above also opens it"
  elif [ "$loopback" = 1 ]; then
    say "open $origin in your browser and click Install in the address bar to add the app"
  else
    say "open $origin in your browser"
  fi
}

main() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "runs on Linux and macOS; this is $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "runs on x64 and arm64; this is $(uname -m)" ;;
  esac
  platform="$os-$arch"
  terminal=0
  [ ! -t 1 ] || terminal=1
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    fail "the terminal addon has no build for musl (Alpine); use a glibc distribution"
  fi
  need git

  new_install=0
  PATH="$BIN_DIR:$HOME/.bun/bin:$PATH"
  export PATH

  need herdr
  need bun
  need node
  herdr_version=$(herdr --version 2>/dev/null | awk '{ print $2 }')
  at_least 0.9.0 "${herdr_version:-0}" \
    || fail "needs herdr 0.9.0 or newer; this is ${herdr_version:-unknown}. Update it (https://herdr.dev/docs/install/), restart herdr, and run this again."

  bun_version=$(bun --version)
  at_least 1.4.0 "$bun_version" || fail "needs Bun 1.4 or newer; install it separately and retry"
  node_major=$(node --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')
  [ "${node_major:-0}" -ge 18 ] || fail "needs Node 18 or newer; install it separately and retry"

  if herdr plugin list 2>/dev/null | grep -q "$PLUGIN "; then
    root=$(herdr plugin list --json | bun -e 'const d = JSON.parse(await Bun.stdin.text()); console.log(d.result.plugins.find((p) => p.plugin_id === "devswha.herdr-web-ui")?.plugin_root ?? "")')
    verify_fork "$root"
    say "already installed as a herdr plugin (verified fork); updates are an operator deployment step (INSTALL.md#update)"
  else
    need git
    ref=${HERDR_WEB_UI_REF:-$(latest_release)}
    case "$ref" in v[0-9]*|remote-v*|fork-remote-v*) fail "app installs require a fork-v release tag (or an explicit development branch/commit)" ;; esac
    [ -n "$ref" ] || fail "could not look up the latest release on github.com. Check the connection and run this again."
    say "installing the herdr plugin at $ref (herdr clones and builds it: about a minute)"
    # herdr previews the whole manifest first; on success its last word is enough, on failure all of it
    log=$(mktemp)
    if herdr plugin install "$REPO" --ref "$ref" --yes </dev/null >"$log" 2>&1; then
      grep '^Installed ' "$log" || true
      rm -f "$log"
      new_install=1
    else
      cat "$log" >&2
      rm -f "$log"
      fail "herdr could not install the plugin; its output is above"
    fi
  fi

  root=$(herdr plugin list --json | bun -e 'const d = JSON.parse(await Bun.stdin.text()); console.log(d.result.plugins.find((p) => p.plugin_id === "'"$PLUGIN"'")?.plugin_root ?? "")')
  [ -n "$root" ] || fail "herdr does not list the plugin after installing it; see: herdr plugin list"
  verify_fork "$root"

  if herdr status server --json 2>/dev/null | grep -q '"running":true'; then
    # the action only queues the start (its output goes to herdr's plugin log), so wait for it here
    herdr plugin action invoke "$PLUGIN.start" >/dev/null </dev/null
    tries=0
    until bun "$root/scripts/plugin.ts" status </dev/null | grep -q '^running'; do
      tries=$((tries + 1))
      [ "$tries" -lt 25 ] || {
        say "did not start within 25 s; see: herdr plugin log list"
        # the start ran inside herdr, so what it said is in herdr's plugin log, not on this terminal
        # shellcheck disable=SC2016 # JavaScript, not shell
        herdr plugin log list 2>/dev/null </dev/null | bun -e 'const logs = JSON.parse(await Bun.stdin.text()).result.logs.filter((log) => log.plugin_id === process.argv[1] && log.stderr); if (logs.length > 0) console.error(logs.at(-1).stderr.trim())' "$PLUGIN" || true
        fail "the web plugin did not start. Resolve any fork migration or startup error before retrying (INSTALL.md#fork-migration)."
      }
      sleep 1
    done
  else
    say "herdr is not running, so neither is the app yet: it starts with herdr. Run: herdr"
  fi

  echo
  origin=$(bun "$root/scripts/plugin.ts" status </dev/null | awk '$1 == "running" { print $2 }')
  [ -z "$origin" ] || say "on this PC: $(link "$origin")"
  say "for another device, configure an HTTPS reverse proxy or SSH tunnel, then use Phone setup to pair"

  open_app

}

# the whole script is read before anything runs: under `curl | sh`, a command that reads stdin
# must not swallow the rest of it
main "$@"
