// 販路ポートフォリオ・ループ（sales loop）— sales-1.0
//
// 問い: 「なぜ売上が立たないのか」。この問いに1つの販路だけを眺めて答えるのをやめる。
//
// すべての販路に同じ漏斗を当てる:
//   listed   … 掲載されている（売り場・索引・名簿に我々が居る）
//   quote    … 値札が返る（未払いの呼び出しに 402 と価格表を返せている）
//   traffic  … 呼ばれた（誰かが実際に叩いた）
//   paid     … 払われた（オンチェーンで決済が成立した）
//   settled  … 入金（自前でない相手の金が台帳に入った）
//
// 最初に 0 になる段が「壁」。壁ごとに打ち手を1対1で決めて、全販路を同時に打つ。
// 1ラウンド = 全販路を測る → 壁を名指しする → 期待値順に打ち手を実行する → 記録する。
//
// 原価0の制約:
//   * 読み取り（自分の資源の疎通確認、公開索引の照会）と、自前資源への書き込みだけ。
//   * 金が要る打ち手・人手が要る打ち手は level='approve' / 'human_only' で止め、
//     「押すだけ」の形にして記録に残す。勝手に使い込まない。

import { nowIso } from '../util.js';
import { setting, setSetting } from '../db.js';

export const SALES_VERSION = 'sales-1.0';
export const SR = 'sales_rounds';
export const SSTATE_KEY = 'sales:state';
export const SCURSOR_KEY = 'sales:cursor';
export const HIST_MAX = 12;

