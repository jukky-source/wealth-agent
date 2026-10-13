# Wealth Agent — 常設デプロイ手順

## 稼働中のURL（デプロイ済み）

| 項目 | 値 |
|---|---|
| アプリURL | https://wealth-agent.wealthagent-app.workers.dev |
| ホスティング | Cloudflare Workers（無料枠） |
| DB | Cloudflare D1 `wealth-agent`（無料枠） |
| スケジューラ | Cron `*/5 * * * *`（稼働中） |
| 認証 | `OWNER_TOKEN` を設定済み。iPhone で初回に1回入力 |

iPhone の Safari でアプリURLを開き、「共有 → ホーム画面に追加」で常設アイコンになります。
`OWNER_TOKEN` の値はこのリポジトリには保存していません（デプロイ実行者が保管してください）。

# デプロイ手順（無料枠のみ / 0円運用）

## まず「常設」させる方法は3つ（おすすめ順）

### A. GitHub Actions → Cloudflare（ブラウザーだけで完結・推奨）
ローカルに何も入れずに、パーマネントURLまで到達します。

1. このプロジェクトをGitHubリポジトリへpush（`scripts/publish-github.sh` が使えます）
2. GitHubの **Settings → Secrets and variables → Actions** に登録
   - `CLOUDFLARE_API_TOKEN`（Workers Scripts:Edit / D1:Edit）
   - `CLOUDFLARE_ACCOUNT_ID`
   - `OWNER_TOKEN`（アプリの認証トークン。推奨）
   - 任意: `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` / `RUNNER_TOKEN`
3. `main` にpush（またはActionsから手動実行）→ テスト→D1作成→スキーマ適用→シークレット反映→デプロイ が自動で走ります
4. ログに出る `https://wealth-agent.<サブドメイン>.workers.dev` を iPhone の Safari で開き、**共有 → ホーム画面に追加**

以後は `main` にpushするだけで更新が反映されます（PWAはnetwork-firstなので次回起動で最新になります）。

