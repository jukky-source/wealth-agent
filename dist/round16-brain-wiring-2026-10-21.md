# 第16ラウンド実測レポート — ブレイン接続の完成＋自律販路実験の開始

## 出荷物（v1.0.4）
1. **決済帰属の完成**: 非同期コールバック経路（receiptFromCallback）も venue/resource を伴う場合 `x402:<venue>:<resource>` を記録。同期経路は既に接続済み（index.js:1385）— 全決済が販路別・商品別に分解可能に。
2. **IndexNow 発見面の拡張**: /agents.json・/x402-index・/grow・/api/skills/catalog.json を毎日の ping に追加（robots.txt 推奨読み順と同じ組）。
3. **自律販路実験 #1** — 仮説: GitHub の topics/description/homepage 設定でトピック検索・GitHub 検索面からの発見が増える / 実行: PATCH /repos/jukky-source/wealth-agent / 判定: **failed: <HTTPError 403: 'Forbidden'>** / 次の実験: GitHub Insights の traffic(views/clones) で次回判定
4. ゲート: テスト 60/0 → 配備 → ライブ確認済み。

## ブレインの実働証拠（内蔵改善ループ・ライブ取得）
- improve: {"ok": true, "version": "improve-1.0", "rounds": 259, "by_verdict": {"no_change": 193, "improved": 28, "acted": 36, "new_entrants": 1, "error": 1}, "by_wall": {"dd": 37, "distributed": 1, "steady": 119, "expiring": 17, "backlog": 1, "no_buyers": 19, "reached": 3, "paid": 33, "weak_sources": 20, "skewed": 9}, "lanes": [{"key": "fx", "label": "FXの論理（自己資金 / E8）", "what": "Yahoo 日足で候補を作り、門（15/6/40/45）
- grow: {"ok": true, "version": "grow-1.0", "read": {"status": "/api/grow", "public": "/api/grow/public", "page": "/grow"}, "north_star": "外部の人が実際に払ったUSDC（basis<>self_test）", "now": {"external_usd": 0.002, "external_events": 2, "hits": 15553, "challenges_402": 15527, "callers_external": 901, "listed_channel

## KPI
- challenge_402 3445 / unique 156 / paid 1 / by_venue [{"venue": "direct", "hits": 2026}]

## 次の実験候補（台帳）
- GitHub traffic で topics 流入を判定（日次）
- by_venue/by_resource の初回データ待ち（次の決済から自動で入る）
- x402scan 等の発見クローラ受信確認（discwatch 日次）
