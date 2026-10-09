#!/bin/sh
# herdr runs plugin commands with the environment herdr itself started with, which can be a
# GUI app's bare PATH (/usr/bin:/bin:…) without ~/.bun/bin or a version manager's shims.
# Find bun (and node, for the terminal sidecar) in the usual places, then hand over to it.
. "$(dirname "$0")/bun-path.sh"
if ! command -v bun >/dev/null 2>&1; then
  echo "herdr web ui: bun not found (looked in PATH and $dirs); install it: curl -fsSL https://bun.sh/install | bash" >&2
  exit 127
fi
exec bun "$@"