### B. ローカルから1コマンド
```bash
bash scripts/deploy-cloudflare.sh
```
Cloudflareへのログイン（ブラウザー1回）以外は自動です。
CIや自動化からは、トークンを環境変数で渡せばログイン不要で完走します。

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... OWNER_TOKEN=... \
RUNNER_TOKEN=... bash scripts/deploy-cloudflare.sh
```

トークンには **Workers Scripts:Edit** と **D1:Edit**（および初回のみ **Account Settings:Read**）を付けてください。
渡したトークンはデプロイ後に失効・再発行するのが安全です。

### D. 実行環境（手足）を Cloudflare Containers で立てる（月$5）

リサーチ・原稿・サムネイル・概要欄までは無料枠のまま動きます。**音声(TTS)と動画の合成(ffmpeg)だけはWorkersの上で動かない**ので、そこだけ実行環境に出します。これが唯一の月額です。

1. Cloudflare の Workers Paid（$5/月）を有効にする
2. ローカルに Docker を入れる（`wrangler deploy` がイメージのビルドに使います。GitHub Actions のランナーには最初から入っています）
3. 依存とクライアントを入れる
   ```bash
   npm install @cloudflare/containers
   npx wrangler secret put RUNNER_TOKEN -c wrangler.containers.toml
   ```
4. 配備する
   ```bash
   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler deploy -c wrangler.containers.toml
   ```
   または GitHub の **Actions → deploy-cloudflare-containers → Run workflow**（手動実行だけにしています。pushでは走りません）。
5. 状態を確認する：アプリで「実行環境」と聞くか、`GET /api/runner/status`。`mode` が `container` になれば繋がっています。

無料枠の配備（`wrangler.toml` / `scripts/deploy-cloudflare.sh`）は**この設定ファイルを使わないので、そのまま動きます**。入口も別（`src/container-entry.js`）にしてあるので、Containers を入れるまで無料側は一切変わりません。

**いまの状態：コードは用意済み・未配備。** Cloudflare のトークンが無効（`Invalid API Token`）で配備できていません。トークンを1本入れるか、GitHub Secrets に `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` を登録して上のワークフローを回せば、この経路が開きます。

**費用の目安**（Cloudflare の公表値・概算）：$5/月に含まれるのは、メモリ 25 GiB時間・vCPU 375分・ディスク 200 GB時間。`basic`（1/4 vCPU / 1 GiB）で5分の1080p動画を1本作ると、おおよそメモリ 600 GiB秒・vCPU 150秒 → **月100本以上が枠内**。課金は「動いている間だけ」で、5分のアイドルで自動的に眠ります。

---

### E. リポジトリを Organization に移した場合（任意）

GitHub を個人の Google アカウントで登録していても、**そのままで問題ありません**。このリポジトリはコード置き場で、YouTube の身元や AdSense の入金とは繋がっていないためです（Google ログインは入口の手段にすぎず、Google が GitHub アカウントを所有するわけではありません）。

見た目を事業側に寄せたい場合だけ、無料の Organization を作ってリポジトリを移せます（Organization は無料で、プライベートリポジトリも無制限）。移行しても Issues・PR・Secrets・deploy keys は維持され、Git の履歴と既存リンクは自動で転送されます。移行後はローカルの向き先を変えるだけです。

```bash
git remote set-url origin git@github.com:<ORG>/wealth-agent.git
```

**2つ目の無料アカウントを作るのは規約違反**です（「1人または1法人が維持できる無料アカウントは1つまで」）。分けたい場合は Organization を使います。

以降の手順に出てくる `jukky-source` は、自分のオーナー名に読み替えてください。

---

### C. Genspark Code（Developer）のホスティング
Gensparkアカウントの **Developer v2** が有効なら、`gsk hosted deploy` でGenspark側のパーマネントURLへ出せます。
現在このアカウントでは `developer_not_enabled` で拒否されます。有効化するには [Genspark Code](https://www.genspark.ai/code/) でプロジェクトを作成してください（有効化できれば、こちらの手順も自動化して実行します）。

---

所要時間：約20分。すべて無料枠で完結します。

---

## 0. 前提

- Node.js 22 以上
- Cloudflare アカウント（無料）
- GitHub アカウント（無料）
- APIキーは**任意**（無くても全機能が決定的モードで動作します）

---

## 1. リポジトリの準備

```bash
cd wealth-agent
git init
git add .
git commit -m "feat: autonomous wealth agent"
git branch -M main
git remote add origin https://github.com/<あなた>/wealth-agent.git
git push -u origin main
```

`.gitignore` が `.dev.vars` / `.wrangler/` / `.local-data/` を除外していることを確認してください。
**APIキーをコミットしないでください。**

---

## 2. D1 データベースの作成

```bash
npx wrangler login
npx wrangler d1 create wealth-agent
```

出力された `database_id` を `wrangler.toml` の `REPLACE_WITH_YOUR_D1_DATABASE_ID` と置き換えます。

```bash
npx wrangler d1 execute wealth-agent --file=./schema.sql --remote
```

---

## 3. シークレットの登録（サーバー側のみ）

```bash
# 必須: オーナー認証トークン（推測困難な文字列）
npx wrangler secret put OWNER_TOKEN

# 任意: AIプロバイダ（1つでも入れると推論品質が上がります）
npx wrangler secret put GEMINI_API_KEY      # https://aistudio.google.com/apikey
npx wrangler secret put GROQ_API_KEY        # https://console.groq.com/keys
npx wrangler secret put OPENROUTER_API_KEY  # https://openrouter.ai/keys

# 任意: 自前の SearXNG を使う場合
npx wrangler secret put SEARCH_ENDPOINT
```

> キーは Cloudflare のシークレットとして暗号化保存され、**Worker からもブラウザーからも値を読み出せません**。
> `/api/providers` と `/api/settings` は「設定済みかどうか」の真偽値だけを返します（受入テスト G で検証）。

---

## 4. Worker のデプロイ

```bash
npx wrangler deploy
```

表示された URL（例 `https://wealth-agent.<subdomain>.workers.dev`）がバックエンド＋PWAの配信元になります。
`wrangler.toml` の `[assets]` により `./public` が同一オリジンで配信されるため、CORS の設定は不要です。

```bash
curl https://wealth-agent.<subdomain>.workers.dev/api/health
```

---

## 5. 初期データと Cron の確認

```bash
curl -X POST https://wealth-agent.<subdomain>.workers.dev/api/admin/seed \
  -H "Authorization: Bearer <OWNER_TOKEN>"
```

`wrangler.toml` の Cron Trigger（既定 `*/5 * * * *`）が有効になっていれば、
**ブラウザーを閉じていても5分ごとに自律ループが進みます。**

```bash
npx wrangler tail   # 実行ログをライブ確認
```

