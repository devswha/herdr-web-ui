#!/usr/bin/env bash
# CI only: a stalled Ubuntu mirror made apt wait until the job's own timeout. With these, a
# connection or read that stalls for 30 s fails, and apt fetches the file again, up to 5 times.
set -euo pipefail
printf '%s\n' \
  'Acquire::Retries "5";' \
  'Acquire::http::Timeout "30";' \
  'Acquire::https::Timeout "30";' \
  | sudo tee /etc/apt/apt.conf.d/80-ci-fail-fast > /dev/null
