# アーキテクチャ詳細

## 1. 設計原則

1. **状態は常に永続化される。** 各ステップの後にタスク状態・証拠・チェックポイントを書く。落ちても、API枠が切れても、ブラウザーを閉じても、続きから再開できる。
2. **証拠がなければ完了ではない。** 検証器は機械的に判定できる基準のみを使う。
3. **推定と実測を混ぜない。** 数値は必ず `measured / third_party / estimated / unverified` の区分を持つ。
4. **自律性は権限ではない。** 危険操作は承認ゲートを通す。
5. **同じ失敗を繰り返さない。** 失敗は記憶に落ち、次の計画から除外される。
6. **無限ループを作らない。** 進捗がなければ戦略を切り替え、それでもだめなら人間に渡す。

---

## 2. 実行ループ（1 tick の流れ）

```
Cron (5分ごと) / クライアント / 手動
        │
        ▼
scheduler.scheduledTick()
 ├─ resumeWaiting()            待機タスクの復帰（クォータ回復後）
 ├─ engine.tick()              ← ここが本体
 │    ├─ エンジン状態確認（stopped/paused なら即終了）
 │    ├─ キャラクター取得（人格重みの算出）
 │    ├─ ミッション選択（priority 降順）
 │    └─ runMissionSlice(mission, steps)
 │         ├─ selectNextTask()      依存関係を満たす最高スコアのタスク
 │         ├─ runTaskAttempt()      planning→running→(testing)→verifying
 │         │    ├─ executeTool()    実際の作業（承認ゲート・支出ガード経由）
 │         │    ├─ verifyResult()   証拠ベースの合否判定
 │         │    ├─ diagnose()       失敗の診断（transient/data_gap/spec_violation/bug/evidence）
 │         │    ├─ mutateForRetry() 再試行はパラメータを実際に変更
 │         │    └─ recordExperience() 成功/失敗を長期記憶へ
 │         ├─ 停止ガード（stall カウント → 戦略切替 → 要人手）
 │         ├─ checkpoint()         各ステップ後に保存
 │         └─ verifyMission()      ミッション単位の達成判定（実測のみ算入）
 ├─ スケジュール済みワークフロー（1回につき1本まで）
 └─ 日次補正（推定値を実測で補正）
```

### タスク状態遷移

```
queued ──▶ planning ──▶ running ──▶ testing ──▶ verifying ──┬──▶ completed
                            │                               │
                            │                               └──▶ improving ──▶ running …
                            ├──▶ waiting_for_quota  （枠回復後に improving へ）
                            ├──▶ waiting_for_approval（承認後に improving へ）
                            └──▶ failed（試行上限 or 非再試行可能）
```

`waiting_for_user` はオーナーの入力が必要な状態です。

### 無限ループ防止（二重の安全弁）

| ガード | 既定値 | 動作 |
|---|---|---|
| `maxStalledSteps` | 6 | 連続して進展がない → 戦略を切り替える（別ツール／別仮説のタスクを生成） |
| `maxStrategySwitches` | 3 | それでも改善しない → ミッションを `paused` にし、エンジンを停止、理由を記憶に記録 |
| `max_attempts`（タスク単位） | 3 | 個別タスクの試行上限 |
| `maxStepsPerTick` | 3 | 1回の tick で行うステップ数の上限（Free プランの CPU 制約対策） |

---

## 3. データモデル（D1 / SQLite）

| テーブル | 役割 |
|---|---|
| `characters` | 人格（プリセット・重み計算の入力） |
| `missions` | 長期目標・成功指標・進捗 |
| `tasks` | タスクと状態機械（依存関係・試行回数・エラー履歴・戦略） |
| `runs` | 実行ログ（全状態遷移・APIエラー） |
| `checkpoints` | 再開点（scope ごとに直近30件を保持） |
| `memories` + `memories_fts` | 検索可能な長期記憶（FTS5） |
| `opportunities` | 収益候補（14観点の評価値・スコア内訳） |
| `fx_strategies` / `fx_backtests` | 戦略のバージョン管理と検証結果 |
| `ai_usage` / `ai_provider_state` | AI利用量・クールダウン管理 |
| `research_reports` / `documents` / `doc_chunks`(+FTS) | 調査レポート・ナレッジベース |
| `workflows` / `workflow_runs` | 自動化と実行履歴 |
| `approvals` | 危険操作の承認記録 |
| `ledger` | 収支（`basis` で実測/推定を厳格に分離） |
| `settings` / `spend_guard` / `fetch_cache` | 設定・支出制御・取得キャッシュ |

---

## 4. AIプロバイダルーター