無料プランの Cron は「アカウントあたり5本・1回15分・CPU 10ms」です。
1回の tick で行う作業は `ENGINE_STEPS_PER_TICK`（既定3）で制限しています。

---

## 6. iPhone のホーム画面に追加

1. Safari で `https://wealth-agent.<subdomain>.workers.dev` を開く
2. 共有ボタン → **「ホーム画面に追加」**
3. 追加されたアイコンから起動すると、**スタンドアロンアプリ**として全画面で動作します（PWA）

Android タブレット / PC も同じURLで利用できます。PC の Chrome では「インストール」ボタンから追加できます。

### 認証トークンの設定（初回のみ）

アプリの **設定 / API Providers** 画面で `OWNER_TOKEN` に登録した値を入力し「この端末に保存」を押してください。
以後、この端末からのリクエストは自動的に認証されます（端末の localStorage に保存。公開リポジトリには入りません）。

---

## 7. フロントエンドのみ GitHub Pages で配信する場合（任意）

Worker の `[assets]` を使わず、静的ファイルだけを GitHub Pages に置く構成も可能です。

```bash
# public/ を gh-pages にデプロイ
git subtree push --prefix public origin gh-pages
```

その場合、`public/app.js` の API 呼び出し先を Worker のフルURLに向ける必要があります（同一オリジンでなくなるため）。
最も簡単なのは冒頭の `api()` を次のように変更する方法です。

```js
const API_BASE = 'https://wealth-agent.<subdomain>.workers.dev';
// fetch(path) → fetch(API_BASE + path)
```

また、Worker 側で CORS は既に許可済み（`access-control-allow-origin: *`）です。

> **重要**: GitHub Pages はフロントエンドの配信場所であり、それ自体は AI を実行しません。
> 常時実行は Worker の Cron Trigger が担います。両者を組み合わせて初めて「閉じていても進む」構成になります。

---

## 8. 動作確認チェックリスト

```bash
# 健全性
curl -s <URL>/api/health | jq

# ミッションを1本入れて自律ループを回す
curl -s -X POST <URL>/api/missions -H "Authorization: Bearer <TOKEN>" \
  -H 'content-type: application/json' \
  -d '{"goal":"毎月3万円の追加収益を、日本から利用可能で規約に適合する方法で継続的に生み出す","target_value":30000}'

curl -s -X POST <URL>/api/engine/start -H "Authorization: Bearer <TOKEN>"
curl -s -X POST <URL>/api/engine/tick -H "Authorization: Bearer <TOKEN>" -d '{"steps":3}'
curl -s <URL>/api/dashboard -H "Authorization: Bearer <TOKEN>" | jq '.next_task, .ledger'
```

---

## 9. ローカルでの事前検証

```bash
npm run test:unit   # 純粋ロジック
npm test            # 受入テスト A〜L（実DB・実Workerコード）
npm run dev         # 手元でUIを確認（http://localhost:8787）
```

---

## 10. 運用のヒント

| 目的 | 方法 |
|---|---|
| 一時停止（進捗は保存） | アプリの「一時停止」ボタン、または `POST /api/engine/pause` |
| 再開 | `POST /api/engine/start`（チェックポイントから続行） |
| Cron の頻度を変える | `wrangler.toml` の `[triggers] crons` を編集して再デプロイ |
| AI使用量を制限 | `wrangler.toml` の `AI_DAILY_CALL_BUDGET`（既定300） |
| 有料APIを禁止のまま維持 | `ALLOW_PAID_AI = "false"`（既定。有効化しない限り課金系は実行されません） |
| 承認待ちの操作を確認 | アプリの「承認」タブ |
| 実測収益を記録 | 実行ログ画面 → 収支を記録（実測は証拠必須） |

---

## トラブルシューティング

| 症状 | 原因 / 対処 |
|---|---|
| `unauthorized` | `OWNER_TOKEN` を設定したのにアプリ側で未入力。設定画面で入力してください |
| `db_unavailable` | D1 の作成漏れ、または `database_id` の未設定 |
| タスクが進まない | エンジンが `paused` の可能性。ミッション画面で再開。または `POST /api/engine/tick` を手動実行 |
| `needs_human` になる | 再計画5回／戦略切替3回の上限に達した状態です。設計通りの安全弁で、方針の見直しが必要です |
| AIが常に「決定的モード」 | キー未設定。設定画面でプレゼンスを確認してください |
| Cron が動かない | Free プランの Cron Trigger 上限（5本）を超えていないか確認 |
