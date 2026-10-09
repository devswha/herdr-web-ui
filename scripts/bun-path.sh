#!/bin/sh
# Augment PATH with common bun and node installation locations.
# Sourced by preflight.sh and with-bun.sh; respects WITH_BUN_EXTRA_DIRS.
dirs="${WITH_BUN_EXTRA_DIRS:-${BUN_INSTALL:+$BUN_INSTALL/bin} $HOME/.bun/bin $HOME/.local/share/mise/shims $HOME/.local/bin /opt/homebrew/bin /usr/local/bin}"
for dir in $dirs; do
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) [ -d "$dir" ] && PATH="$PATH:$dir" ;;
  esac
done
export PATH
