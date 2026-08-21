#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${DROPLET_CODEORG_REMOTE:-}" ]]; then
  remote_name="$DROPLET_CODEORG_REMOTE"
  validate_remote=false
else
  remote_name="codeorg"
  validate_remote=true
fi

remote_url="https://github.com/droplet-editor/droplet.git"
upstream_branch="code-dot-org"

if ! existing_url="$(git remote get-url "$remote_name" 2>/dev/null)"; then
  git remote add "$remote_name" "$remote_url"
elif [[ "$validate_remote" == true && "$existing_url" != "$remote_url" ]]; then
  printf 'Expected remote %q to use %s, but it uses %s.\n' \
    "$remote_name" "$remote_url" "$existing_url" >&2
  printf 'Set DROPLET_CODEORG_REMOTE to intentionally use a different remote.\n' >&2
  exit 1
fi

git fetch "$remote_name" "$upstream_branch"
git log --oneline "main..${remote_name}/${upstream_branch}"
