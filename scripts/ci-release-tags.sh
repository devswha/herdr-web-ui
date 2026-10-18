#!/usr/bin/env bash
# Fetch only this fork's app and runtime release tags for CI release validation.
set -euo pipefail

# An empty wildcard fetch exits 1 before the first fork release. Query without --exit-code:
# no matching tags is success, while authentication and transport failures still stop the job.
tags=$(git ls-remote --tags --refs origin 'refs/tags/fork-v*' 'refs/tags/fork-remote-v*')
if [[ -z "$tags" ]]; then
  echo 'No fork release tags are published yet; validating the source against its base.'
  exit 0
fi

git fetch --no-tags --depth=1 origin '+refs/tags/fork-v*:refs/tags/fork-v*' '+refs/tags/fork-remote-v*:refs/tags/fork-remote-v*'
