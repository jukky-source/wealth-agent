# 無料AIプロバイダ設定ガイド

このエージェントは **1社もキーが無くても決定的エンジンで全機能が動きます**。
キーを足すほど推論品質が上がり、**複数社を設定すると各社の独立した無料枠が合算**されます。

| プロバイダ | 環境変数 | 無料枠（2026年10月時点の公式情報） | 取得先 |
|---|---|---|---|
| Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`（デプロイ時はバインディングで**キー不要**） | 10,000 Neurons/日 | https://developers.cloudflare.com/workers-ai/ |
| Google AI Studio (Gemini) | `GEMINI_API_KEY` | 無料枠あり（モデル・プロジェクト単位、RPDは太平洋時間0時リセット） | https://aistudio.google.com/apikey |
| Groq | `GROQ_API_KEY` | 無料枠あり（モデル別） | https://console.groq.com/keys |
| Cerebras | `CEREBRAS_API_KEY` | Free Trial: `gpt-oss-120b` 5 RPM / 30K uncached TPM / 100万 TPD | https://cloud.cerebras.ai/ |
| Mistral | `MISTRAL_API_KEY` | Experiment（無料）枠 約1リクエスト/秒 | https://console.mistral.ai/api-keys |
| OpenRouter | `OPENROUTER_API_KEY` | `:free` モデルあり | https://openrouter.ai/keys |

> 無料枠は各社が予告なく変更します。数値は必ず各社の最新ドキュメントで確認してください。
> 複数アカウントを作って上限を回避する行為は各社の利用規約に反するため、行わないでください。
> （同一プロバイダで複数キーを使う `_2`〜`_5` は、正当に保有する複数キー用の機能です。）

## 手順（ローカル）

```bash
node scripts/set-keys.mjs      # 対話形式で貼り付け → .dev.vars に保存（権限600）
node server/local.mjs --port 8787 --autorun
```

## 手順（本番 / Cloudflare Workers）

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GROQ_API_KEY
# Workers AI はバインディングで使うためキー不要（wrangler.toml の [ai] binding）
```

### 注意: GitHub Models は 2026-07-30 に提供終了（廃止）のため、このエージェントでは扱いません。