const num = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const rid = () => `sal_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** 漏斗の段。金額に近い段ほど、詰まると痛い。 */
export const STAGES = ['listed', 'quote', 'traffic', 'paid', 'settled'];
export const STAGE_LABEL = {
  listed: '掲載', quote: '値札', traffic: '呼ばれた', paid: '払われた', settled: '入金', repeat: '再購入', unmeasured: '未測定',
};
const STAGE_WEIGHT = { listed: 9, quote: 10, traffic: 7, paid: 8, settled: 4, repeat: 2, unmeasured: 1 };

/** 未払いの値札を確かめるときに送る、最小の妥当な入力。 */
const PROBE_BODY = {
  brief: { question: 'x402 に対応した facilitator を比較して' },
  'data-clean': { csv: 'name,age\nAlice,30' },
  'code-review': { code: 'const a = 1;\n', language: 'javascript' },
  'url-meta': { url: 'https://example.com' },
  'csv-json': { csv: 'a,b\n1,2' },
  regex: { text: 'abc 123', pattern: '\\d+' },
  diff: { a: 'line1\nline2', b: 'line1\nline3' },
  'rea-report': { url: 'https://example.com' },
  'surface-report': { url: 'https://example.com' },
};

const originOf = (env = {}) => String((env && (env.AGENT_ORIGIN || env.PUBLIC_ORIGIN)) || 'https://wealth-agent.wealthagent-app.workers.dev').replace(/\/+$/, '');

async function getJson(url, ms = 6000, headers = {}) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'WealthAgent-Sales/1.0', ...headers }, signal: AbortSignal.timeout(ms) });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch { /* 非JSON はそのまま */ }
    return { status: r.status, json: j, text: t };
  } catch (e) {
    return { status: 0, json: null, text: '', error: String((e && e.message) || e).slice(0, 120) };
  }
}

async function q1(store, sql, ...params) {
  try { const r = await store.first(sql, ...params); return r || null; } catch { return null; }
}

/** 台帳の外部収益（自己テストを除く）。ここが 0 なら、まだ一度も外から銭が来ていない。 */
async function externalRevenue(store) {
  const r = await q1(store, `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt FROM ledger WHERE kind='revenue' AND basis <> 'self_test'`);
  const self = await q1(store, `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt FROM ledger WHERE kind='revenue' AND basis='self_test'`);
  return {
    external_n: num(r && r.n, 0), external_amount: num(r && r.amt, 0),
    self_test_n: num(self && self.n, 0), self_test_amount: num(self && self.amt, 0),
  };
}

/** 呼び出しの実測（x402_hits）。クローラーと人間・買い手を分けて数える。 */
async function trafficStats(store) {
  const rows = await store.all(`SELECT kind, COUNT(*) AS n FROM x402_hits GROUP BY kind`).catch(() => []);
  const byKind = {};
  for (const r of (rows || [])) byKind[String(r.kind)] = num(r.n, 0);
  const total = Object.values(byKind).reduce((a, b) => a + b, 0);
  const callers = await q1(store, `SELECT COUNT(DISTINCT caller) AS n FROM x402_hits WHERE COALESCE(caller,'') <> ''`);
  const bot = await q1(store, `SELECT COUNT(*) AS n FROM x402_hits WHERE instr(lower(COALESCE(ua,'')),'bot') > 0 OR instr(lower(COALESCE(ua,'')),'crawler') > 0 OR instr(lower(COALESCE(ua,'')),'observer') > 0 OR instr(lower(COALESCE(ua,'')),'probe') > 0 OR instr(lower(COALESCE(ua,'')),'bazaar') > 0`);
  const human = await q1(store, `SELECT COUNT(*) AS n FROM x402_hits WHERE COALESCE(note,'') <> 'self_test' AND instr(lower(COALESCE(ua,'')),'bot') = 0 AND instr(lower(COALESCE(ua,'')),'crawler') = 0 AND instr(lower(COALESCE(ua,'')),'observer') = 0 AND instr(lower(COALESCE(ua,'')),'probe') = 0 AND instr(lower(COALESCE(ua,'')),'bazaar') = 0 AND instr(lower(COALESCE(ua,'')),'wealthagent') = 0`);
  const callersExt = await q1(store, `SELECT COUNT(DISTINCT caller) AS n FROM x402_hits WHERE COALESCE(caller,'') <> '' AND instr(lower(COALESCE(ua,'')),'wealthagent') = 0 AND COALESCE(note,'') <> 'self_test'`);
  return { total, by_kind: byKind, distinct_callers: num(callers && callers.n, 0), callers_external: num(callersExt && callersExt.n, 0), bot_like: num(bot && bot.n, 0), non_bot: num(human && human.n, 0) };
}

/**
 * 販路の定義。measure は事実だけを返し、壁の判断は diagnose() が行う。
 * walls は段ごとの「なぜ詰まるか → どう打つか」。level は allow（原価0・無人可）/ approve（人の1タップ）/ human_only。
 */
export const CHANNELS = [
  {
    key: 'x402_direct',
    label: 'x402 直販（自前API 9ルート）',
    kind: '直販',
    autonomy: 'full',
    cost: 0,
    currency: 'USDC',
    what: '値札を出し、払われたら即納品する HTTP 402 の直販。手数料ゼロ。',
    walls: {
      listed: { why: '売り物の定義（openapi / well-known）が外から読めていない', fix: '発見用の面を自前で叩いて欠けを直す', action: 'quote_probe', level: 'allow' },
      quote: { why: '未払いの呼び出しに 402 と価格表を返せていない（値札が壊れている）', fix: '9ルートを実叩きして、402を返さない経路と価格のずれを名指しする', action: 'quote_probe', level: 'allow' },
      traffic: { why: '誰も呼んでいない。索引には居るが、入口が無い', fix: '値札の中身（説明・出力スキーマ・例）を充実させ、索引の順位と発見面を上げる', action: 'expose_boost', level: 'allow' },
      paid: { why: '呼ばれるが払われない。買う側の決済が通っていない', fix: '実決済を通して経路の健全性を確かめ、失敗する条件（説明文長・チェーン・金額）を潰す', action: 'quote_probe', level: 'allow' },
      settled: { why: '自前の決済しか無く、外からの入金が無い', fix: '買い手が付く露出を作る（下流索引・売り場・名簿への追加）', action: 'expose_boost', level: 'allow' },
      repeat: { why: '1件は入ったが、買い手が1人しかいない（単発で終わる）', fix: '最安ルート（買われた商品）を入口として増やし、買い手の数を増やす', action: 'expose_boost', level: 'allow' },
    },
    async measure(ctx) {
      const { env, store } = ctx;
      const origin = originOf(env);
      const cat = await getJson(`${origin}/api/x402/catalog.json`);
      let items = (cat.json && Array.isArray(cat.json.items)) ? cat.json.items : [];
      let httpFaces = items.length ? 1 : 0;
      const disc = await getJson(`${origin}/openapi.json`);
      const wk = await getJson(`${origin}/.well-known/x402.json`);
      if (disc.status === 200) httpFaces += 1;
      if (wk.status === 200) httpFaces += 1;
      // Worker は自分自身の hostname を fetch できない（Cloudflare が自前 fetch を拒否する）。
      // 外から測った面の数だけを信じると 0 になり、健全な売り物を「掲載 0」と誤診する（ラウンド毎に揺れた実例あり）。
      // 配備物そのものをその場で構成し、面の実在を毎回確かめる。外から測れた数と、その場の数の多い方を採る。
      let localFaces = 0;
      let selfError = null;
      try {
        const X = await import('./x402.js');
        const D = await import('./discovery.js');
        const local = X.catalog ? X.catalog(env) : X.X402_CATALOG;
        if (Array.isArray(local) && local.length) {
          localFaces += 1;
          if (!items.length) items = local.map((i) => ({ resource: i.resource, price: i.price, method: i.method || 'POST' }));
        }
        const oa = D.openapi ? D.openapi(env, origin) : null;
        if (oa && oa.paths) localFaces += 1;
        const dm = D.discoveryManifest ? D.discoveryManifest(env, origin) : null;
        if (dm) localFaces += 1;
      } catch (e) { selfError = String((e && e.message) || e).slice(0, 120); }
      const faces = Math.max(httpFaces, localFaces);
      const listed = faces >= 2 ? 1 : 0;
      // 値札: 9ルートを未払いで叩き、402 が返るか。入力不一致(400)は「値札以前」の別問題として区別する。
      let probe = await quoteProbe(origin, items.map((i) => i.resource).filter(Boolean));
      if (probe.ok_count === 0) {
        try {
          const X = await import('./x402.js');
          const pf = X.preflight ? await X.preflight(env) : null;
          const built = [];
          for (const it of items) {
            try {
              const ch = X.challenge ? X.challenge(it.resource, env, { origin }) : null;
              const a = (ch && ch.accepts) || [];
              if (a.length && Number(a[0].amount) > 0) built.push(it.resource);
            } catch (e) { /* その資源は数えない */ }
          }
          if (built.length) {
            probe = { ...probe, ok_count: built.length, built, self_fallback: true,
              note: `自前 fetch 不可（${probe.self_fetch_blocked ? 'Cloudflare が自前 fetch を拒否' : `${probe.other_count} 本が到達不能`}）のため、その場で値札を構成して確認` };
          } else if (pf && !pf.ok) {
            probe = { ...probe, ok_count: 0, note: `値札を構成できない: ${pf.reason || pf.error}` };
          }
        } catch (e) { /* 代替できないときは 0 のまま */ }
      }
      // 自前 fetch が拒否される環境では、値札の健全性はその場の preflight で確かめる。
      if (probe.ok_count === 0 && probe.self_fetch_blocked) {
        try {
          const X = await import('./x402.js');
          const pf = X.preflight ? await X.preflight(env) : null;
          const n = items.length;
          if (pf && pf.ok && n > 0) {
            probe = { ...probe, ok_count: n, self_fallback: 'preflight', broken: [],
              note: `Cloudflare が自前 fetch を拒否するため外からは測れない。その場の preflight は健全（${pf.network_name || pf.caip2} / ${n} ルート）` };
          } else {
            probe = { ...probe, broken: [], note: `値札を構成できない: ${(pf && (pf.reason || pf.error)) || 'preflight 不明'}` };
          }
        } catch (e) { probe = { ...probe, broken: [], note: '自前 fetch 不可・preflight も取れず（未測定）' }; }
      }
      const t = await trafficStats(store);
      const rev = await externalRevenue(store);
      return {
        listed,
        quote: probe.ok_count > 0 ? 1 : 0,
        traffic: t.non_bot > 0 ? 1 : 0,
        paid: t.by_kind && (t.by_kind.settle || t.by_kind.paid) ? 1 : 0,
        settled: rev.external_n > 0 ? 1 : 0,
        evidence: {
          routes_total: items.length, routes_402: probe.ok_count, routes_400: probe.bad_input_count,
          routes_error: probe.err_count, broken: probe.broken.slice(0, 9),
          openapi: disc.status, well_known: wk.status, faces, faces_http: httpFaces, faces_local: localFaces, self_error: selfError,
          self_fallback: probe.self_fallback === true,
          hits_kind: t.by_kind, hits_non_bot: t.non_bot, callers: t.distinct_callers, callers_external: t.callers_external,
          revenue_external: rev.external_amount, revenue_self_test: rev.self_test_amount,
        },
        notes: probe.note ? [probe.note] : [],
      };
    },
  },
  {
    key: 'cdp_bazaar',
    label: 'CDP Bazaar（Coinbase 公式索引）',
    kind: '索引',
    autonomy: 'full',
    cost: 0,
    currency: 'USDC',
    what: 'CDP Facilitator が決済から自動で作るカタログ。登録フォームは無い。',
    walls: {
      listed: { why: '索引に載っていない（決済が索引の引き金なので、決済が要る）', fix: '実決済で索引を発火させる', action: 'index_probe', level: 'allow' },
      quote: { why: '索引は在るが値札が壊れており、買い手が決済できない', fix: '値札の実測（description長・chain・金額）を確認する', action: 'index_probe', level: 'allow' },
      traffic: { why: '索引に居るのに呼ばれない（順位か説明が弱い）', fix: '説明・出力スキーマ・メタデータを充実させ、検索順位を上げる', action: 'expose_boost', level: 'allow' },
      paid: { why: '呼ばれるが決済に至らない', fix: '買い手側の条件（チェーン・金額上限）との噛み合わせを確かめる', action: 'index_probe', level: 'allow' },
      settled: { why: '外部買い手の入金が無い', fix: '露出を増やして買い手に届く面を作る', action: 'index_probe', level: 'allow' },
    },
    async measure(ctx) {
      const { env } = ctx;
      const payTo = String((env && env.X402_PAY_TO) || '0x3291398dC7070472CF2ED2e757246d089760Ca91');
      const r = await cdpMerchant(env, payTo);
      const t = await trafficStats(ctx.store);
      const rev = await externalRevenue(ctx.store);
      return {
        listed: r.count > 0 ? 1 : 0,
        quote: r.count > 0 ? 1 : 0,
        traffic: t.non_bot > 0 ? 1 : 0,
        paid: t.by_kind && (t.by_kind.settle || t.by_kind.paid) ? 1 : 0,
        settled: rev.external_n > 0 ? 1 : 0,
        evidence: { indexed: r.count, status: r.status, error: r.error || null, pay_to: payTo, revenue_self_test: rev.self_test_amount },
        notes: r.note ? [r.note] : [],
      };
    },
  },
  {
    key: 'payai_bazaar',
    label: 'PayAI Bazaar（facilitator.payai.network）',
    kind: '索引',
    autonomy: 'full',
    cost: 0,
    currency: 'USDC',
    what: 'PayAI の facilitator が公開する discovery リスト。payTo で自分の分を数えられる。',
    walls: {
      listed: { why: 'payTo に紐づく掲載が 0 件', fix: 'verify 形の支払いを1回通して索引を更新させる', action: 'index_probe_payai', level: 'allow' },
      quote: { why: '掲載は在るが値札が壊れている', fix: '値札の実測を確認する', action: 'index_probe_payai', level: 'allow' },
      traffic: { why: '掲載は在るのに呼ばれない', fix: '説明文と例を充実させる', action: 'expose_boost', level: 'allow' },
      paid: { why: '呼ばれるが払われない', fix: '決済条件の噛み合わせを確かめる', action: 'index_probe_payai', level: 'allow' },
      settled: { why: '外部買い手の入金が無い', fix: '露出を増やす', action: 'index_probe_payai', level: 'allow' },
    },
    async measure(ctx) {
      const { env } = ctx;
      const payTo = String((env && env.X402_PAY_TO) || '0x3291398dC7070472CF2ED2e757246d089760Ca91');
      const r = await getJson(`https://facilitator.payai.network/discovery/resources?limit=200&payTo=${payTo}`, 8000);
      const items = (r.json && (r.json.items || r.json.resources)) || [];
      const ours = items.filter((x) => JSON.stringify(x).toLowerCase().includes(payTo.toLowerCase())).length;
      const t = await trafficStats(ctx.store);
      const rev = await externalRevenue(ctx.store);
      const settle = num((await q1(ctx.store, `SELECT COUNT(*) AS n FROM x402_hits WHERE kind IN ('settle','paid')`))?.n, 0);
      return {
        listed: r.status === 200 ? (items.length ? 1 : 0) : 0,
        quote: r.status === 200 ? (ours ? 1 : 0) : 0,
        traffic: t.non_bot > 0 ? 1 : 0,
        paid: settle > 0 ? 1 : 0,
        settled: rev.external_n > 0 ? 1 : 0,
        evidence: { status: r.status, returned: items.length, ours, error: r.error || null },
        notes: r.error ? [`取得失敗: ${r.error}`] : [],
      };
    },
  },
  {
    key: 'payapi_market',
    label: 'PayAPI Market（掲載無料・取り分100%）',
    kind: '売り場',
    autonomy: 'partial',
    cost: 0,
    currency: 'USDC',
    what: 'x402 の pay-per-call 売り場。掲載は無料で、提供者が売上の100%を取る。掲載は提出フォーム。',
    external: true,
    submit_url: 'https://payapi.market/list',
    walls: {
      listed: { why: 'この売り場に我々が居ない（掲載が提出制）', fix: '掲載に必要な情報（origin・ルート・価格・402の実応答）を1枚にまとめ、提出できる形にする', action: 'listing_prep', level: 'approve' },
      quote: { why: '掲載済みだが値札が読めていない', fix: '値札を実測する', action: 'listing_prep', level: 'allow' },
      traffic: { why: '掲載済みだが呼ばれない', fix: '説明を充実させる', action: 'listing_prep', level: 'allow' },
      paid: { why: '呼ばれるが払われない', fix: '決済条件を確かめる', action: 'listing_prep', level: 'allow' },
      settled: { why: 'この売り場経由の入金が無い', fix: '掲載面を増やす', action: 'listing_prep', level: 'allow' },
    },
    async measure(ctx) {
      const origin = originOf(ctx.env);
      const [list, mcp, ours] = await Promise.all([
        getJson('https://payapi.market/agent/list?limit=100', 8000),
        getJson('https://payapi.market/openapi.json', 8000),
        getJson(`${origin}/openapi.json`, 6000),
      ]);
      const hay = `${list.text || ''}`.toLowerCase();
      const present = hay.includes('wealthagent-app') || hay.includes('wealth-agent');
      return {
        listed: present ? 1 : 0,
        quote: ours.status === 200 ? 1 : 0,
        traffic: 0, paid: 0, settled: 0,
        evidence: {
          marketplace_agent_api: list.status, marketplace_openapi: mcp.status, our_openapi: ours.status,
          note: '掲載は提出制（自動登録の口は無い）',
        },
        notes: list.error ? [`売り場の照会に失敗: ${list.error}`] : [],
      };
    },
  },
  {
    key: 'agent402',
    label: 'agent402（ルーター順位）',
    kind: '索引',
    autonomy: 'full',
    cost: 0,
    currency: 'USDC',
    what: 'クエリに応じて売り手を並べるルーター。順位が買われる確率を決める。',
    walls: {
      listed: { why: 'ルーターに登録されていない', fix: 'origin を登録する', action: 'rank_probe', level: 'allow' },
      quote: { why: '登録は在るが順位が低い', fix: 'クエリ語との一致（slug・name・説明）を増やす', action: 'rank_probe', level: 'allow' },
      traffic: { why: '順位は在るが呼ばれない', fix: '上位クエリを増やす', action: 'rank_probe', level: 'allow' },
      paid: { why: '呼ばれるが払われない', fix: 'ルーターの決済上限（1コール $0.01）との噛み合わせを確かめる', action: 'rank_probe', level: 'allow' },
      settled: { why: '入金が無い', fix: '露出を増やす', action: 'rank_probe', level: 'allow' },
    },
    async measure(ctx) {
      const queries = String((ctx.env && ctx.env.SALES_AGENT402_QUERIES) || 'code review,research brief,run a regex on text').split(',').map((s) => s.trim()).filter(Boolean);
      const cursor = num(await setting(ctx.store, SCURSOR_KEY, 0).catch(() => 0), 0);
      const q = queries[cursor % Math.max(1, queries.length)];
      await setSetting(ctx.store, SCURSOR_KEY, (cursor + 1) % Math.max(1, queries.length)).catch(() => {});
      const r = await getJson(`https://agent402.tools/api/route?q=${encodeURIComponent(q)}`, 9000);
      const cands = (r.json && (r.json.candidates || r.json.results || r.json.routes || r.json.items)) || [];
      let rank = null; let score = null;
      cands.forEach((c, i) => {
        const s = JSON.stringify(c).toLowerCase();
        if (rank === null && (s.includes('wealthagent-app') || s.includes('wealth-agent'))) { rank = i + 1; score = num((c.why && c.why.score), 0); }
      });
      const listed = r.status === 200 ? 1 : 0;
      const top = rank === 1 ? 1 : 0;
      const t = await trafficStats(ctx.store);
      return {
        listed,
        quote: listed,
        traffic: top || t.non_bot > 0 ? 1 : 0,
        paid: num((await q1(ctx.store, `SELECT COUNT(*) AS n FROM x402_hits WHERE kind IN ('settle','paid')`))?.n, 0) > 0 ? 1 : 0,
        settled: (await externalRevenue(ctx.store)).external_n > 0 ? 1 : 0,
        evidence: { query: q, status: r.status, returned: cands.length, our_rank: rank, our_score: score, top: cands[0] ? (cands[0].url || cands[0].resource || null) : null, error: r.error || null },
        notes: r.status === 429 ? ['ルーターが 429（間隔を空けて再測）'] : [],
      };
    },
  },
  {
    key: 'mcp_registry',
    label: 'MCP 経由（公式レジストリ / エージェント実行環境）',
    kind: '索引',
    autonomy: 'full',
    cost: 0,
    currency: 'USDC',
    what: 'MCP のツール一覧（/mcp）と公式レジストリの登録。呼ばれる入口を増やす。',
    walls: {
      listed: { why: 'レジストリに我々のサーバーが無い', fix: '登録の可否と現在の掲載状態を実測する', action: 'registry_probe', level: 'allow' },
      quote: { why: 'ツール一覧は在るが、価格の見え方が足りない', fix: 'MCP tools/list の説明に価格と例を入れる', action: 'registry_probe', level: 'allow' },
      traffic: { why: 'MCP から呼ばれていない', fix: 'ツール説明と発見面を充実させる', action: 'registry_probe', level: 'allow' },
      paid: { why: 'MCP 経由で払われない', fix: '決済導線を確かめる', action: 'registry_probe', level: 'allow' },
      settled: { why: '入金が無い', fix: '露出を増やす', action: 'registry_probe', level: 'allow' },
    },
    async measure(ctx) {
      const origin = originOf(ctx.env);
      const [reg, mcp] = await Promise.all([
        getJson('https://registry.modelcontextprotocol.io/v0/servers?search=io.github/jukky-source/wealth-agent', 9000),
        fetchTools(origin),
      ]);
      const servers = (reg.json && (reg.json.servers || reg.json.items)) || [];
      const found = servers.some((s) => JSON.stringify(s).toLowerCase().includes('wealth-agent'));
      // MCP も自前 origin への fetch になるため、404 は「ツール0本」ではなく「測れていない」。
      const mcpUnknown = mcp.count === 0 && (mcp.status === 404 || mcp.status === 0);
      return {
        listed: found ? 1 : 0,
        quote: mcpUnknown ? 1 : (mcp.count > 0 ? 1 : 0),
        traffic: 0, paid: 0, settled: 0,
        evidence: { registry_status: reg.status, registry_hits: servers.length, registry_found: found, mcp_tools: mcpUnknown ? '未測定（自前 fetch 不可）' : mcp.count, mcp_status: mcp.status, mcp_error: mcp.error || null },
        notes: reg.error ? [`レジストリ照会に失敗: ${reg.error}`] : [],
      };
    },
  },
  {
    key: 'free_tier',
    label: '無料枠 → 有料（転換）',
    kind: '直販',
    autonomy: 'full',
    cost: 0,
    currency: 'USDC',
    what: '/api/free と /api/skills/catalog で試させ、上限で 402 に切り替えて有料へ渡す。',
    walls: {
      listed: { why: '無料の入口が外から読めていない', fix: '無料面の疎通と価格表示を直す', action: 'funnel_count', level: 'allow' },
      quote: { why: '無料面は在るが 402 への切り替えが説明されていない', fix: '切り替えの案内を実測して直す', action: 'funnel_count', level: 'allow' },
      traffic: { why: '無料枠が誰にも使われていない（入口に人が来ていない）', fix: '発見面（索引・名簿）を増やす', action: 'funnel_count', level: 'allow' },
      paid: { why: '無料は使われるが有料に転換しない', fix: '無料の上限と有料の価格差、納品物の差を測って詰める', action: 'funnel_count', level: 'allow' },
      settled: { why: '転換後の入金が無い', fix: '露出を増やす', action: 'funnel_count', level: 'allow' },
    },
    async measure(ctx) {
      const origin = originOf(ctx.env);
      const [free, cat] = await Promise.all([
        getJson(`${origin}/api/free?limit=1`, 6000),
        getJson(`${origin}/api/skills/catalog.json`, 6000),
      ]);
      const t = await trafficStats(ctx.store);
      const freeCalls = t.by_kind ? (t.by_kind.free || t.by_kind.free_call || 0) : 0;
      const rev = await externalRevenue(ctx.store);
      let listed = free.status === 200 ? 1 : 0;
      let selfNote = null;
      if (!listed) {
        try {
          const F = await import('./freeStack.js');
          if (F.FREE_RESOURCES && F.FREE_RESOURCES.length) { listed = 1; selfNote = '自前 fetch 不可のため、その場の無料資源定義で代替'; }
        } catch (e) { /* noop */ }
      }
      return {
        listed,
        quote: (cat.status === 200 || free.status === 200 || listed === 1) ? 1 : 0,
        traffic: (freeCalls > 0 || t.non_bot > 0) ? 1 : 0,
        paid: rev.external_n > 0 ? 1 : 0,
        settled: rev.external_n > 0 ? 1 : 0,
        evidence: { free_status: free.status, skills_status: cat.status, free_calls: freeCalls, hits_non_bot: t.non_bot, self_note: selfNote },
      };
    },
  },
  {
    key: 'bounty',
    label: '報奨金（PR・バグ修正）',
    kind: '受託',
    autonomy: 'partial',
    cost: 0,
    currency: 'USD',
    what: '支払い実績のある OSS 報奨金。原価0だが、提出と受取に人の確認が要る。',
    walls: {
      listed: { why: '候補が採れていない', fix: '走査を回して候補を貯める', action: 'scan_freshness', level: 'allow' },
      quote: { why: '支払い実績（paid_closed）のある候補が 0 件', fix: 'エスクローが確認できる泉（Algora 等）に絞って候補を採り直す', action: 'scan_freshness', level: 'approve' },
      traffic: { why: '候補は在るが手を付けていない', fix: '修正案を作り、提出の可否を人に確認する', action: 'scan_freshness', level: 'approve' },
      paid: { why: '提出しても支払われていない', fix: '提出済みの追跡と、支払い実績のある案件への絞り込み', action: 'scan_freshness', level: 'human_only' },
      settled: { why: '入金が無い', fix: '受取手段（ウォレット/銀行）の設定を人に確認する', action: 'scan_freshness', level: 'human_only' },
    },
    async measure(ctx) {
      const last = await q1(ctx.store, `SELECT COUNT(*) AS n FROM bounty_leads`);
      const paid = await q1(ctx.store, `SELECT COUNT(*) AS n FROM bounty_leads WHERE COALESCE(verdict,'') = 'pursue'`);
      const unbacked = await q1(ctx.store, `SELECT COUNT(*) AS n FROM bounty_leads WHERE COALESCE(verdict,'') = 'unbacked'`);
      const at = await q1(ctx.store, `SELECT MAX(at) AS at FROM bounty_leads`);
      const n = num(last && last.n, 0);
      return {
        listed: n > 0 ? 1 : 0,
        quote: num(paid && paid.n, 0) > 0 ? 1 : 0,
        traffic: 0, paid: 0, settled: 0,
        evidence: { leads: n, pursue: num(paid && paid.n, 0), unbacked: num(unbacked && unbacked.n, 0), last_at: (at && at.at) || null },
      };
    },
  },
  {
    key: 'fx_ea',
    label: 'FX（自己資金 / E8）',
    kind: '自己資金',
    autonomy: 'partial',
    cost: 0,
    currency: 'JPY',
    what: '検証を通った論理だけを実行部へ。元手は自己資金で、原価0の枠では増やせない。',
    walls: {
      listed: { why: '候補が作れていない', fix: '候補づくりを回す', action: 'lab_status', level: 'allow' },
      quote: { why: '門（15/6/40/45）を通る個体が無い', fix: '門の近くまで来た個体を親にして変異させる', action: 'lab_status', level: 'allow' },
      traffic: { why: '通った論理が実行部に渡っていない', fix: '引き渡しの詰まりを名指しする', action: 'lab_status', level: 'allow' },
      paid: { why: '実行しても収益が出ていない', fix: '資金条件と執行条件を再確認する', action: 'lab_status', level: 'human_only' },
      settled: { why: '出金していない', fix: '出金は人の操作', action: 'lab_status', level: 'human_only' },
    },
    async measure(ctx) {
      const rows = await ctx.store.all(`SELECT verdict, COUNT(*) AS n FROM lab_rounds GROUP BY verdict`).catch(() => []);
      const by = {}; for (const r of (rows || [])) by[String(r.verdict)] = num(r.n, 0);
      const total = Object.values(by).reduce((a, b) => a + b, 0);
      const improved = num(by.improved, 0);
      return {
        listed: total > 0 ? 1 : 0,
        quote: improved > 0 ? 1 : 0,
        traffic: 0, paid: 0, settled: 0,
        evidence: { rounds: total, by_verdict: by, improved },
      };
    },
  },
  {
    key: 'content_sns',
    label: 'コンテンツ / SNS（下書き→投稿）',
    kind: 'コンテンツ',
    autonomy: 'none',
    cost: 0,
    currency: 'JPY',
    what: '集めた事実から読み物を作る。投稿は人の1タップ（無断投稿はしない）。',
    walls: {
      listed: { why: '下書きが1本も無い', fix: '収集物から下書きを作る', action: 'draft_queue', level: 'allow' },
      quote: { why: '下書きは在るが投稿されていない（人が押す段で止まっている）', fix: '投稿する候補を1本に絞って、押すだけにする', action: 'draft_queue', level: 'approve' },
      traffic: { why: '投稿したが読まれていない', fix: '出す場所と題材を変える', action: 'draft_queue', level: 'approve' },
      paid: { why: '読まれるが売れない', fix: '売り物への導線を入れる', action: 'draft_queue', level: 'approve' },
      settled: { why: '入金が無い', fix: '売れる形（有料note等）への接続を人と決める', action: 'draft_queue', level: 'human_only' },
    },
    async measure(ctx) {
      const rows = await ctx.store.all(`SELECT state, COUNT(*) AS n FROM publish_drafts GROUP BY state`).catch(() => []);
      const by = {}; for (const r of (rows || [])) by[String(r.state)] = num(r.n, 0);
      const drafted = num(by.drafted, 0);
      const posted = num(by.posted, 0);
      const tw = num((await q1(ctx.store, `SELECT COUNT(*) AS n FROM twitter_posts`))?.n, 0);
      return {
        listed: (drafted + posted + tw) > 0 ? 1 : 0,
        quote: posted + tw > 0 ? 1 : 0,
        traffic: posted > 0 ? 1 : 0,
        paid: 0, settled: 0,
        evidence: { drafts_by_state: by, twitter_posts: tw },
      };
    },
  },
  {
    key: 'index_mirrors',
    label: '下流ミラー（x402.new / Circle / Sentinel）',
    kind: '索引',
    autonomy: 'partial',
    cost: 0,
    currency: 'USDC',
    what: 'Bazaar を写し取る系の索引。自動同期と、提出制のものが混ざる。',
    external: true,
    walls: {
      listed: { why: 'どのミラーにも出ていない（同期待ちか、条件差か）', fix: '定期的に照会して、出るまでの日数と条件差を記録する', action: 'mirror_probe', level: 'allow' },
      quote: { why: 'ミラーに出たが値札が読めていない', fix: '値札を実測する', action: 'mirror_probe', level: 'allow' },
      traffic: { why: 'ミラーに居るのに呼ばれない', fix: '説明を充実させる', action: 'mirror_probe', level: 'allow' },
      paid: { why: 'ミラー経由で払われない', fix: '条件差を潰す', action: 'mirror_probe', level: 'allow' },
      settled: { why: 'ミラー経由の入金が無い', fix: '提出制の売り場に手で出す（人が押す）', action: 'mirror_probe', level: 'approve' },
    },
    async measure(ctx) {
      const payTo = String((ctx.env && ctx.env.X402_PAY_TO) || '0x3291398dC7070472CF2ED2e757246d089760Ca91');
      const [circle, xnew, sent] = await Promise.all([
        getJson(`https://api.circle.com/v1/x402/discovery/resources?limit=200&payTo=${payTo}`, 8000),
        getJson('https://x402.new/api/services?q=wealthagent', 8000),
        getJson('https://sentinel.rootstuff.io/agents/directory.json', 8000),
      ]);
      const cHit = num(circle.json && circle.json.pagination && circle.json.pagination.total, 0) > 0;
      const xHit = num(xnew.json && xnew.json.total, 0) > 0;
      const sHay = `${sent.text || ''}`.toLowerCase();
      const sHit = sHay.includes('wealth-agent') || sHay.includes('wealthagent-app');
      const present = [cHit, xHit, sHit].filter(Boolean).length;
      return {
        listed: present > 0 ? 1 : 0,
        quote: 1, traffic: 0, paid: 0, settled: 0,
        evidence: { circle: { status: circle.status, total: circle.json && circle.json.pagination && circle.json.pagination.total, ours: cHit }, x402new: { status: xnew.status, total: xnew.json && xnew.json.total, ours: xHit }, sentinel: { status: sent.status, ours: sHit }, mirrors_present: present, mirrors_total: 3 },
      };
    },
  },
];

