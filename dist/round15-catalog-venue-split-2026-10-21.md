# 第15ラウンド実測レポート — catalog.json と well-known の面分離＋venue タグ適用

## 出荷物
1. **面分離の発見と実装**: `/api/x402/catalog.json` と `/.well-known/x402.json` は同一ハンドラ（index.js:197・`discoveryManifest` 生成）で同一中身だったため、直接タグを焼くと canonical も壊す。`discoveryManifest` に `opts.venue` を追加し、index.js で URL ごとに分岐 — catalog.json のみ items の resource に `?venue=catalog` を焼き、well-known は canonical 維持。
2. 適用前ゲート: テスト 60/0（X49「フィードは canonical」主張は green 維持・catalog.json テストは `ok !== false` のみで安全）。
3. ライブ検証: catalog.json items 26/26 タグ付き・well-known 26件 canonical=True・タグ付き POST → 402=True vendor=True・402内 resource canonical=True。
4. CHANGELOG v1.0.3 追記＋ git tag v1.0.3 → GitHub push。

## 実測の推移（KPI）
- challenge_402 3419 / unique 154 / paid 1 / by_venue [{"venue": "direct", "hits": 2000}]

## 意味
- 買い手が catalog.json から来て POST すると by_venue に catalog が積まれる（llms.txt に続き2面目）。well-known 経由のクローラ取り込み（CDP/discwatch）は canonical のまま影響なし。
- 前ラウンドまでのメモ「catalog ビルダは x402.js 内」は誤りで、正しくは discovery.js の discoveryManifest（今回特定・訂正）。

## 残る人タップ（不変）
- MCP publish 1タップ / 配布トークン（npm・PyPI・Glama）/ x402 List $1 / awesome-list PR（ユーザー承認）。
