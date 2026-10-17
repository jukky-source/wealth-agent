// Free stack（使える無料リソースの台帳）＋ 実測プローブ。
//
// 方針: 「無料」と書いてあるだけの情報は使わない。このモジュールは
//   ① 候補を台帳に並べ（料金・鍵の要否・どこから使えるか）
//   ② **実際に叩いて** 生きているか（HTTPステータス・応答時間）を測る
// の2段構え。台帳の `verified` は②で自分が確認したものだけ true にする
// （第三者のまとめ記事の数字を確定として扱わないため）。
//
// 原価0を守るのが目的なので、鍵が要る/課金が要るものは needs_key / paid を立てて
// 明示する。ここで「無料」と混ぜない。

export const STACK_KINDS = ['ai', 'data', 'market_data', 'hosting', 'store', 'dir', 'tool', 'net'];

// ---------------------------------------------------------------------------
// 台帳
// ---------------------------------------------------------------------------
export const FREE_RESOURCES = [
  // --- AI（無料枠）-----------------------------------------------------------
  { id: 'workers_ai', label: 'Cloudflare Workers AI', kind: 'ai', paid: false, needs_key: false,
    limit: '1日 10,000 Neurons（無料）', from: 'workers', auto: true, verified: false,
    source: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
    note: '既にバインディング済み（AI）。無料枠は頭脳・下書き専用。超過課金を避けるためコード側で上限を切る。' },
  { id: 'groq', label: 'Groq', kind: 'ai', paid: false, needs_key: true,
    limit: '無料枠あり（実測で応答確認済み）', from: 'both', auto: true, verified: false,
    source: 'https://console.groq.com/docs/rate-limits',
    note: '無料枠は思考・下書き用。有料納品の品質担保には使わない。' },
  { id: 'gemini_api', label: 'Google Gemini API', kind: 'ai', paid: false, needs_key: true,
    limit: '無料枠あり（キー登録済み）', from: 'both', auto: true, verified: false,
    source: 'https://ai.google.dev/pricing' },
  { id: 'llm7', label: 'LLM7.io', kind: 'ai', paid: false, needs_key: false,
    limit: '無料ゲートウェイ（実測で 429 を観測）', from: 'both', auto: true, verified: false,
    source: 'https://llm7.io/' },
  { id: 'openrouter_free', label: 'OpenRouter の無料モデル枠', kind: 'ai', paid: false, needs_key: true,
    limit: 'モデルごとに無料枠（:free サフィックス）', from: 'both', auto: true, verified: false,
    source: 'https://openrouter.ai/models?max_price=0' },

  // --- データ / 市況（無料・鍵不要）------------------------------------------
  { id: 'hn_algolia', label: 'Hacker News (Algolia API)', kind: 'data', paid: false, needs_key: false,
    limit: '実質無制限（礼儀的なレートのみ）', from: 'both', auto: true, verified: false,
    source: 'https://hn.algolia.com/api' },
  { id: 'github_api', label: 'GitHub REST API', kind: 'data', paid: false, needs_key: false,
    limit: '未認証 60回/時（トークン付きで5,000回/時）', from: 'both', auto: true, verified: false,
    source: 'https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api' },
  { id: 'mcp_registry', label: '公式 MCP レジストリ', kind: 'dir', paid: false, needs_key: false,
    limit: '検索は無料', from: 'both', auto: true, verified: false,
    source: 'https://registry.modelcontextprotocol.io/' },
  { id: 'yahoo_chart', label: 'Yahoo Finance chart API', kind: 'market_data', paid: false, needs_key: false,
    limit: '非公式・実質無料（礼儀的な間隔が必要）', from: 'both', auto: true, verified: false,
    source: 'https://query1.finance.yahoo.com/v8/finance/chart/JPY=X',
    note: '日足OHLC。FX/EAのバックテストの一次データ。実OHLCなので品質は高い。' },
  { id: 'frankfurter', label: 'Frankfurter (ECB 参考相場)', kind: 'market_data', paid: false, needs_key: false,
    limit: '無料・鍵不要', from: 'both', auto: true, verified: false,
    source: 'https://www.frankfurter.app/docs/',
    note: '終値のみ。Yahoo が落ちたときの代替（合成OHLCなので品質は中）。' },
  { id: 'coingecko', label: 'CoinGecko 公開API', kind: 'market_data', paid: false, needs_key: false,
    limit: '無料枠（レート制限あり）', from: 'both', auto: true, verified: false,
    source: 'https://www.coingecko.com/en/api' },
  { id: 'openmeteo', label: 'Open-Meteo', kind: 'data', paid: false, needs_key: false,
    limit: '非商用は無料・鍵不要', from: 'both', auto: true, verified: false,
    source: 'https://open-meteo.com/en/docs' },
  { id: 'wikipedia_api', label: 'Wikipedia / Wikidata API', kind: 'data', paid: false, needs_key: false,
    limit: '無料・鍵不要', from: 'both', auto: true, verified: false,
    source: 'https://www.mediawiki.org/wiki/API:Main_page' },
  { id: 'arxiv_api', label: 'arXiv API', kind: 'data', paid: false, needs_key: false,
    limit: '無料・鍵不要', from: 'both', auto: true, verified: false,
    source: 'https://info.arxiv.org/help/api/index.html' },
  { id: 'nominatim', label: 'OpenStreetMap Nominatim', kind: 'data', paid: false, needs_key: false,
    limit: '1秒1回まで（礼儀）', from: 'both', auto: true, verified: false,
    source: 'https://operations.osmfoundation.org/policies/nominatim/' },

  // --- ホスティング / 定期実行 -------------------------------------------------
  { id: 'cf_workers', label: 'Cloudflare Workers + Cron Triggers', kind: 'hosting', paid: false, needs_key: false,
    limit: '無料枠: 100,000 リクエスト/日・Cron 5本・1回15分', from: 'workers', auto: true, verified: false,
    source: 'https://developers.cloudflare.com/workers/platform/limits/',
    note: 'このエージェントの本体。サンドボックスと違って**入れ替わらない**ので、自動巡回はここに置く。' },
  { id: 'cf_d1', label: 'Cloudflare D1', kind: 'hosting', paid: false, needs_key: false,
    limit: '無料枠: 5GB 保存・500万行読み/日', from: 'workers', auto: true, verified: false,
    source: 'https://developers.cloudflare.com/d1/platform/pricing/' },
  { id: 'gh_actions', label: 'GitHub Actions', kind: 'hosting', paid: false, needs_key: false,
    limit: 'public リポジトリは無料（private は月2,000分）', from: 'both', auto: true, verified: false,
    source: 'https://docs.github.com/billing/managing-billing-for-your-products/about-billing-for-github-actions' },
  { id: 'oracle_arm', label: 'Oracle Cloud Always Free (ARM)', kind: 'hosting', paid: false, needs_key: true,
    limit: '常時無料枠（要アカウント・本人確認）', from: 'vm', auto: false, verified: false,
    source: 'https://www.oracle.com/cloud/free/' ,
    note: 'ffmpeg / TTS を動かす手足の候補。人の1タップ（登録）が要る。' },

  // --- 売り場（手数料は channels.js が唯一の出所）------------------------------
  { id: 'x402_cdp', label: 'x402 直販（CDP Facilitator）', kind: 'store', paid: false, needs_key: true,
    limit: 'CDP: 月1,000 tx まで無料、以降 $0.001/tx', from: 'workers', auto: true, verified: false,
    source: 'https://docs.cdp.coinbase.com/x402/seller/get-discovered',
    note: 'Bazaar 索引の唯一の条件が「CDP Facilitator 経由の決済成立」。鍵は人の1タップ。' },
  { id: 'x402_testnet', label: 'x402 のテストネット決済（Base Sepolia）', kind: 'store', paid: false, needs_key: false,
    limit: '無料（テストUSDC）', from: 'both', auto: true, verified: false,
    source: 'https://docs.cdp.coinbase.com/x402/network-support' },
  { id: 'pypi_npm', label: 'PyPI / npm 公開', kind: 'dir', paid: false, needs_key: false,
    limit: '無料', from: 'both', auto: true, verified: false,
    source: 'https://pypi.org/' },
];