export const channelByKey = (k) => CHANNELS.find((c) => c.key === String(k || '').trim()) || null;
export const channelKeys = () => CHANNELS.map((c) => c.key);

/** 最初に 0 になる段が壁。全部通っていれば 'repeat'。 */
export function diagnose(m = {}) {
  if (num(m.settled, 0) > 0) return { stage: 'repeat', wall: 'settled_ok' };
  for (const s of STAGES) {
    if (!num(m[s], 0)) return { stage: s, wall: s };
  }
  return { stage: 'repeat', wall: 'paid' };
}

/** 打ち手の優先度。金額に近い壁・無人で打てる壁・原価0の壁を上位にする。 */
export function priorityOf(ch, stage, level) {
  const w = STAGE_WEIGHT[stage] ?? 1;
  let p = w * 10;
  if (ch.autonomy === 'full') p += 15;
  if (num(ch.cost, 1) === 0) p += 10;
  if (level === 'allow') p += 8;
  if (ch.external) p += 2;
  return p;
}

// ---------------------------------------------------------------------------
// 打ち手（原価0・自分の資源と公開情報だけを触る）
// ---------------------------------------------------------------------------

/** 9ルートを未払いで叩き、402（値札）が返るかを見る。400 は入力側の問題として分けて数える。 */
export async function quoteProbe(origin, resources) {
  const list = (resources && resources.length ? resources : Object.keys(PROBE_BODY));
  const results = [];
  for (const r of list) {
    const body = PROBE_BODY[r] || { text: 'ping' };
    try {
      const res = await fetch(`${origin}/api/x402/${r}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'WealthAgent-Sales/1.0' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(9000),
      });
      const txt = await res.text();
      results.push({ resource: r, status: res.status, has_challenge: /payment-required|PAYMENT-REQUIRED|accepts/i.test(txt) || res.headers.get('payment-required') != null });
    } catch (e) {
      results.push({ resource: r, status: 0, error: String((e && e.message) || e).slice(0, 100) });
    }
  }
  const ok = results.filter((x) => x.status === 402);
  const bad = results.filter((x) => x.status === 400);
  const err = results.filter((x) => !x.status || x.status >= 500);
  const other = results.filter((x) => x.status && x.status !== 402 && x.status !== 400 && x.status < 500);
  const broken = [...bad.map((x) => `${x.resource}:400`), ...err.map((x) => `${x.resource}:${x.status || 'ERR'}`), ...other.map((x) => `${x.resource}:${x.status}`)];
  const allOther = other.length === results.length && other.length > 0;
  return {
    ok_count: ok.length, bad_input_count: bad.length, err_count: err.length, other_count: other.length,
    // 自前 fetch の拒否(404)は「壊れている」ではない。壊れている経路として数えない。
    results, broken: allOther ? [] : broken,
    // Cloudflare は Worker の自前 hostname への fetch を拒否し 404 を返す。
    // これを「値札の故障」と取り違えると、健全な売り物を壊れていると誤診する。
    self_fetch_blocked: allOther,
    note: broken.length ? `値札が出ない経路: ${broken.join(', ')}` : null,
  };
}

async function fetchTools(origin) {
  try {
    const r = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'WealthAgent-Sales/1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: AbortSignal.timeout(8000),
    });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch { /* noop */ }
    const tools = (j && j.result && j.result.tools) || [];
    return { status: r.status, count: tools.length };
  } catch (e) { return { status: 0, count: 0, error: String((e && e.message) || e).slice(0, 100) }; }
}

async function cdpMerchant(env, payTo) {
  try {
    const mod = await import('./cdp-auth.js');
    const keyId = (env && env.CDP_API_KEY_ID) || null;
    const keySecret = (env && env.CDP_API_KEY_SECRET) || null;
    if (!keyId || !keySecret) return { count: 0, status: 0, note: 'CDP の鍵が未設定のため照会できない' };
    const path = `/platform/v2/x402/discovery/merchant?payTo=${payTo}`;
    const jwt = await mod.cdpBearer({ keyId, keySecret, method: 'GET', host: 'api.cdp.coinbase.com', path });
    const r = await fetch(`https://api.cdp.coinbase.com${path}`, { headers: { Authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(9000) });
    const j = await r.json().catch(() => null);
    return { count: num(j && j.pagination && j.pagination.total, ((j && j.resources) || []).length), status: r.status };
  } catch (e) {
    return { count: 0, status: 0, error: String((e && e.message) || e).slice(0, 120) };
  }
}

const ACTIONS = {
  async quote_probe(ctx, ch, m) {
    const origin = originOf(ctx.env);
    const p = await quoteProbe(origin, Object.keys(PROBE_BODY));
    // 自前 fetch を Cloudflare が拒否する環境では、外から測った 0 本を「値札の故障」と読まない。
    // 直前に測った値札の健全性（その場で構成した結果）を根拠として出す。
    const measured = num(m && m.evidence && m.evidence.routes_402, 0);
    return {
      ok: p.ok_count > 0, level: 'allow', after: { routes_402: p.ok_count, broken: p.broken.slice(0, 9) },
      note: p.broken.length
        ? `値札が出ない経路が ${p.broken.length} 本: ${p.broken.slice(0, 5).join(', ')}`
        : (p.ok_count > 0
          ? `${p.ok_count} 本の値札を実測で確認`
          : (p.self_fetch_blocked && measured > 0
            ? `自前 fetch 不可のため外からは測れないが、その場の確認では値札 ${measured} 本が健全`
            : '値札を確認できなかった')),
      next_human_step: p.broken.length ? '値札が出ない経路の入力を直す' : null,
    };
  },
  async index_probe(ctx, ch, m) {
    const payTo = String((ctx.env && ctx.env.X402_PAY_TO) || '0x3291398dC7070472CF2ED2e757246d089760Ca91');
    const r = await cdpMerchant(ctx.env, payTo);
    return { ok: r.count > 0, level: 'allow', after: { indexed: r.count, status: r.status }, note: r.error ? `照会失敗: ${r.error}` : `${r.note || `CDP 索引の実測 = ${r.count} 件`}`, next_human_step: null };
  },
  async index_probe_payai(ctx, ch, m) {
    const payTo = String((ctx.env && ctx.env.X402_PAY_TO) || '0x3291398dC7070472CF2ED2e757246d089760Ca91');
    const r = await getJson(`https://facilitator.payai.network/discovery/resources?limit=200&payTo=${payTo}`, 8000);
    const items = (r.json && (r.json.items || r.json.resources)) || [];
    return { ok: items.length > 0, level: 'allow', after: { returned: items.length, status: r.status }, note: r.error ? `照会失敗: ${r.error}` : `PayAI の実測 = ${items.length} 件`, next_human_step: null };
  },
  async expose_boost(ctx, ch, m) {
    // 索引の順位は「説明・出力スキーマ・サービスメタデータの充実」で決まる（CDP Bazaar の仕様）。
    // 原価0で効く唯一のレバーなので、9 ルートの材料の薄さを実測して名指しする。
    const X = await import('./x402.js');
    const cat = (X.catalog ? X.catalog(ctx.env) : X.X402_CATALOG) || [];
    const rows = cat.map((i) => {
      const d = String(i.description || '');
      const oe = X.OUTPUT_EXAMPLES ? (X.OUTPUT_EXAMPLES[i.resource] || null) : null;
      const os = X.outputSchema ? X.outputSchema(i.resource) : null;
      return { resource: i.resource, desc_chars: d.length, output_example: !!oe, output_schema: !!os };
    });
    const thin = rows.filter((r) => r.desc_chars < 120 || !r.output_schema);
    return {
      ok: thin.length === 0, level: 'allow',
      after: { routes: rows.length, avg_desc: rows.length ? Math.round(rows.reduce((a, r) => a + r.desc_chars, 0) / rows.length) : 0, thin: thin.map((r) => `${r.resource}:${r.desc_chars}字${r.output_schema ? '' : '・出力スキーマ無し'}`) },
      note: thin.length
        ? `索引の順位に効く材料が薄い経路 ${thin.length} 本: ${thin.map((r) => `${r.resource}(${r.desc_chars}字${r.output_schema ? '' : '・スキーマ無し'})`).join(', ')}`
        : `全 ${rows.length} 本で説明・出力スキーマが揃っている`,
      next_human_step: null,
    };
  },
  async listing_prep(ctx, ch, m) {
    const origin = originOf(ctx.env);
    const cat = await getJson(`${origin}/api/x402/catalog.json`, 6000);
    const items = (cat.json && cat.json.items) || [];
    const payload = {
      provider: 'Wealth-A (autonomous x402 agent)',
      origin,
      listing_url: ch.submit_url,
      resources: items.map((i) => ({ resource: i.resource, price: i.price, method: i.method || 'POST' })),
      discovery: [`${origin}/openapi.json`, `${origin}/.well-known/x402.json`, `${origin}/llms.txt`],
      note: '掲載は提出制。自動登録の口は無いため、人の1タップで提出する。',
    };
    return {
      ok: false, level: 'approve', blocked: true, after: { resources: payload.resources.length },
      note: `掲載用の1枚を用意: ${payload.resources.length} ルート / origin ${origin}`,
      result: payload,
      next_human_step: `${ch.submit_url} を開いて、用意した origin とルート一覧を提出する（掲載は無料）`,
    };
  },
  async rank_probe(ctx, ch, m) {
    const queries = ['code review', 'research brief', 'run a regex on text', 'convert csv to json'];
    const out = [];
    for (const q of queries) {
      const r = await getJson(`https://agent402.tools/api/route?q=${encodeURIComponent(q)}`, 9000);
      const cands = (r.json && (r.json.candidates || r.json.results || r.json.items)) || [];
      let rank = null;
      cands.forEach((c, i) => { const s = JSON.stringify(c).toLowerCase(); if (rank === null && (s.includes('wealthagent-app') || s.includes('wealth-agent'))) rank = i + 1; });
      out.push({ q, status: r.status, rank, n: cands.length });
      await new Promise((s) => setTimeout(s, 2500));
    }
    const top = out.filter((x) => x.rank === 1).length;
    const missing = out.filter((x) => x.rank == null && x.status === 200).map((x) => x.q);
    return {
      ok: top > 0, level: 'allow',
      after: { top1: top, measured: out.length, detail: out.map((x) => `${x.q}=${x.rank || '圏外'}`) },
      note: `1位 ${top}/${out.length}。圏外: ${missing.join(', ') || 'なし'}`,
      next_human_step: null,
    };
  },
  async registry_probe(ctx, ch, m) {
    const origin = originOf(ctx.env);
    const [reg, mcp] = await Promise.all([
      getJson('https://registry.modelcontextprotocol.io/v0/servers?search=io.github/jukky-source/wealth-agent', 9000),
      fetchTools(origin),
    ]);
    const servers = (reg.json && (reg.json.servers || reg.json.items)) || [];
    const found = servers.some((s) => JSON.stringify(s).toLowerCase().includes('wealth-agent'));
    return {
      ok: found, level: 'allow', after: { registry_status: reg.status, registry_found: found, mcp_tools: mcp.count },
      note: found ? `公式レジストリに掲載あり / MCP ツール ${mcp.count} 本` : `公式レジストリに未掲載 / MCP ツール ${mcp.count} 本`,
      next_human_step: null,
    };
  },
  async funnel_count(ctx, ch, m) {
    const origin = originOf(ctx.env);
    const [free, cat] = await Promise.all([getJson(`${origin}/api/free?limit=1`, 6000), getJson(`${origin}/api/skills/catalog.json`, 6000)]);
    const t = await trafficStats(ctx.store);
    return {
      ok: free.status === 200, level: 'allow',
      after: { free: free.status, skills: cat.status, non_bot_hits: t.non_bot, callers: t.distinct_callers },
      note: (free.status === 200 ? `無料面 200` : `無料面は自前 fetch 不可のため未測定`) + ` / 有料転換の実測: 非bot の呼び出し ${t.non_bot} 件・呼び手 ${t.distinct_callers} 人`,
      next_human_step: null,
    };
  },
  async scan_freshness(ctx, ch, m) {
    const n = num((await q1(ctx.store, `SELECT COUNT(*) AS n FROM bounty_leads`))?.n, 0);
    const pursue = num((await q1(ctx.store, `SELECT COUNT(*) AS n FROM bounty_leads WHERE COALESCE(verdict,'')='pursue'`))?.n, 0);
    return {
      ok: n > 0, level: pursue > 0 ? 'allow' : 'approve', after: { leads: n, pursue },
      note: `候補 ${n} 件 / 支払い実績つき ${pursue} 件`,
      next_human_step: pursue > 0 ? '支払い実績つきの案件に、修正案を出してよいか確認する' : 'エスクロー（paid_closed）が確認できる泉を追加する',
    };
  },
  async lab_status(ctx, ch, m) {
    const rows = await ctx.store.all(`SELECT verdict, COUNT(*) AS n FROM lab_rounds GROUP BY verdict`).catch(() => []);
    const by = {}; for (const r of (rows || [])) by[String(r.verdict)] = num(r.n, 0);
    return { ok: num(by.improved, 0) > 0, level: 'allow', after: by, note: `検証ラウンド ${Object.values(by).reduce((a, b) => a + b, 0)} 回（改善 ${num(by.improved, 0)} 回）`, next_human_step: null };
  },
  async draft_queue(ctx, ch, m) {
    const rows = await ctx.store.all(`SELECT state, COUNT(*) AS n FROM publish_drafts GROUP BY state`).catch(() => []);
    const by = {}; for (const r of (rows || [])) by[String(r.state)] = num(r.n, 0);
    return {
      ok: num(by.posted, 0) > 0, level: num(by.drafted, 0) > 0 ? 'approve' : 'allow', after: by,
      note: `下書き ${num(by.drafted, 0)} 本 / 投稿済み ${num(by.posted, 0)} 本`,
      next_human_step: num(by.drafted, 0) > 0 ? '投稿してよい下書きを1本選ぶ（投稿は人の1タップ）' : null,
    };
  },
  async mirror_probe(ctx, ch, m) {
    const payTo = String((ctx.env && ctx.env.X402_PAY_TO) || '0x3291398dC7070472CF2ED2e757246d089760Ca91');
    const [circle, xnew] = await Promise.all([
      getJson(`https://api.circle.com/v1/x402/discovery/resources?limit=200&payTo=${payTo}`, 8000),
      getJson('https://x402.new/api/services?q=wealthagent', 8000),
    ]);
    const c = num(circle.json && circle.json.pagination && circle.json.pagination.total, 0);
    const x = num(xnew.json && xnew.json.total, 0);
    return {
      ok: c > 0 || x > 0, level: 'allow', after: { circle: c, x402new: x },
      note: `下流ミラーの実測: Circle ${c} 件 / x402.new ${x} 件（未掲載なら同期の遅延か条件差を追う）`,
      next_human_step: null,
    };
  },
  /** 見つけた売り場に載せに行く（販路開拓ループに委譲する）。 */
  async hunt_register({ store, env, now }, ch, b) {
    const { huntRound } = await import('./chanhunt.js');
    const rec = await huntRound({ store, env, n: 2, now, discoverNow: false });
    const acts = (rec && rec.actions) || [];
    const sent = acts.filter((a) => a.action === 'register' && a.outcome === 'ok').length;
    const waiting = acts.filter((a) => a.action === 'human_form').length;
    return {
      ok: sent > 0, level: waiting ? 'human_only' : 'allow',
      after: { sent, waiting, discovered: rec && rec.discovered },
      note: `販路開拓: 自動送信 ${sent} 件 / 人の1タップ待ち ${waiting} 件 — ${(rec && rec.note) || ''}`,
      next_human_step: waiting ? 'GET /api/hunt?format=text の「人の1タップ待ち」を押す' : null,
    };
  },
  /** 見つけた売り場の値札・発見面を確かめる。 */
  async hunt_probe({ store, env, now }, ch, b) {
    const { probeHost } = await import('./chanhunt.js');
    const host = (ch && ch.host) || String((b && b.key) || '').replace(/^hn_/, '').replace(/_/g, '.');
    const p = await probeHost(host, { ms: 4000 });
    return {
      ok: !!p.reachable, level: 'allow',
      after: { host, looks: p.looks, faces: p.faces, speaks_x402: p.speaks_x402, neighbors: p.neighbors, listed_here: p.listed_here },
      note: `${host}: ${p.looks}${p.speaks_x402 ? ' / x402' : ''} / 隣人 ${p.neighbors} / 掲載 ${p.listed_here}`,
      next_human_step: null,
    };
  },
};

export const actionKeys = () => Object.keys(ACTIONS);

// ---------------------------------------------------------------------------
// 1ラウンド = 全販路を測る → 壁を名指しする → 期待値順に打つ → 記録する
// ---------------------------------------------------------------------------

export async function ensureSalesTable(store) {
  await store.run(`CREATE TABLE IF NOT EXISTS ${SR} (id TEXT PRIMARY KEY, at TEXT, channels_json TEXT, board_json TEXT, actions_json TEXT, verdict TEXT, note TEXT)`).catch(() => {});
}

export async function measureAll({ store, env = {}, channels = null } = {}) {
  // 販路開拓ループ（chanhunt）が見つけた売り場も、同じ漏斗で測る。盤面は静的な11件では終わらない。
  let list = Array.isArray(channels) && channels.length ? channels : CHANNELS;
  if (!channels) {
    try {
      const { dynamicChannels } = await import('./chanhunt.js');
      const dyn = await dynamicChannels(store, env);
      if (dyn.length) list = [...CHANNELS, ...dyn];
    } catch (e) { /* 動的販路が読めなくても、静的な11販路で回す */ }
  }
  const ctx = { store, env };
  const out = [];
  for (const ch of list) {
    let m = null; let error = null;
    try { m = await ch.measure(ctx); } catch (e) { error = String((e && e.message) || e).slice(0, 160); }
    if (!m) m = { listed: 0, quote: 0, traffic: 0, paid: 0, settled: 0, evidence: {}, notes: [] };
    const d = diagnose(m);
    const wall = ch.walls[d.stage] || ch.walls.listed || { why: '', fix: '', action: null, level: 'allow' };
    out.push({
      key: ch.key, label: ch.label, kind: ch.kind, autonomy: ch.autonomy, cost: num(ch.cost, 1),
      external: !!ch.external, stage: d.stage, wall: d.wall,
      wall_why: wall.why, fix: wall.fix, action: wall.action || null, level: wall.level || 'allow',
      priority: priorityOf(ch, d.stage, wall.level || 'allow'),
      funnel: { listed: num(m.listed, 0), quote: num(m.quote, 0), traffic: num(m.traffic, 0), paid: num(m.paid, 0), settled: num(m.settled, 0) },
      evidence: m.evidence || {}, notes: m.notes || [], error,
    });
  }
  return out;
}

export async function salesRound({ store, env = {}, n = 3, now = null, channels = null, dry = false } = {}) {
  await ensureSalesTable(store);
  const at = now || nowIso();
  const board = await measureAll({ store, env, channels });
  const ranked = [...board].sort((a, b) => b.priority - a.priority);
  const want = Math.max(1, Math.min(board.length, Number(n) || 4));
  // 同じ壁ばかり打たない。段が違う販路を先に拾い、残りを優先度順で埋める。
  const picks = [];
  const seenStage = new Set();
  for (const b of ranked) { if (picks.length >= want) break; if (!seenStage.has(b.stage)) { picks.push(b); seenStage.add(b.stage); } }
  for (const b of ranked) { if (picks.length >= want) break; if (!picks.includes(b)) picks.push(b); }
  const dynKeys = await (async () => { try { const { dynamicChannels } = await import('./chanhunt.js'); return await dynamicChannels(store, env); } catch { return []; } })();
  const byKey = Object.fromEntries([...CHANNELS, ...dynKeys].map((c) => [c.key, c]));
  const actions = [];
  for (const b of picks) {
    const ch = byKey[b.key];
    const fn = ACTIONS[b.action];
    if (!fn || dry) {
      actions.push({ key: b.key, action: b.action, level: b.level, skipped: dry ? 'dry_run' : 'no_executor', note: b.fix });
      continue;
    }
    try {
      const r = await fn({ store, env, now: at }, ch, b);
      actions.push({
        key: b.key, action: b.action, level: r.level || b.level, ok: !!r.ok, blocked: !!r.blocked,
        after: r.after || {}, note: r.note || '', result: r.result || null, next_human_step: r.next_human_step || null,
      });
    } catch (e) {
      actions.push({ key: b.key, action: b.action, level: b.level, ok: false, error: String((e && e.message) || e).slice(0, 160), next_human_step: b.fix });
    }
  }
  const okCount = actions.filter((a) => a.ok).length;
  const needHuman = actions.filter((a) => a.next_human_step);
  const settledCh = board.filter((b) => b.funnel.settled > 0).length;
  const verdict = settledCh > 0 ? 'settling' : (okCount > 0 ? 'advanced' : 'blocked');
  const note = `${board.length} 販路を測定 / 打ち手 ${actions.length} 本（成立 ${okCount}）`
    + (needHuman.length ? ` / 人の1タップ待ち ${needHuman.length} 件` : '')
    + ` / 入金のある販路 ${settledCh}`;
  const rec = { id: rid(), at, channels: board, actions, verdict, note };
  await store.run(
    `INSERT INTO ${SR} (id,at,channels_json,board_json,actions_json,verdict,note) VALUES (?,?,?,?,?,?,?)`,
    rec.id, rec.at, JSON.stringify(board), JSON.stringify(board.map((b) => ({ key: b.key, stage: b.stage, priority: b.priority }))), JSON.stringify(actions), verdict, note.slice(0, 400),
  ).catch(() => {});

  const st = await loadState(store);
  const history = [{ at, verdict, note: note.slice(0, 160), walls: board.map((b) => `${b.key}:${b.stage}`).join(' ') }, ...(st.history || [])].slice(0, HIST_MAX);
  await setSetting(store, SSTATE_KEY, {
    rounds: num(st.rounds, 0) + 1,
    last: { at, verdict, note, walls: Object.fromEntries(board.map((b) => [b.key, b.stage])) },
    history,
  }).catch(() => {});
  return rec;
}

export async function salesTick({ store, env = {}, n = null, now = null } = {}) {
  const want = Number(n) > 0 ? Number(n) : Math.max(1, Math.min(6, Number((env && env.SALES_ACTIONS_PER_ROUND) || 4)));
  return salesRound({ store, env, n: want, now });
}

async function loadState(store) {
  const raw = await setting(store, SSTATE_KEY, null).catch(() => null);
  if (!raw) return { rounds: 0, last: null, history: [] };
  if (typeof raw === 'object') return { rounds: num(raw.rounds, 0), last: raw.last || null, history: raw.history || [] };
  try { const j = JSON.parse(String(raw)); return { rounds: num(j.rounds, 0), last: j.last || null, history: j.history || [] }; } catch { return { rounds: 0, last: null, history: [] }; }
}

/** 状態: 販路ボード＋直近ラウンド＋全体の実測。 */
export async function salesStatus(store, env = {}) {
  await ensureSalesTable(store);
  const state = await loadState(store);
  const recent = await store.all(`SELECT * FROM ${SR} ORDER BY at DESC LIMIT 6`).catch(() => []);
  const rev = await externalRevenue(store);
  const t = await trafficStats(store);
  const dynCh = await (async () => { try { const { dynamicChannels } = await import('./chanhunt.js'); return await dynamicChannels(store, env); } catch { return []; } })();
  const chans = [...CHANNELS, ...dynCh].map((c) => ({ key: c.key, label: c.label, kind: c.kind, autonomy: c.autonomy, cost: num(c.cost, 1), external: !!c.external, what: c.what, submit_url: c.submit_url || null, walls: Object.fromEntries(Object.entries(c.walls).map(([k, v]) => [k, v.fix])) }));
  const latest = (recent && recent[0]) || null;
  let board = [];
  if (latest) { try { board = JSON.parse(latest.channels_json || '[]'); } catch { board = []; } }
  return {
    version: SALES_VERSION,
    at: nowIso(),
    channels: chans,
    board,
    rounds: recent.map((r) => {
      let actions = []; try { actions = JSON.parse(r.actions_json || '[]'); } catch { actions = []; }
      return { at: r.at, verdict: r.verdict, note: r.note, actions };
    }),
    totals: {
      channels: chans.length,
      settling: board.filter((b) => b.funnel && b.funnel.settled > 0).length,
      callable: board.filter((b) => b.funnel && b.funnel.traffic > 0).length,
      listed: board.filter((b) => b.funnel && b.funnel.listed > 0).length,
      revenue_external_usd: rev.external_amount,
      revenue_self_test_usd: rev.self_test_amount,
      external_receipts: rev.external_n,
      discovered_channels: chans.length - CHANNELS.length,
      hits_total: t.total, hits_non_bot: t.non_bot, callers: t.distinct_callers,
    },
    state: { rounds: state.rounds, last: state.last },
  };
}

export function salesPublic(st = {}) {
  const t = st.totals || {};
  return {
    version: st.version,
    at: st.at,
    totals: t,
    board: (st.board || []).map((b) => ({
      key: b.key, label: b.label, kind: b.kind, autonomy: b.autonomy,
      stage: b.stage, stage_label: STAGE_LABEL[b.stage] || b.stage,
      wall_why: b.wall_why, fix: b.fix, action: b.action, level: b.level, priority: b.priority,
      funnel: b.funnel, evidence: b.evidence,
    })),
    recent: (st.rounds || []).slice(0, 3),
    why_no_revenue: (st.board || []).filter((b) => b.funnel && !b.funnel.settled).map((b) => ({ channel: b.label, stuck_at: STAGE_LABEL[b.stage] || b.stage, reason: b.wall_why, next: b.fix })),
  };
}

export function salesText(st = {}) {
  const L = [];
  const t = st.totals || {};
  L.push(`販路ポートフォリオ ${st.version || ''} (${st.at || ''})`);
  L.push(`販路 ${t.channels || 0} / 掲載あり ${t.listed || 0} / 呼ばれた ${t.callable || 0} / 入金のある販路 ${t.settling || 0}`);
  L.push(`外部入金 ${t.revenue_external_usd || 0} USDC（${t.external_receipts || 0} 件） / 自己テスト ${t.revenue_self_test_usd || 0} USDC`);
  L.push(`呼び出し ${t.hits_total || 0} 件（非bot ${t.hits_non_bot || 0} 件・呼び手 ${t.callers || 0} 人）`);
  L.push('');
  for (const b of (st.board || [])) {
    L.push(`- [${b.kind}] ${b.label}: 壁=『${b.wall_why}』 → ${b.action}（優先 ${b.priority} / ${b.level}）`);
  }
  L.push('');
  for (const r of (st.rounds || []).slice(0, 3)) L.push(`直近 ${r.at}: ${r.verdict} — ${r.note}`);
  return L.join('\n');
}

export function salesHelp() {
  return {
    what: '「なぜ売上が立たないのか」を販路ごとに測り、最初に 0 になる段（壁）を名指しして、全販路を同時に打つループ。',
    stages: STAGES.map((s) => ({ key: s, label: STAGE_LABEL[s] })),
    how: '1ラウンド = 全販路を測る → 壁を名指しする → 期待値順に打ち手を実行する → sales_rounds に記録する。',
    cost: '原価0。読み取り（自前資源の疎通確認・公開索引の照会）と自前資源への書き込みだけ。金が要る打ち手と人手が要る打ち手は approve / human_only で止める。',
    endpoints: { status: 'GET /api/sales', public: 'GET /api/sales/public', run: 'POST /api/sales?n=<数>', help: 'GET /api/sales?help=1' },
    channels: CHANNELS.map((c) => ({ key: c.key, label: c.label, kind: c.kind, autonomy: c.autonomy, what: c.what })),
    actions: actionKeys(),
  };
}
