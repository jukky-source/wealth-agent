# 第11ラウンド実測レポート — 全販路同時進行（2026-10-21）

## 方針
「全販路同時に進める」を受け、贩卖台帳（venues）・自動提出ループ（hunt）・外部索引の実掲載・MCP 端点・承認待ちを同時に実測し、
機械で進むものは進めて、人の1タップが必要なものを earnest に洗い出した。

## 販売台帳の全体（/api/venues 実測）
by_state: listed 2 / not_listed 13 / needs_key 3 / pending_review 1 / blocked_cost 4 / blocked_human 6 / needs_account 3 / manual_form 4 / probe_ok 2
- auto_queue（機械で提出試行できる枠）16: npm, pypi, glama, mcp_official_registry, mcp_directory, pulsemcp, agentic_market, cdp_bazaar, claudepluginhub, agent402_index, huggingface, dockerhub, gemini_cli_gallery, open_vsx, agentshare, agenthansa
- human_queue（人の手が要る枠）20: anthropic_connectors, openai_plugins, stripe_agentic, awesome_mcp_servers, aws/google_cloud マーケットプレイス, mcp_registry, rapidapi, smithery ほか

## 自動提出ループの実況（/api/hunt/public 実測・種10）
- agent402: unconfirmed（listed=0・machine=True）
- payai: listed（listed=1・machine=True）
- cdp: unconfirmed（listed=0・machine=True）
- x402new: unconfirmed（listed=0・machine=False）
- circle: absent（listed=0・machine=True）
- sentinel: absent（listed=0・machine=False）
- mcpreg: unconfirmed（listed=0・machine=False）
- payapi: unconfirmed（listed=0・machine=False）
- agentshare: unconfirmed（listed=0・machine=False）
- apiosk: unconfirmed（listed=0・machine=False）
- 試行の実績（trials_by_outcome）: {"blocked": 33, "fail": 16, "listed": 1, "ok": 1}
- 発見数 discovered_n: 30・ラウンド数: 66

## 外部索引での自店掲載の実測
- CDP Bazaar（Coinbase 公式）: 26棚受理・索引入り 9/26。検索語「wealth」で自店 brief が **12件中8位**に掲載。
- PayAI Bazaar: **掲載済み**（listed=1。機械確認済みの唯一の第三者売り場）。
- agentic.market: JS レンダリング付きで取得しても自店ホストは未掲載（まだ彼らのクローラが拾っていないか、掲載審査外）。
- agent402.tools: 一次パースで自店ホスト無し（未掲載の可能性。hunt は unconfirmed を維持）。
- IndexNow: cron で日次 ping 済みの仕組み。llms.txt の venue つき URL 化は次回 tick で検索面へ反映。

## MCP 端点（ディレクトリ掲載の前提条件）
- POST /mcp（JSON-RPC initialize）→ 200・protocolVersion 2025-06-18・serverInfo wealth-agent 1.0.0 — **生存確認**。
- よって glama / PulseMCP / ClaudePluginHub / mcp_directory の掲載条件のうち「動く MCP サーバがある」は満たした。残る入口は各社の鍵・フォーム（人の1タップ）。

## 人の判断が必要なもの（代行不可）
1. **承認待ち 1 件（high リスク）**: x402_refund_or_redeliver — resource brief・tx 0x860bf428…・payer 0x7f06…（自己テストウォレット）の返金か再納品か。/api/approvals で確認できる。
2. MCP 公式レジストリ publish（mcp-publisher の GitHub 認証 1 タップ）。
3. 配布トークン（npm / PyPI / Glama API key）の発行。
4. X への宣伝（コネクタ未接続。接続すれば投稿文の自動投稿まで可能）。

## 判定
全販路のうち機械で動く面（hunt 自動提出・IndexNow・CDP/自前 discwatch・venue 計測）は稼働中。
実売 1件 の底方は「第三者売り場の掲載が 1（PayAI）だけ」であり、次の伸びしろは
MCP ディレクトリ系（/mcp 生存確認済み・鍵の発行だけ残し）と agentic.market/agent402 の拾わせにある。
