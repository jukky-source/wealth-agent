// venues-1.0 — 「Bazaar の外」にある大手の売り場（チャネル）台帳と採点
// 目的: x402 Bazaar 単独では月5万円に届かない（実測 ≈$10,000/30日）ため、
//       到達規模 × 適合度 × 原価0 × 自動化可否 の4軸で「大きい売り場」を並べ、
//       自動で行ける順・人の1タップが要る順に切り分ける。
// 原価0の制約: cost_usd>0 の売り場は「人の判断が要る」として分離する（勝手に課金しない）。

export const REACH_W = { huge: 1.0, large: 0.7, medium: 0.45, small: 0.2 };

export const VENUE_STATES = [
  'listed', 'pending_review', 'not_listed',
  'probe_ok', 'manual_form', 'needs_account', 'needs_key',
  'blocked_cost', 'blocked_human', 'gone', 'down', 'unknown',
];

// reach: 到達規模の帯 / fit: 我々の品との適合(0-1) / auto: 機械だけで出品まで行けるか
// cost_usd: 出品に必要な実費（0以外は原価0制約に触れるので人の承認が要る）
// src: self_measured=本セッションで実測 / search=本セッションの検索結果 / general=一般に安定した事実
export const BIG_VENUES = [
  {
    id: 'payapi_market', name: 'PayAPI Market', kind: 'x402_market',
    url: 'https://payapi.market/', submit: 'https://payapi.market/',
    reach: 'medium', reach_note: 'x402 専用マーケット。Listing is free・売上100%還元を謳う',
    cost_usd: 0, kyc: false, registrable: 'manual_form', auto: false, fit: 1.0,
    state: 'manual_form', src: 'self_measured',
    note: '2026-10-21 実測: 公開 API は読み取り専用（GET /agent/list,/agent/search,/agent/get）— 出品はサイトのフォーム（人タップ1件・掲載無料・売上100%）。',
  },
  {
    id: 'onyx_bazaar', name: 'Onyx Bazaar', kind: 'x402_market',
    url: 'https://onyx-actions.onrender.com/bazaar', submit: 'CDP discovery 由来の自動索引',
    reach: 'small', reach_note: 'CDP discovery API で索引された有料 x402 サービスの無料リーダーボード（15分更新）',
    cost_usd: 0, kyc: false, registrable: 'auto', auto: true, fit: 1.0,
    state: 'not_listed', src: 'self_measured',
    note: '2026-10-21 実測: /bazaar.json に当ホストなし（grep 0件）。CDP 由来なので再クロール待ち・日次で再確認。',
  },
  {
    id: 'x402station', name: 'x402station', kind: 'analytics',
    url: 'https://x402station.com/', submit: 'クロール型の可能性',
    reach: 'small', reach_note: 'x402 サービスの分析・監視プラットフォーム',
    cost_usd: 0, kyc: false, registrable: 'auto', auto: true, fit: 0.8,
    state: 'unknown', src: 'self_measured',
    note: '2026-10-21 実測: /api/services?search= は空応答（エンドポイント未確定）。クロール受信は discwatch で継続観測。',
  },
  {
    id: 'agentzone', name: 'AgentZone', kind: 'explorer',
    url: 'https://agentzone.fun/', submit: 'ERC-8004 identity 由来',
    reach: 'small', reach_note: 'ERC-8004 identity + x402 決済履歴 + 評価シグナルの統合エクスプローラ（Base/Arbitrum）',
    cost_usd: 0, kyc: false, registrable: 'auto', auto: true, fit: 0.8,
    state: 'unknown', src: 'search',
    note: 'ERC-8004 identity の登録要否を確認する（identity コストはオンチェーン登録のみ＝許容済みの例外）。次の実験候補。',
  },
  {
    id: 'circle_discovery', name: 'Circle Discovery API', kind: 'discovery_api',
    url: 'https://www.circle.com/blog/discover-the-whole-agent-marketplace-in-one-call', submit: 'クロール型',
    reach: 'medium', reach_note: 'Circle の keyless Discovery API — USDC を受ける x402 サービスを1コールで発見',
    cost_usd: 0, kyc: false, registrable: 'auto', auto: true, fit: 1.0,
    state: 'not_listed', src: 'self_measured',
    note: '2026-10-21 実測: 正規エンドポイント api.circle.com/v2/x402/discovery/resources（キーレス・自店索引 0 件）。agents.circle.com/services がそのカタログ面。',
  },
  {
    id: 'gold_402', name: 'gold-402 (24K Labs)', kind: 'directory',
    url: 'https://github.com/Haustorium12/gold-402', submit: 'GitHub PR',
    reach: 'medium', reach_note: '厳選 300+ 件の x402 ディレクトリ・CDP/Agentic.market 由来 29,000+ のフルカタログ',
    cost_usd: 0, kyc: false, registrable: 'pr', auto: false, fit: 1.0,
    state: 'blocked_human', src: 'search',
    note: '掲載は GitHub PR（ユーザーの GitHub アカウントでの社会的活動になるため承認待ち）。',
  },
  {
    id: 'pyrimid', name: 'Pyrimid', kind: 'a2a_infra',
    url: 'https://pyrimid.ai/', submit: 'MCP-native discovery',
    reach: 'small', reach_note: 'x402 + ERC-8004 の A2A コマース基盤・MCP ネイティブ発見と支払い分割',
    cost_usd: 0, kyc: false, registrable: 'auto', auto: true, fit: 0.7,
    state: 'unknown', src: 'search',
    note: 'MCP 発見面への掲載要否を確認する。',
  },
  {
    id: 'stablecoin_402', name: 'stablecoin.com 402 Ecosystem', kind: 'directory',
    url: 'https://stablecoin.com/402/ecosystem/', submit: 'フォーム要確認',
    reach: 'small', reach_note: 'HTTP 402 / x402 エコシステムの中立ディレクトリ',
    cost_usd: 0, kyc: false, registrable: 'manual_form', auto: false, fit: 0.8,
    state: 'unknown', src: 'search',
    note: '提出フォームの有無を次回確認（機械提出可なら次ラウンドで実行）。',
  },
  {
    id: 'cdp_bazaar', name: 'x402 Bazaar (CDP discovery)', kind: 'x402_market',
    url: 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search',
    probe: 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=usdc',
    submit: 'https://www.coinbase.com/developer-platform/discover/launches/x402-bazaar',
    reach: 'medium', reach_note: '本セッション実測: 上位1295件の30日総額 ≈ $10,000',
    cost_usd: 0, kyc: false, registrable: 'auto', auto: true, fit: 1.0,
    state: 'listed', src: 'self_measured',
    note: '9品索引済み。値札は出ているが支払者は1人。x402 challenge を返せば自動で載る。',
  },
  {
    id: 'agentic_market', name: 'Agentic.Market (Coinbase)', kind: 'x402_market',
    url: 'https://agentic.market/', submit: 'https://agentic.market/',
    reach: 'medium', reach_note: 'x402 対応なら自動で発見される建て付け（2026-04-20 公開）',
    cost_usd: 0, kyc: false, registrable: 'auto', auto: true, fit: 1.0,
    state: 'not_listed', src: 'search',
    note: 'CDP と同じ発見面。Bazaar に出ていれば載る可能性が高い＝まず在否を実測する。',
  },
  {
    id: 'binance_b402', name: 'B402 Bazaar (Binance)', kind: 'api_market',
    url: 'https://www.binance.com/bapi/ramp/v1/public/ramp/b402/bazaar/search',
    submit: 'https://developers.binance.com/en/docs/products/onchainpay-x402/b402-bazaar',
    reach: 'medium', reach_note: 'Binance の x402 面。payTo で0件＝未掲載を実測済み',
    cost_usd: 0, kyc: true, registrable: 'api', auto: false, fit: 0.9,
    state: 'needs_key', src: 'self_measured',
    note: '載るには Binance Web3 API キー（人の1タップ）。min $0.01/settle 未満は活動なしに見える可能性。',
  },
  {
    id: 'rapidapi', name: 'RapidAPI / Nokia API Hub', kind: 'api_market',
    url: 'https://rapidapi.com/', submit: 'https://rapidapi.com/',
    reach: 'large', reach_note: '検索結果: 98,000 API / 開発者数百万（2026年時点の抜粋値）',
    cost_usd: 0, kyc: true, registrable: 'api', auto: false, fit: 0.8,
    state: 'not_listed', src: 'search',
    note: 'OpenAPI を上げれば出品可。売上の20〜30%を取られる。アカウント作成は人の1タップ。',
  },
  {
    id: 'mcp_official_registry', name: 'MCP 公式レジストリ', kind: 'mcp_registry',
    url: 'https://registry.modelcontextprotocol.io',
    probe: 'https://registry.modelcontextprotocol.io/v0/servers?limit=1', submit: 'https://registry.modelcontextprotocol.io',
    reach: 'large', reach_note: 'MCP の標準発見面。クライアント実装が参照する',
    cost_usd: 0, kyc: false, registrable: 'api', auto: true, fit: 0.75,
    state: 'not_listed', src: 'general',
    note: '既に /mcp はステートレス準拠。登録手順（GitHub PR 等）を実測して自動化できるか判定する。',
  },
  {
    id: 'agentshare', name: 'AgentShare', kind: 'agent_directory',
    url: 'https://agentshare.dev/', submit: 'https://agentshare.dev/',
    reach: 'small', reach_note: '登録 id 119 を取得済み（審査中）',
    cost_usd: 0, kyc: false, registrable: 'auto', auto: true, fit: 0.6,
    state: 'pending_review', src: 'self_measured',
    note: '審査の自動ポーリング稼働中（45分毎）。「掲載済み」とは言わない。',
  },
  {
    id: 'agenthansa', name: 'AgentHansa', kind: 'agent_directory',
    url: 'https://www.agenthansa.com/', submit: 'https://www.agenthansa.com/',
    reach: 'small', reach_note: '自動登録済み',
    cost_usd: 0, kyc: false, registrable: 'auto', auto: true, fit: 0.55,
    state: 'listed', src: 'self_measured',
    note: 'Reddit 側の本人確認は未了（人の手）。',
  },
  {
    id: 'payapi_market', name: 'PayAPI Market', kind: 'api_market',
    url: 'https://payapi.market/', submit: 'https://payapi.market/list',
    reach: 'small', reach_note: '掲載フォーム提出が人の1タップ',
    cost_usd: 0, kyc: false, registrable: 'form', auto: false, fit: 0.6,
    state: 'not_listed', src: 'self_measured',
    note: 'フォーム送信のみ。自動投稿は公開投稿の門（承認）に当たる。',
  },
  {
    id: 'anthropic_connectors', name: 'Claude Connectors ディレクトリ', kind: 'agent_directory',
    url: 'https://support.claude.com/en/articles/11596036-anthropic-connectors-directory-faq',
    submit: 'https://support.claude.com/en/articles/11596036-anthropic-connectors-directory-faq',
    reach: 'huge', reach_note: 'Claude の公式発見面。ただし審査と有料組織が前提',
    cost_usd: 0, kyc: true, registrable: 'form', auto: false, fit: 0.7,
    state: 'blocked_cost', src: 'search',
    note: '提出には Team / Enterprise 組織が要る（実費）＝原価0の制約に触れる。人の判断待ち。',
  },
  {
    id: 'openai_plugins', name: 'ChatGPT プラグイン / リモート MCP', kind: 'agent_directory',
    url: 'https://developers.openai.com/plugins/deploy/app-review', submit: 'https://developers.openai.com/plugins/deploy/app-review',
    reach: 'huge', reach_note: 'ChatGPT は週9億人規模（検索結果の抜粋値）',
    cost_usd: 0, kyc: true, registrable: 'form', auto: false, fit: 0.7,
    state: 'blocked_human', src: 'search',
    note: 'リモート MCP の審査提出。審査・規約同意は人の手が要る。',
  },
  {
    id: 'google_cloud_marketplace', name: 'Google Cloud Marketplace (AI Agent)', kind: 'app_store',
    url: 'https://cloud.google.com/marketplace', submit: 'https://docs.cloud.google.com/marketplace/docs/partners/ai-agents/publish',
    reach: 'huge', reach_note: '企業調達の売り場。AAS 出品は法人前提',
    cost_usd: 0, kyc: true, registrable: 'form', auto: false, fit: 0.5,
    state: 'blocked_human', src: 'search',
    note: 'パートナー登録・法人情報・税務が前提。原価0では今は届かない＝記録だけ残す。',
  },
  {
    id: 'aws_marketplace', name: 'AWS Marketplace', kind: 'app_store',
    url: 'https://aws.amazon.com/marketplace', submit: 'https://aws.amazon.com/marketplace',
    reach: 'huge', reach_note: '企業調達の売り場。出品者登録に税務・銀行情報',
    cost_usd: 0, kyc: true, registrable: 'form', auto: false, fit: 0.5,
    state: 'blocked_human', src: 'general',
    note: '同上。人の手続きが要る棚として分離。',
  },
  {
    id: 'npm', name: 'npm レジストリ', kind: 'package_registry',
    url: 'https://www.npmjs.com/', submit: 'https://www.npmjs.com/',
    probe: 'https://registry.npmjs.org/-/whoami',
    publish_api: 'PUT https://registry.npmjs.org/<pkg> （.npmrc に Bearer トークン。トークン発行は人の1タップ）',
    reach: 'huge', reach_note: '開発者の標準配布路。無料',
    cost_usd: 0, kyc: false, registrable: 'api', auto: true, fit: 0.6,
    state: 'not_listed', src: 'general',
    note: '鍵1本で自動 publish 可。配布＝入口で、課金は別途 x402 に寄せる。',
  },
  {
    id: 'pypi', name: 'PyPI', kind: 'package_registry',
    url: 'https://pypi.org/', submit: 'https://pypi.org/',
    probe: 'https://pypi.org/pypi/requests/json',
    publish_api: 'twine upload / POST https://upload.pypi.org/legacy/ （API トークン。発行は人の1タップ）',
    reach: 'huge', reach_note: 'Python の標準配布路。無料',
    cost_usd: 0, kyc: false, registrable: 'api', auto: true, fit: 0.6,
    state: 'not_listed', src: 'general',
    note: 'トークン1本で自動 publish 可。',
  },
  {
    id: 'huggingface', name: 'Hugging Face Hub', kind: 'storefront',
    url: 'https://huggingface.co/', submit: 'https://huggingface.co/',
    probe: 'https://huggingface.co/api/models?limit=1',
    publish_api: 'POST https://huggingface.co/api/repos/create （write トークン）',
    reach: 'large', reach_note: 'AI 開発者の集まる配布・公開面。無料枠あり',
    cost_usd: 0, kyc: false, registrable: 'api', auto: true, fit: 0.55,
    state: 'not_listed', src: 'general',
    note: 'Space / データセットとして公開可。',
  },
  {
    id: 'dockerhub', name: 'Docker Hub', kind: 'package_registry',
    url: 'https://hub.docker.com/', submit: 'https://hub.docker.com/',
    probe: 'https://hub.docker.com/v2/repositories/library/alpine/',
    publish_api: 'docker push （アクセストークン）',
    reach: 'large', reach_note: 'コンテナ配布の標準。無料枠あり',
    cost_usd: 0, kyc: false, registrable: 'api', auto: true, fit: 0.45,
    state: 'not_listed', src: 'general',
    note: '実行物を配る路。',
  },
  {
    id: 'vscode_marketplace', name: 'VS Code Marketplace', kind: 'plugin_dir',
    url: 'https://marketplace.visualstudio.com/', submit: 'https://marketplace.visualstudio.com/',
    probe: 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
    reach: 'large', reach_note: '開発者の手元に入る拡張の棚。無料',
    cost_usd: 0, kyc: true, registrable: 'api', auto: false, fit: 0.4,
    state: 'needs_key', src: 'general',
    note: 'Azure の PAT 発行が人の1タップ。',
  },
  {
    id: 'open_vsx', name: 'Open VSX', kind: 'plugin_dir',
    url: 'https://open-vsx.org/', submit: 'https://open-vsx.org/',
    probe: 'https://open-vsx.org/api/-/search?query=x402',
    publish_api: 'POST https://open-vsx.org/api/<ns>/<ext> （PAT）',
    reach: 'medium', reach_note: 'VS Code 互換のオープンな棚',
    cost_usd: 0, kyc: false, registrable: 'api', auto: true, fit: 0.4,
    state: 'not_listed', src: 'general',
    note: 'トークン1本で自動 publish 可。',
  },
  {
    id: 'wordpress_plugin_dir', name: 'WordPress プラグインディレクトリ', kind: 'plugin_dir',
    url: 'https://wordpress.org/plugins/', submit: 'https://wordpress.org/plugins/developers/add/',
    reach: 'huge', reach_note: '世界最大級の CMS の公式棚。無料',
    cost_usd: 0, kyc: false, registrable: 'form', auto: false, fit: 0.35,
    state: 'blocked_human', src: 'general',
    note: '提出は人の1タップ＋レビュー。適合は低め（我々の品はAPI寄り）。',
  },
  {
    id: 'gumroad', name: 'Gumroad', kind: 'storefront',
    url: 'https://gumroad.com/', submit: 'https://gumroad.com/',
    reach: 'medium', reach_note: 'デジタル商品の販売面。出品無料・手数料制',
    cost_usd: 0, kyc: true, registrable: 'api', auto: false, fit: 0.4,
    state: 'needs_account', src: 'general',
    note: '売上受け取りに本人確認が要る（人の手）。',
  },
  {
    id: 'bounty_algora', name: 'Algora / OSS バウンティ', kind: 'bounty',
    url: 'https://algora.io/', submit: 'https://algora.io/',
    reach: 'medium', reach_note: '実装に対する直接報酬。原価0で参加可',
    cost_usd: 0, kyc: true, registrable: 'api', auto: false, fit: 0.65,
    state: 'not_listed', src: 'general',
    note: '成果報酬型。受け取りにアカウントが要る。',
  },
  {
    id: 'stripe_agentic', name: 'Stripe Agent Commerce', kind: 'x402_market',
    url: 'https://stripe.com/', submit: 'https://stripe.com/',
    reach: 'huge', reach_note: 'カード網の側。KYC 前提',
    cost_usd: 0, kyc: true, registrable: 'api', auto: false, fit: 0.6,
    state: 'blocked_cost', src: 'search',
    note: 'x402 Foundation の創設メンバー。だが口座開設・KYC が要る＝原価0と両立しないので今は見送り。',
  },
  {
    id: 'chrome_web_store', name: 'Chrome ウェブストア', kind: 'app_store',
    url: 'https://chromewebstore.google.com/', submit: 'https://chromewebstore.google.com/',
    reach: 'huge', reach_note: 'ブラウザ拡張の棚。開発者登録は有料',
    cost_usd: 5, kyc: true, registrable: 'form', auto: false, fit: 0.35,
    state: 'blocked_cost', src: 'general',
    note: '登録に $5 の実費＝原価0の例外に当たるため人の判断待ち。',
  },
  {
    id: 'mcp_registry', name: 'MCP 公式レジストリ（mcp-publisher）', kind: 'mcp_registry',
    url: 'https://registry.modelcontextprotocol.io', probe: 'https://registry.modelcontextprotocol.io/v0/servers?limit=1',
    submit: 'https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx',
    publish_api: 'npx mcp-publisher publish（server.json の remotes だけで可。名前空間 io.github.<user>/… は GitHub で検証）',
    reach: 'large', reach_note: '実測・一次情報: ここに1回出せば Glama / mcp.directory / PulseMCP が自動で這う＝配布の要（かなめ）',
    cost_usd: 0, kyc: false, registrable: 'api', auto: false, fit: 0.8, state: 'needs_account', src: 'self_measured',
    note: 'remote-only でも出品可（packages 不要）。publish は GitHub デバイスフロー（人の1タップ）か Actions(OIDC)。我々のトークンは scope=public_repo のみ＝workflow 権限が無いことを実測。server.json は既にリポジトリ直下に存在する。',
  },
  {
    id: 'glama', name: 'Glama MCP ディレクトリ', kind: 'mcp_registry',
    url: 'https://glama.ai/mcp/servers', probe: 'https://glama.ai/api/mcp/v1/servers',
    reach: 'large', reach_note: '実測: 約21Kサーバの最大級インデックス。API は鍵必須（401 実測）',
    cost_usd: 0, kyc: false, registrable: 'auto', auto: true, fit: 0.75, state: 'needs_key', src: 'self_measured',
    note: 'GitHub と公式レジストリから自動索引。専用APIは glama.ai/settings/api-keys の鍵が要る（人の1タップ）。claim で認証バッジ。',
  },
  {
    id: 'smithery', name: 'Smithery', kind: 'mcp_registry',
    url: 'https://smithery.ai/', probe: 'https://smithery.ai/new',
    publish_api: 'smithery.ai/new（無料 publish。公開時にライブのツールを走査して品質スコアを出す）',
    reach: 'large', reach_note: '実測: /new は 308 でログインへ。7K+ サーバ',
    cost_usd: 0, kyc: false, registrable: 'account', auto: false, fit: 0.8, state: 'needs_account', src: 'self_measured',
    note: '無料 publish はアカウントが要る（人の1タップ）。vendor verification は DNS TXT とバックリンクで無料の範囲がある。',
  },
  {
    id: 'mcp_directory', name: 'mcp.directory', kind: 'mcp_registry',
    url: 'https://mcp.directory/', submit: 'https://mcp.directory/submit', probe: 'https://mcp.directory/',
    reach: 'large', reach_note: '実測: 200。公式レジストリから自動取込',
    cost_usd: 0, kyc: false, registrable: 'auto', auto: true, fit: 0.7, state: 'not_listed', src: 'self_measured',
    note: 'レジストリ登録で自動取込、または /submit。claim は hello@mcp.directory へメール。',
  },
  {
    id: 'mcpservers_org', name: 'mcpservers.org', kind: 'mcp_registry',
    url: 'https://mcpservers.org/', submit: 'https://mcpservers.org/submit', probe: 'https://mcpservers.org/submit',
    reach: 'medium', reach_note: '実測: /submit は 200（無料フォーム）。Marketing カテゴリあり',
    cost_usd: 0, kyc: false, registrable: 'form', auto: false, fit: 0.65, state: 'manual_form', src: 'self_measured',
    note: '無料フォーム提出。$39 の premium は任意（原価0の制約では払わない）。',
  },
  {
    id: 'pulsemcp', name: 'PulseMCP', kind: 'mcp_registry',
    url: 'https://www.pulsemcp.com/servers', probe: 'https://www.pulsemcp.com/',
    reach: 'large', reach_note: '11K+ サーバ。人手審査。2026-08 中旬まで受付停止、再開後は公式レジストリを取込',
    cost_usd: 0, kyc: false, registrable: 'auto', auto: true, fit: 0.7, state: 'not_listed', src: 'search',
    note: 'レジストリ登録が先。再開後に自動で載る建て付け。',
  },
  {
    id: 'claudepluginhub', name: 'ClaudePluginHub', kind: 'mcp_registry',
    url: 'https://www.claudepluginhub.com/', probe: 'https://www.claudepluginhub.com/',
    reach: 'large', reach_note: '65K プラグイン。GitHub から自動発見',
    cost_usd: 0, kyc: false, registrable: 'auto', auto: true, fit: 0.6, state: 'not_listed', src: 'search',
    note: '提出不要。README をそのまま掲載面に使うので、1行目のホームページリンクが効く。',
  },
  {
    id: 'gemini_cli_gallery', name: 'Gemini CLI 拡張ギャラリー', kind: 'agent_directory',
    url: 'https://geminicli.com/extensions', probe: 'https://geminicli.com/extensions/browse/',
    publish_api: '提出不要: repo 直下の gemini-extension.json ＋ GitHub topic「gemini-cli-extension」をクローラが拾う',
    reach: 'medium', reach_note: '実測: 我々の repo jukky-source/wealth-agent は既に topic=gemini-cli-extension を持ち、gemini-extension.json も直下に存在＝索引対象',
    cost_usd: 0, kyc: false, registrable: 'auto', auto: true, fit: 0.6, state: 'probe_ok', src: 'self_measured',
    note: '全候補の中で唯一「人がまったく要らない」販路。条件は既に満たしている。',
  },
  {
    id: 'docker_mcp_catalog', name: 'Docker MCP Catalog', kind: 'mcp_registry',
    url: 'https://hub.docker.com/mcp', submit: 'https://github.com/docker/mcp-registry',
    reach: 'large', reach_note: 'Docker Desktop の MCP Toolkit に供給。審査後 約24時間で反映',
    cost_usd: 0, kyc: false, registrable: 'form', auto: false, fit: 0.7, state: 'manual_form', src: 'search',
    note: 'docker/mcp-registry への PR。remote サーバも可。PR は公開投稿＝承認の門（guardrail: publish_listing=approval）。',
  },
  {
    id: 'cline_marketplace', name: 'Cline MCP Marketplace', kind: 'mcp_registry',
    url: 'https://github.com/cline/mcp-marketplace', submit: 'https://github.com/cline/mcp-marketplace/issues',
    reach: 'medium', reach_note: 'Cline 内蔵。数百万開発者と自称',
    cost_usd: 0, kyc: false, registrable: 'form', auto: false, fit: 0.6, state: 'manual_form', src: 'search',
    note: 'GitHub Issue 提出（ロゴ400x400＋理由）。README をエージェントが読んで導入するので llms-install.md が効く（我々は既に持つ）。',
  },
  {
    id: 'awesome_mcp_servers', name: 'awesome-mcp-servers（PR）', kind: 'mcp_registry',
    url: 'https://github.com/punkpeye/awesome-mcp-servers',
    reach: 'huge', reach_note: '約90K スター。最も這われる一覧',
    cost_usd: 0, kyc: false, registrable: 'form', auto: false, fit: 0.5, state: 'manual_form', src: 'search',
    note: 'カテゴリに1行足して PR。AI エージェントの PR はタイトルに 🤖🤖🤖 で fast-track。公開投稿＝承認の門。',
  },
  {
    id: 'cursor_marketplace', name: 'Cursor Marketplace', kind: 'app_store',
    url: 'https://cursor.com/marketplace/publish',
    reach: 'large', reach_note: '200+ 連携。Cursor 内でワンクリック導入',
    cost_usd: 0, kyc: true, registrable: 'form', auto: false, fit: 0.6, state: 'blocked_human', src: 'search',
    note: 'publisher 申請＋全プラグイン手動審査＋OSS 必須。人が要る棚として分離。',
  },
  {
    id: 'x402_list', name: 'x402 List（エージェント優先ディレクトリ）', kind: 'x402_market',
    url: 'https://x402-list.com/', probe: 'https://x402-list.com/llms.txt', submit: 'https://x402-list.com/submit',
    publish_api: 'POST https://x402-list.com/api/v1/submit',
    reach: 'medium', reach_note: '実測: カテゴリ Data386/AI192/Verification136/Finance109/Blockchain75/Other56/Content46/Compute17。facilitator 39社の決済額をオンチェーン実測し公開（/api/v1/facilitators）',
    cost_usd: 1, kyc: false, registrable: 'api', auto: false, fit: 1.0, state: 'blocked_cost', src: 'self_measured',
    note: '一次情報: 自前ドメインからの提出は無料だが、workers.dev 等の無料ホスト上のサービスは一律 $1（返金・期限なし）。原価0の制約に触れるので人の判断待ち。$0.10 の提案箱 / $5 のサポート / $0.25 の assess / スポンサー週も同 API に同居。日本語オペレータ（Agentic JP）が既に掲載されている。',
  },
  {
    id: 'agent402_index', name: 'Agent402 オープン x402 索引', kind: 'x402_index',
    url: 'https://agent402.tools/api/find', probe: 'https://agent402.tools/api/leaderboard',
    reach: 'medium', reach_note: '実測: /api/leaderboard は7日窓で売り手3,023を走査、bazaar 26,024 品、1呼び出し上限 $0.75、上位25件を決済額順に公開',
    cost_usd: 0, kyc: false, registrable: 'none', auto: true, fit: 0.9, state: 'probe_ok', src: 'self_measured',
    note: '出品先ではなく「買い手側の独立計測面」。上位は多品番の一式だった（OnchainPulse 828 / x402.orthogonal 274 / market.datapackvibe 236 / BlockRun 119 endpoints）＝デパート化が実測でも勝ち筋。MIT で自前ホストも可（/api/find, /api/route）。',
  },
  {
    id: 'lobehub', name: 'LobeHub MCP ディレクトリ', kind: 'mcp_registry',
    url: 'https://lobehub.com/mcp',
    reach: 'medium', reach_note: '88K サーバの大型カタログ',
    cost_usd: 0, kyc: false, registrable: 'none', auto: false, fit: 0.5, state: 'blocked_human', src: 'search',
    note: '見送り（記録）: 掲載も claim も GitHub OAuth で全リポジトリの read/write を要求する唯一の経路。所有確認は他社なら DNS かリポジトリ内ファイルで足りる。権限を与えない判断。',
  },
];

