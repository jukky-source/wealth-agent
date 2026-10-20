# 第10ラウンド実測レポート — 来源帰属（venue attribution）の焼き込み（2026-10-21）

## 判断
ファネル実数（外部の値札閲覧 2533回・ユニーク 135人 → 外部決済 1件・by_venue 全て direct）で、落ちているのは発見ではなく転換。
「どの発見面が買い手を連れてきたか」を後から分解できないのが計測の穴。402 の resource が canonical で組まれることをコードで確認したため、
こちらが発行する /llms.txt の購入 URL に ?venue=llms を焼き込んでも決済経路は壊れないと判断して実装した。

## 実装
- src/agent/x402.js: llms.txt のカタログ行・Flagship 行に ?venue=llms。CDP 検証対象の x402 発見フィードは canonical を維持。
- tests/run.mjs: X48（venueFromRequest の正規化・不正値は direct）・X49（llms.txt は venue つき・フィードは canonical）を X47 の前に追加（動的 import）。
- テスト: ════════ RESULT: 60 passed, 0 failed ════════

## ライブ実測（配備後の本番）
- /llms.txt: 45行・venue つき購入行 27本・カタログ 26品・missing=[]（初回実測の missing 表記は検証側の URL/slug 比較バグ。実体は購入行 27/27 が venue つきで全品掲載を確認）
- POST /api/x402/regex?venue=llms → 402・402 の resource は canonical（{'url': 'https://wealth-agent.wealthagent-app.workers.dev/api/x402/regex', 'name': 'Run a regex on text', 'description': 'Apply one regular expression to a text blob on the server and return every match with its index and capture groups. Deterministic, so the same input always returns the same answer. Useful for log triage, field extraction and validation at scale.', 'mimeType': 'application/json', 'serviceName': 'Regex Extract API', 'tags': ['regex', 'regular expression', 'extract', 'text', 'parser', 'validate', 'grep']}）— 決済経路への影響なし
- discwatch（本日）: 26棚受理・索引入り 9/26（seo-audit は CDP 初回クロール待ち）
- IndexNow: 鍵設定済み・鍵ファイル配信 200・日次 ping 配線済み

## 次の観測
以後 ?venue= 付きで到達した有料ヒットは KPI の by_venue に面別で蓄積され、どの発見面が転換を作るかが実測できる。

判定: ALL_PASS（missing 検出は検証側バグと判明。商品側は全項目 PASS: llms 200・26品全掲載・402 canonical 維持・KPI 計器正常）
