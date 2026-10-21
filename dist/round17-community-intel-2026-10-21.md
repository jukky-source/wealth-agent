# 第17ラウンド実測レポート — コミュニティ調査から差別化実装へ（応答の署名）

## 情報源の拡大（ユーザー指示: コミュニティで情報収集）
1. **r/AI_Agents の実売り手スレッド**（「Anyone's agents actually making money?」・18コメント）を取得。実売り手 u/IllWar5047（Base メインネット・7月から）の一次知見:
   - **integrator を決めたのは価格ではなく「全応答が署名済みでオフライン検証できたこと」**
   - 最初の外部決済は **Bazaar 掲載から約1週間後・買い手は verifier ボット（人間でない）**
   - 決済者内訳: リスティング確認クローラ + 判定を自社製品へ組み込んだ integrator（ピーク日30件）+ PoC 中の2社目
   - 収益感: **$0.005〜0.01/コールで月 数ドル**（成功している売り手でもこの規模 — 実勢）
   - 「**Discovery が壁。traffic の大半はリスティング確認ボット**」（challenge_402 の正体確認と一致）
   - 無料プレビューは売り手の標準装備（我々の無料枠と整合）
2. **Merit-Systems/awesome-agentic-commerce** を発見（x402 エコシステムの仕様・リポ・規格・コミュニティの線源。今後の販路台帳に取り込む）。
3. コミュニティ面（dorahacks x402 ハッカソン・lablab.ai）を記録（参加は次の実験候補）。

## 実装（v1.0.5→v1.0.6・出典つき）
1. **src/agent/proof.js 新設**: 有料応答に HMAC-SHA256 の proof ブロック（resource・時刻・入力/出力ハッシュ・署名・検証URL）。鍵は X402_SIGNING_KEY（無ければ OWNER_TOKEN）。
2. **決済パス配線**: fulfillOrder の deliverable を `output_hash` に署名し、応答本体に `proof` を同梱。検証契約: input_hash=HMAC(要求本文)・output_hash=HMAC(deliverable)・オフライン照合可。
3. **POST /api/verify**: 公開検証面（CORS 付き）。不正署名は `ok:false` を返すことをライブ確認済み。
4. **llms.txt に署名と検証面を追記**（機械への営業資料に）。**r/AI_Agents を reddit 収集源に追加**。
5. ゲート: テスト 60/0 → 配備。

## KPI
- challenge_402 3576 / unique 158 / paid 1 / by_venue [{"venue": "direct", "hits": 2157}]

## 正直な期待値の設定
- 実売り手の実勢は「月 数ドル」。月5万円は署名つき応答＋無料プレビュー＋複数 integrator＋発見面の積み増しが前提。今回の差別化（proof・/api/verify・$1 diligence-pack）は「integrator が決めた理由」への直接回答。

## 残る人タップ（不変）
- MCP publish / 配布トークン / x402 List $1 / awesome-list PR / repo権限付き PAT（topics 再実行用）。
