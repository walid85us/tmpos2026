#!/usr/bin/env bash
#
# github-safe-backup.sh
#
# Safe, fast-forward-only GitHub backup helper for accepted checkpoints.
# Pushes local `main` to `origin/main` ONLY when it is a clean fast-forward.
# It NEVER force pushes and NEVER pushes when the branches have diverged.
#
# Usage:  npm run backup:github   (or: bash scripts/github-safe-backup.sh)

set -euo pipefail

echo "==> GitHub safe backup starting"

# 1. Confirm current branch is main
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
  echo "ERROR: current branch is '$branch', not 'main'. Aborting." >&2
  exit 1
fi
echo "    branch OK: main"

# 2. Working tree must be clean
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree is not clean. Commit or stash changes first. Aborting." >&2
  git status --short >&2
  exit 1
fi
echo "    working tree clean"

# 3. Refresh remote state
echo "==> Fetching origin"
git fetch origin

# 4. Measure ahead/behind:  origin/main...main  ->  "<behind><TAB><ahead>"
counts="$(git rev-list --left-right --count origin/main...main)"
behind="$(printf '%s' "$counts" | awk '{print $1}')"   # commits only on origin/main
ahead="$(printf '%s'  "$counts" | awk '{print $2}')"   # commits only on local main
echo "    origin-only commits: $behind | local-only commits: $ahead"

# 5. Diverged? Remote has commits not in local main -> refuse.
if [ "$behind" -gt 0 ]; then
  echo "WARNING: Remote has commits not in local main. Do not force push." >&2
  echo "Reconcile manually (e.g. 'git pull --rebase origin main') and re-run." >&2
  exit 1
fi

# 6. Nothing to push?
if [ "$ahead" -eq 0 ]; then
  echo "GitHub already up to date."
  exit 0
fi

# 7. Only ahead + zero remote-only commits -> safe fast-forward push.
echo "==> Pushing $ahead commit(s) to origin/main (fast-forward, non-force)"
git push origin main

# 8. Verify the push landed.
echo "==> Verifying"
git fetch origin
local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse origin/main)"
if [ "$local_head" = "$remote_head" ]; then
  echo "SUCCESS: origin/main is up to date at $local_head"
  exit 0
else
  echo "ERROR: post-push verification failed. local=$local_head origin/main=$remote_head" >&2
  exit 1
fi
