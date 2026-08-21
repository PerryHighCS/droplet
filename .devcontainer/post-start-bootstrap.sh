#!/bin/bash
set -euo pipefail

workspace_folder="${1:-.}"

# --privileged: opt-in flag passed only by the privileged devcontainer variant.
# Enables broad (ALL) sudo expansion needed by nested sandbox tooling.
privileged_mode=0
for _arg in "${@:2}"; do
  [[ "$_arg" == "--privileged" ]] && privileged_mode=1
done

echo "🔁 Running Droplet post-start bootstrap..."

if [[ "$privileged_mode" -eq 1 ]]; then
  echo "ℹ️ Privileged container overlay is active."
fi

# Some WSL/devcontainer mounts keep repo files owned by a different UID.
# Align .git ownership with the active user to avoid config.lock chmod failures.
git_dir="$workspace_folder/.git"
if [ -d "$git_dir" ]; then
  current_uid="$(id -u)"
  current_gid="$(id -g)"
  git_uid="$(stat -c '%u' "$git_dir" 2>/dev/null || echo "$current_uid")"
  git_gid="$(stat -c '%g' "$git_dir" 2>/dev/null || echo "$current_gid")"

  if [ "$git_uid" != "$current_uid" ] || [ "$git_gid" != "$current_gid" ]; then
    echo "ℹ️ Adjusting .git ownership for current user..."
    if command -v sudo >/dev/null 2>&1; then
      sudo chown -R "$current_uid:$current_gid" "$git_dir" || \
        echo "⚠️ Could not update .git ownership automatically."
    else
      echo "⚠️ sudo unavailable; skipping .git ownership alignment."
    fi
  fi
fi
