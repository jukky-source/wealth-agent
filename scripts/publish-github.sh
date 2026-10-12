#!/usr/bin/env bash
# Publish this project to GitHub in one command.
#   export GITHUB_TOKEN=ghp_...          # fine-grained token, Contents: read/write
#   scripts/publish-github.sh <owner/repo> [branch]
set -euo pipefail
REPO="${1:?usage: scripts/publish-github.sh <owner/repo> [branch]}"
BRANCH="${2:-main}"
: "${GITHUB_TOKEN:?export GITHUB_TOKEN=<token> first}"
URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"
if git remote get-url origin >/dev/null 2>&1; then git remote set-url origin "$URL"; else git remote add origin "$URL"; fi
git add -A
git diff --cached --quiet || git commit -m "feat: wealth agent — autonomous fleet, image settings, PWA"
git push -u origin "HEAD:${BRANCH}"
echo "pushed to https://github.com/${REPO} (branch ${BRANCH})"
