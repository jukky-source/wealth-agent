#!/usr/bin/env bash
# One-command permanent deploy: Cloudflare Workers + D1 (+ Cron), free tier.
#   bash scripts/deploy-cloudflare.sh
# Requires: Node 22+, a free Cloudflare account (a browser login opens once).
set -euo pipefail
cd "$(dirname "$0")/.."
DB_NAME="${DB_NAME:-wealth-agent}"
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  : "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_API_TOKEN を使う場合は CLOUDFLARE_ACCOUNT_ID も設定してください}"
  echo "==> 1/6 APIトークンで実行します（ブラウザーログイン不要）"
else
  echo "==> 1/6 Cloudflare にログイン（ブラウザーが開きます）"
  npx --yes wrangler@4 login
fi
echo "==> 2/6 D1 データベースを用意"
npx --yes wrangler@4 d1 create "$DB_NAME" || true
DB_ID=$(npx --yes wrangler@4 d1 list --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{let a;try{a=JSON.parse(s)}catch(e){return}const r=Array.isArray(a)?a:(a.result||a.databases||[]);const m=r.find(x=>x.name===process.env.DB_NAME);console.log(m?(m.uuid||m.id||''):'')})" || true)
if [ -z "$DB_ID" ] && [ -n "${D1_DATABASE_ID:-}" ]; then DB_ID="$D1_DATABASE_ID"; fi
if [ -z "$DB_ID" ]; then echo "D1 のIDを取得できませんでした。Cloudflare ダッシュボードの D1 画面で確認し、wrangler.toml の database_id を書き換えてください。"; exit 1; fi
echo "    database_id = $DB_ID"
sed -i.bak "s/REPLACE_WITH_YOUR_D1_DATABASE_ID/$DB_ID/" wrangler.toml && rm -f wrangler.toml.bak
echo "==> 3/6 スキーマ適用（既存DBには不足列だけ追加されます）"
npx --yes wrangler@4 d1 execute "$DB_NAME" --file=./schema.sql --remote
echo "==> 4/6 シークレット登録（空欄はスキップされます）"
[ -n "${OWNER_TOKEN:-}" ]     && printf '%s' "$OWNER_TOKEN"     | npx --yes wrangler@4 secret put OWNER_TOKEN
[ -n "${GEMINI_API_KEY:-}" ]  && printf '%s' "$GEMINI_API_KEY"  | npx --yes wrangler@4 secret put GEMINI_API_KEY
[ -n "${GROQ_API_KEY:-}" ]    && printf '%s' "$GROQ_API_KEY"    | npx --yes wrangler@4 secret put GROQ_API_KEY
[ -n "${RUNNER_TOKEN:-}" ]    && printf '%s' "$RUNNER_TOKEN"    | npx --yes wrangler@4 secret put RUNNER_TOKEN
echo "==> 5/6 デプロイ"
npx --yes wrangler@4 deploy
echo "==> 6/6 完了。表示された https://...workers.dev のURLを iPhone の Safari で開き、"
echo "    「共有 → ホーム画面に追加」で常設のまま使えます。"
echo "    クラウドPCを使う場合は、[vars] に RUNNER_ENABLED = \"true\" を入れ、RUNNER_TOKEN を secret 登録して再デプロイしてください。"
echo "    （トークン運用例: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... OWNER_TOKEN=... bash scripts/deploy-cloudflare.sh）"