```
complete({role, system, user, json, schema})
 ├─ 1日の呼び出し上限チェック → 超過なら待機（進捗保存）
 ├─ 役割ごとの優先順（planner→gemini, critic→groq, …）
 ├─ プロバイダごとに:
 │    ├─ クールダウン中ならスキップ
 │    ├─ モデルごとに最大2回試行（指数バックオフ＋ジッタ）
 │    ├─ 429/503 → レート制限として長めのクールダウン
 │    ├─ 4xx → 恒久エラーとして即フォールバック
 │    └─ 成功 → 使用量を記録し回復
 └─ 全滅 → 決定的エンジン（ルールベース）で処理を継続
```

**決定的エンジン**は以下を担当します（キー0本でも動作）:
- ミッションの自動分解（目標分類 → ブループリント）
- 失敗後の代替戦略の選択（カテゴリ別の代替表）
- レビュー（ルールベースのルブリック）
- ランキング・スコアリング（数式）
- バックテスト・統計処理（すべて自前実装）

### レート制限・課金の扱い
- 制限回避（複数アカウント・キー使い回し）は **実装していません**。
- 有料APIは `ALLOW_PAID_AI=false`（既定）で完全に遮断し、`PAID_DAILY_CAP_USD` 未設定なら課金実行を拒否します。

---

## 5. 誠実性レイヤー（truth.js）

成果の段階を明示的に区別します：

`コード生成済み → テスト実行済み → テスト合格 → デプロイ済み → デプロイ後の動作確認済み → 収益機会の発見 → 収益化の仕組みの実装 → 実際の収益発生 → 実際の入金・換金確認`

`claim(level, {basis, evidence})` は次のルールを強制します：

- `measured` を名乗るには **証拠が必須**（無ければ自動的に `unverified` に降格）
- `third_party` を名乗るには **http(s) のURLが必須**
- `summarizeLedger()` は実測・第三者・推定を別枠で集計し、純利益も分けて返す

---

## 6. 安全設計

### 承認が必須な操作（全自律性レベル共通）

`live_order`（実口座売買）／`fund_transfer`（入出金・資金移動）／`paid_api`（課金）／`account_signup`（登録）／
`external_publish`（投稿・公開）／`data_delete`（重要データ削除）／`irreversible`／`pii_egress`（個人情報送信）

ゲートを通らない限りツールは実行されず、タスクは `waiting_for_approval` に移り、`approvals` に記録が残ります。

### その他の防御

| 脅威 | 対策 |
|---|---|
| プロンプトインジェクション | 外部取得テキストを `<untrusted_source>` で包み、指示的表現を除去（`sanitizeExternal`） |
| SSRF | ローカル/プライベートIPへの取得を拒否 |
| 過剰アクセス | robots.txt を尊重、ホストごとにレート制限、結果をキャッシュ |
| 任意コード実行 | コードテストは純粋関数のみ・制限付き・2秒タイムアウト。Workers 上では動的評価が禁止されるため正直に報告 |
| 秘密の漏洩 | キーはシークレットのみ。APIはプレゼンス真偽値だけを返す。認証は Bearer トークン |
| 無制限の支出 | `spend_guard` により有料呼び出しを遮断・上限管理 |

---

## 7. ブラウザーエージェントの範囲（できないことを明示）

| できる | できない（代替を提示） |
|---|---|
| 公開ページの取得・本文/見出し/表/リンクの抽出 | ログインが必要なページ |
| robots.txt の確認と遵守 | CAPTCHA の突破 |
| 複数ページの並列比較と原文併記 | フォーム送信・購入手続き |
| 取得結果のキャッシュと再現性の確保 | 外部サービスへの投稿・公開（承認が必要） |

Cloudflare Workers に実ブラウザーランタイムは存在しないため、ヘッドレスブラウザーが必要な操作は
「この環境では実行できません」と正直に返し、代わりに HTTP 取得で得られる範囲の結果を返します。

---

## 8. フロントエンド（PWA）

- 単一HTML＋バニラESモジュール。ビルド工程なし。
- 12画面（Mission Control / Character Studio / Missions / Task Queue / Income Opportunities / FX Research /
  Rewards / Side Hustle / Workflow Builder / Knowledge Base / Execution Logs / Settings）＋補助チャット。
- ホーム画面の必須表示：キャラクター状態、現在のミッション、実行中タスク、完了タスク、現在の問題、
  次のタスクと**選んだ理由**、最後に成功したステップ、API使用量と制限状態、確認待ちの重要操作、
  実績/推定/費用/純利益、停止・再開ボタン。
- モバイル最適：44px タップ領域、`safe-area-inset` 対応、下部固定タブ、ダーク/ライト両対応。
- Service Worker：アプリシェルをキャッシュ（APIはキャッシュしない。ダッシュボードのみオフライン時のフォールバック）。