export function venueById(id) {
  return BIG_VENUES.find((v) => v.id === id) || null;
}

export function venueScore(v) {
  const r = REACH_W[v.reach] ?? 0.2;
  const fit = Number(v.fit) || 0;
  const free = (Number(v.cost_usd) || 0) === 0 ? 1 : 0;
  const auto = v.auto ? 1 : 0;
  const parts = {
    reach: +(0.40 * r).toFixed(4),
    fit: +(0.30 * fit).toFixed(4),
    cost0: +(0.15 * free).toFixed(4),
    auto: +(0.15 * auto).toFixed(4),
  };
  const score = +(parts.reach + parts.fit + parts.cost0 + parts.auto).toFixed(4);
  return { score, parts };
}

export function venueBoard(origin = '') {
  // 提出URLには ?venue=<id> を焼いて渡す（提出した掲載から飛んでくる訪問の帰属が切れない）。
  // 元の submit は台帳のまま残し、焼き込みは submit_tagged として別フィールドにする。
  const tag = (u, id) => {
    if (!u || !/^https?:\/\//.test(String(u)) || String(u).includes('{payTo}')) return u || null;
    try {
      const sep = String(u).includes('?') ? '&' : '?';
      return `${String(u)}${sep}venue=${encodeURIComponent(id)}`;
    } catch { return u; }
  };
  return BIG_VENUES
    .map((v) => ({ ...v, ...venueScore(v), submit_tagged: (v.submit && origin) ? tag(v.submit, v.id) : (v.submit || null) }))
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
}

// 自動で行ける順（人の手が不要で原価0）
export function venueAutoQueue() {
  return venueBoard().filter((v) => v.auto && (Number(v.cost_usd) || 0) === 0 && !v.kyc);
}

// 人の1タップが要る順（原価0だがアカウント/鍵/提出が要る）
export function venueHumanQueue() {
  return venueBoard().filter((v) => !v.auto && (Number(v.cost_usd) || 0) === 0);
}

export function venueCounts() {
  const by_state = {};
  for (const v of BIG_VENUES) by_state[v.state] = (by_state[v.state] || 0) + 1;
  return { total: BIG_VENUES.length, by_state };
}

// 登録用APIを持つ配布路（原価0・鍵1本で機械が出せる）の一覧。鍵の発行だけが人の手。
export function venueRegistryPlan() {
  return BIG_VENUES
    .filter((v) => v.probe && v.publish_api && (Number(v.cost_usd) || 0) === 0)
    .map((v) => ({ id: v.id, name: v.name, probe: v.probe, publish_api: v.publish_api, fit: v.fit }))
    .sort((a, b) => b.fit - a.fit);
}

export function classifyVenue(status, body) {
  const st = Number(status) || 0;
  const b = String(body || '');
  if (st === 0 || st >= 500) return 'down';
  if (st === 404 || st === 410) return 'gone';
  if (st === 401 || st === 403 || st === 407) return 'needs_account';
  const low = b.toLowerCase();
  const apiish = /openapi|swagger|"x402"|x402\.org|facilitator|"resources"\s*:/.test(low);
  const submitish = /register|submit|sign[\s-]?up|create[\s-]?account|onboard|apply/.test(low);
  if (st < 400 && apiish && submitish) return 'probe_ok';
  if (/<form[\s>]/i.test(b) && submitish) return 'manual_form';
  if (st < 400) return 'page_only';
  return 'unknown';
}

const PROBE_TIMEOUT_MS = 6000;

export async function probeVenues({ fetchImpl, only, dry, env } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) return { ok: false, error: 'no_fetch' };
  const ids = Array.isArray(only) && only.length ? only.map(String) : BIG_VENUES.map((v) => v.id);
  const targets = BIG_VENUES.filter((v) => ids.includes(v.id));
  const results = [];
  if (dry) {
    return { ok: true, dry: true, planned: targets.map((v) => ({ id: v.id, url: v.submit || v.url })) };
  }
  for (const v of targets) {
    const target = v.probe || v.submit || v.url;
    const t0 = Date.now();
    let status = 0;
    let body = '';
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
      const res = await f(target, {
        method: 'GET',
        headers: { 'user-agent': 'WealthAgent/1.0 (+https://wealth-agent.wealthagent-app.workers.dev)' },
        signal: ac.signal,
      });
      clearTimeout(timer);
      status = res.status;
      body = (await res.text()).slice(0, 20000);
    } catch (e) {
      status = 0;
      body = '';
    }
    const signal = classifyVenue(status, body);
    results.push({ id: v.id, name: v.name, url: target, status, signal, ms: Date.now() - t0 });
  }
  const out = {
    ok: true,
    at: new Date().toISOString(),
    version: 'venues-1.0',
    probed: results.length,
    by_signal: results.reduce((a, r) => { a[r.signal] = (a[r.signal] || 0) + 1; return a; }, {}),
    results,
  };
  if (env && env.DB) {
    try {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)"
      ).run();
      await env.DB.prepare(
        "INSERT INTO settings (key,value) VALUES ('venues:last_probe', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).bind(JSON.stringify(out)).run();
    } catch (e) { /* 記録できなくても測定結果は返す */ }
  }
  return out;
}

