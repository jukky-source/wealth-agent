#!/usr/bin/env bash
# クラウドPC常駐ランナーのブートストラップ（git clone 不要のワンライナー）。
#   RUNNER_URL=https://wealth-agent.wealthagent-app.workers.dev \
#   RUNNER_TOKEN=<secret> bash -c "$(curl -fsSL $RUNNER_URL/cloud-pc.sh)"
# tmux があれば常駐させ、端末を閉じても動き続けます。クラウド再起動後は再実行してください
# （キューはサーバー側に永続化されているので作業は失われません）。
set -euo pipefail
: "${RUNNER_URL:?RUNNER_URL を設定してください（例: https://xxx.workers.dev）}"
: "${RUNNER_TOKEN:?RUNNER_TOKEN を設定してください（Worker と同じ値）}"
RUNNER_WORKDIR="${RUNNER_WORKDIR:-$HOME/agent-workspace}"
mkdir -p "$RUNNER_WORKDIR"
echo "ランナー本体を取得中…"
curl -fsSL "$RUNNER_URL/agent-runner.mjs" -o "$RUNNER_WORKDIR/agent-runner.mjs"
LOG="$RUNNER_WORKDIR/runner.log"
cd "$RUNNER_WORKDIR"
if command -v tmux >/dev/null 2>&1; then
  tmux kill-session -t agent-runner 2>/dev/null || true
  tmux new-session -d -s agent-runner "cd '$RUNNER_WORKDIR' && RUNNER_URL='$RUNNER_URL' RUNNER_TOKEN='$RUNNER_TOKEN' RUNNER_WORKDIR='$RUNNER_WORKDIR' node agent-runner.mjs 2>&1 | tee -a '$LOG'"
  echo "起動しました（tmux セッション: agent-runner）  ログ: $LOG"
  echo "状態確認: tmux attach -t agent-runner"
else
  echo "tmux が無いのでフォアグラウンドで起動します（Ctrl+C で停止）"
  RUNNER_URL="$RUNNER_URL" RUNNER_TOKEN="$RUNNER_TOKEN" RUNNER_WORKDIR="$RUNNER_WORKDIR" node agent-runner.mjs
fi
