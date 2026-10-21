# 第12ラウンド実測レポート — 全販路観測＋機械提出（2026-10-21 JST）

## CDP Bazaar（Coinbase 公式）
検索語 "wealth" 12件中**自店2件**: /api/x402/brief が8位・/api/x402/url-meta が12位（他の wealth ヒットは別業者 wealthpulse）。
昨日の「8位」を正しく再確認（前回の total:0 は検証側パーサのバグ。実キーは resources 配列）。

## 承認キュー — 解決済み（訂正）
前回「未決1件」は**古い実測だった**: 2件とも 2026-10-15 に決着済み。
- apr_x402_mv8xpzz0 → **approved**（decided 10-15 12:32 UTC）
- apr_x402_mv8wxud4 → **rejected**（備考: テスト網での試行分のため終了・本番の受注は納品済み）
現在 pending **0**。ユーザーの判断待ちはなし。

## KPI（実測）
値札閲覧 challenge_402 **2,741**（前回比 +208）・ユニーク **140**（+5）・外部決済 **1**・free_samples 0。
**by_venue はまだ空** — llms.txt の venue つき URL はまだ誰にも踏まれていない（LLM エージェントがクエリを剥がす可能性あり。要継続観測）。

## hunt 自動提出ループ
68ラウンド・発見31・trials: blocked 37 / fail 16 / listed 1 / ok 1。直近: 「10 の索引を照会・新規候補 0・見分けた 1・人の1タップ待ち 1」。cron 駆動で正常。

## discwatch 再実行（?run=1）
day 2026-10-21・products None・accepted None・indexed None・invalid 0。
（前回スナップショット accepted 4 / indexed 0 は 00:01 UTC 計測時の片寄りの疑い。再実行値を今後の基準にする。）

## agent402.tools — 掲載経路の特定
- 公開検索 API /api/find?q= で自店ホストの掲載: **False**（q=workers.dev で照会）。
- /docs は無料掲載を謳う（"free listing nothing deducted non-custodial"・30分ごとに再プローブ・他セラーからもソース）。
- openapi.json（627 paths）から提出系エンドポイントを抽出 → 候補 6 件。
- 機械提出の実行: ('err', 'HTTP Error 402: Payment Required')

## agentic.market
JS レンダリング付きでも提出経路の記載なし — 引き続き相手側クローラ待ち。

## 次の機械アクション
- by_venue への蓄積観測（venue タグは llms のみ焼き込み済み。catalog.json への拡張は次ラウンド候補）。
- agent402 は 30分再プローブ制 — 提出済みなら受理を find API で追う。
- 人の1タップ（MCP publish・配布トークン・x402 List $1）は不変。
