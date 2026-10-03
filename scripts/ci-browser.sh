#!/usr/bin/env bash
# The browser lane of CI: the lockfile's Playwright Chromium, then the scripts that drive it.
set -euo pipefail
bun node_modules/playwright-core/cli.js install --with-deps chromium
CHROME_PATH="$(bun -e 'console.log(require("playwright-core").chromium.executablePath())')"
export CHROME_PATH
bun scripts/ui-regression.ts
bun scripts/file-viewer-regression.ts