export async function venueSnapshotLoad(env) {
  if (!env || !env.DB) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM settings WHERE key='venues:last_probe'"
    ).first();
    if (!row || !row.value) return null;
    const raw = typeof row.value === 'string' ? row.value : String(row.value);
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

export function venueBoardText() {
  const b = venueBoard();
  const lines = [];
  lines.push('venues-1.0 大手の売り場ボード（到達規模 × 適合 × 原価0 × 自動化）');
  lines.push('score  id                     reach   cost  自動  状態');
  for (const v of b) {
    lines.push(
      `${String(v.score).padEnd(6)} ${String(v.id).padEnd(22)} ${String(v.reach).padEnd(7)} ${String(v.cost_usd).padEnd(5)} ${(v.auto ? 'yes' : 'no ').padEnd(5)} ${v.state}`
    );
  }
  const auto = venueAutoQueue();
  const human = venueHumanQueue();
  lines.push('');
  lines.push(`自動で行ける: ${auto.length}件 -> ${auto.map((v) => v.id).join(', ')}`);
  lines.push(`人の1タップ: ${human.length}件 -> ${human.map((v) => v.id).join(', ')}`);
  return lines.join('\n');
}

export function venueHelp() {
  return [
    'GET /api/venues            売り場ボード（オーナー） ?format=text',
    'GET /api/venues/public     公開ボード（件数と上位のみ）',
    'POST /api/venues/probe     実測（{only:[id],dry:true}）',
    '',
    venueBoardText(),
  ].join('\n');
}
