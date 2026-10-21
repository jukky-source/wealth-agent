# 第18ラウンド実測レポート — ネットの海を掘って販路を8件追加・情報源を増強

## 販路の拡大（venues 台帳 +8件・出典: Merit-Systems/awesome-agentic-commerce + 実測プローブ）
| 販路 | 状態 | 実測 |
|---|---|---|
| **PayAPI Market** | not_listed（出品 API あり） | サイトに `/api/marketplace`・`/api/listings` を確認。「掲載無料・売上100%還元」— {"count":100,"total":832,"limit":100,"offset":0,"next_cursor":"eyJvIjoxMDAsInYiOjF9","has_more":true,"results":[{"id":"7a9bd09f-8a7c-4311-8ade-bc492f58420c","name":"10x402","provider":"10x402","descri |
| **Onyx Bazaar** | not_listed | `/bazaar.json` に当ホスト 0 件 — CDP 由来の自動索引なので再クロール待ち |
| **x402station** | unknown | 検索 API は空応答（エンドポイント未確定） |
| **AgentZone** | unknown | ERC-8004 identity 要否確認が次手 |
| **Circle Discovery API** | unknown | 推定エンドポイント 404 — 正規 API を次回特定 |
| **gold-402** | blocked_human | 掲載は GitHub PR → 人タップ（awesome-list PR と同じ壁） |
| **Pyrimid** | unknown | MCP ネイティブ発見 — 掲載要否確認 |
| **stablecoin.com 402** | unknown | 提出フォーム要確認 |

## 情報源の増強
1. **scout に Cloudflare blog RSS を追加**（x402 Foundation を Cloudflare が発表した実績 — インフラ側の x402 ニュース線源。RSS 20件の稼働を実測済み）。
2. **r/AI_Agents は前ラウンドで reddit.js に追加済み** — コミュニティ面の一次情報は自動回収が始まっている。
3. awesome-agentic-commerce を販路台帳の恒常線源として採用（spec・SDK・facilitator・ディレクトリの総覧）。

## トライ&エラーの記録（このラウンドの実験）
- 仮説「主要 x402 面に既に索引されている」→ 実測: **Onyx に未索引（0件）**・Circle/x402station はエンドポイント特定に失敗 → 次の実験で正規 API を特定して再照会。
- 仮説「コミュニティ（r/AI_Agents）に売り手の知見がある」→ 実測: 実売り手スレッドを取得（第17ラウンド）→ **署名実装という差別化に変換済み**。
- 仮説「無料掲載できる x402 マーケットがある」→ 実測: **PayAPI Market を発見（掲載無料）** → 次ラウンド、出品 API 仕様を解析して機械出品を試す。

## KPI
- challenge_402 3632 / unique 160 / paid 1 / by_venue [{"venue": "direct", "hits": 2213}]

## 次の実験（台帳・自動実行可）
1. PayAPI Market の `/api/listings` 仕様解析 → 機械出品を試す（無料・原価0）。
2. Circle Discovery API の正規エンドポイント特定 → 自店索引確認。
3. Onyx Bazaar の再クロール確認（CDP 由来・日次）。
4. ERC-8004 identity（AgentZone）の登録要否（ガス代はオンチェーン例外として許容済み）。

## 残る人タップ（不変）
- MCP publish / 配布トークン / x402 List $1 / awesome-list・gold-402 への PR / repo権限付き PAT。
