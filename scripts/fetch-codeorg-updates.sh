#!/usr/bin/env bash
set -euo pipefail

remote_name="${DROPLET_CODEORG_REMOTE:-codeorg}"
remote_url="https://github.com/droplet-editor/droplet.git"
upstream_branch="code-dot-org"

if ! git remote get-url "$remote_name" >/dev/null 2>&1; then
  git remote add "$remote_name" "$remote_url"
fi

git fetch "$remote_name" "$upstream_branch"
git log --oneline "main..${remote_name}/${upstream_branch}"
