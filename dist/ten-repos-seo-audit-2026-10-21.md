# ツイート参考ラウンド（第9）— 「寝ている間に金を生むリポジトリ10選」から seo-audit を商品化（2026-10-21）

配備 Version `7cf66fee-0e75-41b9-9c71-544dd888cae7` / コミット `9f459f7` / テスト **58 passed / 0 failed**（X47 追加＋テストランナー復旧で復活した末尾テスト群込み）

## きっかけ

[@naldzyul のポスト](https://x.com/naldzyul/status/2112472662270165092)（スペイン語のバイラル投稿・「10 repos de GitHub que te hacen ganar dinero mientras duermes」）。実在確認の結果、10件中8件を確認（2件は404・改名/削除）:

| リポジトリ | ★ | 内容 | wealth-agent への判定 |
|---|---|---|---|
| nowork-studio/toprank | 3,973 | SEO/GEO/マーケ自動化 skills for AI agents | **採用** → 需要シグナルとして seo-audit 棚を商品化 |
| AgriciDaniel/claude-ads | 10,244 | 広告運用の監査・最適化 | 需要確認のみ（当方は広告を出さない＝原価0） |
| jo-inc/camofox-browser | 11,753 | ステルスヘッドレスブラウザ | 後回し（JSレンダリング販路への自動提出に将来候補） |
| cloudflare/agentic-inbox | 8,393 | Workers 上の AI メールクライアント | 棚の着想元候補（今回未採用） |
| HKUDS/Vibe-Trading | 36,036 | トレーディングエージェント | **見送り**: 資本とリスクが要る（原価0制約） |
| Fincept-Corporation/fincept-terminal | 32,802 | 金融ターミナル | 見送り（同上） |
| Anil-matcha/Open-Higgsfield-AI | 31,055 | AI 動画生成スタジオ | 見送り（外部API=原価が発生） |
| heygen-com/hyperframes | 68,444 | HTML→動画 for agents | 見送り（Workers では描画不可） |
| The-Swarm-Corp/AutoHedge | — | 404（消滅/改名） | — |
| mksglu/ClawRouter | — | 404（消滅/改名） | — |

形式面の学びも採用: 「番号付き棚卸し＋保存誘導（guárdatelo 🔖）」というリスト記事は、こちらの llms.txt・カタログ整備と同じ「機械可読な棚卸し」の人力版であり、全発見面の一致（前ラウンド）と整合する。

## 実装したもの: 新棚 `seo-audit`（$0.002・無料体験つき）

- **納品内容**: 公開ページ1つを取得し、title（有無・10-70字）／meta description（50-160字）／canonical／noindex／h1数／h2有無／alt無し画像／lang／viewport／https／robots.txt／sitemap.xml／語数／リンク内外分類の**15の決定的チェック**を観測値つきで返し、0-100 スコア化。Workers AI が使えるときだけ**優先順位つき改善提案3件**を上乗せし `machine_generated` を明示（無いときは偽らず「決定的チェックのみ」と言う）。
- **原価0**: 取得は本文＋robots.txt＋sitemap.xml の3リクエストのみ。SSRF 対策（localhost/プライベートIP/メタデータ拒否・リダイレクト後も再検査）は url-meta と同じ規約。
- **付帯の重大な修正**: `tests/run.mjs` の要約行（`console.log(```）がテスト定義の末尾ブロックを**文字列として飲み込んでおり、X24 以降のテストが静かに実行されていなかった**欠陥を復旧。2引数形式で書かれていた3件は現行の3引数シグネチャへ機械修正、X23/X35 の「カタログ22品」固定と X24 の価格帯境界（0.005 の帰属）という陳腐化した期待値は現行実装（半開区間 [0.001,0.005)）に合わせて更新。全58件が本物として走る。

## ライブ検証（本番）

- ✅ カタログ26品に seo-audit が載る — items=26
- ✅ /llms.txt 27行・新棚込みでカタログ完全一致（回帰ガード） — lines=27 missing=[]
- ✅ /.well-known/x402 発見フィードも26棚 — resources=26
- ✅ kpi 正常（売上計器に影響なし） — 2txn / challenge 2454
- ✅ /api/x402/seo-audit が 402 値札（$0.002）を出す — status=402 amount=?
- ✅ 無料体験が seo-audit を実納品（本物の取得とスコア） — status=200 score=33 checks=15 ai=@cf/meta/llama-3.3-70b-instruct-fp8-fast
- ✅ discwatch: 監視対象が26棚に広がる — products=26 checked=26 ran 
- ✅ discwatch: seo-audit が CDP 審査に載る — [{"resource": "seo-audit", "method": "POST", "valid": true, "outcome": "accepted", "indexed": false, "last_crawled": null}]

discwatch は products=26・accepted=26・indexed=9。seo-audit は CDP の初回クロール待ち（`last_crawled=null`）。

## KPI

外部 **2件 / 0.002 USDC / 2人**（不変）。値札提示 2454 回。売上は外部の確認可能な決済のみ・変わらず。

## 次にやること

1. camofox 方式の再考（JSレンダリング販路＝mcp.directory への自動提出・要ブラウザ基盤）
2. discwatch 日次: seo-audit を含む26棚の索引入りと一般語順位
3. 人手の壁（変わらず）: MCP publish 1タップ・配布トークン・専用ドメイン・X 投稿（コネクタ接続があればリスト記事形式の宣伝文も用意できる）