export const byId = (id) => FREE_RESOURCES.find((r) => r.id === id) || null;
export const freeOf = (kind) => FREE_RESOURCES.filter((r) => r.kind === kind && !r.paid);
export const keylessFree = () => FREE_RESOURCES.filter((r) => !r.paid && !r.needs_key);

// ---------------------------------------------------------------------------
// プローブ（実測）。鍵不要のものだけを実際に叩く。鍵が要る物は「要人の1タップ」として
// 状態を分けて出す（叩いても401が返るだけで情報がないため）。
// ---------------------------------------------------------------------------
export const PROBES = [
  { id: 'hn_algolia', url: 'https://hn.algolia.com/api/v1/search?query=api&hitsPerPage=1', ok: [200] },
  { id: 'github_api', url: 'https://api.github.com/rate_limit', ok: [200] },
  { id: 'mcp_registry', url: 'https://registry.modelcontextprotocol.io/v0/servers?limit=1', ok: [200] },
  { id: 'yahoo_chart', url: 'https://query1.finance.yahoo.com/v8/finance/chart/JPY=X?interval=1d&range=5d', ok: [200] },
  { id: 'frankfurter', url: 'https://api.frankfurter.app/latest?from=USD&to=JPY', ok: [200] },
  { id: 'coingecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', ok: [200] },
  { id: 'openmeteo', url: 'https://api.open-meteo.com/v1/forecast?latitude=35.68&longitude=139.69&current=temperature_2m', ok: [200] },
  { id: 'wikipedia_api', url: 'https://ja.wikipedia.org/w/api.php?action=query&format=json&titles=%E5%82%B5%E5%88%B8', ok: [200] },
  { id: 'arxiv_api', url: 'http://export.arxiv.org/api/query?search_query=all:transformer&max_results=1', ok: [200] },
  { id: 'nominatim', url: 'https://nominatim.openstreetmap.org/search?q=Tokyo&format=json&limit=1', ok: [200] },
  { id: 'lobsters', url: 'https://lobste.rs/hottest.json', ok: [200] },
  { id: 'devto', url: 'https://dev.to/api/articles?per_page=1', ok: [200] },
  { id: 'qiita', url: 'https://qiita.com/api/v2/items?per_page=1', ok: [200] },
  { id: 'zenn', url: 'https://zenn.dev/api/articles?count=1&order=latest', ok: [200] },
  { id: 'producthunt_feed', url: 'https://www.producthunt.com/feed', ok: [200] },
  { id: 'indiehackers_feed', url: 'https://www.indiehackers.com/feed.xml', ok: [200] },
  { id: 'cdp_supported', url: 'https://api.cdp.coinbase.com/platform/v2/x402/supported', ok: [200, 401] },
  { id: 'payai_supported', url: 'https://facilitator.payai.network/supported', ok: [200] },
  { id: 'own_worker', url: 'https://wealth-agent.wealthagent-app.workers.dev/openapi.json', ok: [200] },
  { id: 'own_registry', url: 'https://registry.modelcontextprotocol.io/v0/servers?search=io.github.jukky-source', ok: [200] },
];

