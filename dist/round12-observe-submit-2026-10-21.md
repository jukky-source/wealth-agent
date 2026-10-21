# 第12ラウンド実測レポート — 全販路観測＋機械提出の検証（2026-10-21 JST）

## CDP Bazaar（Coinbase 公式）
検索語 "wealth" 12件中**自店2件**: /api/x402/brief が8位・/api/x402/url-meta が12位（他の wealth ヒットは別業者 wealthpulse の11棚）。
前回の「CDP total: 0」は検証側パーサのバグ（実キーは resources 配列）で、**掲載は維持**。

## 承認キュー — 解決済み（前回実測の訂正）
前回「未決1件」は古い参照だった。2件とも **2026-10-15 に決着済み**:
- apr_x402_mv8xpzz0 → **approved**（10-15 12:32 UTC）
- apr_x402_mv8wxud4 → **rejected**（備考: テスト網の試行分のため終了・本番の受注は納品済み）
現在 pending **0**。ユーザーの判断待ちはなし。

## KPI（実測）
値札閲覧 **2,741**（前回比 +208）・ユニーク **140**（+5）・外部決済 **1**・free_samples 0。
**by_venue はまだ空** — llms.txt の venue つき URL は未だ踏まれていない。LLM エージェントがクエリを剥がす可能性もあり、catalog.json への venue 拡張は次ラウンド候補。

## hunt 自動提出ループ
68ラウンド・発見31・trials: blocked 37 / fail 16 / listed 1 / ok 1。直近 verdict は pending（索引10照会・新規0・人の1タップ待ち1）。cron 駆動で正常。

## discwatch 手動再実行（?run=1・構造訂正版）
{"version": "discwatch-1.0", "day": "2026-10-21", "at": "2026-10-21T02:07:04.764Z", "products": 26, "validate": {"accepted": 26, "indexed": 9, "invalid": [{"resource": "crypto-hash", "method": "POST", "valid": false, "outcome": "accepted", "indexed": false, "last_crawled": null}, {"resource": "time-convert", "method": "POST", "valid": false, "outcome": "accepted", "indexed": false, "last_crawled": null}], "checked": [{"resource": "crypto-price", "method": "POST", "valid": true, "outcome": "accepted", "indexed": false, "last_crawled": null}, {"resource": "fx-rates", "method": "POST", "valid": t

## agent402.tools — 掲載経路の特定（本ラウンドの主成果）
- 公開検索 API /api/find?q=workers.dev で自店ホストは**未掲載**（ヒット5件は他業者）。
- openapi.json 全 **627 paths** を機械解析 → 提出系っぽい POST（add-time, address-label, seller-dossier, seller-payability など）は**自社製品の API であって「工具を提出する口」ではない**。
- 実際に /api/seller-payability へ機械提出を試行 → **HTTP 402 Payment Required**。同社の seller 調査 API 自体が x402 有料（ドッグフーディング）。
- **結論**: 無料の機械提出口は存在しない。掲載は「We source from other sellers」の通り **CDP など他セラー索引からのクロール待ち**（30分再プローブ制）。原価0制約により有料調査 API は使わない（blocked_cost 扱い）。

## agentic.market
JS レンダリング付きでも提出経路の記載なし — 引き続き相手側クローラ待ち。

## 判定と次の機械アクション
- 機械面は全て稼働中: hunt（cron）・discwatch（日次＋手動）・IndexNow（日次）・venue 計測・CDP 2棚掲載維持。
- 伸びしろは人の1タップ（MCP publish・npm/PyPI/Glama トークン・x402 List $1）に集中 — 不変。
- 次ラウンド: by_venue 蓄積観測・agent402 の find API 再照会（クロール待ちの確認）・catalog.json への venue タグ拡張を評価。
