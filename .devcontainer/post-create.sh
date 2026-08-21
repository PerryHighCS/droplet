#!/bin/bash
set -euo pipefail

workspace_folder="${1:-.}"

echo "🛠️ Running Droplet post-create setup..."

if ! git config --global --get-all safe.directory 2>/dev/null | grep -Fxq "$workspace_folder"; then
  git config --global --add safe.directory "$workspace_folder"
fi

cd "$workspace_folder" || exit 1

# The legacy QUnit dependency downloads a Chromium build unavailable on ARM64.
# Playwright supplies the supported browser used by the repository's browser
# harness, so keep Puppeteer's install hook disabled for the legacy tree.
PUPPETEER_SKIP_DOWNLOAD=true npm ci

if [ -f playwright/package.json ]; then
  npm --prefix playwright ci
  npm --prefix playwright exec -- playwright install --with-deps chromium
fi