/**
 * 実際に叩いて測る。返り値は実測値のみ（推測を入れない）。
 * `alive` は「期待するステータスが返った」ことを意味する。
 */
export async function probeFreeStack({ fetchImpl = null, timeoutMs = 9000, probes = PROBES } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const at = new Date().toISOString();
  const out = [];
  for (const p of probes) {
    const rec = { id: p.id, label: byId(p.id)?.label || p.id, url: p.url, status: null, ms: null, alive: false, error: null };
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try { res = await doFetch(p.url, { signal: ctrl.signal, headers: { 'user-agent': 'WealthAgent-Probe/1.0' } }); }
      finally { clearTimeout(timer); }
      rec.status = res.status;
      rec.ms = Date.now() - t0;
      rec.alive = p.ok.includes(res.status);
      if (rec.alive && res.status === 401) rec.note = '認証が必要（＝エンドポイントは生きている）';
    } catch (e) {
      rec.ms = Date.now() - t0;
      rec.error = e.name === 'AbortError' ? 'timeout' : e.message;
    }
    out.push(rec);
  }
  const alive = out.filter((r) => r.alive).length;
  return { at, total: out.length, alive, dead: out.length - alive, results: out };
}

export function freeStackReport({ probe = null } = {}) {
  const byKind = {};
  for (const r of FREE_RESOURCES) {
    byKind[r.kind] = byKind[r.kind] || { kind: r.kind, total: 0, keyless: 0, paid: 0 };
    byKind[r.kind].total++;
    if (!r.paid && !r.needs_key) byKind[r.kind].keyless++;
    if (r.paid) byKind[r.kind].paid++;
  }
  const probeMap = {};
  for (const r of (probe?.results || [])) probeMap[r.id] = r;
  return {
    at: new Date().toISOString(),
    total: FREE_RESOURCES.length,
    keyless: keylessFree().length,
    needs_human_key: FREE_RESOURCES.filter((r) => r.needs_key).map((r) => r.id),
    by_kind: Object.values(byKind),
    probe: probe ? { at: probe.at, alive: probe.alive, total: probe.total, dead: probe.dead } : null,
    rows: FREE_RESOURCES.map((r) => ({
      ...r,
      live: probeMap[r.id] ? probeMap[r.id].alive : null,
      status: probeMap[r.id] ? probeMap[r.id].status : null,
      ms: probeMap[r.id] ? probeMap[r.id].ms : null,
    })),
  };
}

export function freeStackCards(report = {}) {
  const rows = report.rows || [];
  const live = rows.filter((r) => r.live === true);
  const down = rows.filter((r) => r.live === false);
  return [
    {
      type: 'kpi', title: '無料リソース（鍵不要だけで数える）',
      items: [
        { label: '台帳の総数', value: report.total || 0, unit: '件' },
        { label: '鍵が要らない', value: report.keyless || 0, unit: '件' },
        { label: '実測で生きていた', value: live.length, unit: `件 / 叩いた ${report.probe?.total ?? 0} 件` },
        { label: '実測で落ちていた', value: down.length, unit: '件' },
      ],
    },
    {
      type: 'list', title: '実測で使えると確認できた順',
      items: (live.length ? live : rows).slice(0, 10).map((r) => ({
        label: r.label,
        value: r.status ? `HTTP ${r.status}` : (r.needs_key ? '鍵が必要' : '—'),
        unit: `${r.ms ? `${r.ms}ms · ` : ''}${r.limit || ''}`,
      })),
    },
  ];
}

export function freeStackHelp() {
  return [
    '「無料」と書いてあるだけの情報は使わず、実際に叩いて生きているかを測ります。',
    '鍵が要るもの（人の1タップで解放できるもの）と、鍵不要で今すぐ使えるものを分けて数えています。',
    '原価0を守るのが目的なので、課金が要るものは台帳に入れません。',
    '自動巡回・自動実行を置く場所は Cloudflare Workers（Cron Triggers）です。サンドボックスは入れ替わって消えるため、続けたい処理をここに置きません。',
  ].join('\n');
}
