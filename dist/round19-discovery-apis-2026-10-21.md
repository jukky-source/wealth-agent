# 第19ラウンド実測レポート — 発見 API の正体確定と出品経路の切り分け

## 実測（すべて本日 23時台の生プローブ）
1. **Circle Discovery API 確定**: `GET https://api.circle.com/v2/x402/discovery/resources` — キーレス・認証なし。カタログ面は agents.circle.com/services。自店の索引: **0 件**（not_listed）。 Circle は CDP と別系統の発見面 — 今後 discwatch の観測対象に追加する。
2. **PayAPI Market**: 公開 API は読み取り専用（GET /agent/list・/agent/search・/agent/get — OpenAPI 3.1 を確認）。出品はサイトのフォーム = **manual_form（人タップ1件・掲載無料・売上100%）**。台帳を auto=false に訂正。
3. **Onyx Bazaar**: 再クロール確認 → 当ホスト 0件のまま（CDP 由来の自動索引待ち）。

## 台帳の更新（v1.0.8）
- circle_discovery: unknown → **not_listed**（実測つき）
- payapi_market: not_listed(auto) → **manual_form**（実測つき・前ラウンドの「出品 API あり」判定を訂正）
- 訂正もトライ&エラーの一部として台帳に残す。

## KPI
- challenge_402 3860 / unique 161 / paid 1 / by_venue [{"venue": "direct", "hits": 2441}]

## 次の実験（台帳）
1. discwatch に Circle Discovery の観測を追加（CDP と並ぶ第二発見面の日次記録）。
2. by_venue の初回データ継続観測。
3. ERC-8004 identity（AgentZone 参照）のガス代コスト確認 → 予算内なら登録実験。

## 残る人タップ（更新）
- MCP publish / 配布トークン / x402 List $1 / GitHub PR（awesome-list・gold-402）/ repo権限付き PAT / **PayAPI Market の出品フォーム（1件・掲載無料）**。
