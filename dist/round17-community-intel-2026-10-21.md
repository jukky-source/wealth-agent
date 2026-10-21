# 第17ラウンド実測レポート — コミュニティ調査から差別化実装へ（応答の署名）

## 情報源の拡大（ユーザー指示: コミュニティで情報収集）
1. **r/AI_Agents の実売り手スレッド**（「Anyone's agents actually making money?」・18コメント）を取得。実売り手 u/IllWar5047（Base メインネット・7月から）の一次知見:
   - **integrator を決めたのは価格ではなく「全応答が署名済みでオフライン検証できたこと」**
   - 最初の外部決済は **Bazaar 掲載から約1週間後・買い手は verifier ボット（人間でない）**
   - 決済者内訳: リスティング確認クローラ + 自社製品に判定を組み込んだ integrator（ピーク日30件）+ PoC 中の2社目
   - 収益感: **$0.005〜0.01/コールで月 数ドル**（成功している売り手でもこの規模 — 誇張なしの実勢）
   - 「**Discovery が壁。traffic の大半はリスティング確認ボット**」（= challenge_402 の正体確認と一致）
   - 無料プレビューは売り手の標準装備（我々も無料枠あり・整合）
2. **Merit-Systems/awesome-agentic-commerce** を発見（販路リスト・今後の実験台帳の線源）。
3. ハッカソン/コミュニティ面（dorahacks x402・lablab.ai）を紙面として記録（参加は次の実験候補）。

## 実装（v1.0.5・出典つき）
1. **src/agent/proof.js 新設**: 全有料応答に HMAC-SHA256 の proof ブロック（resource・時刻・入力/出力ハッシュ・署名・検証URL）。鍵は X402_SIGNING_KEY（無ければ OWNER_TOKEN）。
2. **決済パスへの配線**: fulfillOrder の応答に proof を添付（r/AI_Agents の知見をコードコメントとして出典記録）。
3. **POST /api/verify 新設**: 統合者がオフライン検証の代わりにここで検証できる（公開・CORS 付き）。
4. **r/AI_Agents を reddit 収集源に追加**（genre: AIエージェント経済）— 今後この面の知見はエージェント自身が回収する。
5. ゲート: テスト 60/0 → 配備 → /api/verify ライブ応答確認。

## KPI
- challenge_402 3575 / unique 158 / paid 1 / by_venue [{"venue": "direct", "hits": 2156}]

## 正直な期待値の設定
- 実売り手の実勢は「月 数ドル」。月5万円は単一の Bazaar ではなく、署名つき応答＋無料プレビュー＋複数 integrator の獲得が前提。次の実験はこの差別化面（proof・/api/verify・diligence-pack $1）を軸に、発見面を増やし続ける。

## 残る人タップ（不変）
- MCP publish / 配布トークン / x402 List $1 / awesome-list PR / repo権限付き PAT（topics 設定の再実行用）。
