# クラウドPC（リモート実行ランナー）

「頭脳」はこの Worker が24時間動き続け、「手足」としてクラウド上のマシンが重い処理を実行します。受け渡しは `runner_jobs` テーブルに永続化されるので、マシンが落ちても、15分のCron間隔が空いても、仕事は失われません。

## セットアップ

1. **デプロイ先（または `.dev.vars`）に2つの値を入れる**
   ```
   RUNNER_ENABLED=true
   RUNNER_TOKEN=<推測困難な文字列>          # wrangler secret put RUNNER_TOKEN でも可
   ```
2. **クラウドPC側でランナーを起動**
   ```bash
   RUNNER_URL=https://<あなたのURL> RUNNER_TOKEN=<同じ値> bash runner/cloud-pc.sh
   ```
   アプリの「クラウドPC」画面からコピーできます。tmux があればセッション内で常駐します。
3. **アプリの「クラウドPC」画面**で接続確認（`node -v` を1件投入）→ 出力が返れば疎通完了。

## 無料で使えるクラウドPC（2026-10時点）

| サービス | 無料枠 | 注意点 |
|---|---|---|
| Google Cloud Shell | 週50時間・5GB永続ホーム | セッションは最大12時間で切断。切断されてもジョブはキューに残ります |
| GitHub Codespaces | 個人Freeで月120 core時間・15GB保存 | 既定30分アイドルで停止（設定で延長可） |
| Cloudflare Containers | — | Workers Paid（$5/月）が必要。常時稼働させたいときの本命 |
| Modal | Starterで月$30分の無料クレジット | GPU込みの重い処理向き |
| 自前のVPS / 自宅PC | — | `cloud-pc.sh` を systemd か tmux で常駐 |

## Cloudflare Containers で動かす（月$5・推奨）

同じジョブ定義（`runner/jobs.mjs`）が、コンテナの中では `runner/jobs-server.mjs` として常駐します。違いは「誰が起こすか」だけ — クラウドPCはWorkerのキューを取りに行き、コンテナはWorkerから直接叩かれます。

```bash
npm install @cloudflare/containers
npx wrangler secret put RUNNER_TOKEN -c wrangler.containers.toml
npx wrangler deploy -c wrangler.containers.toml
```

手元で中身を確かめる（Docker が無くても、ffmpeg と espeak-ng があれば同じコードが動きます）：

```bash
RUNNER_TOKEN=test PORT=8123 node runner/jobs-server.mjs
curl -s localhost:8123/health
curl -s -X POST localhost:8123/job -H 'x-runner-token: test' -H 'content-type: application/json' -d '{"kind":"probe"}'
```

実機テスト（ffmpeg と espeak-ng を使います）：

```bash
node tests/jobs.test.mjs
```

---
## 安全設計（2つの鍵）

- **既定で無効**。`RUNNER_ENABLED=true` と `RUNNER_TOKEN` が揃うまで、ジョブは受け付けません。
- **ランナー用トークンは `/api/runner/*` にしか通りません**（オーナーAPIの他の経路は開きません）。
- **許可リスト** — 先頭コマンドが `RUNNER_ALLOW`（既定: `node,npm,npx,python3,pip3,ls,cat,echo,pwd,git,date,df,uname,head,tail,wc,find,grep,curl`）に一致しないと、投入時点で拒否。ランナー側でも実行直前に再検査します。
- **資源の上限** — 1ジョブのタイムアウト（既定60秒、最大15分）と出力上限（既定20,000文字）。超過はプロセスグループごとSIGKILLします。
- **二重取得なし** — 取り出しは `UPDATE … WHERE state='queued'` の条件付き更新なので、2台が同時にポーリングしても同じ仕事を二度実行しません。

## git clone なしのワンライナー（公開URLから直接）

リポジトリをクローンしなくても、デプロイ済みアプリが配信するブートストラップだけで常駐できます。

```bash
RUNNER_URL=https://wealth-agent.wealthagent-app.workers.dev \
RUNNER_TOKEN=<あなたのRUNNER_TOKEN> \
bash -c "$(curl -fsSL https://wealth-agent.wealthagent-app.workers.dev/cloud-pc.sh)"
```

Google Cloud Shell（週50時間・無料）で実行すると、tmux 上で常駐し、ブラウザータブを閉じても動き続けます。
