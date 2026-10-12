#!/usr/bin/env bash
# One-liner bootstrap for a free cloud PC (GitHub Codespaces / Google Cloud Shell / any VM).
#   RUNNER_URL=https://<your-worker>.workers.dev RUNNER_TOKEN=<secret> bash runner/cloud-pc.sh
# Keeps the runner alive after the terminal tab closes (tmux), so the machine
# can be left working. Re-run it after a cloud restart — the queue is durable.
set -euo pipefail
: "${RUNNER_URL:?RUNNER_URL を設定してください（例: https://xxx.workers.dev）}"
: "${RUNNER_TOKEN:?RUNNER_TOKEN を設定してください（Worker と同じ値）}"
RUNNER_WORKDIR="${RUNNER_WORKDIR:-$HOME/agent-workspace}"
mkdir -p "$RUNNER_WORKDIR"
LOG="$RUNNER_WORKDIR/runner.log"
if command -v tmux >/dev/null 2>&1; then
  tmux kill-session -t agent-runner 2>/dev/null || true
  tmux new-session -d -s agent-runner "cd '$(pwd)' && RUNNER_URL='$RUNNER_URL' RUNNER_TOKEN='$RUNNER_TOKEN' RUNNER_WORKDIR='$RUNNER_WORKDIR' node runner/agent-runner.mjs 2>&1 | tee -a '$LOG'"
  echo "起動しました（tmux セッション: agent-runner）。ログ: $LOG"
  echo "状態確認: tmux attach -t agent-runner"
else
  echo "tmux が無いのでフォアグラウンドで起動します（Ctrl+C で停止）"
  RUNNER_URL="$RUNNER_URL" RUNNER_TOKEN="$RUNNER_TOKEN" RUNNER_WORKDIR="$RUNNER_WORKDIR" node runner/agent-runner.mjs
fi
